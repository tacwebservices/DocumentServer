// SPDX-FileCopyrightText: 2026 Personal Office
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run with: node --test plugins/personal-office-ai/test/plan.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const plan = require("../scripts/plan.js");

const table = plan.describeTable({
	name: "Sales 2026",
	firstRow: 1,
	firstCol: 1,
	values: [
		["Date", "Branch", "Sales"],
		["2026-01-03", "Lusaka", 1200],
		["2026-01-04", "Ndola", 800],
		["2026-01-05", "Lusaka", 400],
		["", "", ""]
	]
});

test("describes columns and data rows", () => {
	assert.deepStrictEqual(table.columns.map(c => [c.letter, c.name, c.type]),
		[["A", "Date", "text"], ["B", "Branch", "text"], ["C", "Sales", "number"]]);
	assert.strictEqual(table.firstDataRow, 2);
	assert.strictEqual(table.lastDataRow, 4);
});

test("column letters past Z", () => {
	assert.strictEqual(plan.columnLetter(25), "Z");
	assert.strictEqual(plan.columnLetter(26), "AA");
	assert.strictEqual(plan.columnLetter(701), "ZZ");
	assert.strictEqual(plan.columnLetter(702), "AAA");
});

test("summary is built from formulas over the source data", () => {
	const checked = plan.checkPlan('{"type":"summary","groupBy":"branch","value":"Sales","aggregation":"sum","chart":"bar","title":"Sales by branch"}', table);
	assert.ok(checked.ok, checked.error);
	assert.deepStrictEqual(plan.summaryCells(checked.plan, table), [
		["Branch", "Total Sales"],
		["Lusaka", "=SUMIFS('Sales 2026'!$C$2:$C$4,'Sales 2026'!$B$2:$B$4,$A2)"],
		["Ndola", "=SUMIFS('Sales 2026'!$C$2:$C$4,'Sales 2026'!$B$2:$B$4,$A3)"]
	]);
	assert.strictEqual(checked.plan.chart, "bar");
});

test("count needs no value column", () => {
	const checked = plan.checkPlan('{"type":"summary","groupBy":"Branch","aggregation":"count","chart":"none"}', table);
	assert.ok(checked.ok, checked.error);
	assert.strictEqual(plan.summaryCells(checked.plan, table)[1][1], "=COUNTIFS('Sales 2026'!$B$2:$B$4,$A2)");
	assert.strictEqual(checked.plan.chart, null);
});

test("rejects columns the sheet does not have", () => {
	const checked = plan.checkPlan('{"type":"summary","groupBy":"Region","value":"Sales","aggregation":"sum"}', table);
	assert.strictEqual(checked.ok, false);
	assert.match(checked.error, /no column called "Region"/);
});

test("accepts column letters, but only for real columns", () => {
	for (const groupBy of ["B", "B: Branch", "B:Branch", "\"Branch\""]) {
		const checked = plan.checkPlan(JSON.stringify({ type: "summary", groupBy, value: "C", aggregation: "sum" }), table);
		assert.ok(checked.ok, groupBy + ": " + checked.error);
		assert.strictEqual(checked.plan.groupBy.name, "Branch");
	}
	for (const groupBy of ["Z", "C: Branch", "B: Region"])
		assert.strictEqual(plan.checkPlan(JSON.stringify({ type: "summary", groupBy, value: "Sales", aggregation: "sum" }), table).ok, false, groupBy);
});

test("rejects summing a text column", () => {
	const checked = plan.checkPlan('{"type":"summary","groupBy":"Branch","value":"Date","aggregation":"sum"}', table);
	assert.strictEqual(checked.ok, false);
});

test("formula answers get a leading = and a clean cell", () => {
	const checked = plan.checkPlan('Here you go: {"type":"formula","cell":"$E$2","formula":"SUM(C2:C4)","explanation":"Total sales"}', table);
	assert.ok(checked.ok);
	assert.strictEqual(checked.plan.formula, "=SUM(C2:C4)");
	assert.strictEqual(checked.plan.cell, "E2");
});

test("formulas never land inside the table", () => {
	for (const cell of ["C2", "A1", "B4", "", "nonsense"]) {
		const checked = plan.checkPlan(JSON.stringify({ type: "formula", cell, formula: "=AVERAGE(C2:C4)" }), table);
		assert.strictEqual(checked.plan.cell, "E2", cell);
	}
	assert.strictEqual(plan.checkPlan('{"type":"formula","cell":"H9","formula":"=1"}', table).plan.cell, "H9");
});

test("unreadable answers are reported, not guessed", () => {
	assert.strictEqual(plan.checkPlan("Sales are about 2400", table).ok, false);
	assert.strictEqual(plan.checkPlan('{"type":"poem"}', table).ok, false);
});

test("prompt lists columns with letters and the question", () => {
	const messages = plan.buildMessages("show sales by branch", table, "D1");
	assert.match(messages[1].content, /- C: "Sales" \(number\)/);
	assert.match(messages[1].content, /Question: show sales by branch$/);
});

// 46025 = 2026-01-03; formats are the number formats of the first data row.
const dated = plan.describeTable({
	name: "Sales",
	firstRow: 1,
	firstCol: 1,
	values: [["Date", "Branch", "Sales"], [46025, "Lusaka", 1200], [46026, "Ndola", 800], [46054, "Kitwe", 950], [46062, "Ndola", 300]],
	formats: ["m/d/yyyy", "General", "General"]
});

