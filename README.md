# QMD Search

An [Obsidian](https://obsidian.md) desktop plugin that searches your vault with its own **[QMD](https://github.com/tobi/qmd)** index: fast keyword + semantic search, LLM-expanded deep search on demand, and a related-notes panel. No runtime dependencies.

## Requirements

- Obsidian 1.8.0 or newer, desktop only.
- [qmd](https://github.com/tobi/qmd) installed, with an index created inside the vault (`qmd init` in the vault folder).

## Installation

**From a release**

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/dingzy53/obsidian-qmd/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/qmd-search/`.
3. Reload Obsidian and enable **QMD Search** under *Settings → Community plugins*.

**With BRAT:** add `dingzy53/obsidian-qmd`.

---

## How it works

- **The vault's own index.** The plugin runs `qmd` inside the vault folder, so qmd uses `<vault>/.qmd/index.sqlite` and `<vault>/.qmd/index.yml` (created with `qmd init`). If that index cannot be found the plugin says so and stops; it never falls back to the global index.
- **A warm server.** While Obsidian is open the plugin keeps one `qmd mcp --http` process running so the embedding model stays loaded. A fused keyword + vector search then takes roughly 0.3–0.7 s instead of 10+ s per search through the CLI. The server stops when the plugin is disabled or Obsidian closes.
- **Scheduled refresh.** About 20 seconds after launch, and once a day after a set hour, the plugin runs `qmd update` and, if anything changed, `qmd embed`. When nothing changed it does nothing else.

---

## Using it

| Surface | Open with | What it does |
|---|---|---|
| Quick search | command **QMD Search: Search** (assign a hotkey) | Type to search; results update as you type. |
| Search panel | ribbon icon ✨ or **Open search panel** | The same search in the right sidebar; results stay while you work. |
| Related notes | **Open related notes** | Notes semantically close to the note you are on. Follows the active note. |
| Selection | **Search selected text** | Sends the selection to the search panel. |

Each result shows the note name, its folder, the matched section and an excerpt taken from the note itself (math rendered, never cut mid-formula).

**Keys in the search box**

| Key | Action |
|---|---|
| ↑ / ↓ | Move through results (↑ on an empty box recalls the last query) |
| Enter | Open the note at the match and flash it |
| Ctrl+Enter | Open in a new tab |
| Ctrl+Alt+Enter | Open to the right |
| Shift+Enter | Deep search: rerun with LLM query expansion (about 15–20 s on CPU) |
| Alt+Enter | Insert a link to the result at the cursor |

**Mouse:** click opens, Ctrl-click or middle-click opens a new tab, hover shows a page preview, right-click gives a menu, and a row can be dragged into a note to make a link.

**Query syntax:** `"exact phrase"` and `-excluded` work for the keyword half of the search. **Folder filter:** type a folder in the field under the search box.

The status bar item **QMD ●** shows the state (green ready, yellow starting or indexing, red problem). Click it to update the index, restart the server or open settings.

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| Index location | vault root | Folder that contains `.qmd`. |
| qmd binary | auto-detect | |
| Refresh when Obsidian starts | on | |
| Refresh daily | on, 04:00 | First chance after that hour while Obsidian is open. |
| Embed changed notes | on | Runs `qmd embed` after an update that changed something. |
| Keep a qmd server running | on | Off = keyword search only. |
| Port | 8421 | The next five are tried if it is taken. |
| Search results | 20 | Up to 40. |
| Related notes shown | 10 | |
| Rerank in deep search | off | Minutes without a dedicated GPU. |

---

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # type-check and bundle to main.js
npm run lint
npm test
QMD_PLUGIN_DIR=<vault>/.obsidian/plugins/qmd-search npm run deploy   # build and copy into a vault
```

Then reload the plugin: `obsidian plugin:reload id=qmd-search`. See [AGENTS.md](AGENTS.md) for design notes.

## Releasing

```bash
npm version patch   # bumps package.json, manifest.json and versions.json, commits and tags
git push --follow-tags
```

The tag triggers the Release workflow, which lints, tests, builds and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release.

---

## Good to know

- `.qmd/index.sqlite` changes whenever the index is refreshed after notes changed. While the server runs, the newest writes sit in `index.sqlite-wal` and are folded into `index.sqlite` when the server stops or restarts.
- A fused search draws on the top 20 keyword and top 20 semantic hits. With a folder filter the plugin tops the list up with a wider keyword search.
- Reranking and query expansion are CPU-bound LLM work; only fast search is instant.

## License

[MIT](LICENSE)
