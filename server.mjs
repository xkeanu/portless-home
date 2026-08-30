// portless-home: a tiny tailnet home page for portless.
// Lists the machine's running portless apps with their Tailscale URLs.
// Reads ~/.portless/routes.json on every request — no restarts needed.
import { createServer, request } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES = process.env.PORTLESS_ROUTES || join(homedir(), '.portless', 'routes.json');
const NAMES = process.env.PORTLESS_NAMES || join(homedir(), '.portless-home', 'names.json');
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
		// Hard deadline: http's `timeout` option only tracks socket inactivity,
		// so a peer trickling bytes could stall the probe (and the page) forever.
		const req = request({ host: '127.0.0.1', port, method: 'HEAD' }, (res) => {
			res.destroy();
			done(true);
		});
		const deadline = setTimeout(() => req.destroy(), timeoutMs);
		const done = (up) => {
			clearTimeout(deadline);
			resolve(up);
		};
		req.on('error', () => done(false));
		req.end();
	});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const readNames = () => {
	try {
		const names = JSON.parse(readFileSync(NAMES, 'utf8'));
		if (names && typeof names === 'object' && !Array.isArray(names)) return names;
	} catch {}
	return {};
};

const card = (r, up, names) => {
	const name = esc(names[r.hostname] || r.hostname.replace(/\.localhost$/, ''));
	const row = `<span class="row"><span class="${up ? 'dot up' : 'dot'}" role="img" aria-label="${
		up ? 'online' : 'offline'
	}"></span><span class="name" data-host="${esc(r.hostname)}" role="button" tabindex="0">${name}</span></span>`;
	if (!r.tailscaleUrl) {
		return `<li class="local">${row}<span class="url">local only — ${esc(r.hostname)}</span></li>`;
	}
	return `<li><a href="${esc(r.tailscaleUrl)}">${row}<span class="url">${esc(
		r.tailscaleUrl.replace('https://', '')
	)}</span></a></li>`;
};

const readRoutes = () => {
	try {
		return JSON.parse(readFileSync(ROUTES, 'utf8')).filter((r) => alive(r.pid));
	} catch {
		return [];
	}
};

const readBody = (req, limit = 16 * 1024) =>
	new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk) => {
			data += chunk;
			if (data.length > limit) {
				req.destroy();
				reject(new Error('payload too large'));
			}
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});

const writeNames = (names) => {
	mkdirSync(dirname(NAMES), { recursive: true });
	writeFileSync(NAMES, JSON.stringify(names));
};

const fail = (res, code) => res.writeHead(code).end();

const MANIFEST = JSON.stringify({
	name: 'dev apps', short_name: 'dev apps', start_url: '/', display: 'standalone',
	background_color: '#101014', theme_color: '#101014',
	icons: [
		{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
		{ src: '/icon.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
	],
});

// Home-screen icon: the page's card + status-dot motif.
const ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="#101014"/><rect x="36" y="36" width="120" height="120" rx="24" fill="#1a1a20" stroke="#2a2a32" stroke-width="4"/><circle cx="96" cy="96" r="26" fill="#34c759"/></svg>';

// Same design as ICON_SVG, pre-rendered to a 192x192 PNG because iOS
// apple-touch-icon does not accept SVG.
const ICON_PNG = Buffer.from('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', 'base64');

const serve = (res, type, body) => {
	res.writeHead(200, { 'Content-Type': type });
	res.end(body);
};

const rename = async (req, res) => {
	let payload;
	try {
		payload = JSON.parse(await readBody(req));
	} catch {
		return fail(res, 400);
	}
	const { hostname, label } = payload ?? {};
	if (typeof hostname !== 'string' || typeof label !== 'string') return fail(res, 400);
	const trimmed = label.trim();
	if (trimmed.length > 64) return fail(res, 400);
	if (!readRoutes().some((r) => r.hostname === hostname)) return fail(res, 404);
	const names = readNames();
	if (trimmed) names[hostname] = trimmed;
	else delete names[hostname];
	writeNames(names);
	res.writeHead(204).end();
};

export const handler = async (req, res) => {
	if (req.method === 'POST' && req.url === '/rename') return rename(req, res);
	if (req.url === '/manifest.webmanifest') return serve(res, 'application/manifest+json', MANIFEST);
	if (req.url === '/icon.svg') return serve(res, 'image/svg+xml', ICON_SVG);
	if (req.url === '/icon.png') return serve(res, 'image/png', ICON_PNG);
	const routes = readRoutes();
	const up = await Promise.all(routes.map((r) => probe(r.port)));
	const names = readNames();
	const rows = routes.map((r, i) => card(r, up[i], names)).join('');
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	res.end(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light"><meta http-equiv="refresh" content="15">
<meta name="theme-color" content="#101014">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.png">
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
</main>
<script>
document.querySelectorAll('.name').forEach((el) => {
  const rename = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const label = prompt('Rename', el.textContent);
    if (label === null) return;
    fetch('/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: el.dataset.host, label }),
    }).then((r) => (r.ok ? location.reload() : alert('Rename failed'))).catch(() => alert('Rename failed'));
  };
  el.addEventListener('click', rename);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') rename(e);
  });
});
</script>
</body></html>`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) createServer(handler).listen(PORT, '127.0.0.1');
