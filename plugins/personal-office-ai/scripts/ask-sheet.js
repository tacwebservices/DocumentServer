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
		var selection = Api.GetSelection();
		return {
			name: sheet.GetName(),
			firstRow: used.GetRow(),
			firstCol: used.GetCol(),
			values: values,
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
		var sheet = Asc.scope.sheet ? Api.GetSheet(Asc.scope.sheet) : Api.GetActiveSheet();
		return Asc.scope.cells.map(function (cell) {
			return sheet.GetRange(cell).GetText();
		});
	}

	function restoreCell() {
		Api.GetActiveSheet().GetRange(Asc.scope.cell).SetValue(Asc.scope.value);
		return true;
	}

	function insertSummary() {
		var s = Asc.scope;
		var base = s.title.replace(/[\[\]:*?\/\\]/g, " ").slice(0, 28).trim() || "Summary";
		var name = base;
		for (var n = 2; Api.GetSheet(name); n++)
			name = base + " " + n;
		Api.AddSheet(name);
		var sheet = Api.GetSheet(name);
		for (var r = 0; r < s.cells.length; r++) {
			for (var c = 0; c < s.cells[r].length; c++)
				sheet.GetRangeByNumber(r, c).SetValue(s.cells[r][c]);
		}
		var last = s.cells.length;
		sheet.GetRange("A1:B1").SetBold(true);
		sheet.GetRange("A1:B" + last).AutoFit(false, true);
		sheet.GetRange("A" + (last + 2)).SetValue(s.source);
		sheet.GetRange("A" + (last + 2)).SetItalic(true);

		if (s.chart) {
			var cm = 360000;
			var chart = sheet.AddChart(
				"'" + name.replace(/'/g, "''") + "'!$A$1:$B$" + last,
				false, s.chart, 2, 16 * cm, 9 * cm, 3, 0, 1, 0);
			if (chart)
				chart.SetTitle(s.title, 13, true);
		}
		return { sheet: name, last: last };
	}

	/* Panel */

	function renderPlan() {
		var p = current.plan;
		$("result").hidden = false;
		$("explanation").textContent = p.explanation;
		$("formula-box").hidden = p.type !== "formula";
		$("summary-box").hidden = p.type !== "summary";
		$("insert").hidden = p.type === "unsupported";

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

	function ask() {
		var question = $("question").value.trim();
		if (!question)
			return;
		$("result").hidden = true;
		setBusy(true);
		setStatus("Reading the sheet…");
		callCommand(readSheet).then(function (sheet) {
			if (!sheet || !sheet.values || sheet.values.length < 2)
				throw new Error("This sheet has no table to work with. Put column names in the first row and data below.");
			var table = plan.describeTable(sheet);
			setStatus("Thinking…");
			return client.chat(client.loadSettings(), plan.buildMessages(question, table, sheet.selection))
				.then(function (reply) {
					var checked = plan.checkPlan(reply, table);
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
		} else {
			var t = current.table;
			done = callCommand(insertSummary, {
				title: p.title,
				cells: plan.summaryCells(p, t),
				chart: p.chart,
				source: "Source: sheet " + t.sheetName + ", rows " + t.firstDataRow + " to " + t.lastDataRow +
					". Each value is a formula you can click to check."
			}).then(function (res) {
				var cells = [];
				for (var row = 2; row <= res.last; row++)
					cells.push("B" + row);
				return callCommand(readCells, { sheet: res.sheet, cells: cells }).then(function (texts) {
					var errors = cells.filter(function (cell, i) {
						return (/^#/).test(texts[i]);
					});
					if (errors.length)
						throw new Error("Some values could not be calculated (" + errors.join(", ") + "). Check sheet \"" + res.sheet + "\".");
					return "Added sheet \"" + res.sheet + "\".";
				});
			});
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
