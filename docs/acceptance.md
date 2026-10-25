# Acceptance map

The directory and account screen retain their existing Svelte styles. Account
refinements use the compact 760px layout, system typography, dark/light palette,
and amber actions in the existing components.

| Journey | Start | Success signal | Proof |
| --- | --- | --- | --- |
| Open local, peer, and external apps | `/` | Correct links, health and local-only actions | `node --test ui.test.mjs server.test.mjs` |
| Detect and save current CLI logins | `/accounts` | Unsaved A is visible; saving A, signing into B and returning preserves A and offers Save for B; saving B retains both | `node --test accounts.test.mjs accounts-http.test.mjs accounts-ui.test.mjs`; browser capture command below |
| Switch or forget a saved login | `/accounts` | Explicit confirmation; busy switches refused; manual relaunch guidance; forgetting leaves the CLI signed in | Same account tests and browser keyboard checks |
| Inspect quota and configure routing | `/accounts` | Freshness is visible beside quotas; current and recommended states stay distinct; settings save correctly | `node --test accounts-ui.test.mjs account-routing.test.mjs` |
| Keep credentials local across devices | `/api/accounts/metadata` | Only saved metadata syncs; remote accounts require a local login; no credential payload in public models | `node --test accounts.test.mjs account-sync.test.mjs accounts-http.test.mjs` |

Run `npm run build` before individual UI tests. `npm test` builds and runs all
Node tests. CONTRIBUTING.md also requires packaging and release smoke checks.

| Screen | States | Viewports | Capture |
| --- | --- | --- | --- |
| `/accounts` | Detected/unsaved, populated, empty, unavailable, remote-only, busy/pending, usage error, stale quota, long identity, disabled; completed save lifecycle and switch confirmation | 390 and 1280 CSS pixels; light plus selected dark states | `browser-gate run -- node scripts/capture-accounts.mjs /tmp/portless-account-captures` |

The capture script uses optional Playwright CLI 0.1.22 through npx; it does not
change the runtime dependency requirements. To use an already installed CLI,
set `PORTLESS_PLAYWRIGHT_CLI` to its JavaScript entry point. Run under
`browser-gate` where available; it bounds concurrent browser workloads.

Browser fixtures use the real renderer, account manager and account HTTP handler
with synthetic provider adapters, a temporary encrypted vault, and a dynamic
loopback port. They never inspect real provider credentials. The command closes
its browser and server on completion and saves screenshots plus command logs in
the output directory. For an interactive local look, run
`node scripts/account-preview.mjs` and open its printed URL; stop it with Ctrl-C.

Keyboard proofs: Tab/Enter reaches Save account; switching requires Space on the
stopped-sessions checkbox followed by Tab/Enter on Switch login; Enter opens
Routing preferences. A dispatched browser focus event verifies return detection.
The automated browser keeps tabs focused, so native window/tab event delivery
is not proven by this command. Focused forms,
confirmations, hidden pages and in-flight actions are covered by UI regressions.
Returning does not save a login or refresh its credentials; there is no account polling.

These fixtures prove application behavior and layout, not current compatibility
with a live provider login or the validity of saved credentials. Human visual
review remains required before merging account UI changes.
