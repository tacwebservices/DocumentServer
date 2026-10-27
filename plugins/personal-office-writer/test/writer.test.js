// SPDX-FileCopyrightText: 2026 Personal Office
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run with: node --test plugins/personal-office-writer/test/
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const writing = require("../scripts/writing.js");
const references = require("../scripts/references.js");
const flowchart = require("../scripts/flowchart.js");
const docSummary = require("../scripts/doc-summary.js");

// Applies operations the way the editor does: each search text must occur once.
function apply(text, operations) {
	operations.forEach(op => {
		assert.strictEqual(text.split(op.find).length, 2, "\"" + op.find + "\" occurs once");
		const at = text.indexOf(op.find);
		if (op.replace !== undefined)
			text = text.slice(0, at) + op.replace + text.slice(at + op.find.length);
		else if (op.position === "after")
			text = text.slice(0, at + op.find.length) + op.insert + text.slice(at + op.find.length);
		else
			text = text.slice(0, at) + op.insert + text.slice(at);
	});
	return text;
}

test("writing: word changes become operations that rebuild the corrected text", () => {
	const pairs = [
		["Their are many reasons why the projet failed. We recieve the report on monday and it is is late.",
			"There are many reasons why the project failed. We received the final report on Monday, and it is late."],
		["A a cat sat on a mat in a house.", "A cat sat on the mat in a house."],
		["the cat", "The black cat"],
		["Sales rose.", "Sales rose sharply."]
	];
	pairs.forEach(([original, revised]) => {
		const ops = writing.toOperations(original, writing.diff(original, revised));
		assert.strictEqual(ops.skipped, 0);
		assert.strictEqual(apply(original, ops.operations), revised);
	});
});

test("writing: refuses rewrites that change numbers or too much", () => {
	const paragraphs = [{ id: 1, text: "Sales was 400 in March." }, { id: 2, text: "The cat sat on the mat." }];
	const reply = JSON.stringify({ paragraphs: [
		{ id: 1, text: "Sales were 500 in March." },
		{ id: 2, text: "A completely different sentence appears here instead." },
		{ id: 9, text: "Unknown paragraph." }
	] });
	const checked = writing.checkEdits(reply, "proofread", paragraphs);
	assert.ok(checked.ok);
	assert.deepStrictEqual(checked.results, []);
	assert.deepStrictEqual(checked.refused.map(r => r.id), [1, 2]);
	assert.match(checked.refused[0].reason, /number/);
	const fine = writing.checkEdits(JSON.stringify({ paragraphs: [{ id: 1, text: "Sales were 400 in March.", why: "grammar" }] }), "proofread", paragraphs);
	assert.deepStrictEqual(fine.results[0].operations.map(o => [o.find, o.replace]), [["was", "were"]]);
	assert.strictEqual(writing.checkEdits("not json", "proofread", paragraphs).ok, false);
});

test("writing: continuation and structure checks", () => {
	assert.strictEqual(writing.checkContinuation('{"continuation":"It rained."}', "The sky was grey.").text, " It rained.");
	assert.strictEqual(writing.checkContinuation('{"continuation":"The sky was grey. It rained."}', "The sky was grey. ").text, "It rained.");
	assert.strictEqual(writing.checkContinuation("{}", "x").ok, false);
	const long = Array(45).fill("word").join(" ") + ".";
	const notes = writing.checkStructure([
		{ id: "a", text: "Introduction", level: 1 },
		{ id: "b", text: long, level: 0 },
		{ id: "c", text: "Detail", level: 3 },
		{ id: "d", text: "Methods", level: 1 }
	]);
	assert.deepStrictEqual(notes.map(n => n.id), ["b", "c", "c", "d"]);
	assert.match(notes[1].note, /jumps from 1 to 3/);
	assert.match(notes[3].note, /no text/);
	const outline = [{ id: "a", heading: "Intro", level: 1 }];
	const review = writing.checkOutline('{"notes":[{"id":"a","note":"Add aims."},{"id":"zz","note":"x"}],"missing":["Conclusion"]}', outline);
	assert.deepStrictEqual(review.notes, [{ id: "a", note: "Add aims." }]);
	assert.deepStrictEqual(review.missing, ["Conclusion"]);
});