test("dates are recognised from the number format", () => {
	assert.deepStrictEqual(dated.columns.map(c => c.type), ["date", "text", "number"]);
	assert.strictEqual(table.columns[0].type, "text");
	const typeFor = format => plan.describeTable({ name: "S", firstRow: 1, firstCol: 1, values: [["V"], [46025]], formats: [format] }).columns[0].type;
	for (const format of ["dd.mm.yyyy", "mmm yyyy", "yyyy-mm-dd", "[$-409]d-mmm-yy"])
		assert.strictEqual(typeFor(format), "date", format);
	for (const format of ["General", "0.00", "#,##0", "h:mm", "[Red]0", '"days" 0'])
		assert.strictEqual(typeFor(format), "number", format);
});

test("date columns are grouped by month with range formulas", () => {
	const checked = plan.checkPlan('{"type":"summary","groupBy":"Date","value":"Sales","aggregation":"sum","chart":"line"}', dated);
	assert.ok(checked.ok, checked.error);
	assert.strictEqual(checked.plan.period, "month");
	assert.deepStrictEqual(checked.plan.groups, [46023, 46054]); // 2026-01-01, 2026-02-01
	const cells = plan.summaryCells(checked.plan, dated, 5);
	assert.deepStrictEqual(cells[0], ["Month", "Total Sales", "Month start"]);
	assert.deepStrictEqual(cells[1], ["=TEXT($C6,\"mmm yyyy\")",
		"=SUMIFS('Sales'!$C$2:$C$5,'Sales'!$A$2:$A$5,\">=\"&$C6,'Sales'!$A$2:$A$5,\"<\"&EDATE($C6,1))", 46023]);
	assert.strictEqual(checked.plan.chart, "line");
});

test("a yearly trend inside one year becomes monthly", () => {
	const checked = plan.checkPlan('{"type":"summary","groupBy":"Date","value":"Sales","aggregation":"sum","period":"year","chart":"line"}', dated);
	assert.strictEqual(checked.plan.period, "month");
	assert.strictEqual(checked.plan.groups.length, 2);
	assert.match(plan.buildMessages("q", dated)[1].content, /"Date" \(date, from 2026-01-03 to 2026-02-09\)/);
});

test("line charts need a time axis", () => {
	const checked = plan.checkPlan('{"type":"summary","groupBy":"Branch","value":"Sales","aggregation":"sum","chart":"line"}', dated);
	assert.strictEqual(checked.plan.chart, "bar");
});

test("visual summary keeps valid, distinct charts only", () => {
	const reply = JSON.stringify({ charts: [
		{ groupBy: "Date", value: "Sales", aggregation: "sum", period: "month", chart: "line", title: "Sales per month", why: "Trend" },
		{ groupBy: "Branch", value: "Sales", aggregation: "sum", chart: "bar", title: "Sales by branch" },
		{ groupBy: "Branch", value: "Sales", aggregation: "sum", chart: "pie", title: "Same again" },
		{ groupBy: "Region", value: "Sales", aggregation: "sum", chart: "bar", title: "Invented column" }
	] });
	const checked = plan.checkVisualSummary(reply, dated);
	assert.ok(checked.ok, checked.error);
	assert.deepStrictEqual(checked.plan.charts.map(c => c.title), ["Sales per month", "Sales by branch"]);
	assert.strictEqual(checked.plan.charts[0].explanation, "Trend");
	assert.strictEqual(checked.plan.skipped.length, 1);
});

test("visual summary says so when there is nothing to chart", () => {
	const checked = plan.checkVisualSummary('{"charts":[],"explanation":"Only names, no numbers."}', dated);
	assert.strictEqual(checked.ok, false);
	assert.strictEqual(checked.error, "Only names, no numbers.");
	const words = plan.describeTable({ name: "S", firstRow: 1, firstCol: 1, values: [["Name"], ["Ann"]] });
	assert.strictEqual(plan.canSummarize(words), false);
	assert.strictEqual(plan.canSummarize(dated), true);
});

test("values the editor returns as text are read as numbers", () => {
	const fromEditor = plan.describeTable({
		name: "Sales", firstRow: 1, firstCol: 1, formats: ["m/d/yyyy", "General", "General"],
		values: [["Date", "Branch", "Sales"], ["46025", "Lusaka", "1200"], ["46054", "Ndola", "800.5"]]
	});
	assert.deepStrictEqual(fromEditor.columns.map(c => c.type), ["date", "text", "number"]);
	assert.deepStrictEqual(fromEditor.rows[1], [46054, "Ndola", 800.5]);
	const checked = plan.checkPlan('{"type":"summary","groupBy":"Date","value":"Sales","aggregation":"sum"}', fromEditor);
	assert.deepStrictEqual(checked.plan.groups, [46023, 46054]);
	assert.strictEqual(plan.describeFacts({ aggregation: "sum" }, ["A", "B"], ["3", "1"]).text,
		"Highest: A (3, 75% of the total). Lowest: B (1).");
});

test("facts come from the calculated values", () => {
	const groupPlan = { aggregation: "sum", period: null };
	assert.strictEqual(plan.describeFacts(groupPlan, ["Lusaka", "Ndola", "Kitwe"], [1600, 1100, 1590]).text,
		"Highest: Lusaka (1,600, 37% of the total). Lowest: Ndola (1,100).");
	const trend = plan.describeFacts({ aggregation: "sum", period: "month" }, ["Jan 2026", "Feb 2026", "Mar 2026"], [1000, 1100, 1452]);
	assert.strictEqual(trend.text, "Mar 2026: 1,452, up 32% from Feb 2026. Biggest change: Mar 2026, up 32%.");
	assert.strictEqual(trend.flag, true);
	assert.strictEqual(plan.describeFacts({ aggregation: "average", period: null }, ["A", "B"], [2, 1]).text,
		"Highest: A (2). Lowest: B (1).");
});
