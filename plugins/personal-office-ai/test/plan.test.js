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
