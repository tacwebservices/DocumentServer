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

test("formula answers get a leading = and a label that is not a formula", () => {
	const checked = plan.checkPlan('Here you go: {"type":"formula","formula":"SUM(C2:C4)","label":"=Total sales"}', table);
	assert.ok(checked.ok);
	assert.strictEqual(checked.plan.formula, "=SUM(C2:C4)");
	assert.strictEqual(checked.plan.label, "Total sales");
	assert.strictEqual(plan.checkPlan('{"type":"formula","formula":"=1"}', table).plan.label, "Answer");
});

test("calculations are built from the sheet's columns", () => {
	const total = plan.checkPlan('{"type":"calculation","aggregation":"sum","value":"Sales","filters":[],"label":"Total sales"}', table);
	assert.ok(total.ok, total.error);
	assert.strictEqual(total.plan.formula, "=SUM('Sales 2026'!$C$2:$C$4)");
	assert.strictEqual(total.plan.built, true);
	const count = plan.checkPlan('{"type":"calculation","aggregation":"count"}', table);
	assert.strictEqual(count.plan.formula, "=COUNTA('Sales 2026'!$A$2:$A$4)");
	assert.strictEqual(count.plan.label, "Count of rows");
});

test("calculation filters match real values and quote them", () => {
	const lusaka = plan.checkPlan('{"type":"calculation","aggregation":"average","value":"Sales","filters":[{"column":"branch","operator":"=","value":"lusaka"}]}', table);
	assert.ok(lusaka.ok, lusaka.error);
	assert.strictEqual(lusaka.plan.formula, "=AVERAGEIFS('Sales 2026'!$C$2:$C$4,'Sales 2026'!$B$2:$B$4,\"Lusaka\")");
	const big = plan.checkPlan('{"type":"calculation","aggregation":"count","filters":[{"column":"Sales","operator":">=","value":"500"}]}', table);
	assert.strictEqual(big.plan.formula, "=COUNTIFS('Sales 2026'!$C$2:$C$4,\">=500\")");
	const typo = plan.checkPlan('{"type":"calculation","aggregation":"sum","value":"Sales","filters":[{"column":"Branch","value":"Lusak"}]}', table);
	assert.strictEqual(typo.ok, false);
	assert.strictEqual(typo.error, "Column \"Branch\" has no value \"Lusak\". It has: Lusaka, Ndola.");
	assert.strictEqual(plan.checkPlan('{"type":"calculation","aggregation":"sum","value":"Branch"}', table).ok, false);
});

test("shares divide the filtered total by the whole", () => {
	const share = plan.checkPlan('{"type":"calculation","aggregation":"share","value":"Sales","filters":[{"column":"Branch","value":"Lusaka"}]}', table);
	assert.ok(share.ok, share.error);
	assert.strictEqual(share.plan.formula, "=SUMIFS('Sales 2026'!$C$2:$C$4,'Sales 2026'!$B$2:$B$4,\"Lusaka\")/SUM('Sales 2026'!$C$2:$C$4)");
	assert.strictEqual(share.plan.numberFormat, "0.0%");
	const rows = plan.checkPlan('{"type":"calculation","aggregation":"share","filters":[{"column":"Branch","value":"Ndola"}]}', table);
	assert.strictEqual(rows.plan.formula, "=COUNTIFS('Sales 2026'!$B$2:$B$4,\"Ndola\")/COUNTA('Sales 2026'!$A$2:$A$4)");
	assert.strictEqual(plan.checkPlan('{"type":"calculation","aggregation":"share","value":"Sales"}', table).ok, false);
});

test("which row has the largest value is looked up, not guessed", () => {
	const top = plan.checkPlan('{"type":"calculation","aggregation":"which_max","value":"Sales","answerColumn":"Branch","filters":[]}', table);
	assert.ok(top.ok, top.error);
	assert.strictEqual(top.plan.formula, "=INDEX('Sales 2026'!$B$2:$B$4,MATCH(MAX('Sales 2026'!$C$2:$C$4),'Sales 2026'!$C$2:$C$4,0))");
	assert.strictEqual(plan.checkPlan('{"type":"calculation","aggregation":"which_min","value":"Sales","answerColumn":"Town"}', table).ok, false);
	const min = plan.checkPlan('{"type":"calculation","aggregation":"min","value":"Sales","answerColumn":"Branch"}', table);
	assert.strictEqual(min.plan.formula, "=INDEX('Sales 2026'!$B$2:$B$4,MATCH(MIN('Sales 2026'!$C$2:$C$4),'Sales 2026'!$C$2:$C$4,0))");
	assert.strictEqual(plan.checkPlan('{"type":"calculation","aggregation":"min","value":"Sales","answerColumn":""}', table).plan.formula, "=MIN('Sales 2026'!$C$2:$C$4)");
	const asked = plan.checkPlan('{"type":"calculation","aggregation":"max","value":"Sales","filters":[]}', table, "Which branch made the biggest sale?");
	assert.strictEqual(asked.plan.formula, "=INDEX('Sales 2026'!$B$2:$B$4,MATCH(MAX('Sales 2026'!$C$2:$C$4),'Sales 2026'!$C$2:$C$4,0))");
	assert.strictEqual(plan.checkPlan('{"type":"calculation","aggregation":"max","value":"Sales"}', table, "what is the biggest sale").plan.formula, "=MAX('Sales 2026'!$C$2:$C$4)");
	const circular = plan.checkPlan('{"type":"calculation","aggregation":"max","value":"Sales","filters":[{"column":"Branch","value":"Lusaka"}]}', table, "which branch made the biggest sale");
	assert.strictEqual(circular.plan.formula, asked.plan.formula);
});

