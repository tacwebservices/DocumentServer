/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Visual summary of a document: the language model picks which charts tell
 * the story of the document's tables; every value is computed here from the
 * table cells, never estimated. Uses the sheet planner's checks (plan.js).
 */
(function (exports, plan) {
	"use strict";

	var MAX_TABLES = 12;
	var TOTAL_ROW = /^\s*(grand\s+)?(total|totals|sum|overall|all)\b/i;
	var CHART_TYPES = { bar: "bar", horizontalBar: "horizontalBar", line: "lineNormalMarker", pie: "pie" };

	// "K 1,200.50", "(300)", "12%", "1 200" -> number; anything else -> null.
	function parseNumber(text) {
		var t = String(text === null || text === undefined ? "" : text).trim();
		if (!t)
			return null;
		var negative = (/^\(.*\)$/).test(t);
		t = t.replace(/^\(|\)$/g, "")
			.replace(/^[A-Za-z$€£¥₦]{0,4}\$?\s*/, "") // currency before: K, ZMW, US$, $
			.replace(/\s*(%|[A-Za-z]{1,4})$/, "") // percent or unit after
			.replace(/(\d)[,\s  ](?=\d{3}\b)/g, "$1");
		if (!(/^[-−]?\d+(\.\d+)?$/).test(t))
			return null;
		var n = Number(t.replace("−", "-"));
		return negative ? -n : n;
	}

	// tables: [{index, caption, rows: [[cell text]]}] as read from the document.
	// Returns sheet-style tables (plan.describeTable) for those with numbers;
	// total rows at the bottom are left out so they are not counted twice.
	function describeTables(tables) {
		return tables.slice(0, MAX_TABLES).map(function (t) {
			var rows = t.rows.filter(function (row) {
				return row.some(function (cell) { return String(cell).trim(); });
			});
			while (rows.length > 2 && TOTAL_ROW.test(rows[rows.length - 1][0] || ""))
				rows.pop();
			if (rows.length < 3 || rows[0].length < 2)
				return null;
			var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
			var values = rows.map(function (row, r) {
				var full = row.concat(new Array(width - row.length).fill(""));
				return r === 0 ? full.map(function (h, c) { return String(h).trim() || "Column " + (c + 1); }) :
					full.map(function (cell) {
						var n = parseNumber(cell);
						return n === null ? String(cell).trim() : n;
					});
			});
			var table = plan.describeTable({ name: "Table " + t.index, firstRow: 1, firstCol: 1, values: values, formats: [] });
			table.index = t.index;
			table.caption = t.caption || "";
			return plan.canSummarize(table) && table.rowCount >= 2 ? table : null;
		}).filter(Boolean);
	}

	var PROMPT = [
		"You plan a visual summary of a document from its tables: the 3 to 5 charts that best tell its story,",
		"such as comparisons between groups, shares of a total and changes over time.",
		"You never calculate numbers; the values are computed from the tables.",
		"Reply with one JSON object only:",
		'{"charts":[{"table":<table number>,"groupBy":"<column name>","value":"<column name, or empty for count>","aggregation":"sum|average|count|min|max","chart":"bar|horizontalBar|pie|line","title":"<short title>","why":"<one sentence on what the chart shows>"}]}',
		"Rules:",
		"- Write column names exactly as listed. Use value columns of type number.",
		"- Use pie only for shares of a total with few groups, line only when the groups are periods such as months or years.",
		"- Do not repeat the same chart. If no table has numbers worth charting, reply {\"charts\":[],\"explanation\":\"<why>\"}."
	].join("\n");

	function buildMessages(tables) {
		var lines = [];
		tables.forEach(function (t) {
			lines.push("Table " + t.index + (t.caption ? " (" + t.caption + ")" : "") + ", " + t.rowCount + " rows. Columns:");
			t.columns.forEach(function (c) {
				lines.push("- \"" + c.name + "\" (" + c.type + ")");
			});
			lines.push("First rows:");
			t.sample.slice(0, 8).forEach(function (row) { lines.push(JSON.stringify(row)); });
			lines.push("");
		});
		return [
			{ role: "system", content: PROMPT },
			{ role: "user", content: lines.join("\n") }
		];
	}

	var PERIOD_LABEL = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{2,4})?$|^(19|20)\d{2}$|^q[1-4](\s+\d{2,4})?$|^(19|20)\d{2}[-\/]\d{1,2}$/i;

	// Values per group, computed from the table rows.
	function compute(chart, table) {
		var g = table.columns.indexOf(chart.groupBy);
		var v = chart.value ? table.columns.indexOf(chart.value) : -1;
		return chart.groups.map(function (group) {
			var values = [];
			var count = 0;
			table.rows.forEach(function (row) {
				if (row[g] !== group)
					return;
				count++;
				if (v >= 0 && typeof row[v] === "number")
					values.push(row[v]);
			});
			var result;
			switch (chart.aggregation) {
				case "count": result = count; break;
				case "sum": result = values.reduce(function (a, b) { return a + b; }, 0); break;
				case "average": result = values.length ? values.reduce(function (a, b) { return a + b; }, 0) / values.length : null; break;
				case "min": result = values.length ? Math.min.apply(null, values) : null; break;
				case "max": result = values.length ? Math.max.apply(null, values) : null; break;
			}
			return result === null ? null : Math.round(result * 100) / 100;
		});
	}

	// Checked charts with their values and a fact sentence each.
	function checkReply(reply, tables) {
		var answer = plan.parseReply(reply);
		if (!answer || !Array.isArray(answer.charts))
			return { ok: false, error: "The assistant's answer could not be read. Try again." };
		var byIndex = {};
		tables.forEach(function (t) { byIndex[t.index] = t; });
		var charts = [], skipped = [], seen = {};
		answer.charts.forEach(function (item) {
			if (charts.length >= 5 || !item)
				return;
			var table = byIndex[Number(item.table)] || (tables.length === 1 ? tables[0] : null);
			if (!table) {
				skipped.push("There is no table " + item.table + ".");
				return;
			}
			var checked = plan.checkSummary(item, table);
			if (!checked.ok) {
				skipped.push("Table " + table.index + ": " + checked.error);
				return;
			}
			var p = checked.plan;
			var key = [table.index, p.groupBy.name, p.value && p.value.name, p.aggregation].join("|");
			if (seen[key])
				return;
			if (p.groups.length > 15 || p.groups.length < 2) {
				skipped.push("Column \"" + p.groupBy.name + "\" has " + (p.groups.length < 2 ? "only one value" : "too many different values") + " for a chart.");
				return;
			}
			seen[key] = true;
			var periods = p.groups.every(function (group) { return PERIOD_LABEL.test(String(group).trim()); });
			var chart = String(item.chart || "");
			if (chart === "line" && !periods)
				chart = "bar";
			if (chart === "pie" && (p.aggregation === "average" || p.aggregation === "min" || p.aggregation === "max"))
				chart = "bar";
			p.chart = CHART_TYPES[chart] ? chart : (periods ? "line" : "bar");
			p.editorChart = CHART_TYPES[p.chart];
			p.explanation = String(item.why || "");
			p.table = table;
			p.labels = p.groups.map(String);
			p.values = compute(p, table);
			p.seriesName = (p.aggregation === "count" ? "Count" : p.value.name);
			// Periods read in order, so the fact names the latest change
			p.fact = plan.describeFacts(periods ? { period: "month", aggregation: p.aggregation } : p, p.labels, p.values);
			charts.push(p);
		});
		if (!charts.length)
			return { ok: false, error: answer.explanation || skipped[0] || "The assistant found nothing in the tables worth charting." };
		return { ok: true, charts: charts, skipped: skipped };
	}

	exports.parseNumber = parseNumber;
	exports.describeTables = describeTables;
	exports.buildMessages = buildMessages;
	exports.checkReply = checkReply;
	exports.compute = compute;
})(typeof module !== "undefined" ? module.exports : (window.PersonalOfficeAI = window.PersonalOfficeAI || {}).docSummary = {},
	typeof module !== "undefined" ? require("../../personal-office-ai/scripts/plan.js") : window.PersonalOfficeAI.plan);
