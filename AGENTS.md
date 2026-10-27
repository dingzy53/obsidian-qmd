# QMD Search (`qmd-search`)

An Obsidian desktop plugin that searches the vault's own **QMD** index. Developed and tested on Linux with the Flatpak build of Obsidian; the plain (non-Flatpak) spawn path is kept but untested.

---

## 1. Design principles

1. **The vault's own index, or nothing.** qmd picks its index from the working directory: the nearest `.qmd/` at or above it, else the global `~/.cache/qmd` index. Every qmd call therefore runs in the *project directory* (the folder containing `.qmd`, by default the vault root). `QmdRunner` refuses to run when `.qmd/index.yml` is missing and `verify()` checks that `qmd status` reports `<projectDir>/.qmd/index.sqlite`. A silent fallback to the global index was the original bug; do not reintroduce it.
2. **Warm server for speed.** One managed `qmd mcp --http` child keeps the models loaded. Fast search goes over its REST endpoint; the CLI is used for keyword fallback, deep search and index jobs.
3. **Zero runtime dependencies.** Obsidian API plus Node built-ins (`child_process`, `http`, `fs`, `os`, `path`).
4. **One result row everywhere.** The modal, the search panel and the related-notes panel all use `ResultList`. Rows show note name, folder, matched section and an excerpt. No score, docid or line badges, no per-row buttons.
5. **Scheduled refresh.** The index is refreshed at launch and daily (user's choice). When `qmd update` reports no changes, nothing else happens: no embed, no server restart.

---

## 2. Layout

```
src/
  main.ts              lifecycle, commands, status bar, wiring
  types.ts             settings, QmdResult
  settings.ts          settings tab
  utils.ts             openAtMatch (+flash), link helpers
  qmd/runner.ts        binary resolution; exec/spawn/kill in the project dir (Flatpak-aware); status(); verify()
  qmd/server.ts        managed `qmd mcp --http` child, health, restart, http client
  qmd/search.ts        fast / deep / related; query sanitizing; result -> vault file
  qmd/indexer.ts       update + embed job; launch and daily schedule
  ui/result-list.ts    the shared rows: render, open, hover, menu, drag, keyboard selection
  ui/snippet.ts        excerpt built from the note file; render + cache
  ui/search-pane.ts    query box + folder filter + status + list (shared by modal and panel)
  ui/search-modal.ts   quick-search modal
  ui/search-view.ts    sidebar search panel
  ui/related-view.ts   related-notes panel
  ui/folder-suggest.ts folder autocomplete
scripts/deploy.mjs     copy the build into the vault
```

---

## 3. Facts about qmd and Flatpak that the code depends on

These were established by testing against qmd 2.8.3 and Obsidian 1.13.7 (Flatpak). Re-verify after upgrades.

**Spawning**
- Flatpak form: `flatpak-spawn --host [--watch-bus] --directory=<dir> --env=PWD=<dir> <qmd> …`. `--directory` alone leaves a stale `PWD`, which qmd reads. The sandbox environment is not forwarded to the host; pass what is needed with `--env=`.
- `qmd` is a launcher script that starts the real program as a child process. Through `flatpak-spawn`, **SIGTERM reaches only the launcher and leaves the real process running**; SIGINT is forwarded to the whole host process group, and `--watch-bus` kills the group when the spawner dies. So `QmdRunner.kill()` sends SIGINT (outside Flatpak: SIGINT to the detached process group). Never stop qmd with SIGTERM.
- Never use `qmd mcp --daemon` (its pidfile is shared with the global index) and never `pkill -f`.

**Server**
- Talk to it with Node `http` on host `localhost`. Renderer `fetch` adds `Origin: app://obsidian.md` and gets 403.
- `POST /query` needs `searches: [{type, query}]` and **`rerank: false` sent explicitly** (rerank defaults to on and takes minutes on CPU).
- It fuses the top 20 keyword and top 20 vector hits, so it returns at most 40 results. Keyword lists are always ranked first and weighted double; the order of `searches` has no effect.
- The server logs every request; its pipes must be drained or it eventually blocks.
- The plugin never adopts a server it did not start. A busy port means "try the next one".
- After the launcher exits, the real server still needs a moment to close; `stop()` waits until the port is free.

**Results and queries**
- REST returns `file: "qmd://<collection>/<url-encoded path>"`; the CLI returns it unencoded. Do not use `--full-path` (it emits `./`-relative paths when cwd is the vault). Stored paths are verbatim relative to the collection root; a relative collection `path` resolves against the folder containing `.qmd`.
- `line` is the 1-based matched line; the snippet header `@@ -S,C @@` gives the snippet's first line `S`. Over REST each snippet line is also prefixed with `N: `.
- vec queries are rejected if they contain negation (`/(^|\s)-[\w"]/`); REST lex queries are rejected on an odd number of `"`. On the CLI, pass the query after `--` or a leading `-` is parsed as a flag.
- Query expansion costs about 12–20 s on CPU even with warm models, so deep search runs as a separate, abortable CLI process (`qmd query … --no-rerank`).

**Index**
- `qmd update` prints `Indexed: N new, M updated, U unchanged, R removed` and, when vectors are missing, `(N unique hashes need vectors)`. `QmdIndexer` parses both.
- SQLite runs in WAL mode with a 120 s busy timeout, so the server and an index job can overlap. The server is restarted after a job that changed something, which also checkpoints the WAL into `index.sqlite` (the vault tracks that file in git).

**Obsidian internals used (feature-detected)**
- `editor.addHighlights(ranges, 'is-flashing', true, true)` / `removeHighlights` for the flash.
- `app.dragManager.dragFile` / `onDragStart` for dragging a row as a file.
- `workspace.trigger('hover-link', …)` with a registered hover source for page preview.

---

## 4. Workflow

- `npm run build` — type-check (`tsc --noEmit`) and bundle.
- `npm run lint`, `npm test` — eslint; vitest for the pure query/snippet helpers (`obsidian` is stubbed in `test/obsidian-stub.ts`).
- `npm run deploy` — build and copy into the vault (`QMD_PLUGIN_DIR` overrides the target).
- Reload in the running app: `obsidian plugin:reload id=qmd-search`. Inspect with `obsidian eval code="app.plugins.plugins['qmd-search']…"`, `obsidian dev:errors`, `obsidian dev:screenshot path=<file under $HOME>` (the sandbox has its own `/tmp`).
- After any change to process handling, check that exactly one `qmd.js mcp --http` process exists after a reload, a restart and a disable.
