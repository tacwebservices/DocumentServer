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
	var current = null; // {plan, table}
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
		var formats = values[0].map(function (header, i) {
			return sheet.GetRangeByNumber(firstRow, firstCol - 1 + i).GetNumberFormat();
		});
		var selection = Api.GetSelection();
		return {
			name: sheet.GetName(),
			firstRow: firstRow,
			firstCol: firstCol,
			values: values,
			formats: formats,
			selection: selection ? selection.GetAddress(false, false) : ""
		};
	}

	// The editor recalculates after a command returns, so results are read
	// back in a separate command.

	function insertFormula() {
		var range = Api.GetActiveSheet().GetRange(Asc.scope.cell);
		if (!range)
			return { error: "Cell " + Asc.scope.cell + " does not exist." };
		if (range.GetFormula() !== "")
			return { error: "Cell " + Asc.scope.cell + " is not empty. Choose an empty cell." };
		range.SetValue(Asc.scope.formula);
		range.Select();
		return { inserted: true };
	}

	function readCells() {
		var sheet = Api.GetActiveSheet();
		return Asc.scope.cells.map(function (cell) {
			return sheet.GetRange(cell).GetText();
		});
	}

	function restoreCell() {
		Api.GetActiveSheet().GetRange(Asc.scope.cell).SetValue(Asc.scope.value);
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
				var cell = sheet.GetRange("B" + row);
				values.push(cell.GetValue2());
				if ((/^#/).test(cell.GetText()))
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
		$("insert").hidden = p.type === "unsupported";

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
			$("cell").value = p.cell;
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

	// Reads the sheet, asks the model, and shows the checked plan.
	// makeRequest(table) returns {messages, check} or throws when there is nothing to ask.
	function run(makeRequest) {
		$("result").hidden = true;
		setBusy(true);
		setStatus("Reading the sheet…");
		callCommand(readSheet).then(function (sheet) {
			if (!sheet.values || sheet.values.length < 2)
				throw new Error("This sheet has no table to work with. Put column names in the first row and data below.");
			var table = plan.describeTable(sheet);
			var request = makeRequest(table, sheet);
			setStatus("Thinking…");
			return client.chat(client.loadSettings(), request.messages).then(function (reply) {
				var checked = request.check(reply, table);
				if (!checked.ok)
					throw new Error(checked.error);
				current = { plan: checked.plan, table: table };
				renderPlan();
				setStatus(checked.plan.type === "unsupported" ? "" : "Check the result, then insert it.");
			});
		}).catch(function (error) {
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
			return { messages: plan.buildMessages(question, table, sheet.selection), check: plan.checkPlan };
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
			return "Added sheet \"" + sheet + "\" with " + blocks.length + " charts.";
		});
	}

	function insert() {
		if ($("insert").disabled)
			return;
		var p = current.plan;
		var done;
		if (p.type === "formula") {
			var cell = $("cell").value.trim().toUpperCase();
			if (!(/^[A-Z]{1,3}\d{1,7}$/).test(cell)) {
				setStatus("Enter the cell to put the formula in, such as F2.", "error");
				return;
			}
			done = callCommand(insertFormula, { cell: cell, formula: p.formula }).then(function (res) {
				if (res.error)
					throw new Error(res.error);
				return callCommand(readCells, { cells: [cell] }).then(function (texts) {
					if (!(/^#/).test(texts[0]))
						return "Inserted in " + cell + ". Result: " + texts[0];
					return callCommand(restoreCell, { cell: cell, value: "" }).then(function () {
						throw new Error("The formula gives " + texts[0] + ", so it was not inserted.");
					});
				});
			});
		} else if (p.type === "visual") {
			done = insertVisual(p, current.table);
		} else {
			done = insertSummary(p, current.table);
		}
		$("insert").disabled = true;
		done.then(function (message) {
			$("result").hidden = true;
			setStatus(message, "ok");
		}, function (error) {
			setStatus(error.message, "error");
		}).then(function () {
			$("insert").disabled = false;
		});
	}

	function showSettings() {
		var s = client.loadSettings();
		$("setting-url").value = s.url;
		$("setting-model").value = s.model;
		$("setting-key").value = s.apiKey;
	}

	function saveSettings() {
		client.saveSettings({
			url: $("setting-url").value.trim(),
			model: $("setting-model").value.trim(),
			apiKey: $("setting-key").value.trim()
		});
		setStatus("Settings saved.", "ok");
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
		$("insert").onclick = insert;
		$("discard").onclick = function () {
			$("result").hidden = true;
			setStatus("");
		};
		$("settings").ontoggle = showSettings;
		$("save-settings").onclick = saveSettings;
		$("question").focus();
	};

	window.Asc.plugin.button = function () {
		this.executeCommand("close", "");
	};
})(window);
