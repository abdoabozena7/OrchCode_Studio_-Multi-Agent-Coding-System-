# UI Flow Map

## Verified
- Vite web UI rendered at `http://127.0.0.1:5174/`.
- DOM showed: Select workspace, details/diff/terminal toggles, composer, Plan mode, RTL, Full Access, Open workspace, startup suggestions.
- Console errors/warnings from browser capture: 0.
- Screenshot capture through in-app browser timed out; see `screenshots/SCREENSHOT_UNAVAILABLE.md`.

## Not Verified
- Native Tauri window automation was not performed.
- Native file picker/workspace activation was not clicked.
- Real runtime SSE update into native UI was not E2E verified.
- Command approval and patch auto-apply were verified by source and smoke scripts, not by clicking in the native window.

## Source Trace Findings
- UI state lives mostly in `App.tsx`.
- Runtime session subscription mirrors events to Rust SQLite asynchronously. If append fails, UI logs but runtime keeps moving.
- Activity stream is a derived compact stream from recent transitions, not a full event log by default.
- Terminal drawer can run manual Rust commands separately from agent command requests.
- Full Access defaults are visible in startup DOM, but dangerous command behavior still depends on frontend safety settings and Rust policy.
- Provider mode is configured in settings/source/DB, but startup DOM did not clearly show "active provider/model".
- Swarm/trial artifacts are not visible in captured startup DOM.

## Evidence
- `tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt`
- `apps/desktop/src/app/App.tsx:482`, `App.tsx:761`, `App.tsx:848`
- `apps/desktop/src/app/activityStream.ts`
