/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * "Ask in plain words" panel for the spreadsheet editor.
 */
(function (window) {
	"use strict";

	var plan = window.PersonalOfficeAI.plan;
	var client = window.PersonalOfficeAI.client;
	var current = null; // {plan, table, sheet, request, reply, undo}
	var CHART_ROWS = 19; // rows a chart block needs next to its table
	var EDITOR_CHART_TYPES = { line: "lineNormalMarker" }; // names the editor's AddChart expects

	function $(id) {
		return document.getElementById(id);
	}

	function callCommand(fn, scope) {
		window.Asc.scope = scope || {};
		return new Promise(function (resolve, reject) {
			window.Asc.plugin.callCommand(fn, false, true, function (result) {
				if (result === undefined)
					reject(new Error("The editor did not finish the change. Please try again."));
				else
					resolve(result);
			});
		});
	}

	function setStatus(text, kind) {
		var status = $("status");
		status.textContent = text || "";
		status.className = "status" + (kind ? " " + kind : "");
	}

	function setBusy(busy) {
		$("ask").disabled = busy;
		$("visual").disabled = busy;
		$("question").disabled = busy;
	}

	/* The functions passed to callCommand run inside the editor, not here,
	 * so they can only use Api and Asc.scope. */

	function readSheet() {
		var sheet = Api.GetActiveSheet();
		var used = sheet.GetUsedRange();
		var values = used.GetValue2();
		if (!Array.isArray(values))
			values = [[values]];
		var firstRow = used.GetRow(), firstCol = used.GetCol();
		// Number formats of the first rows tell dates apart; the table's header
		// row is found later, so the formats of the rows below it are read too.
		var formatRows = values.slice(0, 8).map(function (row, r) {
			return row.map(function (v, c) {
				return sheet.GetRangeByNumber(firstRow - 1 + r, firstCol - 1 + c).GetNumberFormat();
			});
		});
		var selection = Api.GetSelection();
		return {
			name: sheet.GetName(),
			firstRow: firstRow,
			firstCol: firstCol,
			values: values,
			formatRows: formatRows,
			selection: selection ? selection.GetAddress(false, false) : ""
		};
	}

	// The editor recalculates after a command returns, so results are read
	// back in a separate command.

	// Asc.scope = {preferred, col, startRow, label, formula, numberFormat}: the formula goes in
	// the preferred cell when it is empty, else into the first row from startRow
	// where both the label cell (column col, 0-based) and the cell right of it are empty.
	function placeAnswer() {
		var s = Asc.scope, sheet = Api.GetActiveSheet();
		var isEmpty = function (range) {
			return range.GetFormula() === "" && range.GetText() === "";
		};
		var value = null, label = null;
		if (s.preferred) {
			var preferred = sheet.GetRange(s.preferred);
			if (preferred && isEmpty(preferred))
				value = preferred;
		}
		for (var row = s.startRow; !value && row < s.startRow + 1000; row++) {
			var l = sheet.GetRangeByNumber(row - 1, s.col), v = sheet.GetRangeByNumber(row - 1, s.col + 1);
			if (isEmpty(l) && isEmpty(v)) {
				label = l;
				value = v;
			}
		}
		if (!value)
			return { error: "No empty cell was found for the answer." };
		if (label) {
			label.SetValue(s.label);
			sheet.SetColumnWidth(s.col, 28);
			sheet.SetColumnWidth(s.col + 1, 16);
		}
		value.SetValue(s.formula);
		if (s.numberFormat)
			value.SetNumberFormat(s.numberFormat);
		value.Select();
		return { cell: value.GetAddress(false, false), label: label ? label.GetAddress(false, false) : "" };
	}

	// Calculated value and displayed text; error is the error code, if any.
	// The value is checked, not the text, as a narrow column shows "####".
	function readCells() {
		var sheet = Api.GetActiveSheet();
		return Asc.scope.cells.map(function (cell) {
			var range = sheet.GetRange(cell), value = range.GetValue2();
			var error = (/^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!)/).exec(String(value));
			return { value: value, text: range.GetText(), error: error ? error[0] : "" };
		});
	}

	function clearCells() {
		var sheet = Api.GetActiveSheet();
		Asc.scope.cells.forEach(function (cell) {
			sheet.GetRange(cell).SetValue("");
		});
		return true;
	}

	function deleteSheet() {
		var sheet = Api.GetSheet(Asc.scope.sheet);
		if (sheet)
			sheet.Delete();
		return true;
	}

	// Asc.scope = {name, notes: [{cell, text, bold, italic}], widths: [A, B],
	//   blocks: [{top, cells, chart, title, groupFormat}]}, where top is the
	//   sheet row of the table header. Charts go next to their table.
	function buildSheet() {
		var s = Asc.scope;
		var base = s.name.replace(/[\[\]:*?\/\\]/g, " ").slice(0, 28).trim() || "Summary";
		var name = base;
		for (var n = 2; Api.GetSheet(name); n++)
			name = base + " " + n;
		Api.AddSheet(name);
		var sheet = Api.GetSheet(name);
		var cm = 360000;
		var failedCharts = [];
		s.blocks.forEach(function (block) {
			for (var r = 0; r < block.cells.length; r++) {
				for (var c = 0; c < block.cells[r].length; c++)
					sheet.GetRangeByNumber(block.top - 1 + r, c).SetValue(block.cells[r][c]);
			}
			var last = block.top + block.cells.length - 1;
			sheet.GetRange("A" + block.top + ":C" + block.top).SetBold(true);
			if (block.groupFormat)
				sheet.GetRange("C" + (block.top + 1) + ":C" + last).SetNumberFormat(block.groupFormat);
			if (block.chart) {
				// Values from column B and labels set explicitly, so labels made by
				// formulas (period names) are not drawn as a second series.
				var prefix = "'" + name.replace(/'/g, "''") + "'!";
				try {
					var chart = sheet.AddChart(prefix + "$B$" + block.top + ":$B$" + last,
						false, block.chart, 2, 16 * cm, 9 * cm, 3, 0, block.top - 1, 0);
					chart.SetCatFormula(prefix + "$A$" + (block.top + 1) + ":$A$" + last);
					chart.SetTitle(block.title, 13, true);
				} catch (e) {
					failedCharts.push(block.title);
				}
			}
		});
		s.notes.forEach(function (note) {
			var range = sheet.GetRange(note.cell);
			range.SetValue(note.text);
			if (note.bold)
				range.SetBold(true);
			if (note.italic)
				range.SetItalic(true);
		});
		s.widths.forEach(function (width, column) {
			sheet.SetColumnWidth(column, width);
		});
		return { sheet: name, failedCharts: failedCharts };
	}

	// Labels and calculated values of each block, after recalculation.
	function readBlocks() {
		var sheet = Api.GetSheet(Asc.scope.sheet);
		return Asc.scope.blocks.map(function (block) {
			var labels = [], values = [], errors = [];
			for (var row = block.top + 1; row < block.top + block.rows; row++) {
				labels.push(sheet.GetRange("A" + row).GetText());
				var value = sheet.GetRange("B" + row).GetValue2();
				values.push(value);
				if ((/^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!)/).test(String(value)))
					errors.push("B" + row);
			}
			return { labels: labels, values: values, errors: errors };
		});
	}

	function writeFacts() {
		var sheet = Api.GetSheet(Asc.scope.sheet);
		Asc.scope.facts.forEach(function (fact) {
			var range = sheet.GetRange(fact.cell);
			range.SetValue(fact.text);
			if (fact.flag)
				range.SetFontColor(Api.CreateColorFromRGB(192, 0, 0));
		});
		return true;
	}

	/* Panel */

	function renderPlan() {
		var p = current.plan;
		$("result").hidden = false;
		$("explanation").textContent = p.explanation;
		$("formula-box").hidden = p.type !== "formula";
		$("summary-box").hidden = p.type !== "summary";
		$("visual-box").hidden = p.type !== "visual";

		if (p.type === "visual") {
			var charts = $("visual-charts");
			charts.textContent = "";
			p.charts.forEach(function (chart) {
				var item = document.createElement("li");
				var title = document.createElement("strong");
				title.textContent = chart.title + " (" + chart.chart + ")";
				item.appendChild(title);
				item.appendChild(document.createTextNode(chart.explanation ? ": " + chart.explanation : ""));
				charts.appendChild(item);
			});
			$("explanation").textContent = p.charts.length + " charts, each built from formulas over your data:";
		}

		if (p.type === "formula") {
			$("formula").textContent = p.formula;
		} else if (p.type === "summary") {
			var cells = plan.summaryCells(p, current.table);
			var list = $("summary-formulas");
			list.textContent = "";
			cells.slice(1, 6).forEach(function (row) {
				var item = document.createElement("li");
				item.textContent = row[0] + ": " + row[1];
				list.appendChild(item);
			});
			if (cells.length > 6) {
				var more = document.createElement("li");
				more.textContent = "… and " + (cells.length - 6) + " more";
				list.appendChild(more);
			}
			$("summary-title").textContent = p.title;
			$("summary-chart").textContent = p.chart ? "with a " + p.chart + " chart" : "without a chart";
		}
	}

	function think(messages) {
		var started = Date.now();
		var showTime = function () {
			var seconds = Math.round((Date.now() - started) / 1000);
			setStatus(seconds < 20 ? "Thinking…" : "Thinking… " + seconds + " s (on a laptop this can take a minute or two)");
		};
		showTime();
		var ticker = setInterval(showTime, 1000);
		return client.chat(client.loadSettings(), messages).finally(function () {
			clearInterval(ticker);
		});
	}

	// Reads the sheet, asks the model, checks its plan and carries it out.
	// makeRequest(table) returns {messages, check} or throws when there is nothing to ask.
	function run(makeRequest) {
		$("result").hidden = true;
		setBusy(true);
		setStatus("Reading the sheet…");
		callCommand(readSheet).then(function (sheet) {
			var table = plan.describeTable(sheet);
			if (table.columns.length < 1 || table.rowCount < 1)
				throw new Error("This sheet has no table to work with. Put column names in one row and data below.");
			var request = makeRequest(table, sheet);
			var askForPlan = function (messages, retries) {
				return think(messages).then(function (reply) {
					var checked = request.check(reply, table);
					if (checked.ok)
						return { checked: checked, reply: reply };
					if (!retries)
						throw new Error(checked.error);
					return askForPlan(plan.buildRepairMessages(messages, reply, checked.error), retries - 1);
				});
			};
			return askForPlan(request.messages, request.retries || 0).then(function (answer) {
				var checked = answer.checked, reply = answer.reply;
				current = { plan: checked.plan, table: table, sheet: sheet, request: request, reply: reply, undo: null };
				renderPlan();
				if (checked.plan.type === "unsupported") {
					setStatus("");
					return;
				}
				setStatus("Adding the answer…");
				return apply(current).then(function (message) {
					$("remove").hidden = !current.undo;
					setStatus(message, "ok");
				});
			});
		}).catch(function (error) {
			if (!window.PersonalOfficeAI.settingsPanel.offerModelDownload(error, setStatus))
				setStatus(error.message, "error");
		}).then(function () {
			setBusy(false);
		});
	}

	function ask() {
		var question = $("question").value.trim();
		if (!question)
			return;
		run(function (table, sheet) {
			return {
				messages: plan.buildMessages(question, table, sheet.selection),
				check: function (reply, t) {
					return plan.checkPlan(reply, t, question);
				},
				retries: 1
			};
		});
	}

	function visualSummary() {
		run(function (table) {
			if (!plan.canSummarize(table))
				throw new Error("This sheet has no numbers to chart, so there is no visual summary to make.");
			return { messages: plan.buildVisualMessages(table), check: plan.checkVisualSummary };
		});
	}

	function sourceNote(table) {
		return "Source: sheet " + table.sheetName + ", rows " + table.firstDataRow + " to " + table.lastDataRow +
			". Each value is a formula you can click to check.";
	}

	function columnWidths(blocks) {
		var widths = [10, 10, 10];
		blocks.forEach(function (block) {
			block.cells.forEach(function (row, i) {
				var label = block.groupFormat && i > 0 ? "Mmm 0000" : String(row[0]);
				widths[0] = Math.max(widths[0], Math.min(label.length + 2, 40));
			});
			block.cells[0].slice(1).forEach(function (header, i) {
				widths[i + 1] = Math.max(widths[i + 1], Math.min(String(header).length + 2, 40));
			});
		});
		return widths;
	}

	// Builds the sheet, then reads the calculated values back to check them
	// and, for a visual summary, to write one factual sentence per chart.
	function insertBlocks(name, blocks, notes, factRows) {
		var editorBlocks = blocks.map(function (b) {
			return { top: b.top, cells: b.cells, title: b.title, groupFormat: b.groupFormat, chart: EDITOR_CHART_TYPES[b.chart] || b.chart };
		});
		return callCommand(buildSheet, { name: name, blocks: editorBlocks, notes: notes, widths: columnWidths(blocks) }).then(function (res) {
			var shape = blocks.map(function (b) { return { top: b.top, rows: b.cells.length }; });
			return callCommand(readBlocks, { sheet: res.sheet, blocks: shape }).then(function (read) {
				var errors = [].concat.apply([], read.map(function (r) { return r.errors; }));
				if (errors.length)
					throw new Error("Some values could not be calculated (" + errors.join(", ") + "). Check sheet \"" + res.sheet + "\".");
				if (res.failedCharts.length)
					throw new Error("The table is in sheet \"" + res.sheet + "\", but the editor could not draw: " + res.failedCharts.join(", ") + ".");
				if (!factRows)
					return res.sheet;
				var facts = read.map(function (r, i) {
					var fact = plan.describeFacts(blocks[i].plan, r.labels, r.values);
					return { cell: "A" + factRows[i], text: (fact.flag ? "⚠ " : "") + fact.text, flag: fact.flag };
				});
				return callCommand(writeFacts, { sheet: res.sheet, facts: facts }).then(function () {
					return res.sheet;
				});
			});
		});
	}

	function insertSummary(p, table) {
		var blocks = [{ top: 1, cells: plan.summaryCells(p, table, 1), chart: p.chart, title: p.title, groupFormat: p.groupFormat }];
		var notes = [{ cell: "A" + (blocks[0].cells.length + 2), text: sourceNote(table), italic: true }];
		return insertBlocks(p.title, blocks, notes).then(function (sheet) {
			current.undo = { sheet: sheet };
			return "Added sheet \"" + sheet + "\".";
		});
	}

	// Layout per chart: title, why, facts, then the table with the chart beside it.
	function insertVisual(p, table) {
		var notes = [
			{ cell: "A1", text: "Visual summary of " + table.sheetName, bold: true },
			{ cell: "A2", text: sourceNote(table), italic: true }
		];
		var blocks = [], factRows = [], row = 4;
		p.charts.forEach(function (chart) {
			notes.push({ cell: "A" + row, text: chart.title, bold: true });
			if (chart.explanation)
				notes.push({ cell: "A" + (row + 1), text: chart.explanation, italic: true });
			factRows.push(row + 2);
			var top = row + 3;
			var cells = plan.summaryCells(chart, table, top);
			blocks.push({ top: top, cells: cells, chart: chart.chart, title: chart.title, groupFormat: chart.groupFormat, plan: chart });
			row = top + Math.max(cells.length, CHART_ROWS) + 2;
		});
		return insertBlocks("Visual summary", blocks, notes, factRows).then(function (sheet) {
			current.undo = { sheet: sheet };
			return "Added sheet \"" + sheet + "\" with " + blocks.length + " charts.";
		});
	}

	// Puts the formula beside the table with its label and checks the result.
	// A formula the model wrote that gives an error is removed, and the model
	// gets one chance to fix it.
	function insertAnswer(state, repairs) {
		var p = state.plan;
		var place = plan.answerPlace(state.table, state.sheet.selection);
		var scope = { preferred: place.preferred, col: place.col, startRow: place.startRow, label: p.label, formula: p.formula, numberFormat: p.numberFormat || "" };
		return callCommand(placeAnswer, scope).then(function (at) {
			if (at.error)
				throw new Error(at.error);
			var cells = [at.cell].concat(at.label ? [at.label] : []);
			return callCommand(readCells, { cells: [at.cell] }).then(function (read) {
				var result = read[0];
				if (!result.error) {
					state.undo = { cells: cells };
					var shown = (/^#+$/).test(result.text) ? result.value : result.text;
					return p.label + ": " + shown + " (in " + at.cell + ").";
				}
				return callCommand(clearCells, { cells: cells }).then(function () {
					if (p.built || !repairs)
						throw new Error("The formula " + p.formula + " gives " + result.error + ", so it was removed. Try asking in other words.");
					setStatus("The formula gave " + result.error + ". Asking for a fix…");
					var messages = plan.buildRepairMessages(state.request.messages, state.reply,
						"in the sheet, " + p.formula + " gives " + result.error + ".");
					return think(messages).then(function (reply) {
						var checked = state.request.check(reply, state.table);
						if (!checked.ok)
							throw new Error(checked.error);
						if (checked.plan.type !== "formula")
							throw new Error("The formula " + p.formula + " gives " + result.error + " and no fix was found.");
						state.plan = checked.plan;
						state.reply = reply;
						renderPlan();
						return insertAnswer(state, repairs - 1);
					});
				});
			});
		});
	}

	function apply(state) {
		if (state.plan.type === "formula")
			return insertAnswer(state, 1);
		if (state.plan.type === "visual")
			return insertVisual(state.plan, state.table);
		return insertSummary(state.plan, state.table);
	}

	function remove() {
		var undo = current && current.undo;
		if (!undo)
			return;
		var done = undo.sheet ? callCommand(deleteSheet, { sheet: undo.sheet }) : callCommand(clearCells, { cells: undo.cells });
		done.then(function () {
			current.undo = null;
			$("result").hidden = true;
			setStatus("Removed.", "ok");
		}, function (error) {
			setStatus(error.message, "error");
		});
	}

	window.Asc.plugin.init = function () {
		$("ask").onclick = ask;
		$("visual").onclick = visualSummary;
		$("question").onkeydown = function (e) {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				ask();
			}
		};
		$("remove").onclick = remove;
		window.PersonalOfficeAI.settingsPanel.init(function () {
			setStatus("Settings saved.", "ok");
		});
		$("question").focus();
	};

	window.Asc.plugin.button = function () {
		this.executeCommand("close", "");
	};
})(window);
