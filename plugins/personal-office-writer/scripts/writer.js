/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * "Write with Personal Office" panel for the document editor: writing help,
 * references, flowcharts and a visual summary.
 */
(function (window) {
	"use strict";

	var AI = window.PersonalOfficeAI;
	var client = AI.client, writing = AI.writing, references = AI.references, flowchart = AI.flowchart, docSummary = AI.docSummary;
	var LIBRARY_KEY = "personal-office-ai.library";
	var STYLE_KEY = "personal-office-ai.citation-style";
	var MAX_SENTENCES = 25;
	var state = { suggestion: null, proposals: null, flow: null, library: [] };

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
		Array.prototype.forEach.call(document.querySelectorAll("button.action"), function (button) {
			button.disabled = busy;
		});
	}

	function think(messages, label) {
		var started = Date.now();
		var showTime = function () {
			var seconds = Math.round((Date.now() - started) / 1000);
			setStatus((label || "Thinking…") + (seconds < 20 ? "" : " " + seconds + " s (on a laptop this can take a minute or two)"));
		};
		showTime();
		var ticker = setInterval(showTime, 1000);
		return client.chat(client.loadSettings(), messages).finally(function () {
			clearInterval(ticker);
		});
	}

	// Runs task() with the buttons disabled and shows its message or error.
	function run(task) {
		setBusy(true);
		return Promise.resolve().then(task).then(function (message) {
			if (message)
				setStatus(message, "ok");
		}, function (error) {
			setStatus(error.message, "error");
		}).then(function () {
			setBusy(false);
		});
	}

	// Asks the model and checks the answer, asking once more if the check fails.
	function askChecked(messages, check, label) {
		return think(messages, label).then(function (reply) {
			var checked = check(reply);
			if (checked.ok)
				return checked;
			return think(messages.concat([
				{ role: "assistant", content: String(reply) },
				{ role: "user", content: "That answer could not be used: " + checked.error + " Reply with a corrected JSON object." }
			]), label).then(function (again) {
				var second = check(again);
				if (!second.ok)
					throw new Error(second.error);
				return second;
			});
		});
	}

	function el(tag, text, className) {
		var node = document.createElement(tag);
		if (text)
			node.textContent = text;
		if (className)
			node.className = className;
		return node;
	}

	/* The functions passed to callCommand run inside the editor, not here,
	 * so they can only use Api, Asc.scope and globals such as AscFormat.
	 * Api.GetDocument().Document is the editor's own document, for the cursor. */

	// The selected paragraphs, or the one with the cursor. tracked is true when
	// the paragraph already has tracked changes.
	function readSelectedParagraphs() {
		var doc = Api.GetDocument();
		var range = doc.GetRangeBySelect();
		var paragraphs = range ? range.GetAllParagraphs() : [];
		if (!paragraphs.length) {
			var current = Api.GetDocument().Document.GetCurrentParagraph();
			var p = current && Api.GetByInternalId(current.GetId());
			if (p)
				paragraphs = [p];
		}
		return paragraphs.map(function (p) {
			var tracked = p.Paragraph.Content.some(function (item) {
				return item.GetReviewType && item.GetReviewType() !== 0;
			});
			return { id: p.GetInternalId(), text: p.GetText().replace(/[\r\n]+$/, ""), tracked: tracked };
		}).filter(function (p) {
			return p.text.trim();
		});
	}

	// Asc.scope.results = [{id, operations}]; each operation is applied as a tracked change.
	function applyEdits() {
		var doc = Api.GetDocument();
		var wasTracking = doc.IsTrackRevisions();
		doc.SetTrackRevisions(true);
		var applied = 0, missed = 0;
		Asc.scope.results.forEach(function (result) {
			var p = Api.GetByInternalId(result.id);
			result.operations.forEach(function (op) {
				var found = p ? p.Search(op.find, true) : [];
				if (found.length !== 1) {
					missed++;
					return;
				}
				var range = found[0];
				if (op.replace !== undefined) {
					// Deleted text stays in place, crossed out, so the new text goes after it
					range.Delete();
					if (op.replace)
						range.AddText(op.replace, "after");
				} else {
					range.AddText(op.insert, op.position);
				}
				applied++;
			});
		});
		doc.SetTrackRevisions(wasTracking);
		return { applied: applied, missed: missed };
	}

	// Body paragraphs with their heading level (0 for text).
	function readOutline() {
		var doc = Api.GetDocument();
		var paragraphs = [];
		for (var i = 0, n = doc.GetElementsCount(); i < n && paragraphs.length < 3000; i++) {
			var element = doc.GetElement(i);
			if (element.GetClassType() !== "paragraph")
				continue;
			var level = element.Paragraph.GetOutlineLvl();
			paragraphs.push({
				id: element.GetInternalId(),
				text: element.GetText().replace(/[\r\n]+$/, "").slice(0, 4000),
				level: typeof level === "number" && level >= 0 ? level + 1 : 0
			});
		}
		return paragraphs;
	}

	function addComments() {
		var added = 0;
		Asc.scope.notes.forEach(function (note) {
			var p = Api.GetByInternalId(note.id);
			if (p && p.AddComment(note.note, "Personal Office"))
				added++;
		});
		return added;
	}

	// Text before the cursor: up to two paragraphs before, and the current one
	// up to the cursor.
	function readBeforeCursor() {
		var doc = Api.GetDocument();
		var logic = Api.GetDocument().Document;
		var current = logic.GetCurrentParagraph();
		var p = current && Api.GetByInternalId(current.GetId());
		if (!p)
			return { text: "" };
		var text = p.GetText().replace(/[\r\n]+$/, "");
		var sentence = doc.GetCurrentSentence("before") || "";
		var at = sentence ? text.lastIndexOf(sentence) : -1;
		var before = at >= 0 ? text.slice(0, at + sentence.length) : text;
		var previous = [];
		for (var q = p.GetPrevious(); q && previous.length < 2; q = q.GetPrevious()) {
			if (q.GetClassType && q.GetClassType() === "paragraph")
				previous.unshift(q.GetText().replace(/[\r\n]+$/, ""));
		}
		return { text: previous.concat([before]).join("\n") };
	}

	// Asc.scope.text goes in at the cursor as a tracked insertion.
	function insertTrackedText() {
		var doc = Api.GetDocument();
		var logic = Api.GetDocument().Document;
		if (logic.IsSelectionUse())
			logic.MoveCursorRight(false, false);
		var wasTracking = doc.IsTrackRevisions();
		doc.SetTrackRevisions(true);
		var p = Api.CreateParagraph();
		p.AddText(Asc.scope.text);
		var ok = doc.InsertContent([p], true);
		doc.SetTrackRevisions(wasTracking);
		return ok;
	}

	// Asc.scope.citations = [{id, anchor, text, tag}]: a citation control goes
	// after the anchor text of paragraph id. Without id, it goes at the cursor.
	function insertCitations() {
		var doc = Api.GetDocument();
		var logic = Api.GetDocument().Document;
		var inserted = 0;
		Asc.scope.citations.forEach(function (c) {
			var space = " ";
			if (c.id) {
				var p = Api.GetByInternalId(c.id);
				var found = p ? p.Search(c.anchor, true) : [];
				if (found.length !== 1)
					return;
				found[0].Select();
				logic.MoveCursorRight(false, false);
			} else {
				if (logic.IsSelectionUse())
					logic.MoveCursorRight(false, false);
				if ((/(\s|^)$/).test(doc.GetCurrentSentence("before") || ""))
					space = "";
			}
			var sdt = Api.CreateInlineLvlSdt();
			sdt.AddText(c.text);
			sdt.SetTag(c.tag);
			sdt.SetAlias("Citation");
			var holder = Api.CreateParagraph();
			if (space)
				holder.AddText(space);
			holder.AddInlineLvlSdt(sdt);
			if (doc.InsertContent([holder], true))
				inserted++;
		});
		return inserted;
	}

	function readCitationTags() {
		return Api.GetDocument().GetAllContentControls().map(function (c) {
			return c.GetTag();
		}).filter(function (tag) {
			return String(tag).indexOf("po-cite:") === 0;
		});
	}

	// Asc.scope = {citations: [text], entries: [[{text, italic}]], hanging}:
	// rewrites each citation and the reference list at the end of the document.
	function writeBibliography() {
		var s = Asc.scope, doc = Api.GetDocument();
		var controls = doc.GetAllContentControls().filter(function (c) {
			return String(c.GetTag()).indexOf("po-cite:") === 0;
		});
		controls.forEach(function (control, i) {
			var text = s.citations[i];
			if (text !== undefined && control.GetRange().GetText() !== text) {
				control.RemoveAllElements();
				control.AddText(text);
			}
		});
		var list = doc.GetContentControlsByTag("po-references")[0];
		if (!list) {
			if (!s.entries.length)
				return { created: false };
			var heading = Api.CreateParagraph();
			heading.AddText(s.heading);
			var style = doc.GetStyle("Heading 1");
			if (style)
				heading.SetStyle(style);
			doc.Push(heading);
			list = Api.CreateBlockLvlSdt();
			list.SetTag("po-references");
			list.SetAlias("Reference list");
			doc.Push(list);
		}
		var content = list.GetContent();
		content.RemoveAllElements();
		s.entries.forEach(function (runs) {
			var p = Api.CreateParagraph();
			runs.forEach(function (r) {
				var run = p.AddText(r.text);
				if (r.italic)
					run.SetItalic(true);
			});
			if (s.hanging) {
				p.SetIndLeft(720);
				p.SetIndFirstLine(-720);
			}
			content.Push(p);
		});
		// A cleared control keeps one empty paragraph
		if (content.GetElementsCount() > s.entries.length && !content.GetElement(0).GetText().trim())
			content.RemoveElement(0);
		return { created: true };
	}

	// Asc.scope = {title, nodes, lines, labels} in millimetres. The shapes go
	// in a new paragraph after the cursor; they are grouped by groupFlowchart.
	function insertFlowchart() {
		var s = Asc.scope, doc = Api.GetDocument();
		var mm = 36000;
		var logic = Api.GetDocument().Document;
		var current = logic.GetCurrentParagraph();
		var anchor = current && Api.GetByInternalId(current.GetId());
		var holder = Api.CreateParagraph();
		// Only beside a top-level paragraph: not inside a table, content control or shape
		if (anchor && !anchor.GetParentTable() && !anchor.GetParentContentControl() && anchor.Paragraph.GetParent() === logic)
			anchor.InsertParagraph(holder, "after", true);
		else
			doc.Push(holder);
		var blue = Api.CreateRGBColor(30, 94, 255), grey = Api.CreateRGBColor(60, 60, 60);
		var fill = Api.CreateSolidFill(Api.CreateRGBColor(222, 235, 255));
		var types = { start: "flowChartTerminator", step: "flowChartProcess", decision: "flowChartDecision", io: "flowChartInputOutput" };
		var place = function (shape, x, y) {
			shape.SetWrappingStyle("inFront");
			shape.SetHorPosition("column", Math.round(x * mm));
			shape.SetVerPosition("paragraph", Math.round(y * mm));
			holder.AddDrawing(shape);
		};
		var addText = function (shape, text, size, color, jc) {
			var p = shape.GetDocContent().GetElement(0);
			p.SetJc(jc || "center");
			p.SetSpacingAfter(0);
			p.SetSpacingBefore(0);
			var run = p.AddText(text);
			run.SetFontSize(size);
			run.SetColor(color[0], color[1], color[2]);
			shape.SetVerticalTextAlign("center");
			shape.SetPaddings(36000, 0, 36000, 0);
		};
		s.nodes.forEach(function (n) {
			var shape = Api.CreateShape(types[n.kind] || "flowChartProcess", Math.round(n.w * mm), Math.round(n.h * mm), fill, Api.CreateStroke(12700, Api.CreateSolidFill(blue)));
			addText(shape, n.text, 18, [0, 0, 0]);
			place(shape, n.x, n.y);
		});
		var arrows = 0;
		s.lines.forEach(function (l) {
			var stroke = Api.CreateStroke(12700, Api.CreateSolidFill(grey));
			if (l.arrow) {
				try {
					var end = new AscFormat.EndArrow();
					end.setType(AscFormat.LineEndType.Triangle);
					end.setLen(AscFormat.LineEndSize.Mid);
					end.setW(AscFormat.LineEndSize.Mid);
					stroke.Ln.setTailEnd(end);
					arrows++;
				} catch (e) {}
			}
			var w = Math.abs(l.x2 - l.x1), h = Math.abs(l.y2 - l.y1);
			var line = Api.CreateShape("line", Math.max(1, Math.round(w * mm)), Math.max(1, Math.round(h * mm)), Api.CreateNoFill(), stroke);
			if (l.x2 < l.x1)
				line.SetFlipH(true);
			if (l.y2 < l.y1)
				line.SetFlipV(true);
			place(line, Math.min(l.x1, l.x2), Math.min(l.y1, l.y2));
		});
		s.labels.forEach(function (l) {
			var w = Math.min(40, l.text.length * 1.9 + 3);
			var label = Api.CreateShape("rect", Math.round(w * mm), Math.round(4 * mm), Api.CreateNoFill(), Api.CreateStroke(0, Api.CreateNoFill()));
			addText(label, l.text, 14, [85, 85, 85], "left");
			label.SetPaddings(0, 0, 0, 0);
			place(label, l.x, l.y);
		});
		var caption = Api.CreateParagraph();
		caption.AddText(s.title).SetItalic(true);
		caption.SetJc("center");
		holder.InsertParagraph(caption, "after", true);
		return { id: holder.GetInternalId(), arrows: arrows };
	}

	function groupFlowchart() {
		var doc = Api.GetDocument();
		var holder = Api.GetByInternalId(Asc.scope.id);
		if (!holder)
			return { grouped: false };
		var group = doc.GroupDrawings(holder.GetAllDrawingObjects());
		if (!group)
			return { grouped: false };
		group.SetWrappingStyle("topAndBottom");
		group.SetHorAlign("column", "center");
		// Grouping turns the page position into the offset from the paragraph
		group.SetVerPosition("paragraph", 0);
		return { grouped: true };
	}

	// Every table's cell text, with the paragraph before it as a caption.
	function readTables() {
		var doc = Api.GetDocument();
		return doc.GetAllTables().map(function (table, i) {
			var rows = [];
			for (var r = 0; r < table.GetRowsCount() && r < 500; r++) {
				var row = table.GetRow(r), cells = [];
				for (var c = 0; c < row.GetCellsCount(); c++) {
					var content = row.GetCell(c).GetContent(), texts = [];
					for (var e = 0; e < content.GetElementsCount(); e++) {
						var element = content.GetElement(e);
						if (element.GetClassType() === "paragraph")
							texts.push(element.GetText().replace(/[\r\n]+$/, ""));
					}
					cells.push(texts.join(" ").trim());
				}
				rows.push(cells);
			}
			var caption = "";
			var position = table.GetPosInParent();
			if (position > 0 && !table.GetParentTable()) {
				var before = doc.GetElement(position - 1);
				if (before && before.GetClassType() === "paragraph") {
					var text = before.GetText().trim();
					if (text.length < 120)
						caption = text;
				}
			}
			return { index: i + 1, caption: caption, rows: rows };
		});
	}

	// Asc.scope = {charts: [{title, why, fact, flag, chart, labels, values, seriesName, table}], note}:
	// a "Visual summary" section at the end of the document, in one content
	// control so it can be replaced or removed.
	function insertVisualSummary() {
		var s = Asc.scope, doc = Api.GetDocument();
		doc.GetContentControlsByTag("po-visual-summary").forEach(function (old) {
			old.Delete(false);
		});
		var tables = doc.GetAllTables();
		var block = Api.CreateBlockLvlSdt();
		block.SetTag("po-visual-summary");
		block.SetAlias("Visual summary");
		var content = block.GetContent();
		content.RemoveAllElements();
		var styled = function (text, styleName) {
			var p = Api.CreateParagraph();
			p.AddText(text);
			var style = doc.GetStyle(styleName);
			if (style)
				p.SetStyle(style);
			return p;
		};
		var heading = styled("Visual summary", "Heading 1");
		heading.SetPageBreakBefore(true);
		content.Push(heading);
		var note = Api.CreateParagraph();
		note.AddText(s.note).SetItalic(true);
		content.Push(note);
		var failed = [];
		s.charts.forEach(function (c) {
			content.Push(styled(c.title, "Heading 2"));
			try {
				var chart = Api.CreateChart(c.chart, [c.values], [c.seriesName], c.labels, 15 * 360000, 7.5 * 360000, 24);
				chart.SetLegendPos(c.chart === "pie" ? "right" : "none");
				chart.SetShowDataLabels(false, false, true, false);
				var holder = Api.CreateParagraph();
				holder.AddDrawing(chart);
				content.Push(holder);
			} catch (e) {
				failed.push(c.title);
			}
			if (c.fact) {
				var fact = Api.CreateParagraph();
				var run = fact.AddText((c.flag ? "⚠ " : "") + c.fact);
				if (c.flag)
					run.SetColor(192, 0, 0);
				content.Push(fact);
			}
			if (c.why) {
				var why = Api.CreateParagraph();
				why.AddText(c.why).SetItalic(true);
				content.Push(why);
			}
			var source = Api.CreateParagraph();
			// A caption such as "Table 1: Sales" already names the table
			var named = c.caption && (/^tables*d+/i).test(c.caption);
			source.AddText("Source: " + (named ? c.caption : "Table " + c.table + (c.caption ? " (" + c.caption + ")" : "")));
			var table = tables[c.table - 1];
			var bookmark = "po_table_" + c.table;
			try {
				if (table && table.GetRange().AddBookmark(bookmark))
					source.AddHyperlink("", "Go to table " + c.table, bookmark);
			} catch (e) {}
			content.Push(source);
		});
		if (content.GetElementsCount() && !content.GetElement(0).GetText().trim())
			content.RemoveElement(0);
		doc.Push(block);
		return { failed: failed };
	}

	function removeVisualSummary() {
		var removed = 0;
		Api.GetDocument().GetContentControlsByTag("po-visual-summary").forEach(function (block) {
			block.Delete(false);
			removed++;
		});
		return removed;
	}

	/* Writing */

	function checkWriting() {
		var mode = $("mode").value;
		$("writing-results").textContent = "";
		run(function () {
			setStatus("Reading the text…");
			return callCommand(readSelectedParagraphs).then(function (paragraphs) {
				if (!paragraphs.length)
					throw new Error("Select the text to check, or put the cursor in a paragraph.");
				var tracked = paragraphs.filter(function (p) { return p.tracked; }).length;
				paragraphs = paragraphs.filter(function (p) { return !p.tracked; });
				if (!paragraphs.length)
					throw new Error("This text already has tracked changes. Accept or reject them first (Collaboration tab).");
				var chunks = writing.chunkParagraphs(paragraphs);
				var all = { results: [], refused: [], skipped: 0 };
				var next = function (i) {
					if (i >= chunks.length)
						return Promise.resolve(all);
					var label = chunks.length > 1 ? "Checking part " + (i + 1) + " of " + chunks.length + "…" : "Checking…";
					return askChecked(writing.buildEditMessages(mode, chunks[i]), function (reply) {
						return writing.checkEdits(reply, mode, chunks[i]);
					}, label).then(function (checked) {
						all.results = all.results.concat(checked.results);
						all.refused = all.refused.concat(checked.refused);
						all.skipped += checked.skipped;
						return next(i + 1);
					});
				};
				return next(0).then(function (all) {
					all.tracked = tracked;
					all.texts = {};
					paragraphs.forEach(function (p) { all.texts[p.id] = p.text; });
					return all;
				});
			}).then(function (all) {
				if (!all.results.length) {
					showWritingResults(all, null);
					return all.refused.length ? "No changes were added." : "No changes needed.";
				}
				setStatus("Adding the suggestions…");
				return callCommand(applyEdits, { results: all.results }).then(function (done) {
					showWritingResults(all, done);
					return done.applied + " suggestion" + (done.applied === 1 ? "" : "s") + " added as tracked changes. Accept or reject them in the Collaboration tab.";
				});
			});
		});
	}

	function showWritingResults(all, done) {
		var list = $("writing-results");
		list.textContent = "";
		all.results.forEach(function (r) {
			var item = el("li");
			item.appendChild(el("strong", "“" + all.texts[r.id].slice(0, 50).trim() + "…”"));
			item.appendChild(el("span", ": " + r.changes + " change" + (r.changes === 1 ? "" : "s") + (r.why ? " (" + r.why + ")" : "")));
			list.appendChild(item);
		});
		all.refused.forEach(function (r) {
			list.appendChild(el("li", "“" + all.texts[r.id].slice(0, 50).trim() + "…”: not changed, because " + r.reason + ".", "muted"));
		});
		var missed = (done ? done.missed : 0) + all.skipped;
		if (missed)
			list.appendChild(el("li", missed + " change" + (missed === 1 ? " was" : "s were") + " left out because the text could not be found exactly.", "muted"));
		if (all.tracked)
			list.appendChild(el("li", all.tracked + " paragraph" + (all.tracked === 1 ? " was" : "s were") + " skipped because they already have tracked changes.", "muted"));
	}

	function continueWriting() {
		$("suggestion").hidden = true;
		run(function () {
			return callCommand(readBeforeCursor).then(function (read) {
				if (!read.text.trim())
					throw new Error("Put the cursor after some text, and a sentence will be suggested to continue it.");
				return askChecked(writing.buildContinueMessages(read.text), function (reply) {
					return writing.checkContinuation(reply, read.text);
				}, "Writing a suggestion…");
			}).then(function (checked) {
				state.suggestion = checked.text;
				$("suggestion-text").textContent = checked.text.trim();
				$("suggestion").hidden = false;
				return "Suggestion ready.";
			});
		});
	}

	function insertSuggestion() {
		if (!state.suggestion)
			return;
		run(function () {
			return callCommand(insertTrackedText, { text: state.suggestion }).then(function () {
				$("suggestion").hidden = true;
				state.suggestion = null;
				return "Inserted as a tracked change at the cursor.";
			});
		});
	}

	function checkStructure() {
		$("writing-results").textContent = "";
		run(function () {
			setStatus("Reading the document…");
			return callCommand(readOutline).then(function (paragraphs) {
				var notes = writing.checkStructure(paragraphs);
				var headings = [];
				paragraphs.forEach(function (p, i) {
					if (!p.level)
						return;
					var next = paragraphs.slice(i + 1).filter(function (q) { return !q.level && q.text.trim(); })[0];
					headings.push({ id: p.id, level: p.level, heading: p.text.slice(0, 120), start: next ? writing.sentences(next.text)[0].slice(0, 200) : "" });
				});
				var outlineReview = headings.length >= 2 ?
					askChecked(writing.buildOutlineMessages(headings.slice(0, 60)), function (reply) {
						return writing.checkOutline(reply, headings);
					}, "Reviewing the outline…") : Promise.resolve({ notes: [], missing: [] });
				return outlineReview.then(function (review) {
					var all = notes.concat(review.notes);
					var list = $("writing-results");
					all.forEach(function (n) { list.appendChild(el("li", n.note)); });
					review.missing.forEach(function (m) { list.appendChild(el("li", "The document may need a section on: " + m, "muted")); });
					if (!all.length)
						return review.missing.length ? "The structure looks fine; see the ideas below." : "No structure problems found.";
					return callCommand(addComments, { notes: all }).then(function (added) {
						return added + " comment" + (added === 1 ? "" : "s") + " added. Find them in the Comments panel on the left.";
					});
				});
			});
		});
	}

	/* References */

	function loadLibrary() {
		try {
			state.library = JSON.parse(localStorage.getItem(LIBRARY_KEY)) || [];
		} catch (e) {
			state.library = [];
		}
		showLibrary();
	}

	function saveLibrary() {
		try {
			localStorage.setItem(LIBRARY_KEY, JSON.stringify(state.library));
		} catch (e) {
			setStatus("The library is too big to keep in this browser; it will be gone after reloading.", "error");
		}
	}

	function citationStyle() {
		return $("style").value;
	}

	function showLibrary() {
		var count = state.library.length;
		$("library-info").textContent = count ? count + " source" + (count === 1 ? "" : "s") + " in your library." :
			"No library yet. Export your sources from Zotero, Mendeley or EndNote as BibTeX (.bib), CSL JSON or RIS, then import the file.";
		$("library-clear").hidden = !count;
		searchLibrary();
	}

	function importLibrary(event) {
		var file = event.target.files[0];
		event.target.value = "";
		if (!file)
			return;
		var reader = new FileReader();
		reader.onload = function () {
			try {
				var items = references.parseLibrary(reader.result, file.name);
				if (!items.length)
					throw new Error("No sources were found in " + file.name + ".");
				var byId = {};
				state.library.forEach(function (item) { byId[item.id] = item; });
				items.forEach(function (item) { byId[item.id] = item; });
				state.library = Object.keys(byId).map(function (id) { return byId[id]; });
				saveLibrary();
				showLibrary();
				setStatus("Imported " + items.length + " source" + (items.length === 1 ? "" : "s") + " from " + file.name + ".", "ok");
			} catch (e) {
				setStatus("Could not read " + file.name + ": " + e.message, "error");
			}
		};
		reader.readAsText(file);
	}

	function clearLibrary() {
		state.library = [];
		saveLibrary();
		showLibrary();
		setStatus("Library cleared. Citations already in the document stay.", "ok");
	}

	function describeItem(item) {
		var names = item.authors.slice(0, 2).map(function (a) { return a.literal || a.family; }).join(", ") + (item.authors.length > 2 ? " et al." : "");
		return (names ? names + " " : "") + "(" + (item.year || "n.d.") + "). " + item.title;
	}

	function searchLibrary() {
		var list = $("library-results");
		list.textContent = "";
		if (!state.library.length)
			return;
		references.searchLibrary(state.library, $("library-search").value).slice(0, 15).forEach(function (item) {
			var row = el("li");
			var cite = el("button", "Cite", "btn-text-default small action");
			cite.title = "Insert a citation at the cursor";
			cite.onclick = function () {
				insertCitationList([{ ids: [item.id] }]);
			};
			row.appendChild(cite);
			row.appendChild(el("span", " " + describeItem(item)));
			list.appendChild(row);
		});
	}

	function libraryById() {
		var byId = {};
		state.library.forEach(function (item) { byId[item.id] = item; });
		return byId;
	}

	function findSources() {
		$("proposals").textContent = "";
		$("insert-citations").hidden = true;
		state.proposals = null;
		run(function () {
			if (!state.library.length)
				throw new Error("Import your library first. Personal Office only cites sources from your own library, so no reference is ever made up.");
			setStatus("Reading the text…");
			return callCommand(readSelectedParagraphs).then(function (paragraphs) {
				var sentences = [];
				paragraphs.forEach(function (p) {
					writing.sentences(p.text).forEach(function (text) {
						if (text.split(/\s+/).length >= 5 && sentences.length < MAX_SENTENCES)
							sentences.push({ id: p.id, text: text.trim(), paragraph: p.text });
					});
				});
				if (!sentences.length)
					throw new Error("Select the sentences that need sources.");
				var candidates = references.shortlist(sentences, state.library);
				if (!candidates.length)
					throw new Error("No source in your library shares words with the selected text.");
				return askChecked(references.buildMatchMessages(sentences, candidates), function (reply) {
					return references.checkMatches(reply, sentences, candidates);
				}, "Matching sentences to your sources…").then(function (checked) {
					if (!checked.proposals.length)
						return "None of your sources clearly supports these sentences.";
					state.proposals = checked.proposals.map(function (p) {
						return { sentence: sentences[p.sentence], ids: p.ids, why: p.why };
					});
					showProposals();
					return checked.proposals.length + " citation" + (checked.proposals.length === 1 ? "" : "s") + " suggested. Untick any you do not want, then insert." +
						(checked.invented ? " " + checked.invented + " source" + (checked.invented === 1 ? "" : "s") + " not in your library were ignored." : "");
				});
			});
		});
	}

	function showProposals() {
		var byId = libraryById();
		var list = $("proposals");
		list.textContent = "";
		state.proposals.forEach(function (p, i) {
			var item = el("li");
			var label = el("label", "", "proposal");
			var box = el("input");
			box.type = "checkbox";
			box.checked = true;
			box.dataset.index = i;
			label.appendChild(box);
			var items = p.ids.map(function (id) { return byId[id]; });
			label.appendChild(el("span", " “…" + p.sentence.text.slice(-60) + "” "));
			label.appendChild(el("strong", references.formatCitation(items, citationStyle() === "ieee" ? "apa" : citationStyle(), {})));
			item.appendChild(label);
			item.appendChild(el("div", items.map(describeItem).join("; ") + (p.why ? ". " + p.why : ""), "muted"));
			list.appendChild(item);
		});
		$("insert-citations").hidden = false;
	}

	// Inserts citations, then renumbers them and rewrites the reference list.
	// list: [{ids, sentence?}]; without a sentence the citation goes at the cursor.
	function insertCitationList(list) {
		var byId = libraryById();
		var citations = [];
		list.forEach(function (c) {
			var items = c.ids.map(function (id) { return byId[id]; }).filter(Boolean);
			if (!items.length)
				return;
			var entry = { tag: references.citationTag(c.ids), text: references.formatCitation(items, citationStyle() === "ieee" ? "apa" : citationStyle(), {}) };
			if (c.sentence) {
				entry.id = c.sentence.id;
				entry.anchor = references.citationAnchor(c.sentence.text, c.sentence.paragraph);
				if (!entry.anchor)
					return;
			}
			citations.push(entry);
		});
		return run(function () {
			if (!citations.length)
				throw new Error("Nothing to insert.");
			return callCommand(insertCitations, { citations: citations }).then(function (inserted) {
				return updateBibliography().then(function (message) {
					var missed = citations.length - inserted;
					return inserted + " citation" + (inserted === 1 ? "" : "s") + " inserted. " + message +
						(missed ? " " + missed + " could not be placed because the sentence was not found." : "");
				});
			});
		});
	}

	function insertTickedCitations() {
		var ticked = Array.prototype.filter.call($("proposals").querySelectorAll("input[type=checkbox]"), function (box) {
			return box.checked;
		}).map(function (box) {
			return state.proposals[Number(box.dataset.index)];
		});
		insertCitationList(ticked).then(function () {
			$("proposals").textContent = "";
			$("insert-citations").hidden = true;
		});
	}

	function updateBibliography() {
		var style = citationStyle();
		return callCommand(readCitationTags).then(function (tags) {
			var built = references.buildBibliography(tags, state.library, style);
			return callCommand(writeBibliography, {
				citations: built.citations,
				entries: built.entries,
				heading: "References",
				hanging: !references.STYLES[style].numeric
			}).then(function () {
				if (!tags.length)
					return "There are no citations in this document yet.";
				return "Reference list updated (" + built.entries.length + " source" + (built.entries.length === 1 ? "" : "s") + ", " + references.STYLES[style].name + ")." +
					(built.missing.length ? " " + built.missing.length + " cited source" + (built.missing.length === 1 ? " is" : "s are") + " not in your library: import it again." : "");
			});
		});
	}

	/* Flowchart */

	function drawFlowchart() {
		$("flow-result").hidden = true;
		run(function () {
			var typed = $("process").value.trim();
			var description = typed ? Promise.resolve(typed) : callCommand(readSelectedParagraphs).then(function (paragraphs) {
				return paragraphs.map(function (p) { return p.text; }).join("\n");
			});
			return description.then(function (text) {
				if (text.trim().split(/\s+/).length < 5)
					throw new Error("Describe the process in a few sentences, or select the text in the document that describes it.");
				return askChecked(flowchart.buildMessages(text), flowchart.checkReply, "Drawing the flowchart…");
			}).then(function (checked) {
				showFlowchart(checked.graph, checked.title);
				return "Check the flowchart, then insert it. You can edit the steps under the preview.";
			});
		});
	}

	function showFlowchart(graph, title) {
		var chart = flowchart.layout(graph);
		state.flow = { graph: graph, chart: chart, title: title };
		$("flow-preview").innerHTML = flowchart.toSVG(chart);
		$("flow-title").value = title;
		$("flow-source").value = flowchart.toMermaid(graph);
		$("flow-result").hidden = false;
	}

	function redrawFlowchart() {
		var parsed = flowchart.parseMermaid($("flow-source").value);
		if (!parsed.ok) {
			setStatus(parsed.error, "error");
			return;
		}
		showFlowchart(parsed.graph, $("flow-title").value.trim() || "Flowchart");
		setStatus("Redrawn.", "ok");
	}

	function insertFlowchartIntoDocument() {
		var flow = state.flow;
		if (!flow)
			return;
		var title = $("flow-title").value.trim() || "Flowchart";
		run(function () {
			setStatus("Drawing the shapes…");
			return callCommand(insertFlowchart, { title: title, nodes: flow.chart.nodes, lines: flow.chart.lines, labels: flow.chart.labels }).then(function (res) {
				return callCommand(groupFlowchart, { id: res.id }).then(function (group) {
					return "Flowchart inserted below the cursor" + (group.grouped ? " as one group" : "") +
						". Every box is an ordinary shape: double-click to edit its text.";
				});
			});
		});
	}

	function downloadDrawio() {
		var flow = state.flow;
		if (!flow)
			return;
		var title = $("flow-title").value.trim() || "Flowchart";
		var blob = new Blob([flowchart.toDrawio(flow.graph, flow.chart, title)], { type: "application/xml" });
		var link = document.createElement("a");
		link.href = URL.createObjectURL(blob);
		link.download = title.replace(/[\\\/:*?"<>|]+/g, " ").trim() + ".drawio";
		document.body.appendChild(link);
		link.click();
		setTimeout(function () {
			URL.revokeObjectURL(link.href);
			link.remove();
		}, 1000);
		setStatus("Saved " + link.download + ". Open it at app.diagrams.net or in the draw.io app.", "ok");
	}

	/* Visual summary */

	function visualSummary() {
		$("visual-charts").textContent = "";
		run(function () {
			setStatus("Reading the tables…");
			return callCommand(readTables).then(function (read) {
				var tables = docSummary.describeTables(read);
				if (!tables.length)
					throw new Error(read.length ? "The tables in this document have no numbers to chart, so there is no visual summary to make." :
						"This document has no tables. A visual summary is made from tables of numbers.");
				return askChecked(docSummary.buildMessages(tables), function (reply) {
					return docSummary.checkReply(reply, tables);
				}, "Choosing the charts…");
			}).then(function (checked) {
				var charts = checked.charts.map(function (c) {
					return {
						title: c.title, why: c.explanation, fact: c.fact.text, flag: c.fact.flag, chart: c.editorChart,
						labels: c.labels, values: c.values, seriesName: c.seriesName, table: c.table.index, caption: c.table.caption
					};
				});
				setStatus("Adding the charts…");
				return callCommand(insertVisualSummary, {
					charts: charts,
					note: "Charts made from the tables in this document. Every value is calculated from the table named under its chart; nothing is estimated."
				}).then(function (res) {
					var list = $("visual-charts");
					charts.forEach(function (c) {
						var item = el("li");
						item.appendChild(el("strong", c.title));
						item.appendChild(el("span", ": " + c.fact));
						list.appendChild(item);
					});
					$("visual-remove").hidden = false;
					var drawn = charts.length - res.failed.length;
					return "Added a \"Visual summary\" section with " + drawn + " chart" + (drawn === 1 ? "" : "s") + " at the end of the document." +
						(res.failed.length ? " Could not draw: " + res.failed.join(", ") + "." : "");
				});
			});
		});
	}

	function removeVisual() {
		run(function () {
			return callCommand(removeVisualSummary).then(function (removed) {
				$("visual-remove").hidden = true;
				$("visual-charts").textContent = "";
				return removed ? "Visual summary removed." : "There is no visual summary in this document.";
			});
		});
	}

	/* Panel */

	function showTab(name) {
		Array.prototype.forEach.call(document.querySelectorAll("[role=tab]"), function (tab) {
			var selected = tab.dataset.tab === name;
			tab.setAttribute("aria-selected", selected);
			$("tab-" + tab.dataset.tab).hidden = !selected;
		});
		setStatus("");
	}

	window.Asc.plugin.init = function () {
		Object.keys(writing.MODES).forEach(function (key) {
			$("mode").add(new Option(writing.MODES[key].name, key));
		});
		Object.keys(references.STYLES).forEach(function (key) {
			$("style").add(new Option(references.STYLES[key].name, key));
		});
		try {
			$("style").value = localStorage.getItem(STYLE_KEY) || "apa";
		} catch (e) {}
		Array.prototype.forEach.call(document.querySelectorAll("[role=tab]"), function (tab) {
			tab.onclick = function () { showTab(tab.dataset.tab); };
		});
		$("check").onclick = checkWriting;
		$("continue").onclick = continueWriting;
		$("suggestion-insert").onclick = insertSuggestion;
		$("suggestion-again").onclick = continueWriting;
		$("suggestion-dismiss").onclick = function () {
			$("suggestion").hidden = true;
			state.suggestion = null;
		};
		$("structure").onclick = checkStructure;
		$("library-file").onchange = importLibrary;
		$("library-clear").onclick = clearLibrary;
		$("library-search").oninput = searchLibrary;
		$("style").onchange = function () {
			try {
				localStorage.setItem(STYLE_KEY, citationStyle());
			} catch (e) {}
			run(updateBibliography);
		};
		$("find-sources").onclick = findSources;
		$("insert-citations").onclick = insertTickedCitations;
		$("update-references").onclick = function () {
			run(updateBibliography);
		};
		$("draw").onclick = drawFlowchart;
		$("flow-redraw").onclick = redrawFlowchart;
		$("flow-insert").onclick = insertFlowchartIntoDocument;
		$("flow-drawio").onclick = downloadDrawio;
		$("visual").onclick = visualSummary;
		$("visual-remove").onclick = removeVisual;
		AI.settingsPanel.init(function () {
			setStatus("Settings saved.", "ok");
		});
		loadLibrary();
	};

	window.Asc.plugin.button = function () {
		this.executeCommand("close", "");
	};
})(window);
