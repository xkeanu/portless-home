# portless-home

A tiny home page for your tailnet: open `https://<device>.<tailnet>.ts.net`
on your phone and see every dev app currently running through
[portless](https://github.com/vercel-labs/portless), as tappable links.

Portless's `--tailscale` mode shares each app on its own port of your
device's MagicDNS name (`:443`, `:8443`, `:8444`, …), assigned by start
order — so from another device you never know which port an app got.
portless-home claims `:443` with a directory page instead:

- the bare device URL always shows the list (auto-refreshes every 15s)
- apps land predictably on `:8443`, `:8444`, …
- apps running without Tailscale show up greyed out as "local only"

It's one dependency-free Node server (~70 lines) reading portless's own
`~/.portless/routes.json` per request. Nothing to configure, nothing to
restart when apps come and go. No data leaves your machine — the page is
only reachable from your own tailnet (and localhost).

## Requirements

- macOS (launchd; PRs for Linux/systemd welcome)
- Node.js
- [portless](https://github.com/vercel-labs/portless) with Tailscale sharing
  (`--tailscale` or `PORTLESS_TAILSCALE=1`)
- Tailscale connected, with MagicDNS + HTTPS Certificates enabled in your
  tailnet's DNS settings

## Install

```sh
git clone https://github.com/xkeanu/portless-home
cd portless-home
./install.sh
```

This copies the server to `~/.portless-home/`, registers a login
LaunchAgent (`sh.portless.home` — starts at boot, restarts on crash, no
sudo), and adds a persistent `tailscale serve` rule pinning it to `:443`.

Custom port: `PORT=6001 ./install.sh` (then serve rule targets that port).

## Uninstall

```sh
./uninstall.sh
```

Removes the LaunchAgent, the installed files, and the `:443` serve rule.

## How it fits together

```
phone ── https://mac.<tailnet>.ts.net ──► tailscale serve :443 ──► portless-home :5995
                                  :8443 ──► your app A
                                  :8444 ──► your app B
```

portless-home never proxies app traffic; it only renders links. Each app's
traffic goes through Tailscale's own serve rules, with Tailscale's certs.
