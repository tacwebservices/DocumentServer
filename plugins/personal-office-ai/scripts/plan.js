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

	function valueType(values) {
		var numbers = 0, filled = 0;
		values.forEach(function (v) {
			if (v === "" || v === null || v === undefined)
				return;
			filled++;
			if (typeof v === "number" || (/^-?\d+(\.\d+)?$/).test(String(v).trim()))
				numbers++;
		});
		if (!filled)
			return "empty";
		return numbers === filled ? "number" : "text";
	}

	// sheet = {name, firstRow, firstCol, values} where firstRow/firstCol are 1-based
	// and values[0] is the header row.
	function describeTable(sheet) {
		var values = sheet.values || [];
		var header = values[0] || [];
		var rows = values.slice(1).filter(function (row) {
			return row.some(function (v) { return v !== "" && v !== null && v !== undefined; });
		});
		var columns = header.map(function (name, i) {
			var column = rows.map(function (row) { return row[i]; });
			return {
				name: String(name).trim(),
				letter: columnLetter(sheet.firstCol - 1 + i),
				type: valueType(column)
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
		"you choose formulas or a summary, and the spreadsheet does the maths.",
		"Reply with one JSON object only, in one of these shapes:",
		'{"type":"formula","cell":"<an empty cell outside the table, or empty>","formula":"=<spreadsheet formula>","explanation":"<one sentence>"}',
		'{"type":"summary","groupBy":"<column name in quotes from the list>","value":"<column name, or empty for count>","aggregation":"sum|average|count|min|max","chart":"bar|horizontalBar|pie|line|none","title":"<short title>","explanation":"<one sentence>"}',
		'{"type":"unsupported","explanation":"<why the data cannot answer this>"}',
		"Rules:",
		"- In groupBy and value, write the column name only, such as \"Branch\". In formulas, use the column letters and row numbers.",
		"- Use \"summary\" for questions like \"sales by branch\" or \"count of orders per region\".",
		"- Use \"formula\" for a single result, such as a total, an average or a lookup.",
		"- Choose pie only for shares of a total, line only when the group column is ordered in time.",
		"- If the sheet does not contain the data needed, reply with \"unsupported\". Never invent data."
	].join("\n");

	function buildMessages(question, table, selection) {
		var lines = [
			"Sheet: " + table.sheetName,
			"Data rows: " + table.firstDataRow + " to " + table.lastDataRow + " (" + table.rowCount + " rows)",
			"Columns:"
		];
		table.columns.forEach(function (c) {
			lines.push("- " + c.letter + ": \"" + c.name + "\" (" + c.type + ")");
		});
		lines.push("First rows:");
		table.sample.forEach(function (row) {
			lines.push(JSON.stringify(row));
		});
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

	// The first cell right of the table, leaving one empty column.
	function freeCell(table) {
		return columnLetter(table.firstCol - 1 + table.columns.length + 1) + table.firstDataRow;
	}

	function insideTable(table, cell) {
		var match = (/^([A-Z]{1,3})(\d+)$/).exec(cell);
		var col = columnIndex(match[1]), row = parseInt(match[2], 10);
		return row >= table.firstRow && row <= table.lastDataRow &&
			col >= table.firstCol - 1 && col < table.firstCol - 1 + table.columns.length;
	}

	function checkFormula(plan, table) {
		var formula = String(plan.formula || "").trim();
		if (!formula)
			return fail("The assistant did not return a formula.");
		if (formula[0] !== "=")
			formula = "=" + formula;
		var cell = String(plan.cell || "").trim().toUpperCase().replace(/\$/g, "");
		if (!(/^[A-Z]{1,3}\d{1,7}$/).test(cell) || insideTable(table, cell))
			cell = freeCell(table);
		return {
			ok: true,
			plan: { type: "formula", formula: formula, cell: cell, explanation: plan.explanation || "" }
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
		var groups = uniqueValues(table, group);
		if (!groups.length)
			return fail("Column \"" + group.name + "\" is empty.");
		var chart = CHART_TYPES[String(plan.chart || "").toLowerCase()] || null;
		return {
			ok: true,
			plan: {
				type: "summary",
				aggregation: String(plan.aggregation).toLowerCase(),
				groupBy: group,
				value: value,
				groups: groups,
				chart: chart,
				title: plan.title || (aggregation.label + (value ? " " + value.name : "") + " by " + group.name),
				explanation: plan.explanation || ""
			}
		};
	}

	// Cells for the summary sheet: a header row, then one row per group whose
	// value is a formula over the source data, so every number can be checked.
	function summaryCells(plan, table) {
		var aggregation = AGGREGATIONS[plan.aggregation];
		var groupRange = columnRange(table, plan.groupBy);
		var header = [plan.groupBy.name, aggregation.label + (plan.value ? " " + plan.value.name : "")];
		var cells = [header];
		plan.groups.forEach(function (groupValue, i) {
			var criteria = "$A" + (i + 2);
			var formula = aggregation.needsValue ?
				"=" + aggregation.fn + "(" + columnRange(table, plan.value) + "," + groupRange + "," + criteria + ")" :
				"=" + aggregation.fn + "(" + groupRange + "," + criteria + ")";
			cells.push([groupValue, formula]);
		});
		return cells;
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

	function checkPlan(reply, table) {
		var plan = parseReply(reply);
		if (!plan || typeof plan !== "object")
			return fail("The assistant's answer could not be read. Try asking again.");
		switch (plan.type) {
			case "formula":
				return checkFormula(plan, table);
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
	exports.checkPlan = checkPlan;
	exports.summaryCells = summaryCells;
})(typeof module !== "undefined" ? module.exports : (window.PersonalOfficeAI = window.PersonalOfficeAI || {}).plan = {});
