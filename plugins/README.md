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

The AI only decides what to do. It answers with a plan, and the plugin checks the
plan against the sheet before anything changes:

- **formula**: one formula, shown with its target cell. After inserting, the
  result is read back; a formula that gives an error (`#NAME?`, `#VALUE!`, ...)
  is removed again.
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

Any OpenAI-compatible chat endpoint works: Ollama on the laptop
(`http://localhost:11434/v1` with `qwen2.5:7b`, the default) or llama.cpp / vLLM on an AI Box.
Change the address, model and access key under "AI connection" in the panel.
The browser calls the server directly, so it must allow the document server's
origin (Ollama allows `localhost` and `127.0.0.1` by default; set
`OLLAMA_ORIGINS` for other hosts).

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
