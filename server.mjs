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
		{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
	],
});

// Home-screen icon: the page's card + status-dot motif.
const ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="#101014"/><rect x="36" y="36" width="120" height="120" rx="24" fill="#1a1a20" stroke="#2a2a32" stroke-width="4"/><circle cx="96" cy="96" r="26" fill="#34c759"/></svg>';

// Same design as ICON_SVG, pre-rendered to PNG: iOS apple-touch-icon does not
// accept SVG, and Chromium's install criteria want 192px and 512px rasters.
const ICON_PNG_512 = Buffer.from('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', 'base64');
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
	if (req.url === '/icon-512.png') return serve(res, 'image/png', ICON_PNG_512);
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
