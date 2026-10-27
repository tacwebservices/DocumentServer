/*
 * SPDX-FileCopyrightText: 2026 Personal Office
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Flowcharts. The language model describes the process in Mermaid; the
 * chart is checked and laid out here and drawn as ordinary shapes, so it
 * stays editable in the document, and it can be opened in draw.io.
 */
(function (exports) {
	"use strict";

	var MAX_NODES = 30;
	var MAX_TEXT = 90;
	var KINDS = ["start", "step", "decision", "io"];
	// Sizes in millimetres
	var BOX = { w: 42, h: 13 };
	var DECISION = { w: 46, h: 20 };
	var RANK_GAP = 10;
	var COLUMN_GAP = 8;
	var CHANNEL = 5; // distance between lines routed beside the chart
	var CONTENT_WIDTH = 160;

	/* Mermaid */

	// Shapes as [open, close, kind]; longer delimiters first.
	var SHAPES = [
		["([", "])", "start"], ["((", "))", "start"], ["[[", "]]", "step"], ["[(", ")]", "step"],
		["[/", "/]", "io"], ["[\\", "\\]", "io"], ["[/", "\\]", "io"], ["[\\", "/]", "io"],
		["{{", "}}", "decision"], ["{", "}", "decision"], ["(", ")", "step"], ["[", "]", "step"], [">", "]", "step"]
	];
	var ARROW = /^\s*(?:(?:--|==|-\.)\s*([^\-=>|][^>|]*?)\s*(?:-->|==>|\.->|---)|(?:-->|==>|-\.->|---|-\.-|===|--o|--x)(?:\s*\|([^|]*)\|)?)\s*/;

	function unquote(text) {
		text = String(text).trim();
		if ((/^"[\s\S]*"$/).test(text))
			text = text.slice(1, -1);
		return text.replace(/<br\s*\/?>/gi, " ").replace(/#quot;/g, "\"").replace(/\s+/g, " ").trim();
	}

	// Reads one node reference at the start of text: {id, text, kind, rest}.
	function readNode(text) {
		var m = (/^\s*([\p{L}\p{N}_][\p{L}\p{N}_]*)/u).exec(text);
		if (!m)
			return null;
		var rest = text.slice(m[0].length);
		for (var i = 0; i < SHAPES.length; i++) {
			var open = SHAPES[i][0], close = SHAPES[i][1];
			if (rest.indexOf(open) !== 0)
				continue;
			var body = rest.slice(open.length);
			var end = -1;
			if (body[0] === "\"") {
				var q = body.indexOf("\"", 1);
				end = q > 0 ? body.indexOf(close, q) : -1;
			} else {
				end = body.indexOf(close);
			}
			if (end < 0)
				continue;
			return { id: m[1], text: unquote(body.slice(0, end)), kind: SHAPES[i][2], rest: body.slice(end + close.length) };
		}
		return { id: m[1], text: null, kind: null, rest: rest };
	}

	// Parses the flowchart subset of Mermaid. Returns {ok, graph: {direction,
	// nodes: [{id, text, kind}], edges: [{from, to, label}]}} or {ok: false, error}.
	function parseMermaid(source) {
		var lines = String(source || "").replace(/\\n/g, "\n").split(/\n|;/);
		var nodes = {}, order = [], edges = [], direction = "TD";
		var problems = [];
		var declare = function (n) {
			if (!nodes[n.id]) {
				nodes[n.id] = { id: n.id, text: n.text || n.id, kind: n.kind || "step" };
				order.push(n.id);
			} else if (n.text) {
				nodes[n.id].text = n.text;
				nodes[n.id].kind = n.kind;
			}
		};
		lines.forEach(function (raw, lineNo) {
			var line = raw.replace(/%%.*$/, "").trim();
			if (!line)
				return;
			var header = (/^(flowchart|graph)\b\s*(\w+)?/i).exec(line);
			if (header) {
				direction = (header[2] || "TD").toUpperCase();
				return;
			}
			if ((/^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/).test(line))
				return;
			var node = readNode(line);
			if (!node) {
				problems.push("line " + (lineNo + 1));
				return;
			}
			declare(node);
			var rest = node.rest.replace(/^:::\w+/, "");
			while (rest.trim()) {
				var arrow = ARROW.exec(rest);
				if (!arrow) {
					problems.push("line " + (lineNo + 1));
					break;
				}
				var next = readNode(rest.slice(arrow[0].length));
				if (!next) {
					problems.push("line " + (lineNo + 1));
					break;
				}
				declare(next);
				var label = unquote(arrow[1] || arrow[2] || "");
				edges.push({ from: node.id, to: next.id, label: label });
				node = next;
				rest = next.rest.replace(/^:::\w+/, "");
			}
		});
		var list = order.map(function (id) { return nodes[id]; });
		if (list.length < 2 || !edges.length)
			return { ok: false, error: "The flowchart needs at least two steps joined by arrows." + (problems.length ? " Could not read " + problems[0] + "." : "") };
		if (list.length > MAX_NODES)
			return { ok: false, error: "The flowchart has " + list.length + " steps; at most " + MAX_NODES + " fit on a page. Describe a shorter process or split it." };
		list.forEach(function (n) {
			if (n.text.length > MAX_TEXT)
				n.text = n.text.slice(0, MAX_TEXT - 1).replace(/\s+\S*$/, "") + "…";
			if (KINDS.indexOf(n.kind) < 0)
				n.kind = "step";
		});
		return { ok: true, graph: { direction: direction, nodes: list, edges: edges }, problems: problems };
	}

	function escapeMermaid(text) {
		return String(text).replace(/"/g, "#quot;");
	}

	// Writes a graph back as Mermaid, for the text box under the preview.
	function toMermaid(graph) {
		var shape = { start: ["([", "])"], step: ["[", "]"], decision: ["{", "}"], io: ["[/", "/]"] };
		var lines = ["flowchart TD"];
		graph.nodes.forEach(function (n) {
			lines.push("    " + n.id + shape[n.kind][0] + "\"" + escapeMermaid(n.text) + "\"" + shape[n.kind][1]);
		});
		graph.edges.forEach(function (e) {
			lines.push("    " + e.from + " -->" + (e.label ? "|" + escapeMermaid(e.label) + "|" : "") + " " + e.to);
		});
		return lines.join("\n");
	}

	/* Layout */

	// Layered layout, top to bottom. Returns {width, height, nodes: [{id, text,
	// kind, x, y, w, h}], lines: [{x1, y1, x2, y2, arrow}], labels: [{text, x, y}]}
	// in millimetres from the top left corner.
	function layout(graph) {
		var ids = graph.nodes.map(function (n) { return n.id; });
		var out = {}, incoming = {};
		ids.forEach(function (id) {
			out[id] = [];
			incoming[id] = 0;
		});
		graph.edges.forEach(function (e, i) {
			out[e.from].push(i);
			incoming[e.to]++;
		});
		// Edges that go back up (loops) are found by a depth-first walk from the starts.
		var state = {}, back = {};
		var visit = function (id) {
			state[id] = 1;
			out[id].forEach(function (i) {
				var to = graph.edges[i].to;
				if (state[to] === 1)
					back[i] = true;
				else if (!state[to])
					visit(to);
			});
			state[id] = 2;
		};
		ids.filter(function (id) { return !incoming[id]; }).concat(ids).forEach(function (id) {
			if (!state[id])
				visit(id);
		});
		// Rank: the longest path from a start, ignoring loops.
		var rank = {};
		var rankOf = function (id) {
			if (rank[id] === undefined) {
				rank[id] = 0;
				graph.edges.forEach(function (e, i) {
					if (e.to === id && !back[i])
						rank[id] = Math.max(rank[id], rankOf(e.from) + 1);
				});
			}
			return rank[id];
		};
		ids.forEach(rankOf);
		var ranks = [];
		ids.forEach(function (id) {
			(ranks[rank[id]] = ranks[rank[id]] || []).push(id);
		});
		ranks = ranks.filter(Boolean);
		// Order each rank by the average position of its parents, so branches line up.
		var position = {};
		ranks.forEach(function (row, r) {
			if (r > 0) {
				var weight = function (id) {
					var parents = graph.edges.filter(function (e, i) { return e.to === id && !back[i] && position[e.from] !== undefined; });
					if (!parents.length)
						return Infinity;
					return parents.reduce(function (sum, e) { return sum + position[e.from]; }, 0) / parents.length;
				};
				var weights = {};
				row.forEach(function (id) { weights[id] = weight(id); });
				row.sort(function (a, b) { return weights[a] - weights[b] || ids.indexOf(a) - ids.indexOf(b); });
			}
			row.forEach(function (id, i) { position[id] = i - (row.length - 1) / 2; });
		});
		var widest = Math.max.apply(null, ranks.map(function (row) { return row.length; }));
		var scale = Math.min(1, CONTENT_WIDTH / (widest * (DECISION.w + COLUMN_GAP)));
		var column = (DECISION.w + COLUMN_GAP) * scale;
		var byId = {};
		graph.nodes.forEach(function (n) { byId[n.id] = n; });
		var placed = {}, y = 0;
		ranks.forEach(function (row) {
			var height = Math.max.apply(null, row.map(function (id) { return (byId[id].kind === "decision" ? DECISION : BOX).h; }));
			row.forEach(function (id) {
				var size = byId[id].kind === "decision" ? DECISION : BOX;
				var w = size.w * scale, h = size.h;
				var cx = position[id] * column;
				placed[id] = { id: id, text: byId[id].text, kind: byId[id].kind, x: cx - w / 2, y: y + (height - h) / 2, w: w, h: h };
			});
			y += height + RANK_GAP;
		});
		var nodes = ids.map(function (id) { return placed[id]; });
		var left = Math.min.apply(null, nodes.map(function (n) { return n.x; }));
		var right = Math.max.apply(null, nodes.map(function (n) { return n.x + n.w; }));
		var lines = [], labels = [];
		var leftChannel = left, rightChannel = right;
		var segment = function (x1, y1, x2, y2, arrow) {
			if (Math.abs(x1 - x2) > 0.01 || Math.abs(y1 - y2) > 0.01)
				lines.push({ x1: x1, y1: y1, x2: x2, y2: y2, arrow: !!arrow });
		};
		graph.edges.forEach(function (e, i) {
			var a = placed[e.from], b = placed[e.to];
			var ax = a.x + a.w / 2, bx = b.x + b.w / 2;
			if (back[i] || rank[e.to] - rank[e.from] > 1) {
				// Loops and lines that skip a rank run beside the chart, clear of the
				// boxes between, on the side nearest the box they leave. Loops prefer
				// the right side and skips the left, so they do not share a channel.
				var center = (left + right) / 2;
				var onLeft = back[i] ? ax < center - 0.5 : ax < center + 0.5;
				var channel = onLeft ? (leftChannel -= CHANNEL) : (rightChannel += CHANNEL);
				var ay = a.y + a.h / 2, by = b.y + b.h / 2;
				var aSide = onLeft ? a.x : a.x + a.w, bSide = onLeft ? b.x : b.x + b.w;
				segment(aSide, ay, channel, ay);
				segment(channel, ay, channel, by);
				segment(channel, by, bSide, by, true);
				if (e.label)
					labels.push({ text: e.label, x: (onLeft ? channel : aSide) + 1, y: ay - 4.5 });
			} else {
				var top = a.y + a.h, bottom = b.y;
				var middle = top + (bottom - top) / 2;
				if (Math.abs(ax - bx) < 0.5) {
					segment(ax, top, bx, bottom, true);
				} else {
					segment(ax, top, ax, middle);
					segment(ax, middle, bx, middle);
					segment(bx, middle, bx, bottom, true);
				}
				// Next to the line into the target, so the labels of a decision's branches stay apart
				if (e.label)
					labels.push({ text: e.label, x: bx + 1, y: Math.abs(ax - bx) < 0.5 ? top + 0.5 : middle + 0.5 });
			}
		});
		// Shift everything so the chart starts at 0,0
		var minX = Math.min(left, leftChannel), maxX = Math.max(right, rightChannel);
		nodes.forEach(function (n) { n.x -= minX; });
		lines.forEach(function (l) {
			l.x1 -= minX;
			l.x2 -= minX;
		});
		labels.forEach(function (l) { l.x -= minX; });
		return { width: maxX - minX, height: y - RANK_GAP, nodes: nodes, lines: lines, labels: labels };
	}

	/* Output */

	function escapeXml(text) {
		return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	// Splits text into lines of about maxChars characters.
	function wrapText(text, maxChars) {
		var lines = [], line = "";
		String(text).split(" ").forEach(function (word) {
			if (line && (line + " " + word).length > maxChars) {
				lines.push(line);
				line = word;
			} else {
				line = line ? line + " " + word : word;
			}
		});
		if (line)
			lines.push(line);
		return lines;
	}

	function shapePath(n) {
		var x = n.x, y = n.y, w = n.w, h = n.h;
		switch (n.kind) {
			case "start":
				return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + h / 2 + '"/>';
			case "decision":
				return '<polygon points="' + [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]].join(" ") + '"/>';
			case "io":
				return '<polygon points="' + [[x + 4, y], [x + w, y], [x + w - 4, y + h], [x, y + h]].join(" ") + '"/>';
			default:
				return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="1"/>';
		}
	}

	// Preview for the panel (units are millimetres).
	function toSVG(chart) {
		var parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ' + (chart.width + 4) + " " + (chart.height + 4) +
			'" font-family="Arial, sans-serif" font-size="3.2">',
			'<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#3c3c3c"/></marker></defs>',
			'<g fill="#deebff" stroke="#1e5eff" stroke-width="0.35">'];
		chart.nodes.forEach(function (n) { parts.push(shapePath(n)); });
		parts.push('</g><g stroke="#3c3c3c" stroke-width="0.35">');
		chart.lines.forEach(function (l) {
			parts.push('<line x1="' + l.x1 + '" y1="' + l.y1 + '" x2="' + l.x2 + '" y2="' + l.y2 + '"' + (l.arrow ? ' marker-end="url(#arrow)"' : "") + "/>");
		});
		parts.push('</g><g fill="#000" text-anchor="middle">');
		chart.nodes.forEach(function (n) {
			var rows = wrapText(n.text, Math.max(8, Math.floor((n.kind === "decision" ? n.w * 0.6 : n.w - 4) / 1.7)));
			rows.forEach(function (row, i) {
				parts.push('<text x="' + (n.x + n.w / 2) + '" y="' + (n.y + n.h / 2 + (i - (rows.length - 1) / 2) * 3.8 + 1.1) + '">' + escapeXml(row) + "</text>");
			});
		});
		parts.push('</g><g fill="#555" font-size="2.8">');
		chart.labels.forEach(function (l) {
			parts.push('<text x="' + l.x + '" y="' + (l.y + 3) + '">' + escapeXml(l.text) + "</text>");
		});
		parts.push("</g></svg>");
		return parts.join("");
	}

	// A draw.io file of the same chart, with real connectors.
	function toDrawio(graph, chart, title) {
		var px = 3.78; // pixels per millimetre
		var styles = {
			start: "rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#deebff;strokeColor=#1e5eff;",
			step: "rounded=0;whiteSpace=wrap;html=1;fillColor=#deebff;strokeColor=#1e5eff;",
			decision: "rhombus;whiteSpace=wrap;html=1;fillColor=#deebff;strokeColor=#1e5eff;",
			io: "shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1;size=15;whiteSpace=wrap;html=1;fillColor=#deebff;strokeColor=#1e5eff;"
		};
		var cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
		var cellId = {};
		chart.nodes.forEach(function (n, i) {
			cellId[n.id] = "n" + i;
			cells.push('<mxCell id="n' + i + '" value="' + escapeXml(n.text) + '" style="' + styles[n.kind] + '" vertex="1" parent="1">' +
				'<mxGeometry x="' + Math.round(n.x * px) + '" y="' + Math.round(n.y * px) + '" width="' + Math.round(n.w * px) + '" height="' + Math.round(n.h * px) + '" as="geometry"/></mxCell>');
		});
		graph.edges.forEach(function (e, i) {
			cells.push('<mxCell id="e' + i + '" value="' + escapeXml(e.label || "") + '" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;" edge="1" parent="1" source="' +
				cellId[e.from] + '" target="' + cellId[e.to] + '"><mxGeometry relative="1" as="geometry"/></mxCell>');
		});
		return '<mxfile host="Personal Office"><diagram name="' + escapeXml(title || "Flowchart") + '"><mxGraphModel><root>' +
			cells.join("") + "</root></mxGraphModel></diagram></mxfile>";
	}

	/* Model */

	// Small models write a list of steps more reliably than Mermaid, so the
	// model answers with steps and the Mermaid text is written here.
	function buildMessages(description) {
		return [
			{
				role: "system", content: [
					"You turn a description of a process into the steps of a flowchart.",
					"Use only the steps the description gives; never invent steps. Each text is a short label of 2 to 7 words.",
					"Step types: start (the first event), step (an action), decision (a yes/no question), end (the last step).",
					"A decision has two next entries, labelled Yes and No. A step may lead back to an earlier step.",
					"Reply with one JSON object only:",
					'{"title":"<short title>","steps":[{"id":1,"text":"<label>","type":"start|step|decision|end","next":[{"to":<id>,"label":"<Yes, No or empty>"}]}]}',
					"Example for \"Boil water. If it is hot enough, pour it, otherwise keep boiling\":",
					'{"title":"Making tea","steps":[{"id":1,"text":"Boil water","type":"start","next":[{"to":2,"label":""}]},{"id":2,"text":"Hot enough?","type":"decision","next":[{"to":3,"label":"Yes"},{"to":1,"label":"No"}]},{"id":3,"text":"Pour water","type":"end","next":[]}]}'
				].join("\n")
			},
			{ role: "user", content: String(description).slice(0, 6000) }
		];
	}

	var STEP_KINDS = { start: "start", end: "start", step: "step", process: "step", action: "step", decision: "decision", io: "io", input: "io", output: "io" };

	// Steps [{id, text, type, next: [{to, label}]}] -> Mermaid text, or null.
	function stepsToMermaid(steps) {
		if (!Array.isArray(steps))
			return null;
		var ids = {}, lines = ["flowchart TD"];
		steps.forEach(function (step, i) {
			if (step && step.id !== undefined && step.id !== null)
				ids[String(step.id)] = "S" + (i + 1);
		});
		var shape = { start: ["([", "])"], step: ["[", "]"], decision: ["{", "}"], io: ["[/", "/]"] };
		steps.forEach(function (step) {
			var id = step && ids[String(step.id)];
			if (!id)
				return;
			var kind = STEP_KINDS[String(step.type || "").toLowerCase()] || "step";
			var text = String(step.text || step.label || "").replace(/["\[\]{}()|]/g, " ").replace(/\s+/g, " ").trim() || "Step";
			lines.push("    " + id + shape[kind][0] + "\"" + text + "\"" + shape[kind][1]);
		});
		steps.forEach(function (step) {
			var id = step && ids[String(step.id)];
			var decision = STEP_KINDS[String(step && step.type || "").toLowerCase()] === "decision";
			(id && Array.isArray(step.next) ? step.next : []).forEach(function (n) {
				var to = n !== null && typeof n === "object" ? n.to : n;
				var target = ids[String(to)];
				if (!target)
					return;
				// Only a decision's arrows carry labels (Yes / No)
				var label = decision && n && typeof n === "object" ? String(n.label || "").replace(/[|"]/g, " ").trim() : "";
				lines.push("    " + id + " -->" + (label ? "|" + label + "|" : "") + " " + target);
			});
		});
		return lines.join("\n");
	}

	function checkReply(reply) {
		var body = String(reply || "").trim();
		var start = body.indexOf("{"), end = body.lastIndexOf("}");
		var answer = null;
		try {
			answer = start >= 0 && end > start ? JSON.parse(body.slice(start, end + 1)) : null;
		} catch (e) {
			answer = null;
		}
		var source = answer ? stepsToMermaid(answer.steps) || (typeof answer.mermaid === "string" ? answer.mermaid : null) : null;
		if (!source && (/^\s*(flowchart|graph)\b/m).test(body))
			source = body.replace(/^```\w*|```$/gm, "");
		if (!source)
			return { ok: false, error: "The assistant did not return a flowchart. Try describing the steps more plainly." };
		var parsed = parseMermaid(source);
		if (!parsed.ok)
			return parsed;
		return { ok: true, title: answer && answer.title ? String(answer.title).slice(0, 80) : "Flowchart", graph: parsed.graph };
	}

	exports.parseMermaid = parseMermaid;
	exports.toMermaid = toMermaid;
	exports.layout = layout;
	exports.toSVG = toSVG;
	exports.toDrawio = toDrawio;
	exports.wrapText = wrapText;
	exports.buildMessages = buildMessages;
	exports.checkReply = checkReply;
})(typeof module !== "undefined" ? module.exports : (window.PersonalOfficeAI = window.PersonalOfficeAI || {}).flowchart = {});
