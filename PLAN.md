# PLAN: QA audit fixes (qmd-vault-search)

> Branch: `fix/qa-audit-fixes` (from `feat/e2e-testing`) · Date: 2026-11-24 · Status: Implemented and verified.

## Context & Findings

From `/Users/ding/GitHub/OBSIDIAN_PLUGINS_QA_REPORT.md`:

1. **BUG-05 (P2)**: All QMD search results show as "Not in the vault any more" when the collection path or vault path goes through a symlink alias (e.g. `/tmp` vs `/private/tmp`), and re-adding the collection fails until reload because `.qmd/index.yml` is cached.
2. **BUG-06 (P2)**: An orphaned `qmd mcp --http` server (PPID 1) can remain alive after a crash/force-quit and hold the default port (8421).
3. **BUG-09a (P3)**: **Restart qmd server** does not clear the red error status after the index is created.
4. **BUG-09b (P3)**: The search modal jumps from mid-screen to the top when results arrive.
5. **BUG-09c (P3)**: Ribbon tooltip ("Open vault search") disagrees with command name ("Open search panel").
6. **BUG-09d (P3)**: Status-bar item is not keyboard-focusable.
7. **BUG-09e (P3)**: "Hover preview delay" displays `"2 / s"` on two lines.
8. **Settings audit**: Remove built-in `min`/`max` on `serverPort` so the custom period-ended `validate` message runs consistently; tighten `"Purge removed notes"` description to one sentence.

## Verified Root Causes & Fix Design

1. **Symlink path canonicalization & config invalidation (`src/qmd/config.ts`, `src/qmd/search.ts`)**:
   - Export `realPath(p)` (`fs.realpathSync` with `path.resolve` fallback) and canonicalize both `vaultPath` and collection `root` in `QmdSearch.toResult`, `QmdConfig.inRoot`, and `QmdConfig.vaultFolder`.
   - Add `QmdConfig.reloadIfChanged()` (stat `mtimeMs`/`size`) and invoke it before `fast()`, `deep()`, and `related()` searches.
2. **Process-group kill & orphan reaping (`src/qmd/runner.ts`, `src/qmd/server.ts`, `src/main.ts`, `README.md`)**:
   - Signal `-child.pid` on detached process groups even if the launcher wrapper already exited, and escalate `QmdServer.stop()` to process-group `SIGKILL`.
   - Record `{ pid, port, projectDir }` in vault-scoped `localStorage` (`qmd-vault-search-server`), verify `qmd mcp --http --port <port>` via `/proc/<pid>/cmdline` or `ps` before reaping on next startup, and clear on clean stop. Disclose `ps` in `README.md`.
3. **Status recovery & UI/settings polish (`src/qmd/indexer.ts`, `src/main.ts`, `src/settings.ts`, `styles.css`)**:
   - Add `QmdIndexer.clearError()` and central `QmdPlugin.restartServer()` (re-verifies `runner`, invalidates search/config, clears stale error, restarts server).
   - Anchor `.modal.qmd-modal` near the top (`align-self: flex-start; margin-top: 9vh;`).
   - Align ribbon tooltip to `'Open search panel'`, make status bar keyboard-accessible (`tabindex="0"`, `role="button"`, `Enter`/Space menu), format delay as `` `${ms / 1000}s` ``, drop `min`/`max` on `serverPort`, and tighten `"Purge removed notes"` description.

## Order of Work

1. `[x]` Fix symlink resolution and `.qmd/index.yml` invalidation (`src/qmd/config.ts`, `src/qmd/search.ts`).
2. `[x]` Fix process-group cleanup and orphan reaping (`src/qmd/runner.ts`, `src/qmd/server.ts`, `README.md`).
3. `[x]` Fix status recovery, modal jump, ribbon tooltip, status-bar keyboard access, and settings polish (`src/qmd/indexer.ts`, `src/main.ts`, `src/settings.ts`, `styles.css`).
4. `[x]` Add unit tests, run `npm run lint && npm test && npm run build && npm run check:mobile`, mark plan verified, and push `fix/qa-audit-fixes`.

## Verification Plan

- `npm run lint` (0 errors, 0 warnings, zero `eslint-disable`)
- `npm test` (Vitest unit tests)
- `npm run build`
- `npm run check:mobile`