const BIB = `@article{banda2021,
  author = {Banda, John and Mwale, Grace K. and Phiri, Peter},
  title = {Solar mini-grids and diesel use in rural {Zambian} clinics},
  journal = {Energy for Sustainable Development},
  year = 2021, volume = {62}, number = {3}, pages = {10--24},
  doi = {10.1016/j.esd.2021.01.002},
  abstract = {We study solar mini-grids in rural clinics and find diesel use falls by half.}
}
@book{worldbank2019, author = {{World Bank}}, title = {Off-grid solar market trends}, publisher = {World Bank}, year = {2019}}
@misc{mulenga, author = {Chileshe Mulenga}, title = {Electricity tariffs in M\\"{u}nchen and Lusaka}, year = {2020}}`;

test("references: reads BibTeX, CSL JSON and RIS", () => {
	const lib = references.parseLibrary(BIB, "library.bib");
	assert.deepStrictEqual(lib.map(i => i.id), ["banda2021", "worldbank2019", "mulenga"]);
	assert.deepStrictEqual(lib[0].authors[1], { family: "Mwale", given: "Grace K." });
	assert.deepStrictEqual(lib[1].authors, [{ literal: "World Bank" }]);
	assert.strictEqual(lib[2].title, "Electricity tariffs in München and Lusaka");
	assert.strictEqual(lib[0].pages, "10–24");
	const csl = references.parseLibrary(JSON.stringify([{ id: "x1", type: "article-journal", title: "T", author: [{ family: "Zulu", given: "Ann" }], issued: { "date-parts": [[2018, 3]] }, DOI: "https://doi.org/10.1/abc" }]), "a.json");
	assert.deepStrictEqual([csl[0].year, csl[0].doi], ["2018", "10.1/abc"]);
	const ris = references.parseLibrary("TY  - JOUR\nAU  - Tembo, Ruth\nTI  - Maize yields\nPY  - 2017\nJO  - Field Crops\nSP  - 5\nEP  - 9\nER  - \n", "a.ris");
	assert.deepStrictEqual([ris[0].authors[0].family, ris[0].pages, ris[0].container], ["Tembo", "5–9", "Field Crops"]);
});

test("references: formats citations and the reference list in each style", () => {
	const lib = references.parseLibrary(BIB, "library.bib");
	const tags = [references.citationTag(["banda2021"]), references.citationTag(["worldbank2019", "mulenga"]), references.citationTag(["gone"])];
	const apa = references.buildBibliography(tags, lib, "apa");
	assert.deepStrictEqual(apa.citations, ["(Banda et al., 2021)", "(World Bank, 2019; Mulenga, 2020)", "[missing source]"]);
	assert.deepStrictEqual(apa.missing, ["gone"]);
	const text = runs => runs.map(r => r.text).join("");
	assert.deepStrictEqual(apa.entries.map(e => text(e).slice(0, 12)), ["Banda, J., M", "Mulenga, C. ", "World Bank. "]);
	assert.strictEqual(text(apa.entries[0]), "Banda, J., Mwale, G. K., & Phiri, P. (2021). Solar mini-grids and diesel use in rural Zambian clinics. Energy for Sustainable Development, 62(3), 10–24. https://doi.org/10.1016/j.esd.2021.01.002");
	assert.ok(apa.entries[0].some(r => r.italic && r.text.indexOf("Energy") === 0));
	const ieee = references.buildBibliography(tags, lib, "ieee");
	assert.deepStrictEqual(ieee.citations.slice(0, 2), ["[1]", "[2], [3]"]);
	assert.strictEqual(text(ieee.entries[0]).slice(0, 26), "[1] J. Banda, G. K. Mwale,");
	const harvard = references.buildBibliography(tags, lib, "harvard");
	assert.strictEqual(harvard.citations[0], "(Banda et al. 2021)");
});

