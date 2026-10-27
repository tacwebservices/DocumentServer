<!--
 - SPDX-FileCopyrightText: 2026 Personal Office
 - SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Bundled editor plugins

Plugins in this folder ship with the document server and are installed into
`sdkjs-plugins/` by `build.sh` (called from the image build and `make plugins`).
`v1/plugins.js` is the loader every plugin includes; the editor sends it the
plugin API code when the plugin starts.

## Ask Personal Office (`personal-office-ai`)

A panel in the spreadsheet editor (Plugins tab) where people ask about their
sheet in plain words, such as "show sales by branch".

The AI only decides what to do. It answers with a plan, the plugin checks the
plan against the sheet, then carries it out; **Remove** takes the answer out again.

- **calculation**: one number (total, average, count, smallest, largest,
  median, share of the total, or which row holds the largest/smallest value),
  with optional filters such as Branch = Lusaka. The plugin writes the formula
  (`SUMIFS`, `COUNTIFS`, `INDEX`/`MATCH`, ...); filter values must exist in the
  column, so a typo is reported instead of giving 0.
- **formula**: a formula the AI writes, for what a calculation cannot express.
  If it gives an error (`#NAME?`, `#VALUE!`, ...) it is removed and the AI gets
  one chance to fix it.

A single answer goes into the selected cell when that cell is empty and clear
of the table; otherwise into a label/value pair of columns right of the table
(one empty column between), each answer on the next free row. The table is the
block under the first row with two or more filled cells, up to the first empty
column and row, so earlier answers never become part of it.

Plans that rely on a value the question never names, such as filtering on
"Lusaka" to answer "which branch sold most", are sent back to the AI once with
the reason. Answers to "which ..." questions are looked up by formula.
- **summary**: a new sheet with one row per group and a `SUMIFS` / `COUNTIFS` /
  `AVERAGEIFS` / `MINIFS` / `MAXIFS` formula over the source data, an optional
  chart, and a note naming the source rows. The groups come from the data, the
  formulas are written by the plugin, so every number can be clicked and checked.
- **unsupported**: the sheet does not have the data, and nothing is inserted.

Column names the sheet does not have, or sums over text columns, are rejected.
Date columns (recognised by their number format) are grouped by month or year
with `SUMIFS(..., ">="&start, ..., "<"&end)` formulas.

### Visual summary

The "Visual summary" button asks the AI for the 3 to 5 charts that best tell the
sheet's story (trends over time, comparisons, shares). Each chart passes the
same checks as a single summary; duplicates and charts with too many groups are
dropped. The result is one new sheet with, per chart, a table of formulas, the
chart, the AI's one-line reason, and a fact sentence such as
"Mar 2026: 14,700, up 17% from Feb 2026." The facts are written by the plugin
from the calculated values after recalculation, never by the AI; changes of 25%
or more are flagged in red. A sheet without numbers gets no summary.

### AI server

Choose the AI service under "AI connection" in the panel:

- **This computer (Ollama)**, the default: `http://localhost:11434/v1` with `qwen2.5:7b`.
- **ChatGPT (OpenAI)**: `gpt-5-mini`, needs an OpenAI API key.
- **Claude (Anthropic)**: `claude-opus-5-5`, needs an Anthropic API key.
- **Other OpenAI-compatible server**, such as llama.cpp or vLLM on an AI Box.

With ChatGPT or Claude the sheet's table leaves the computer, and the panel says so.
The browser calls the service directly and keeps the access key in its local
storage, so anyone using the same browser profile uses the same key.
A local server must allow the document server's origin (Ollama allows
`localhost` and `127.0.0.1` by default; set `OLLAMA_ORIGINS` for other hosts).

### Develop

```sh
node --test plugins/personal-office-ai/test/plan.test.js
docker compose exec -T eo make plugins   # copy into the running dev server
```

### Quick image

Adds the plugins to the released document server, without a full build:

```sh
docker build -t personal-office/documentserver plugins
```

Use it in MyStickCloud with `OFFICE_IMAGE=personal-office/documentserver:latest`.
