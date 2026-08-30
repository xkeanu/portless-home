// portless-home: a tiny tailnet home page for portless.
// Lists the machine's running portless apps with their Tailscale URLs.
// Reads ~/.portless/routes.json on every request — no restarts needed.
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES = process.env.PORTLESS_ROUTES || join(homedir(), '.portless', 'routes.json');
// Keep outside portless's 4000-4999 app port range.
const PORT = Number(process.env.PORT) || 5995;

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

export const probe = (port, timeoutMs = 300) =>
	new Promise((resolve) => {
		const req = request({ host: '127.0.0.1', port, method: 'HEAD', timeout: timeoutMs }, (res) => {
			res.destroy();
			resolve(true);
		});
		req.on('timeout', () => req.destroy());
		req.on('error', () => resolve(false));
		req.end();
	});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const card = (r, up) => {
	const name = esc(r.hostname.replace(/\.localhost$/, ''));
	const row = `<span class="row"><span class="${up ? 'dot up' : 'dot'}"></span><span class="name">${name}</span></span>`;
	if (!r.tailscaleUrl) {
		return `<li class="local">${row}<span class="url">local only — ${esc(r.hostname)}</span></li>`;
	}
	return `<li><a href="${esc(r.tailscaleUrl)}">${row}<span class="url">${esc(
		r.tailscaleUrl.replace('https://', '')
	)}</span></a></li>`;
};

export const handler = async (req, res) => {
	let routes = [];
	try {
		routes = JSON.parse(readFileSync(ROUTES, 'utf8')).filter((r) => alive(r.pid));
	} catch {}
	const up = await Promise.all(routes.map((r) => probe(r.port)));
	const rows = routes.map((r, i) => card(r, up[i])).join('');
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	res.end(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light"><meta http-equiv="refresh" content="15">
<title>dev apps</title>
<style>
  body{font-family:ui-sans-serif,system-ui;background:#101014;color:#e6e6ea;margin:0;
    display:flex;justify-content:center;padding:48px 16px}
  main{width:100%;max-width:420px}
  h1{font-size:14px;font-weight:500;color:#8a8a94;letter-spacing:.08em;text-transform:uppercase}
  ul{list-style:none;padding:0;margin:16px 0}
  li a,li.local{display:flex;flex-direction:column;gap:2px;padding:14px 16px;margin-bottom:8px;
    background:#1a1a20;border:1px solid #2a2a32;border-radius:10px;text-decoration:none}
  li.local{opacity:.5}
  li a:active{background:#22222a}
  .row{display:flex;align-items:center;gap:8px}
  .dot{width:8px;height:8px;border-radius:50%;background:#4a4a54;flex:none}
  .dot.up{background:#34c759}
  .name{color:#e6e6ea;font-size:16px;font-weight:600}
  .url{color:#8a8a94;font-size:12px;font-family:ui-monospace,monospace}
  .empty{color:#8a8a94;font-size:14px}
</style></head>
<body><main><h1>dev apps</h1>
${rows ? `<ul>${rows}</ul>` : '<p class="empty">Nothing running. Start an app through portless.</p>'}
</main></body></html>`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) createServer(handler).listen(PORT, '127.0.0.1');