test("references: the model can only pick listed sources", () => {
	const lib = references.parseLibrary(BIB, "library.bib");
	const sentences = [{ text: "Solar mini-grids cut diesel use in rural clinics." }, { text: "Tariffs rose in Lusaka last year." }];
	const candidates = references.shortlist(sentences, lib);
	assert.strictEqual(candidates[0].id, "banda2021");
	const checked = references.checkMatches(JSON.stringify({ citations: [
		{ sentence: 1, sources: ["banda2021", "invented2020"], why: "same topic" },
		{ sentence: 7, sources: ["banda2021"] },
		{ sentence: 2, sources: ["invented2020"] }
	] }), sentences, candidates);
	assert.deepStrictEqual(checked.proposals, [{ sentence: 0, ids: ["banda2021"], why: "same topic" }]);
	assert.strictEqual(checked.invented, 2);
	assert.strictEqual(references.citationAnchor("Solar grids help clinics.", "Solar grids help clinics. Clinics need power."), "clinics");
	assert.strictEqual(references.citationAnchor("Grids help clinics.", "Grids help clinics. Grids help clinics."), null);
	assert.strictEqual(references.citationAnchor("Clinics need power.", "Solar grids help clinics. Clinics need power."), "power");
});

const PROCESS = `flowchart TD
  A([Start]) --> B[/Receive application/]
  B --> C{Is the form complete?}
  C -->|No| D[Return to applicant]
  D --> B
  C -- Yes --> E[Check budget]
  E --> F{Funds available?}
  F -->|Yes| G[Approve request]
  F -->|No| H[Reject request]
  G --> Z([End])
  H --> Z`;

test("flowchart: reads Mermaid and lays it out top to bottom", () => {
	const parsed = flowchart.parseMermaid(PROCESS);
	assert.ok(parsed.ok);
	assert.deepStrictEqual(parsed.graph.nodes.map(n => n.kind), ["start", "io", "decision", "step", "step", "decision", "step", "step", "start"]);
	assert.deepStrictEqual(parsed.graph.edges.filter(e => e.label).map(e => e.label), ["No", "Yes", "Yes", "No"]);
	const chart = flowchart.layout(parsed.graph);
	const y = id => chart.nodes.find(n => n.id === id).y;
	assert.ok(y("A") < y("B") && y("B") < y("C") && y("C") < y("E") && y("F") < y("G") && y("G") < y("Z"));
	assert.strictEqual(y("G"), y("H"));
	chart.nodes.forEach(n => assert.ok(n.x >= 0 && n.x + n.w <= chart.width + 0.01));
	// The loop from D (left column) back to B runs up the left side, clear of
	// the boxes, and ends in an arrow into B's left edge
	const B = chart.nodes.find(n => n.id === "B"), D = chart.nodes.find(n => n.id === "D");
	assert.ok(D.x < B.x);
	assert.ok(chart.lines.some(l => l.arrow && l.x2 === B.x && l.y2 === B.y + B.h / 2 && l.x1 < B.x));
	assert.ok(chart.lines.filter(l => l.x1 === l.x2).every(l => !chart.nodes.some(n => l.x1 > n.x + 0.1 && l.x1 < n.x + n.w - 0.1 &&
		Math.max(l.y1, l.y2) > n.y + 0.1 && Math.min(l.y1, l.y2) < n.y + n.h - 0.1)), "no vertical line crosses a box");
	assert.strictEqual(chart.labels.length, 4);
	assert.match(flowchart.toSVG(chart), /^<svg[\s\S]*Receive application[\s\S]*<\/svg>$/);
	assert.match(flowchart.toDrawio(parsed.graph, chart, "Approval"), /<mxCell id="e2" value="No"[^>]*source="n2" target="n3"/);
	assert.ok(flowchart.parseMermaid(flowchart.toMermaid(parsed.graph)).ok);
});

