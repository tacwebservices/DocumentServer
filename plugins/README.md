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

### AI server

Any OpenAI-compatible chat endpoint works: Ollama on the laptop
(`http://localhost:11434/v1`, the default) or llama.cpp / vLLM on an AI Box.
Change the address, model and access key under "AI connection" in the panel.
The browser calls the server directly, so it must allow the document server's
origin (Ollama allows `localhost` and `127.0.0.1` by default; set
`OLLAMA_ORIGINS` for other hosts).

### Develop

```sh
node --test plugins/personal-office-ai/test/plan.test.js
docker compose exec -T eo make plugins   # copy into the running dev server
```
