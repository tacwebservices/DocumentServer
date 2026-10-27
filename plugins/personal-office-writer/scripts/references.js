/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Referencing from the author's own library (BibTeX, CSL JSON or RIS, as
 * exported by Zotero, Mendeley or EndNote). The language model may only pick
 * sources from that library; it never writes a citation. Citations and the
 * reference list are formatted here.
 */
(function (exports) {
	"use strict";

	var STYLES = {
		apa: { name: "APA 7th", numeric: false },
		harvard: { name: "Harvard", numeric: false },
		ieee: { name: "IEEE", numeric: true }
	};
	var MAX_CANDIDATES = 15;
	var MAX_SOURCES_PER_SENTENCE = 3;
	var STOPWORDS = ("a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your " +
		"study studies paper research results result show shows shown use used using based new also may however").split(" ").reduce(function (set, w) {
		set[w] = true;
		return set;
	}, {});

	/* Reading libraries */

	var LATEX_ACCENTS = { "'": "́", "`": "̀", "^": "̂", "\"": "̈", "~": "̃", "c": "̧", "=": "̄", ".": "̇", "u": "̆", "v": "̌", "H": "̋" };

	function cleanLatex(text) {
		return String(text || "")
			.replace(/\\([`'^"~=.]|[cuvH](?=[{\s]))\s*\{?([A-Za-z])\}?/g, function (m, accent, letter) {
				return (letter + LATEX_ACCENTS[accent]).normalize("NFC");
			})
			.replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\_/g, "_")
			.replace(/--/g, "–")
			.replace(/\\[a-zA-Z]+\s*/g, "")
			.replace(/[{}]/g, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	// "Banda, John and Mary Phiri and {World Bank}" -> [{family, given}] or [{literal}]
	function parseNames(text) {
		var parts = [], depth = 0, current = "";
		String(text || "").split(/(\{|\}|\s+and\s+)/).forEach(function (piece) {
			if (piece === "{")
				depth++;
			else if (piece === "}")
				depth--;
			if ((/^\s+and\s+$/).test(piece) && depth === 0) {
				parts.push(current);
				current = "";
			} else {
				current += piece;
			}
		});
		parts.push(current);
		return parts.map(function (raw) {
			raw = raw.trim();
			if (!raw)
				return null;
			if ((/^\{.*\}$/).test(raw))
				return { literal: cleanLatex(raw) };
			var name = cleanLatex(raw);
			if (name.indexOf(",") >= 0) {
				var bits = name.split(",");
				return { family: bits[0].trim(), given: bits.slice(1).join(",").trim() };
			}
			var words = name.split(" ");
			return words.length > 1 ? { family: words.pop(), given: words.join(" ") } : { literal: name };
		}).filter(Boolean);
	}

	var BIBTEX_TYPES = { article: "article-journal", book: "book", inbook: "chapter", incollection: "chapter", inproceedings: "paper-conference", conference: "paper-conference", phdthesis: "thesis", mastersthesis: "thesis", techreport: "report", misc: "document", online: "webpage", report: "report", thesis: "thesis" };

	function parseBibTeX(text) {
		var items = [], source = String(text);
		var entry = /@(\w+)\s*\{/g, match;
		while ((match = entry.exec(source))) {
			var type = match[1].toLowerCase();
			var start = entry.lastIndex, depth = 1, i = start;
			while (i < source.length && depth > 0) {
				if (source[i] === "{")
					depth++;
				else if (source[i] === "}")
					depth--;
				i++;
			}
			entry.lastIndex = i;
			if (type === "comment" || type === "string" || type === "preamble")
				continue;
			var body = source.slice(start, i - 1);
			var comma = body.indexOf(",");
			if (comma < 0)
				continue;
			var fields = { key: body.slice(0, comma).trim() };
			var rest = body.slice(comma + 1), pos = 0;
			while (pos < rest.length) {
				var head = (/^\s*,?\s*([\w\-:]+)\s*=\s*/).exec(rest.slice(pos));
				if (!head)
					break;
				pos += head[0].length;
				var value = "", ch = rest[pos];
				if (ch === "{" || ch === "\"") {
					var close = ch === "{" ? "}" : "\"", d = 1, j = pos + 1;
					while (j < rest.length && d > 0) {
						if (ch === "{" && rest[j] === "{")
							d++;
						else if (rest[j] === close && rest[j - 1] !== "\\")
							d--;
						j++;
					}
					value = rest.slice(pos + 1, j - 1);
					pos = j;
				} else {
					var plain = (/^[^,]*/).exec(rest.slice(pos))[0];
					value = plain;
					pos += plain.length;
				}
				fields[head[1].toLowerCase()] = value;
			}
			items.push(normalize({
				id: fields.key,
				type: BIBTEX_TYPES[type] || "document",
				title: cleanLatex(fields.title),
				authors: parseNames(fields.author || fields.editor),
				year: (/\d{4}/.exec(fields.year || fields.date || "") || [""])[0],
				container: cleanLatex(fields.journal || fields.journaltitle || fields.booktitle),
				volume: cleanLatex(fields.volume),
				issue: cleanLatex(fields.number || fields.issue),
				pages: cleanLatex(fields.pages),
				publisher: cleanLatex(fields.publisher || fields.institution || fields.school || fields.organization),
				doi: cleanLatex(fields.doi),
				url: cleanLatex(fields.url),
				abstract: cleanLatex(fields.abstract),
				keywords: cleanLatex(fields.keywords)
			}));
		}
		return items;
	}

	function parseCSLJSON(text) {
		var data = JSON.parse(text);
		if (!Array.isArray(data))
			data = data && Array.isArray(data.items) ? data.items : [data];
		return data.map(function (item) {
			var issued = item.issued || {};
			var year = issued["date-parts"] && issued["date-parts"][0] ? String(issued["date-parts"][0][0] || "") :
				(/\d{4}/.exec(issued.raw || issued.literal || "") || [""])[0];
			return normalize({
				id: item.id || item["citation-key"],
				type: item.type || "document",
				title: item.title,
				authors: (item.author || item.editor || []).map(function (a) {
					return a.family ? { family: a.family, given: a.given || "" } : { literal: a.literal || a.given || "" };
				}),
				year: year,
				container: item["container-title"],
				volume: item.volume,
				issue: item.issue,
				pages: item.page,
				publisher: item.publisher,
				doi: item.DOI,
				url: item.URL,
				abstract: item.abstract,
				keywords: item.keyword
			});
		});
	}

	var RIS_TYPES = { JOUR: "article-journal", BOOK: "book", CHAP: "chapter", CONF: "paper-conference", CPAPER: "paper-conference", THES: "thesis", RPRT: "report", ELEC: "webpage", WEB: "webpage" };

	function parseRIS(text) {
		var items = [], current = null;
		String(text).split(/\r?\n/).forEach(function (line) {
			var m = (/^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/).exec(line);
			if (!m)
				return;
			var tag = m[1], value = m[2].trim();
			if (tag === "TY") {
				current = { type: RIS_TYPES[value] || "document", authors: [], keywords: [], start: "", end: "" };
				return;
			}
			if (!current)
				return;
			if (tag === "ER") {
				current.pages = current.start + (current.end ? "–" + current.end : "");
				current.keywords = current.keywords.join(", ");
				items.push(normalize(current));
				current = null;
				return;
			}
			switch (tag) {
				case "ID": current.id = value; break;
				case "TI": case "T1": current.title = current.title || value; break;
				case "AU": case "A1": current.authors = current.authors.concat(parseNames(value)); break;
				case "PY": case "Y1": case "DA": current.year = current.year || (/\d{4}/.exec(value) || [""])[0]; break;
				case "JO": case "JF": case "T2": case "BT": current.container = current.container || value; break;
				case "VL": current.volume = value; break;
				case "IS": current.issue = value; break;
				case "SP": current.start = value; break;
				case "EP": current.end = value; break;
				case "PB": current.publisher = value; break;
				case "DO": current.doi = value; break;
				case "UR": current.url = current.url || value; break;
				case "AB": case "N2": current.abstract = value; break;
				case "KW": current.keywords.push(value); break;
			}
		});
		return items;
	}

	function normalize(item) {
		var text = function (v) {
			return v === undefined || v === null ? "" : String(Array.isArray(v) ? v.join(", ") : v).replace(/\s+/g, " ").trim();
		};
		var authors = (item.authors || []).filter(function (a) { return a && (a.family || a.literal); });
		var out = {
			id: text(item.id),
			type: text(item.type) || "document",
			title: text(item.title).replace(/\.$/, ""),
			authors: authors,
			year: text(item.year),
			container: text(item.container),
			volume: text(item.volume),
			issue: text(item.issue),
			pages: text(item.pages).replace(/\s*-+\s*/, "–"),
			publisher: text(item.publisher),
			doi: text(item.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""),
			url: text(item.url),
			abstract: text(item.abstract).slice(0, 1500),
			keywords: text(item.keywords)
		};
		if (!out.id)
			out.id = ((authors[0] && (authors[0].family || authors[0].literal)) || "source").replace(/\W+/g, "") + out.year;
		return out;
	}

	// Reads a library file by its contents; ids are made unique.
	function parseLibrary(text, fileName) {
		var body = String(text || "").replace(/^﻿/, "");
		var items;
		if ((/\.json$/i).test(fileName || "") || (/^\s*[\[{]/).test(body))
			items = parseCSLJSON(body);
		else if ((/^\s*TY\s{2}-/m).test(body))
			items = parseRIS(body);
		else
			items = parseBibTeX(body);
		var seen = {};
		return items.filter(function (item) { return item.title || item.authors.length; }).map(function (item) {
			var id = item.id, n = 2;
			while (seen[id])
				id = item.id + "-" + n++;
			seen[id] = true;
			item.id = id;
			return item;
		});
	}

	/* Formatting */

	function familyName(a) {
		return a.literal || a.family;
	}

	function initials(given, withSpaces) {
		return String(given || "").split(/[\s.]+/).filter(Boolean).map(function (part) {
			return part.split("-").map(function (p) { return p[0].toUpperCase() + "."; }).join("-");
		}).join(withSpaces ? " " : "");
	}

	function yearOf(item) {
		return item.year || "n.d.";
	}

	// In-text part for one source: "Banda", "Banda & Phiri", "Banda et al."
	function citedNames(item, style) {
		var a = item.authors;
		if (!a.length)
			return "“" + item.title.split(" ").slice(0, 4).join(" ") + "”";
		var and = style === "apa" ? " & " : " and ";
		if (a.length === 1)
			return familyName(a[0]);
		if (a.length === 2)
			return familyName(a[0]) + and + familyName(a[1]);
		return familyName(a[0]) + " et al.";
	}

	// items: the sources cited together; numbers: id -> number for numeric styles.
	function formatCitation(items, style, numbers) {
		if (STYLES[style] && STYLES[style].numeric) {
			var list = items.map(function (item) { return numbers[item.id]; }).sort(function (x, y) { return x - y; });
			return "[" + list.join("], [") + "]";
		}
		var parts = items.map(function (item) {
			return citedNames(item, style) + (style === "apa" ? ", " : " ") + yearOf(item);
		});
		return "(" + parts.join("; ") + ")";
	}

	function authorList(item, style) {
		var a = item.authors;
		if (!a.length)
			return "";
		var names = a.map(function (author, i) {
			if (author.literal)
				return author.literal;
			if (style === "ieee")
				return (initials(author.given, true) + " " + author.family).trim();
			return author.family + (author.given ? ", " + initials(author.given, style === "apa") : "");
		});
		if (style === "apa" && names.length > 20)
			names = names.slice(0, 19).concat(["… " + names[names.length - 1]]);
		if (names.length === 1)
			return names[0];
		var last = names.pop();
		if (style === "apa")
			return names.join(", ") + ", & " + last;
		if (style === "ieee")
			return names.join(", ") + (names.length > 1 ? ", and " : " and ") + last;
		return names.join(", ") + " and " + last;
	}

	// Works that stand alone (no journal or book around them) have their title in italics.
	function isBookLike(item) {
		return item.type === "book" || item.type === "report" || item.type === "thesis" || !item.container;
	}

	// One reference as text runs [{text, italic}], so titles can be set in italics.
	function formatReference(item, style, number) {
		var runs = [];
		var add = function (text, italic) {
			if (text)
				runs.push({ text: text, italic: !!italic });
		};
		var authors = authorList(item, style);
		var doi = item.doi ? "https://doi.org/" + item.doi : item.url;
		var volume = item.volume ? item.volume : "";
		if (style === "ieee") {
			add("[" + number + "] ");
			if (authors)
				add(authors + ", ");
			if (isBookLike(item)) {
				add(item.title, true);
				add(". " + [item.publisher, item.year].filter(Boolean).join(", ") + ".");
			} else {
				add("“" + item.title + ",” ");
				if (item.container)
					add((item.type === "paper-conference" ? "in " : "") + item.container, true);
				var details = [volume && "vol. " + volume, item.issue && "no. " + item.issue, item.pages && "pp. " + item.pages, item.year].filter(Boolean);
				add((item.container && details.length ? ", " : "") + details.join(", ") + ".");
			}
			if (item.doi)
				add(" doi: " + item.doi + ".");
			else if (item.url)
				add(" [Online]. Available: " + item.url);
			return runs;
		}
		var year = yearOf(item);
		if (style === "apa") {
			add((authors ? authors.replace(/([^.])$/, "$1.") : item.title) + " (" + year + "). ");
			if (isBookLike(item)) {
				if (authors)
					add(item.title, true);
				add(". " + (item.publisher ? item.publisher + ". " : ""));
			} else {
				if (authors)
					add(item.title + ". ");
				if (item.container) {
					add(item.container + (volume ? ", " : ""), true);
					if (volume)
						add(volume, true);
					add((item.issue ? "(" + item.issue + ")" : "") + (item.pages ? ", " + item.pages : "") + ". ");
				}
			}
			add(doi || "");
			return runs.map(function (r) { return { text: r.text.replace(/\.\. /g, ". "), italic: r.italic }; });
		}
		// Harvard
		add((authors || item.title) + " (" + year + ") ");
		if (isBookLike(item)) {
			if (authors)
				add(item.title, true);
			add(". " + (item.publisher ? item.publisher + ". " : ""));
		} else {
			if (authors)
				add("‘" + item.title + "’" + (item.container ? ", " : ". "));
			if (item.container) {
				add(item.container, true);
				add((volume ? ", " + volume : "") + (item.issue ? "(" + item.issue + ")" : "") + (item.pages ? ", pp. " + item.pages : "") + ". ");
			}
		}
		if (item.doi)
			add("doi: " + item.doi + ".");
		else if (item.url)
			add("Available at: " + item.url + ".");
		return runs;
	}

	/* Citations in the document */

	var CITE_TAG = "po-cite:";

	function citationTag(ids) {
		return CITE_TAG + ids.map(encodeURIComponent).join(",");
	}

	function idsFromTag(tag) {
		if (String(tag).indexOf(CITE_TAG) !== 0)
			return null;
		return String(tag).slice(CITE_TAG.length).split(",").filter(Boolean).map(decodeURIComponent);
	}

	// tags: the citation tags in document order. Returns the text of each
	// citation, the reference list (runs per entry) and ids missing from the library.
	function buildBibliography(tags, library, style) {
		var byId = {};
		library.forEach(function (item) { byId[item.id] = item; });
		var numbers = {}, order = [], missing = [];
		var citations = tags.map(function (tag) {
			var ids = idsFromTag(tag) || [];
			var items = [];
			ids.forEach(function (id) {
				if (!byId[id]) {
					if (missing.indexOf(id) < 0)
						missing.push(id);
					return;
				}
				if (!numbers[id]) {
					order.push(id);
					numbers[id] = order.length;
				}
				items.push(byId[id]);
			});
			return items.length ? formatCitation(items, style, numbers) : "[missing source]";
		});
		var cited = order.map(function (id) { return byId[id]; });
		if (!STYLES[style].numeric) {
			cited.sort(function (x, y) {
				var a = (x.authors[0] ? familyName(x.authors[0]) : x.title).toLowerCase();
				var b = (y.authors[0] ? familyName(y.authors[0]) : y.title).toLowerCase();
				return a < b ? -1 : a > b ? 1 : yearOf(x).localeCompare(yearOf(y));
			});
		}
		return {
			citations: citations,
			entries: cited.map(function (item) { return formatReference(item, style, numbers[item.id]); }),
			missing: missing
		};
	}

	/* Finding sources with the model */

	function keywords(text) {
		return (String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(function (w) { return !STOPWORDS[w]; });
	}

	// Sources whose title, keywords or abstract share words with the sentences,
	// best first: only these are shown to the model.
	function shortlist(sentences, library, limit) {
		var wanted = {};
		sentences.forEach(function (s) {
			keywords(s.text).forEach(function (w) { wanted[w] = true; });
		});
		var scored = library.map(function (item) {
			var score = 0;
			var count = function (text, weight) {
				var seen = {};
				keywords(text).forEach(function (w) {
					if (wanted[w] && !seen[w]) {
						seen[w] = true;
						score += weight;
					}
				});
			};
			count(item.title, 3);
			count(item.keywords, 2);
			count(item.abstract, 1);
			count(item.container, 0.5);
			return { item: item, score: score };
		}).filter(function (s) { return s.score > 0; });
		scored.sort(function (a, b) { return b.score - a.score; });
		return scored.slice(0, limit || MAX_CANDIDATES).map(function (s) { return s.item; });
	}

	function buildMatchMessages(sentences, candidates) {
		return [
			{
				role: "system", content: [
					"You help an author cite sources from their own library. You never invent a source.",
					"For each numbered sentence that makes a claim, choose the sources from the list that support it, judging by their title and abstract.",
					"Use only source ids from the list. If no source supports a sentence, leave it out. At most 3 sources per sentence.",
					"Reply with one JSON object only:",
					'{"citations":[{"sentence":<number>,"sources":["<source id>"],"why":"<a few words on how the source supports it>"}]}'
				].join("\n")
			},
			{
				role: "user", content: "Sentences:\n" + sentences.map(function (s, i) {
					return (i + 1) + ". " + s.text;
				}).join("\n") + "\n\nSources:\n" + candidates.map(function (c) {
					return JSON.stringify({
						id: c.id,
						title: c.title,
						authors: c.authors.slice(0, 3).map(familyName).join(", "),
						year: c.year,
						abstract: c.abstract.slice(0, 400)
					});
				}).join("\n")
			}
		];
	}

	// Proposals [{sentence: index, ids, why}] that only use listed sources.
	function checkMatches(reply, sentences, candidates) {
		var answer = (function (text) {
			var body = String(text || "").trim();
			var start = body.indexOf("{"), end = body.lastIndexOf("}");
			try {
				return start >= 0 && end > start ? JSON.parse(body.slice(start, end + 1)) : null;
			} catch (e) {
				return null;
			}
		})(reply);
		if (!answer || !Array.isArray(answer.citations))
			return { ok: false, error: "The assistant's answer could not be read. Try again." };
		var known = {};
		candidates.forEach(function (c) { known[c.id] = true; });
		var invented = 0, used = {};
		var proposals = [];
		answer.citations.forEach(function (c) {
			var index = Number(c && c.sentence) - 1;
			if (!(index >= 0 && index < sentences.length) || used[index] || !Array.isArray(c.sources))
				return;
			var ids = [];
			c.sources.forEach(function (id) {
				id = String(id);
				if (!known[id])
					invented++;
				else if (ids.indexOf(id) < 0)
					ids.push(id);
			});
			if (!ids.length)
				return;
			used[index] = true;
			proposals.push({ sentence: index, ids: ids.slice(0, MAX_SOURCES_PER_SENTENCE), why: String(c.why || "") });
		});
		proposals.sort(function (a, b) { return a.sentence - b.sentence; });
		return { ok: true, proposals: proposals, invented: invented };
	}

	// Text before which the citation goes: the end of the sentence without its
	// final punctuation, grown leftwards until it occurs once in the paragraph.
	function citationAnchor(sentence, paragraphText) {
		var body = sentence.replace(/[\s.!?:;,"”’)]+$/, "");
		if (!body)
			return null;
		var words = body.split(/(\s+)/);
		for (var n = 1; n <= words.length; n++) {
			var anchor = words.slice(words.length - n).join("");
			if (anchor.trim() && paragraphText.split(anchor).length === 2)
				return anchor;
		}
		return null;
	}

	function searchLibrary(library, query) {
		var terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
		if (!terms.length)
			return library.slice(0, 30);
		return library.filter(function (item) {
			var text = [item.title, item.year, item.container, item.keywords, item.authors.map(familyName).join(" ")].join(" ").toLowerCase();
			return terms.every(function (t) { return text.indexOf(t) >= 0; });
		}).slice(0, 30);
	}

	exports.STYLES = STYLES;
	exports.parseLibrary = parseLibrary;
	exports.parseNames = parseNames;
	exports.formatCitation = formatCitation;
	exports.formatReference = formatReference;
	exports.citationTag = citationTag;
	exports.idsFromTag = idsFromTag;
	exports.buildBibliography = buildBibliography;
	exports.shortlist = shortlist;
	exports.buildMatchMessages = buildMatchMessages;
	exports.checkMatches = checkMatches;
	exports.citationAnchor = citationAnchor;
	exports.searchLibrary = searchLibrary;
})(typeof module !== "undefined" ? module.exports : (window.PersonalOfficeAI = window.PersonalOfficeAI || {}).references = {});