test("flowchart: rejects answers without a usable chart", () => {
	assert.strictEqual(flowchart.checkReply('{"mermaid":"flowchart TD\\nA[Only one]"}').ok, false);
	assert.strictEqual(flowchart.checkReply("I cannot help").ok, false);
	const ok = flowchart.checkReply('{"title":"Steps","mermaid":"graph TD; A[One] --> B[Two]; B --> C[\\"Three, quoted\\"]"}');
	assert.ok(ok.ok);
	assert.deepStrictEqual(ok.graph.nodes.map(n => n.text), ["One", "Two", "Three, quoted"]);
});

test("flowchart: steps from the model become a chart", () => {
	const reply = JSON.stringify({ title: "Approval", steps: [
		{ id: 1, text: "Application arrives", type: "start", next: [{ to: 2, label: "No" }] },
		{ id: 2, text: "Form complete?", type: "decision", next: [{ to: 3, label: "Yes" }, { to: 1, label: "No" }] },
		{ id: 3, text: "Approve [now]", type: "end", next: [{ to: 99 }] }
	] });
	const checked = flowchart.checkReply(reply);
	assert.ok(checked.ok);
	assert.strictEqual(checked.title, "Approval");
	assert.deepStrictEqual(checked.graph.nodes.map(n => [n.kind, n.text]), [["start", "Application arrives"], ["decision", "Form complete?"], ["start", "Approve now"]]);
	assert.deepStrictEqual(checked.graph.edges.map(e => [e.from, e.to, e.label]), [["S1", "S2", ""], ["S2", "S3", "Yes"], ["S2", "S1", "No"]]);
});

test("visual summary: numbers come from the tables, totals are not counted twice", () => {
	assert.deepStrictEqual(["K 1,200", "(300)", "12.5%", "1 200", "ZMW 4,000.50", "abc", ""].map(docSummary.parseNumber),
		[1200, -300, 12.5, 1200, 4000.5, null, null]);
	const tables = docSummary.describeTables([
		{ index: 1, caption: "Table 1: Sales", rows: [["Branch", "Month", "Sales (K)"], ["Lusaka", "Jan", "1,200"], ["Ndola", "Jan", "800"], ["Lusaka", "Feb", "1,500"], ["Kitwe", "Feb", "950"], ["Total", "", "4,450"]] },
		{ index: 2, rows: [["Name", "Role"], ["Ann", "Chair"], ["Ben", "Clerk"]] }
	]);
	assert.deepStrictEqual(tables.map(t => [t.index, t.rowCount]), [[1, 4]]);
	const checked = docSummary.checkReply(JSON.stringify({ charts: [
		{ table: 1, groupBy: "Branch", value: "Sales (K)", aggregation: "sum", chart: "pie", title: "Sales by branch" },
		{ table: 1, groupBy: "Month", value: "Sales (K)", aggregation: "sum", chart: "line", title: "Sales by month" },
		{ table: 1, groupBy: "Branch", value: "Sales (K)", aggregation: "sum", chart: "bar", title: "Duplicate" },
		{ table: 1, groupBy: "Region", value: "Sales (K)", aggregation: "sum", chart: "bar", title: "Missing column" }
	] }), tables);
	assert.ok(checked.ok);
	assert.deepStrictEqual(checked.charts.map(c => [c.chart, c.labels, c.values]), [
		["pie", ["Lusaka", "Ndola", "Kitwe"], [2700, 800, 950]],
		["line", ["Jan", "Feb"], [2000, 2450]]
	]);
	assert.strictEqual(checked.charts[0].fact.text, "Highest: Lusaka (2,700, 61% of the total). Lowest: Ndola (800).");
	assert.strictEqual(checked.charts[1].fact.text, "Feb: 2,450, up 23% from Jan.");
	assert.strictEqual(checked.skipped.length, 1);
	assert.strictEqual(docSummary.checkReply('{"charts":[],"explanation":"No numbers."}', tables).error, "No numbers.");
});