test("date filters use DATE, not text", () => {
	const march = plan.checkPlan('{"type":"calculation","aggregation":"sum","value":"Sales","filters":[{"column":"Date","operator":">=","value":"2026-02-01"}]}', dated);
	assert.ok(march.ok, march.error);
	assert.strictEqual(march.plan.formula, "=SUMIFS('Sales'!$C$2:$C$5,'Sales'!$A$2:$A$5,\">=\"&DATE(2026,2,1))");
	assert.strictEqual(plan.checkPlan('{"type":"calculation","aggregation":"sum","value":"Sales","filters":[{"column":"Date","value":"March"}]}', dated).ok, false);
});

test("answers go beside the table, or in a selected cell clear of it", () => {
	assert.deepStrictEqual(plan.answerPlace(table, ""), { preferred: "", col: 4, startRow: 1 }); // label in E, value in F
	for (const cell of ["B3", "A5", "D2", "C1", "A1:B2"])
		assert.strictEqual(plan.answerPlace(table, cell).preferred, "", cell);
	assert.strictEqual(plan.answerPlace(table, "$H$9").preferred, "H9");
	assert.strictEqual(plan.answerPlace(table, "A7").preferred, "A7");
});

test("the table ends at an empty column or row, after any title", () => {
	const found = plan.describeTable({
		name: "S", firstRow: 1, firstCol: 1,
		values: [
			["Sales report", "", "", "", "", ""],
			["", "", "", "", "", ""],
			["Branch", "Sales", "", "Total sales", 2400, ""],
			["Lusaka", 1200, "", "", "", ""],
			["Ndola", 800, "", "", "", ""],
			["", "", "", "", "", ""],
			["Note", "", "", "", "", ""]
		],
		formatRows: [[], [], [], ["General", "0.00"]]
	});
	assert.deepStrictEqual(found.columns.map(c => c.letter + ":" + c.name), ["A:Branch", "B:Sales"]);
	assert.strictEqual(found.firstRow, 3);
	assert.strictEqual(found.firstDataRow, 4);
	assert.strictEqual(found.lastDataRow, 5);
	assert.deepStrictEqual(plan.answerPlace(found, "").col, 3); // D, next to the earlier answer
});

test("a formula error is sent back for one fix", () => {
	const first = plan.buildMessages("share of Lusaka", table, "");
	const repair = plan.buildRepairMessages(first, '{"type":"formula","formula":"=X"}', "in the sheet, =X gives #NAME?.");
	assert.strictEqual(repair.length, 4);
	assert.strictEqual(repair[2].role, "assistant");
	assert.match(repair[3].content, /=X gives #NAME\?/);
});

test("plans that guess the answer are rejected", () => {
	const question = "which branch made the biggest sale";
	const filtered = plan.checkPlan('{"type":"calculation","aggregation":"sum","value":"Sales","filters":[{"column":"Branch","value":"Lusaka"}]}', table, "what are the biggest sales");
	assert.strictEqual(filtered.ok, false);
	assert.match(filtered.error, /Branch = "Lusaka" is not in the question/);
	const formula = plan.checkPlan('{"type":"formula","formula":"=MAXIFS(C2:C4,B2:B4,\\"Lusaka\\")"}', table, question);
	assert.strictEqual(formula.ok, false);
	assert.match(formula.error, /assumes Branch "Lusaka"/);
	assert.ok(plan.checkPlan('{"type":"calculation","aggregation":"sum","value":"Sales","filters":[{"column":"Branch","value":"Lusaka"}]}', table, "total sales in lusaka").ok);
	assert.ok(plan.checkPlan('{"type":"formula","formula":"=COUNTIFS(B2:B4,\\"Ndola\\")"}', table, "orders from Ndola?").ok);
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
