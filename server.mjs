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
	const routes = readRoutes();
	const up = await Promise.all(routes.map((r) => probe(r.port)));
	const names = readNames();
	const rows = routes.map((r, i) => card(r, up[i], names)).join('');
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
