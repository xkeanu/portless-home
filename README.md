# portless-home

A tiny home page for your tailnet: open `https://<device>.<tailnet>.ts.net`
on your phone and see every dev app currently running through
[portless](https://github.com/vercel-labs/portless), as tappable links.

<img src="docs/screenshot.png" width="390" alt="portless-home directory page on a phone: app cards with green health dots">

Rendered from the example fixture (`docs/fixtures/routes.example.json`):
fake app names and `example.ts.net`, not a real tailnet.

## Why

Portless's `--tailscale` mode shares each app on its own port of your
device's MagicDNS name (`:443`, `:8443`, `:8444`, …), assigned by start
order — so from another device you never know which port an app got.
portless-home claims `:443` with a directory page instead:

- the bare device URL always shows the list, auto-refreshing every 15s
- apps land predictably on `:8443`, `:8444`, …
- each card has a health dot: green if the app answers a local probe
  (HEAD request, 300ms timeout, all cards probed in parallel), grey if
  not
- apps running without Tailscale sharing show up greyed out as "local
  only"

It's one dependency-free Node server (`server.mjs`, ~90 lines) reading
portless's own `~/.portless/routes.json` on every request. Nothing to
configure, nothing to restart when apps come and go. It listens on
`127.0.0.1` and is only reachable from your own tailnet (and localhost)
through `tailscale serve`. Nothing is sent to any third-party service.

## Requirements

- Node.js
- macOS or Linux
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

This copies the server to `~/.portless-home/`, registers a login service
(launchd `sh.portless.home` on macOS, a systemd user service on Linux;
starts at login, restarts on crash, no sudo), and adds a persistent
`tailscale serve` rule pinning it to `:443`. If Tailscale isn't running
at install time, the script skips the serve rule and prints the command
to run once it's up.

Custom port: `PORT=6001 ./install.sh` (then the serve rule targets that
port).

Don't want it starting at login? `./install.sh --no-autostart` starts
the server now but skips start-at-login (and crash restarts). Rerun
`./install.sh` without the flag to switch back.

### Homebrew

There are no tagged releases yet, so the formula installs from HEAD:

```sh
brew tap xkeanu/portless-home https://github.com/xkeanu/portless-home
brew install --HEAD xkeanu/portless-home/portless-home
```

Then pick how it runs — this is the start-at-login switch for the brew
path:

```sh
brew services start portless-home   # run now and at every login
brew services run portless-home     # run now only
brew services stop portless-home    # off
```

Homebrew doesn't touch your Tailscale config, so add the serve rule
yourself (once; it persists across reboots):

```sh
tailscale serve --bg --https=443 http://127.0.0.1:5995
```

## Uninstall

```sh
./uninstall.sh
```

Removes the login service, the installed files, and the `:443` serve
rule.

## How it fits together

```text
phone ── https://<device>.<tailnet>.ts.net ──► tailscale serve :443 ──► portless-home :5995
                                       :8443 ──► your app A
                                       :8444 ──► your app B
```

portless-home never proxies app traffic; it only renders links. Each
app's traffic goes through Tailscale's own serve rules, with Tailscale's
certs.

## Running it locally

Run the server straight from a checkout, no install needed. It reads
`~/.portless/routes.json` by default and serves `http://127.0.0.1:5995`:

```sh
node server.mjs
```

`PORTLESS_ROUTES` points it at any other routes file. The server hides
entries whose `pid` isn't a live process, so to preview the bundled
fixture (the one the screenshot above is rendered from), stamp its
entries with a live pid first:

```sh
node -e 'const fs=require("fs"),r=JSON.parse(fs.readFileSync("docs/fixtures/routes.example.json","utf8"));fs.writeFileSync("/tmp/routes.json",JSON.stringify(r.map(x=>({...x,pid:+process.argv[1]}))))' $$
PORTLESS_ROUTES=/tmp/routes.json node server.mjs
```

The default port is `5995`, outside portless's own `4000-4999` app
range; override with `PORT`.

Tests:

```sh
node --test
```
