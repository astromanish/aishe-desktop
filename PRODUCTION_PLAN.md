# Aishe Desktop — Production Readiness Plan

Ordered by risk. See `aishe-cli/PRODUCTION_PLAN.md` for the CLI-side items;
this file covers the desktop specifically.

Status legend: `DONE` · `PLANNED` · `WONTFIX`

---

## DONE

### Markdown URL scheme restriction — verified already correct
The audit flagged `javascript:` URLs as reachable through model output. On
inspection, the link regex at `renderer/app.js:44` already requires `https?://`,
so non-http schemes (`javascript:`, `data:`, `vbscript:`) never become links.
`escapeHtml` alone would not have been enough — it stops HTML injection but
leaves the scheme intact. Two regression tests now pin the scheme restriction
and the escape-before-parse ordering.

---

## PLANNED — blocking for a real user

### 1 · Packaging (highest priority)
There is no build script. Users cannot install this; it only runs from the
checkout via `aishe desktop` → `run.sh`.

- `electron-builder` producing an **AppImage** (this is an Arch/Omarchy box, so
  AppImage first; `.deb`/`.rpm` only if there is demand)
- A `.desktop` entry so it appears in the app launcher
- Code signing is out of scope for now — AppImage on Linux is conventionally
  unsigned

### 2 · CI
48 test assertions exist and nothing runs them on push.

- `.github/workflows/test.yml`: `npm ci && npm test`
- `npm run check` for svelte/electron type drift would need a lint setup that
  does not exist yet — start with tests only

## PLANNED — correctness

### 3 · Auth-error handling
`lib/services.js` has no 401/403 branch, so a bad API key looks identical to a
provider outage. Detect it and say which credential failed, pointing at the Keys
pane. The Keys pane already shows masked fingerprints, so the user can confirm
*which* key is in play.

### 4 · Retry on transient failure
No retry anywhere in `lib/services.js`. A dropped connection during a health
probe reads as "service down", and the model picker shows a provider as having
no models when its catalogue fetch simply timed out.

Add bounded retry with backoff to the health and model-catalogue fetches. Do
**not** add retry to `model:set` — restarting DeepAgent twice is worse than
reporting one failure.

### 5 · Offline / degraded state
When DeepAgent is down the composer still accepts input and the send fails with
a raw error. Better: disable the composer and show a one-line reason with a
"Start DeepAgent" action, since `lib/control.js` already knows how to start it.

### 6 · Window state persistence
Window size and position are not remembered between launches.

### 7 · Deep-agent log surface
`lib/control.js` captures stderr to `~/.local/state/aishe/voice/deepagent.log`,
but nothing in the UI shows it. When a model switch fails, the reason is in that
file and the user has no way to see it without a terminal.

## PLANNED — accessibility

- No ARIA on the model picker or the message list; screen-reader users get
  nothing useful from a chat transcript.
- No keyboard shortcut to focus the composer.

## WONTFIX

- **Auto-update** — no code signing, and the app is tied to a local DeepAgent
  that must be updated in step. Ship by hand until there are real users.
- **Tray icon** — the app is a focused chat window, not a background daemon.
