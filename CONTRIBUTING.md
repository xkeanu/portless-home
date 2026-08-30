# Contributing

Thanks for helping out! portless-home is intentionally tiny — the bar for
merging is "small, focused, and keeps the project simple."

## Ground rules

- **All changes go through a pull request.** `main` is protected; nothing
  merges without CI passing.
- **One logical change per PR.** A PR that fixes a bug *and* restyles the
  page will be asked to split.
- **Branch names** must match `type/short-description` (lowercase kebab),
  optionally with an issue number:
  - `feature/12-linux-systemd`
  - `fix/dead-pid-filter`
  - `docs/readme-typo`
  - Allowed types: `feature/`, `fix/`, `docs/`, `chore/`, `ci/`.
    GitHub rejects other names at push time.
- PRs are **squash-merged**, so your PR title becomes the commit message —
  write it like one.

## Design principles

These keep the project maintainable; PRs that break them need a very good
reason in the description.

1. **Zero dependencies, no build step.** The server runs with `node
   server.mjs` and nothing else. Don't add npm packages.
2. **Single-file server until it hurts.** `server.mjs` stays one file
   while it's small. If a change would push it past ~200 lines, split by
   concern (e.g. `render.mjs` for HTML) rather than growing it.
3. **Logic lives in pure functions.** HTML comes from functions like
   `card()` that take data and return strings. Don't inline duplicate
   markup in the request handler — extract a function instead.
4. **Stateless per request.** The server rereads `routes.json` on every
   request. No caches, no watchers, no background timers.
5. **Escape everything user-influenced.** Any value from `routes.json`
   goes through `esc()` before landing in HTML.

## Testing

CI runs a syntax check and a smoke test (boots the server against a
fixture `routes.json` and asserts the page renders). Run it locally:

```sh
node --check server.mjs
bash -n install.sh && bash -n uninstall.sh
```

For install/uninstall changes, note in the PR which macOS version you
tested on. Linux/systemd support is welcome (tracked in the README).
