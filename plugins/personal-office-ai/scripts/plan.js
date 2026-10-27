/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Turns a question about a sheet into a checked plan. The language model only
 * chooses what to do (which columns, which aggregation, which formula); the
 * values are always computed by spreadsheet formulas written here.
 */
(function (exports) {
	"use strict";

	var SAMPLE_ROWS = 15;
	var AGGREGATIONS = {
		sum: { label: "Total", fn: "SUMIFS", needsValue: true },
		average: { label: "Average", fn: "AVERAGEIFS", needsValue: true },
		count: { label: "Count", fn: "COUNTIFS", needsValue: false },
		min: { label: "Minimum", fn: "MINIFS", needsValue: true },
		max: { label: "Maximum", fn: "MAXIFS", needsValue: true }
	};
	var CHART_TYPES = { bar: "bar", column: "bar", horizontalbar: "horizontalBar", line: "line", pie: "pie", scatter: "scatter" };
	var PERIODS = {
		month: { label: "Month", format: "mmm yyyy", end: "EDATE($C{row},1)" },
		year: { label: "Year", format: "yyyy", end: "DATE(YEAR($C{row})+1,1,1)" }
	};
	var MAX_VISUAL_CHARTS = 5;
	var MAX_VISUAL_GROUPS = 15;
	var DAY_MS = 86400000;
	var UNIX_EPOCH_SERIAL = 25569; // spreadsheet serial number of 1970-01-01

	function columnLetter(index) {
		var letters = "";
		for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
			letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
		return letters;
	}

	function columnIndex(letters) {
		var index = 0;
		for (var i = 0; i < letters.length; i++)
			index = index * 26 + letters.charCodeAt(i) - 64;
		return index - 1;
	}

	function quoteSheet(name) {
		return "'" + String(name).replace(/'/g, "''") + "'";
	}

	// The editor returns cell values as text; numbers are converted back here.
	function toNumber(v) {
		if (typeof v === "number")
			return v;
		var text = String(v === null || v === undefined ? "" : v).trim();
		return (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/).test(text) ? Number(text) : null;
	}

	function valueType(values) {
		var numbers = 0, filled = 0;
		values.forEach(function (v) {
			if (v === "" || v === null || v === undefined)
				return;
			filled++;
			if (toNumber(v) !== null)
				numbers++;
		});
		if (!filled)
			return "empty";
		return numbers === filled ? "number" : "text";
	}

	// Dates are stored as serial numbers; the cell's number format tells them apart.
	// Quoted text and [..] sections (colours, currencies) are ignored.
	function isDateFormat(format) {
		return (/[dy]/i).test(String(format || "").replace(/"[^"]*"|\[[^\]]*\]/g, ""));
	}

	function serialToDate(serial) {
		return new Date((serial - UNIX_EPOCH_SERIAL) * DAY_MS);
	}

	function dateToSerial(date) {
		return date.getTime() / DAY_MS + UNIX_EPOCH_SERIAL;
	}

	function isoDate(serial) {
		return serialToDate(Math.floor(serial)).toISOString().slice(0, 10);
	}

	function periodStart(serial, period) {
		var d = serialToDate(Math.floor(serial));
		return dateToSerial(new Date(Date.UTC(d.getUTCFullYear(), period === "year" ? 0 : d.getUTCMonth(), 1)));
	}

	function isBlank(v) {
		return v === "" || v === null || v === undefined;
	}

	// Finds the table in the sheet's used range: the header is the first row
	// with at least two filled cells (titles above it are skipped), the columns
	// run until the first empty header cell, and the rows until the first empty
	// row. Answers written beside or below the table are therefore not part of it.
	function findTable(values) {
		var headerIndex = 0;
		for (var r = 0; r < values.length; r++) {
			if (values[r].filter(function (v) { return !isBlank(v); }).length >= 2) {
				headerIndex = r;
				break;
			}
		}
		var header = values[headerIndex] || [];
		var start = 0;
		while (start < header.length && isBlank(header[start]))
			start++;
		var end = start;
		while (end < header.length && !isBlank(header[end]))
			end++;
		var rows = [];
		for (r = headerIndex + 1; r < values.length; r++) {
			var row = values[r].slice(start, end);
			if (row.every(isBlank))
				break;
			rows.push(row);
		}
		return { headerIndex: headerIndex, start: start, header: header.slice(start, end), rows: rows };
	}

	// sheet = {name, firstRow, firstCol, values, formats | formatRows}: firstRow and
	// firstCol (1-based) locate values[0][0], the corner of the used range.
	// formatRows holds the number formats of the used range's first rows;
	// formats (tests) gives those of the table's first data row directly.
	function describeTable(sheet) {
		var found = findTable(sheet.values || []);
		var header = found.header;
		var rows = found.rows;
		var formats = sheet.formats ||
			((sheet.formatRows || [])[found.headerIndex + 1] || []).slice(found.start, found.start + header.length);
		sheet = {
			name: sheet.name,
			firstRow: sheet.firstRow + found.headerIndex,
			firstCol: sheet.firstCol + found.start
		};
		var columns = header.map(function (name, i) {
			var column = rows.map(function (row) { return row[i]; });
			var type = valueType(column);
			if (type === "number" && isDateFormat(formats[i]))
				type = "date";
			if (type === "number" || type === "date") {
				rows.forEach(function (row) {
					if (row[i] !== "" && row[i] !== null && row[i] !== undefined)
						row[i] = toNumber(row[i]);
				});
			}
			return {
				name: String(name).trim(),
				letter: columnLetter(sheet.firstCol - 1 + i),
				type: type
			};
		});
		var firstDataRow = sheet.firstRow + 1;
		return {
			sheetName: sheet.name,
			firstRow: sheet.firstRow,
			firstCol: sheet.firstCol,
			columns: columns,
			rowCount: rows.length,
			firstDataRow: firstDataRow,
			lastDataRow: firstDataRow + rows.length - 1,
			rows: rows,
			sample: rows.slice(0, SAMPLE_ROWS)
		};
	}

	function columnRange(table, column) {
		return quoteSheet(table.sheetName) + "!$" + column.letter + "$" + table.firstDataRow +
			":$" + column.letter + "$" + table.lastDataRow;
	}

	var SYSTEM_PROMPT = [
		"You help people work with spreadsheets. You never calculate numbers yourself:",
		"you choose what to calculate, and the spreadsheet does the maths.",
		"Reply with one JSON object only, in one of these shapes:",
		'{"type":"calculation","aggregation":"sum|average|count|min|max|median|share","answerColumn":"<only for which-questions: the column to show>","value":"<column name, or empty for count>","filters":[{"column":"<column name>","operator":"=|<>|>|>=|<|<=","value":"<text, number, or date as yyyy-mm-dd>"}],"label":"<2 to 5 words naming the result>","explanation":"<one sentence>"}',
		'{"type":"summary","groupBy":"<column name>","value":"<column name, or empty for count>","aggregation":"sum|average|count|min|max","period":"month|year|none","chart":"bar|horizontalBar|pie|line|none","title":"<short title>","explanation":"<one sentence>"}',
		'{"type":"formula","formula":"=<spreadsheet formula>","label":"<2 to 5 words naming the result>","explanation":"<one sentence>"}',
		'{"type":"unsupported","explanation":"<why the data cannot answer this>"}',
		"Rules:",
		"- Use \"calculation\" for one number: a total, average, count, smallest or largest value, with optional filters such as Branch = Lusaka. filters may be [].",
		"- For \"which ... made the largest/smallest single sale\", use max or min with value the number column and answerColumn the column to show, such as Branch. Otherwise leave answerColumn empty.",
		"- For \"which branch sold the most\" (totals per group), use \"summary\" for that group.",
		"- Filters only repeat conditions the question states. Never filter on the answer you expect.",
		"- For a percentage or share, such as \"what percent of sales is from Lusaka\", use aggregation share: the filtered rows' total (or count, without value) divided by all rows'.",
		"- Use \"summary\" for one number per group, such as \"sales by branch\" or \"orders per month\".",
		"- Use \"formula\" only when neither fits, such as a lookup or a ratio. Use English function names, commas between arguments, and absolute ranges over the data rows given below, such as $C$2:$C$40.",
		"- Write column names exactly as listed, such as \"Branch\".",
		"- To group a date column, set period to month or year; otherwise set period to none.",
		"- Choose pie only for shares of a total, line only for a date column grouped by period.",
		"- If the sheet does not contain the data needed, reply with \"unsupported\". Never invent data."
	].join("\n");

	function describeForModel(table) {
		var lines = [
			"Sheet: " + table.sheetName,
			"Data rows: " + table.firstDataRow + " to " + table.lastDataRow + " (" + table.rowCount + " rows)",
			"Columns:"
		];
		table.columns.forEach(function (c, i) {
			var type = c.type;
			if (type === "date") {
				var dates = table.rows.map(function (row) { return row[i]; }).filter(function (v) { return typeof v === "number"; });
				type += ", from " + isoDate(Math.min.apply(null, dates)) + " to " + isoDate(Math.max.apply(null, dates));
			}
			lines.push("- " + c.letter + ": \"" + c.name + "\" (" + type + ")");
		});
		lines.push("First rows:");
		table.sample.forEach(function (row) {
			lines.push(JSON.stringify(row));
		});
		return lines;
	}

	function buildMessages(question, table, selection) {
		var lines = describeForModel(table);
		if (selection)
			lines.push("Selected cell: " + selection);
		lines.push("", "Question: " + question);
		return [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: lines.join("\n") }
		];
	}

	// Accepts a column name, a column letter, or both ("C: Product"), as models
	// mix them up. Anything that does not match a real column is rejected.
	function findColumn(table, name) {
		var wanted = String(name || "").trim().replace(/^["']|["']$/g, "");
		var lettered = (/^([A-Za-z]{1,3})\s*[:\-]\s*(.+)$/).exec(wanted);
		var byName = function (n) {
			return table.columns.filter(function (c) { return c.name.toLowerCase() === n.toLowerCase(); })[0] || null;
		};
		var byLetter = function (l) {
			return table.columns.filter(function (c) { return c.letter === l.toUpperCase(); })[0] || null;
		};
		var column = byName(wanted);
		if (!column && lettered) {
			column = byLetter(lettered[1]);
			if (column && column.name.toLowerCase() !== lettered[2].trim().replace(/^["']|["']$/g, "").toLowerCase())
				column = null;
		}
		return column || ((/^[A-Za-z]{1,3}$/).test(wanted) ? byLetter(wanted) : null);
	}

	function fail(message) {
		return { ok: false, error: message };
	}

	// Where a single answer goes: the selected cell when it is clear of the
	// table (not in it and not touching it, so it never joins the table), else
	// the first free row of a label/value pair of columns right of the table,
	// leaving one empty column between. The editor checks which cells are empty.
	function answerPlace(table, selection) {
		var lastCol = table.firstCol - 1 + table.columns.length - 1; // 0-based
		var place = { preferred: "", col: lastCol + 2, startRow: table.firstRow };
		var match = (/^([A-Z]{1,3})(\d{1,7})$/).exec(String(selection || "").toUpperCase().replace(/\$/g, ""));
		if (match) {
			var col = columnIndex(match[1]), row = parseInt(match[2], 10);
			var touching = row >= table.firstRow && row <= table.lastDataRow + 1 &&
				col >= table.firstCol - 1 && col <= lastCol + 1;
			if (!touching)
				place.preferred = match[1] + match[2];
		}
		return place;
	}

	// A label is written into a cell as text, so it must not look like a formula.
	function cleanLabel(label, fallback) {
		var text = String(label || "").replace(/^[=+\-@\s]+/, "").trim().slice(0, 60);
		return text || fallback;
	}

	function mentions(question, value) {
		return question === undefined || String(question).toLowerCase().indexOf(String(value).toLowerCase()) >= 0;
	}

	// A value from the sheet that the plan relies on but the question never
	// names is a guess at the answer, such as filtering on "Lusaka" to answer
	// "which branch sold most".
	function guessedValue(table, question, texts) {
		for (var i = 0; i < table.columns.length; i++) {
			var column = table.columns[i];
			if (column.type !== "text")
				continue;
			var values = uniqueValues(table, column).map(String);
			for (var j = 0; j < texts.length; j++) {
				var hit = values.filter(function (v) { return v.toLowerCase() === String(texts[j]).toLowerCase(); })[0];
				if (hit !== undefined && !mentions(question, hit))
					return { column: column, value: hit };
			}
		}
		return null;
	}

	function checkFormula(plan, table, question) {
		var formula = String(plan.formula || "").trim();
		if (!formula)
			return fail("The assistant did not return a formula.");
		if (formula[0] !== "=")
			formula = "=" + formula;
		var literals = [], literal = /"((?:[^"]|"")*)"/g, m;
		while ((m = literal.exec(formula)))
			literals.push(m[1].replace(/""/g, "\""));
		var guess = guessedValue(table, question, literals);
		if (guess)
			return fail("The formula assumes " + guess.column.name + " \"" + guess.value + "\", which the question does not mention. Let the formula find it.");
		return {
			ok: true,
			plan: { type: "formula", formula: formula, label: cleanLabel(plan.label, "Answer"), explanation: plan.explanation || "" }
		};
	}

	var CALCULATIONS = {
		sum: { label: "Total", plain: "SUM", filtered: "SUMIFS", needsValue: true },
		average: { label: "Average", plain: "AVERAGE", filtered: "AVERAGEIFS", needsValue: true },
		count: { label: "Count", plain: "COUNTA", filtered: "COUNTIFS", needsValue: false },
		min: { label: "Smallest", plain: "MIN", filtered: "MINIFS", needsValue: true },
		max: { label: "Largest", plain: "MAX", filtered: "MAXIFS", needsValue: true },
		median: { label: "Median", plain: "MEDIAN", filtered: null, needsValue: true },
		share: { label: "Share", needsValue: false },
		which_max: { label: "Largest", needsValue: true, which: "MAX" },
		which_min: { label: "Smallest", needsValue: true, which: "MIN" }
	};
	var OPERATORS = ["=", "<>", ">", ">=", "<", "<="];

	function textLiteral(text) {
		return "\"" + String(text).replace(/"/g, "\"\"") + "\"";
	}

	// The criteria argument of SUMIFS and friends for one filter, or an error.
	function criteria(table, filter, question) {
		var column = findColumn(table, filter.column);
		if (!column)
			return { error: "The sheet has no column called \"" + filter.column + "\"." };
		var operator = String(filter.operator || "=").trim();
		if (OPERATORS.indexOf(operator) < 0)
			return { error: "Unknown comparison \"" + filter.operator + "\"." };
		var raw = filter.value;
		if (column.type === "date") {
			var date = (/^(\d{4})-(\d{1,2})-(\d{1,2})$/).exec(String(raw).trim());
			if (!date)
				return { error: "Column \"" + column.name + "\" holds dates; \"" + raw + "\" is not a date." };
			return { column: column, text: textLiteral(operator) + "&DATE(" + date[1] + "," + Number(date[2]) + "," + Number(date[3]) + ")" };
		}
		if (column.type === "number") {
			var number = toNumber(raw);
			if (number === null)
				return { error: "Column \"" + column.name + "\" holds numbers; \"" + raw + "\" is not a number." };
			return { column: column, text: textLiteral(operator + number) };
		}
		var wanted = String(raw === null || raw === undefined ? "" : raw).trim();
		if (operator === "=" || operator === "<>") {
			// Match a real value, ignoring case, so a typo is reported instead of counting nothing.
			var values = uniqueValues(table, column).map(String);
			var match = values.filter(function (v) { return v.toLowerCase() === wanted.toLowerCase(); })[0];
			if (match === undefined)
				return { error: "Column \"" + column.name + "\" has no value \"" + wanted + "\". It has: " +
					values.slice(0, 8).join(", ") + (values.length > 8 ? ", …" : "") + "." };
			wanted = match;
			if (!mentions(question, wanted))
				return { error: "The filter " + column.name + " = \"" + wanted + "\" is not in the question. Use only conditions the question states." };
		}
		return { column: column, text: textLiteral((operator === "=" ? "" : operator) + wanted) };
	}

	// The text column a "which/what/who <column> ..." question asks for, or "".
	function askedColumn(table, question) {
		var asked = (/\b(?:which|what|who)\s+([a-z][\w ]*)/i).exec(String(question || ""));
		if (!asked)
			return "";
		var words = asked[1].toLowerCase();
		var column = table.columns.filter(function (c) {
			var name = c.name.toLowerCase();
			return c.type === "text" && (words.indexOf(name) === 0 || words.indexOf(name.replace(/s$/, "")) === 0);
		})[0];
		return column ? column.name : "";
	}

	function checkCalculation(plan, table, question) {
		var calc = CALCULATIONS[String(plan.aggregation || "").toLowerCase()];
		if (!calc)
			return fail("Unknown calculation \"" + plan.aggregation + "\".");
		// max or min with a column to show asks which row holds that value; a
		// question such as "which branch ..." names that column itself.
		if (calc === CALCULATIONS.max || calc === CALCULATIONS.min) {
			if (!String(plan.answerColumn || "").trim())
				plan.answerColumn = askedColumn(table, question);
			if (plan.answerColumn)
				calc = calc === CALCULATIONS.max ? CALCULATIONS.which_max : CALCULATIONS.which_min;
		}
		var value = null;
		if (calc.needsValue || (calc === CALCULATIONS.share && String(plan.value || "").trim())) {
			value = findColumn(table, plan.value);
			if (!value)
				return fail("The sheet has no column called \"" + plan.value + "\".");
			if (value.type !== "number")
				return fail("Column \"" + value.name + "\" does not contain numbers.");
		}
		var filters = Array.isArray(plan.filters) ? plan.filters.filter(Boolean) : [];
		var answer = calc.which ? findColumn(table, plan.answerColumn) : null;
		if (calc.which && !answer)
			return fail("The sheet has no column called \"" + plan.answerColumn + "\".");
		if (answer) {
			// "Which branch ..." filtered on Branch can only be a guess at the answer.
			filters = filters.filter(function (f) {
				return findColumn(table, f.column) !== answer;
			});
		}
		var parts = [];
		for (var i = 0; i < filters.length; i++) {
			var c = criteria(table, filters[i], question);
			if (c.error)
				return fail(c.error);
			parts.push(columnRange(table, c.column) + "," + c.text);
		}
		var formula, numberFormat = "";
		if (calc.which) {
			if (parts.length)
				return fail("Finding the row with the " + (calc.which === "MAX" ? "largest" : "smallest") + " value does not support filters yet.");
			// The row holding the largest (smallest) value; the first one on a tie.
			formula = "=INDEX(" + columnRange(table, answer) + ",MATCH(" + calc.which + "(" + columnRange(table, value) + ")," +
				columnRange(table, value) + ",0))";
		} else if (calc === CALCULATIONS.share) {
			if (!parts.length)
				return fail("A share needs a filter, such as Branch = Lusaka.");
			formula = value ?
				"=SUMIFS(" + columnRange(table, value) + "," + parts.join(",") + ")/SUM(" + columnRange(table, value) + ")" :
				"=COUNTIFS(" + parts.join(",") + ")/COUNTA(" + columnRange(table, table.columns[0]) + ")";
			numberFormat = "0.0%";
		} else if (!parts.length)
			formula = "=" + calc.plain + "(" + columnRange(table, value || table.columns[0]) + ")";
		else if (calc.filtered)
			formula = "=" + calc.filtered + "(" + (value ? columnRange(table, value) + "," : "") + parts.join(",") + ")";
		else
			return fail("A median with filters is not supported yet. Try an average instead.");
		return {
			ok: true,
			plan: {
				type: "formula",
				formula: formula,
				numberFormat: numberFormat,
				label: cleanLabel(plan.label, calc.label + (value ? " " + value.name : " of rows")),
				explanation: plan.explanation || "",
				built: true
			}
		};
	}

	function uniqueValues(table, column) {
		var index = table.columns.indexOf(column);
		var seen = {}, groups = [];
		table.rows.forEach(function (row) {
			var v = row[index];
			if (v === "" || v === null || v === undefined)
				return;
			var key = typeof v + ":" + v;
			if (!seen[key]) {
				seen[key] = true;
				groups.push(v);
			}
		});
		return groups;
	}

	function checkSummary(plan, table) {
		var aggregation = AGGREGATIONS[String(plan.aggregation || "").toLowerCase()];
		if (!aggregation)
			return fail("Unknown aggregation \"" + plan.aggregation + "\".");
		var group = findColumn(table, plan.groupBy);
		if (!group)
			return fail("The sheet has no column called \"" + plan.groupBy + "\".");
		var value = null;
		if (aggregation.needsValue) {
			value = findColumn(table, plan.value);
			if (!value)
				return fail("The sheet has no column called \"" + plan.value + "\".");
			if (value.type !== "number")
				return fail("Column \"" + value.name + "\" does not contain numbers.");
		}
		var period = null;
		if (group.type === "date")
			period = PERIODS[String(plan.period || "").toLowerCase()] ? String(plan.period).toLowerCase() : "month";
		var groups = uniqueValues(table, group);
		if (period) {
			var starts = function (p) {
				return groups.map(function (v) { return periodStart(v, p); })
					.filter(function (v, i, all) { return all.indexOf(v) === i; })
					.sort(function (a, b) { return a - b; });
			};
			// A trend needs a few points but not hundreds: switch period when the data says so.
			if (period === "year" && starts("year").length < 2)
				period = "month";
			else if (period === "month" && starts("month").length > 36)
				period = "year";
			groups = starts(period);
		}
		if (!groups.length)
			return fail("Column \"" + group.name + "\" is empty.");
		var chart = CHART_TYPES[String(plan.chart || "").toLowerCase()] || null;
		if (chart === "line" && !period)
			chart = "bar";
		return {
			ok: true,
			plan: {
				type: "summary",
				aggregation: String(plan.aggregation).toLowerCase(),
				groupBy: group,
				value: value,
				period: period,
				groupFormat: period ? PERIODS[period].format : null,
				groups: groups,
				chart: chart,
				title: plan.title || (aggregation.label + (value ? " " + value.name : "") + " by " + group.name),
				explanation: plan.explanation || ""
			}
		};
	}

	// Cells for the summary sheet: a header row, then one row per group whose
	// value is a formula over the source data, so every number can be checked.
	// Periods get a third column with the period start; column A shows it as
	// text so charts use it as a label rather than as a second series.
	// firstRow is the sheet row of the header (default 1).
	function summaryCells(plan, table, firstRow) {
		firstRow = firstRow || 1;
		var aggregation = AGGREGATIONS[plan.aggregation];
		var groupRange = columnRange(table, plan.groupBy);
		var period = plan.period && PERIODS[plan.period];
		var valueHeader = aggregation.label + (plan.value ? " " + plan.value.name : "");
		var cells = [period ? [period.label, valueHeader, period.label + " start"] : [plan.groupBy.name, valueHeader]];
		plan.groups.forEach(function (groupValue, i) {
			var row = firstRow + i + 1;
			var criteria = period ?
				groupRange + ",\">=\"&$C" + row + "," + groupRange + ",\"<\"&" + period.end.replace("{row}", row) :
				groupRange + ",$A" + row;
			var formula = "=" + aggregation.fn + "(" + (aggregation.needsValue ? columnRange(table, plan.value) + "," : "") + criteria + ")";
			cells.push(period ? ["=TEXT($C" + row + ",\"" + period.format + "\")", formula, groupValue] : [groupValue, formula]);
		});
		return cells;
	}

	var VISUAL_PROMPT = [
		"You plan a visual summary of a spreadsheet: the 3 to 5 charts that best tell its story,",
		"such as trends over time, comparisons between groups, shares of a total and outliers.",
		"You never calculate numbers; the spreadsheet does the maths.",
		"Reply with one JSON object only:",
		'{"charts":[{"groupBy":"<column name>","value":"<column name, or empty for count>","aggregation":"sum|average|count|min|max","period":"month|year|none","chart":"bar|horizontalBar|pie|line","title":"<short title>","why":"<one sentence on what the chart shows>"}]}',
		"Rules:",
		"- Write column names only, such as \"Branch\". Use value columns of type number.",
		"- Group a date column by month or year and show it as a line. Otherwise set period to none.",
		"- Use pie only for shares of a total with few groups. Do not repeat the same chart.",
		"- If the sheet has no numbers worth charting, reply {\"charts\":[],\"explanation\":\"<why>\"}."
	].join("\n");

	function canSummarize(table) {
		return table.rowCount > 0 && table.columns.some(function (c) { return c.type === "number"; });
	}

	function buildVisualMessages(table) {
		return [
			{ role: "system", content: VISUAL_PROMPT },
			{ role: "user", content: describeForModel(table).join("\n") }
		];
	}

	// Keeps the charts that pass the same checks as a single summary.
	function checkVisualSummary(reply, table) {
		var answer = parseReply(reply);
		if (!answer || !Array.isArray(answer.charts))
			return fail("The assistant's answer could not be read. Try again.");
		var charts = [], skipped = [], seen = {};
		answer.charts.forEach(function (item) {
			if (charts.length >= MAX_VISUAL_CHARTS || !item)
				return;
			var checked = checkSummary(item, table);
			if (!checked.ok) {
				skipped.push(checked.error);
				return;
			}
			var p = checked.plan;
			var key = [p.groupBy.name, p.value && p.value.name, p.aggregation, p.period].join("|");
			if (seen[key])
				return;
			if (!p.period && p.groups.length > MAX_VISUAL_GROUPS) {
				skipped.push("Column \"" + p.groupBy.name + "\" has too many different values for a chart.");
				return;
			}
			seen[key] = true;
			p.chart = p.chart || (p.period ? "line" : "bar");
			p.explanation = item.why || p.explanation;
			charts.push(p);
		});
		if (!charts.length)
			return fail(answer.explanation || skipped[0] || "The assistant found nothing in this sheet worth charting.");
		return { ok: true, plan: { type: "visual", charts: charts, skipped: skipped } };
	}

	function formatNumber(n) {
		return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
	}

	function percentChange(from, to) {
		return Math.round((to - from) / Math.abs(from) * 100);
	}

	function changeText(change) {
		return (change >= 0 ? "up " : "down ") + Math.abs(change) + "%";
	}

	// One factual sentence per chart, built only from the calculated values:
	// labels are the displayed group names, values the numbers the sheet computed.
	function describeFacts(plan, labels, values) {
		var points = labels.map(function (label, i) { return { label: label, value: toNumber(values[i]) }; })
			.filter(function (pt) { return pt.value !== null && isFinite(pt.value); });
		if (!points.length)
			return { text: "", flag: false };
		if (plan.period) {
			var last = points[points.length - 1];
			if (points.length < 2)
				return { text: last.label + ": " + formatNumber(last.value) + ".", flag: false };
			var prev = points[points.length - 2];
			var parts = [last.label + ": " + formatNumber(last.value) +
				(prev.value !== 0 ? ", " + changeText(percentChange(prev.value, last.value)) + " from " + prev.label : "") + "."];
			var biggest = null;
			for (var i = 1; i < points.length; i++) {
				if (points[i - 1].value === 0)
					continue;
				var c = percentChange(points[i - 1].value, points[i].value);
				if (!biggest || Math.abs(c) > Math.abs(biggest.change))
					biggest = { label: points[i].label, change: c };
			}
			var flag = !!biggest && Math.abs(biggest.change) >= 25;
			if (flag)
				parts.push("Biggest change: " + biggest.label + ", " + changeText(biggest.change) + ".");
			return { text: parts.join(" "), flag: flag };
		}
		var sorted = points.slice().sort(function (a, b) { return b.value - a.value; });
		var total = points.reduce(function (sum, pt) { return sum + pt.value; }, 0);
		var showShare = (plan.aggregation === "sum" || plan.aggregation === "count") && total > 0 &&
			points.every(function (pt) { return pt.value >= 0; });
		var top = sorted[0], bottom = sorted[sorted.length - 1];
		var text = "Highest: " + top.label + " (" + formatNumber(top.value) +
			(showShare ? ", " + Math.round(top.value / total * 100) + "% of the total" : "") + ").";
		if (sorted.length > 1)
			text += " Lowest: " + bottom.label + " (" + formatNumber(bottom.value) + ").";
		return { text: text, flag: false };
	}

	// Asks the model once more after its answer failed a check or its formula
	// gave an error in the sheet.
	function buildRepairMessages(messages, reply, problem) {
		return messages.concat([
			{ role: "assistant", content: String(reply) },
			{ role: "user", content: "That answer could not be used: " + problem +
				" Reply with a corrected JSON object. Prefer \"calculation\" if it can answer the question." }
		]);
	}

	function parseReply(text) {
		var body = String(text || "").trim();
		var start = body.indexOf("{"), end = body.lastIndexOf("}");
		if (start < 0 || end < start)
			return null;
		try {
			return JSON.parse(body.slice(start, end + 1));
		} catch (e) {
			return null;
		}
	}

	// question, when given, is used to catch plans that guess the answer.
	function checkPlan(reply, table, question) {
		var plan = parseReply(reply);
		if (!plan || typeof plan !== "object")
			return fail("The assistant's answer could not be read. Try asking again.");
		switch (plan.type) {
			case "calculation":
				return checkCalculation(plan, table, question);
			case "formula":
				return checkFormula(plan, table, question);
			case "summary":
				return checkSummary(plan, table);
			case "unsupported":
				return { ok: true, plan: { type: "unsupported", explanation: plan.explanation || "This sheet does not have the data for that question." } };
		}
		return fail("The assistant returned an unknown answer type.");
	}

	exports.columnLetter = columnLetter;
	exports.describeTable = describeTable;
	exports.buildMessages = buildMessages;
	exports.buildRepairMessages = buildRepairMessages;
	exports.answerPlace = answerPlace;
	exports.checkPlan = checkPlan;
	exports.summaryCells = summaryCells;
	exports.canSummarize = canSummarize;
	exports.buildVisualMessages = buildVisualMessages;
	exports.checkVisualSummary = checkVisualSummary;
	exports.describeFacts = describeFacts;
})(typeof module !== "undefined" ? module.exports : (window.PersonalOfficeAI = window.PersonalOfficeAI || {}).plan = {});
