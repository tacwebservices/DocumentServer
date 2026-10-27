/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Writing help. The language model rewrites paragraphs; the changes are
 * worked out here, word by word, and shown as tracked changes, so nothing is
 * rewritten silently. Structure checks are plain rules, not AI guesses.
 */
(function (exports) {
	"use strict";

	var MODES = {
		proofread: {
			name: "Fix spelling and grammar",
			task: "Correct spelling, grammar and punctuation only. Keep the author's words, style and meaning; change as little as possible.",
			maxChange: 0.5
		},
		clearer: {
			name: "Make it clearer",
			task: "Make the text clearer and more concise: shorter sentences, plain words, active voice. Keep every fact, name and number.",
			maxChange: 0.9
		},
		formal: {
			name: "Make it more formal",
			task: "Make the tone formal and professional, as for a report. Keep every fact, name and number.",
			maxChange: 0.9
		}
	};
	var MAX_TOKENS = 700; // longer paragraphs are skipped: the diff grows with the square
	var CHUNK_CHARS = 2500; // text sent per request, so a laptop model answers in time
	var LONG_SENTENCE_WORDS = 40;
	var LONG_PARAGRAPH_WORDS = 180;

	// Words, numbers, spaces and single punctuation marks; joined they give the text back.
	function tokenize(text) {
		return String(text).match(/\s+|[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || [];
	}

	function numbersIn(text) {
		return (String(text).match(/\d+(?:[.,]\d+)*/g) || []).map(function (n) {
			return n.replace(/,/g, "");
		}).sort();
	}

	// Longest common subsequence of two token lists, as matched index pairs.
	function commonTokens(a, b) {
		var n = a.length, m = b.length, i, j;
		var lengths = new Array((n + 1) * (m + 1)).fill(0);
		for (i = n - 1; i >= 0; i--) {
			for (j = m - 1; j >= 0; j--) {
				lengths[i * (m + 1) + j] = a[i] === b[j] ? lengths[(i + 1) * (m + 1) + j + 1] + 1 :
					Math.max(lengths[(i + 1) * (m + 1) + j], lengths[i * (m + 1) + j + 1]);
			}
		}
		var pairs = [];
		for (i = 0, j = 0; i < n && j < m;) {
			if (a[i] === b[j]) {
				pairs.push([i, j]);
				i++;
				j++;
			} else if (lengths[(i + 1) * (m + 1) + j] >= lengths[i * (m + 1) + j + 1]) {
				i++;
			} else {
				j++;
			}
		}
		return pairs;
	}

	// Changes that turn original into revised: [{start, end, text}] in
	// character offsets of original. Changes separated only by a space are
	// joined, so "recieve the" -> "received a" reads as one change.
	function diff(original, revised) {
		var a = tokenize(original), b = tokenize(revised);
		var pairs = commonTokens(a, b).concat([[a.length, b.length]]);
		var offsets = [0];
		a.forEach(function (t, i) { offsets.push(offsets[i] + t.length); });
		var changes = [], ai = 0, bi = 0;
		pairs.forEach(function (pair) {
			if (pair[0] > ai || pair[1] > bi)
				changes.push({ from: ai, to: pair[0], text: b.slice(bi, pair[1]).join("") });
			ai = pair[0] + 1;
			bi = pair[1] + 1;
		});
		var merged = [];
		changes.forEach(function (c) {
			var last = merged[merged.length - 1];
			if (last && c.from - last.to === 1 && (/^\s+$/).test(a[last.to])) {
				last.text += a[last.to] + c.text;
				last.to = c.to;
			} else {
				merged.push({ from: c.from, to: c.to, text: c.text });
			}
		});
		return merged.map(function (c) {
			return { start: offsets[c.from], end: offsets[c.to], text: c.text };
		});
	}

	function countOccurrences(text, part) {
		var count = 0;
		for (var at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1))
			count++;
		return count;
	}

	// The editor finds text by searching for it, so every change is turned into
	// text that occurs once in the paragraph: {find, replace} replaces it,
	// {find, insert, position: "after" | "before"} adds text next to it. Text
	// around the change is added until the search text is unique; it is also
	// checked against the new text, which is in the paragraph by then.
	function toOperations(original, changes) {
		var tokens = tokenize(original);
		var starts = [0];
		tokens.forEach(function (t, i) { starts.push(starts[i] + t.length); });
		var tokenAt = function (offset) {
			return starts.indexOf(offset);
		};
		var added = changes.map(function (c) { return c.text; }).join("\n");
		var unique = function (find) {
			return find.trim() !== "" && countOccurrences(original, find) === 1 && added.indexOf(find) < 0;
		};
		var operations = [], skipped = 0;
		changes.forEach(function (c) {
			var from = tokenAt(c.start), to = tokenAt(c.end);
			var op = null;
			if (c.end > c.start) {
				// Grow left and right one token at a time until the text is unique.
				for (var grow = 0; !op && (from - grow >= 0 || to + grow <= tokens.length); grow++) {
					var lo = Math.max(0, from - grow), hi = Math.min(tokens.length, to + grow);
					var find = tokens.slice(lo, hi).join("");
					if (unique(find))
						op = { find: find, replace: tokens.slice(lo, from).join("") + c.text + tokens.slice(to, hi).join("") };
				}
			} else if (from > 0) {
				for (var lo2 = from - 1; !op && lo2 >= 0; lo2--) {
					var before = tokens.slice(lo2, from).join("");
					if (unique(before))
						op = { find: before, insert: c.text, position: "after" };
				}
			} else {
				for (var hi2 = 1; !op && hi2 <= tokens.length; hi2++) {
					var after = tokens.slice(0, hi2).join("");
					if (unique(after))
						op = { find: after, insert: c.text, position: "before" };
				}
			}
			if (op) {
				op.start = c.start;
				operations.push(op);
			} else {
				skipped++;
			}
		});
		// Applied from the end of the paragraph backwards
		operations.sort(function (x, y) { return y.start - x.start; });
		return { operations: operations, skipped: skipped };
	}

	function changedShare(original, changes) {
		var changed = changes.reduce(function (sum, c) { return sum + Math.max(c.end - c.start, c.text.length); }, 0);
		return original.length ? changed / original.length : 1;
	}

	// Splits paragraphs into requests of about CHUNK_CHARS characters.
	function chunkParagraphs(paragraphs) {
		var chunks = [], current = [], size = 0;
		paragraphs.forEach(function (p) {
			if (current.length && size + p.text.length > CHUNK_CHARS) {
				chunks.push(current);
				current = [];
				size = 0;
			}
			current.push(p);
			size += p.text.length;
		});
		if (current.length)
			chunks.push(current);
		return chunks;
	}

	function buildEditMessages(mode, paragraphs) {
		var m = MODES[mode] || MODES.proofread;
		return [
			{
				role: "system", content: [
					"You are a careful editor. " + m.task,
					"Never add facts, names, dates or numbers. Keep the same language as the text.",
					"Reply with one JSON object only:",
					'{"paragraphs":[{"id":<id>,"text":"<the whole corrected paragraph>","why":"<a few words on what you changed>"}]}',
					"Include only paragraphs you changed. If nothing needs changing, reply {\"paragraphs\":[]}."
				].join("\n")
			},
			{
				role: "user", content: JSON.stringify(paragraphs.map(function (p) {
					return { id: p.id, text: p.text };
				}))
			}
		];
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

	// Turns the model's paragraphs into editor operations, refusing rewrites
	// that change numbers or more of the text than the mode allows.
	// paragraphs: [{id, text}] as sent. Returns {ok, results: [{id, why,
	// operations, changes}], refused: [{id, reason}], skipped} or {ok: false, error}.
	function checkEdits(reply, mode, paragraphs) {
		var answer = parseReply(reply);
		if (!answer || !Array.isArray(answer.paragraphs))
			return { ok: false, error: "The assistant's answer could not be read. Try again." };
		var m = MODES[mode] || MODES.proofread;
		var byId = {};
		paragraphs.forEach(function (p) { byId[String(p.id)] = p; });
		var results = [], refused = [], skipped = 0, seen = {};
		answer.paragraphs.forEach(function (item) {
			var source = item && byId[String(item.id)];
			if (!source || seen[source.id] || typeof item.text !== "string")
				return;
			seen[source.id] = true;
			var revised = item.text.replace(/\s+$/, "");
			var original = source.text;
			if (revised.trim() === "" || revised === original)
				return;
			if (numbersIn(original).join() !== numbersIn(revised).join()) {
				refused.push({ id: source.id, reason: "it changed a number" });
				return;
			}
			if (tokenize(original).length > MAX_TOKENS || tokenize(revised).length > MAX_TOKENS) {
				refused.push({ id: source.id, reason: "the paragraph is too long to compare" });
				return;
			}
			var changes = diff(original, revised);
			if (!changes.length)
				return;
			if (changedShare(original, changes) > m.maxChange) {
				refused.push({ id: source.id, reason: "it rewrote too much for \"" + m.name + "\"" });
				return;
			}
			var ops = toOperations(original, changes);
			skipped += ops.skipped;
			if (ops.operations.length)
				results.push({ id: source.id, why: String(item.why || ""), operations: ops.operations, changes: changes.length });
		});
		return { ok: true, results: results, refused: refused, skipped: skipped };
	}

	/* Continue writing */

	function buildContinueMessages(before) {
		return [
			{
				role: "system", content: [
					"You suggest how a text continues: one or two sentences in the author's style and language.",
					"Do not repeat the text. Do not add numbers, dates or names that are not in the text.",
					"Reply with one JSON object only: {\"continuation\":\"<the next sentence or two>\"}"
				].join("\n")
			},
			{ role: "user", content: before.slice(-1500) }
		];
	}

	// The suggestion, with a leading space when the text before needs one.
	function checkContinuation(reply, before) {
		var answer = parseReply(reply);
		var text = answer && typeof answer.continuation === "string" ? answer.continuation.replace(/\s+/g, " ").trim() : "";
		if (!text)
			return { ok: false, error: "No suggestion came back. Try again." };
		var tail = before.slice(-200).trim();
		if (tail && text.indexOf(tail) === 0)
			text = text.slice(tail.length).trim();
		if (text.length > 500)
			text = text.slice(0, 500).replace(/\s+\S*$/, "") + "…";
		if (before && !(/\s$/).test(before))
			text = " " + text;
		return { ok: true, text: text };
	}

	/* Structure */

	function words(text) {
		return String(text).split(/\s+/).filter(function (w) { return (/[\p{L}\p{N}]/u).test(w); }).length;
	}

	function sentences(text) {
		return String(text).split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“(])/u).filter(function (s) { return s.trim(); });
	}

	// paragraphs: [{id, text, level}] in order, level 1-9 for headings, 0 for body text.
	// Returns notes [{id, note}] for comments.
	function checkStructure(paragraphs) {
		var notes = [];
		var lastLevel = 0, total = 0, headings = 0;
		paragraphs.forEach(function (p, i) {
			var level = p.level || 0;
			var count = words(p.text);
			total += count;
			if (level) {
				headings++;
				if (lastLevel && level > lastLevel + 1)
					notes.push({ id: p.id, note: "Heading level jumps from " + lastLevel + " to " + level + ". Use level " + (lastLevel + 1) + " here, or add the missing level above." });
				var next = paragraphs.slice(i + 1).filter(function (q) { return q.text.trim(); })[0];
				if (!next || (next.level && next.level <= level))
					notes.push({ id: p.id, note: "This section has no text under its heading." });
				if (count > 15)
					notes.push({ id: p.id, note: "Long heading (" + count + " words). Headings read best under about 10 words." });
				lastLevel = level;
				return;
			}
			if (count > LONG_PARAGRAPH_WORDS)
				notes.push({ id: p.id, note: "Long paragraph (" + count + " words). Consider splitting it where the topic changes." });
			sentences(p.text).forEach(function (s) {
				var n = words(s);
				if (n > LONG_SENTENCE_WORDS)
					notes.push({ id: p.id, note: "Long sentence (" + n + " words): \"" + s.slice(0, 60).trim() + "…\". Consider splitting it." });
			});
		});
		if (!headings && total > 600 && paragraphs.length)
			notes.unshift({ id: paragraphs[0].id, note: "This document has " + total + " words and no headings. Headings make it easier to scan and give it a table of contents." });
		return notes;
	}

	// Asks the model to review the outline: [{id, heading, level, start}] where
	// start is the first sentence of the section.
	function buildOutlineMessages(outline) {
		return [
			{
				role: "system", content: [
					"You review the structure of a document from its outline: the order of sections, gaps and repetition.",
					"Comment only on structure, not on wording. At most 5 notes, each one short and practical.",
					"Reply with one JSON object only:",
					'{"notes":[{"id":<heading id>,"note":"<suggestion>"}],"missing":["<a section the document seems to need>"]}'
				].join("\n")
			},
			{
				role: "user", content: JSON.stringify(outline.map(function (h) {
					return { id: h.id, level: h.level, heading: h.heading, starts: h.start };
				}))
			}
		];
	}

	function checkOutline(reply, outline) {
		var answer = parseReply(reply);
		if (!answer)
			return { ok: false, error: "The assistant's answer could not be read. Try again." };
		var ids = {};
		outline.forEach(function (h) { ids[String(h.id)] = h.id; });
		var notes = (Array.isArray(answer.notes) ? answer.notes : []).filter(function (n) {
			return n && ids[String(n.id)] !== undefined && typeof n.note === "string" && n.note.trim();
		}).slice(0, 5).map(function (n) {
			return { id: ids[String(n.id)], note: n.note.trim() };
		});
		var missing = (Array.isArray(answer.missing) ? answer.missing : []).filter(function (m) {
			return typeof m === "string" && m.trim();
		}).slice(0, 3);
		return { ok: true, notes: notes, missing: missing };
	}

	exports.MODES = MODES;
	exports.tokenize = tokenize;
	exports.diff = diff;
	exports.toOperations = toOperations;
	exports.chunkParagraphs = chunkParagraphs;
	exports.buildEditMessages = buildEditMessages;
	exports.checkEdits = checkEdits;
	exports.buildContinueMessages = buildContinueMessages;
	exports.checkContinuation = checkContinuation;
	exports.sentences = sentences;
	exports.checkStructure = checkStructure;
	exports.buildOutlineMessages = buildOutlineMessages;
	exports.checkOutline = checkOutline;
	exports.parseReply = parseReply;
})(typeof module !== "undefined" ? module.exports : (window.PersonalOfficeAI = window.PersonalOfficeAI || {}).writing = {});
