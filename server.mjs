// portless-home: a tiny tailnet home page for portless.
// Lists the machine's running portless apps with their Tailscale URLs.
// Reads ~/.portless/routes.json on every request — no restarts needed.
import { createServer, request } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { card, directory, page, MANIFEST, ICON_SVG, ICON_PNG, ICON_PNG_512 } from './render.mjs';
import { readPeers, fetchPeer, snapshot } from './peers.mjs';
import { menubar } from './menubar.mjs';

const ROUTES = process.env.PORTLESS_ROUTES || join(homedir(), '.portless', 'routes.json');
const NAMES = process.env.PORTLESS_NAMES || join(homedir(), '.portless-home', 'names.json');
const LAYOUT = process.env.PORTLESS_LAYOUT || join(homedir(), '.portless-home', 'layout.json');
const PEERS = process.env.PORTLESS_PEERS || join(homedir(), '.portless-home', 'peers.json');
// Keep outside portless's 4000-4999 app port range.
const PORT = Number(process.env.PORT) || 5995;

// Tailscale gives every node an IPv4 in 100.64.0.0/10 (CGNAT) and an IPv6 in
// fd7a:115c:a1e0::/48; either on a non-internal interface means the tailnet is up.
// Interface inspection is in-process and instant — no tailscale CLI to shell out to.
export const hasTailnetAddr = (ifaces) =>
	Object.entries(ifaces).some(([name, addrs]) =>
		(addrs ?? []).some((a) => {
			if (a.internal) return false;
			if (a.family === 'IPv6') return a.address.toLowerCase().startsWith('fd7a:115c:a1e0:');
			// CGNAT space is shared, not Tailscale-exclusive: an ISP or cellular
			// uplink can hold a 100.64.0.0/10 address too, so only trust it on a
			// tunnel interface (macOS utunN, Linux tailscale0).
			if (!/^(utun|tailscale)/.test(name)) return false;
			const [first, second] = a.address.split('.').map(Number);
			return a.family === 'IPv4' && first === 100 && second >= 64 && second <= 127;
		})
	);

// Pinned routes float to the top in pin order; the rest keep routes.json order.
export const orderRoutes = (routes, pinned) => {
	const byHost = new Map(routes.map((r) => [r.hostname, r]));
	const top = pinned.map((h) => byHost.get(h)).filter(Boolean);
	const pinnedSet = new Set(pinned);
	return [...top, ...routes.filter((r) => !pinnedSet.has(r.hostname))];
};

// New pinned list from a save: the request orders the currently running apps,
// while pins for apps that are not running survive (appended) so the layout
// re-attaches when they come back.
export const mergePinned = (requested, oldPinned, liveHostnames) => {
	const live = new Set(liveHostnames);
	const keepRequested = requested.filter((h) => live.has(h));
	const keepAbsent = oldPinned.filter((h) => !live.has(h) && !keepRequested.includes(h));
	return [...new Set([...keepRequested, ...keepAbsent])];
};

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

const readNames = () => {
	try {
		const names = JSON.parse(readFileSync(NAMES, 'utf8'));
		if (names && typeof names === 'object' && !Array.isArray(names)) return names;
	} catch {}
	return {};
};

const readLayout = () => {
	try {
		const layout = JSON.parse(readFileSync(LAYOUT, 'utf8'));
		if (Array.isArray(layout?.pinned)) return { pinned: layout.pinned.filter((h) => typeof h === 'string') };
	} catch {}
	return { pinned: [] };
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

const serve = (res, type, body) => {
	res.writeHead(200, { 'Content-Type': type });
	res.end(body);
};

const readJson = async (req) => {
	try {
		return JSON.parse(await readBody(req));
	} catch {}
};

const rename = async (req, res) => {
	const payload = await readJson(req);
	if (payload === undefined) return fail(res, 400);
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

const layout = async (req, res) => {
	const payload = await readJson(req);
	if (payload === undefined) return fail(res, 400);
	const { pinned } = payload ?? {};
	if (!Array.isArray(pinned) || pinned.length > 100) return fail(res, 400);
	if (pinned.some((h) => typeof h !== 'string' || h.length > 253)) return fail(res, 400);
	const live = readRoutes().map((r) => r.hostname);
	const next = mergePinned(pinned, readLayout().pinned, live);
	mkdirSync(dirname(LAYOUT), { recursive: true });
	writeFileSync(LAYOUT, JSON.stringify({ pinned: next }));
	res.writeHead(204).end();
};

// This device's running apps, pinned first, each probed for health.
const localApps = async () => {
	const { pinned } = readLayout();
	const routes = orderRoutes(readRoutes(), pinned);
	const up = await Promise.all(routes.map((r) => probe(r.port)));
	return { routes, up, names: readNames(), pinned: new Set(pinned) };
};

// JSON twin of the cards, for other portless-home instances (see peers.mjs).
// Lists this device only, so peers pointing at each other cannot fan out.
const api = async (res) => {
	const { routes, up, names } = await localApps();
	serve(res, 'application/json', JSON.stringify(snapshot(hostname(), routes, up, names)));
};

// Text twin of the cards in xbar/SwiftBar plugin format, for menubar/ (see menubar.mjs).
const menu = async (res) => {
	const { routes, up, names } = await localApps();
	serve(res, 'text/plain; charset=utf-8', menubar(routes, up, names, `http://127.0.0.1:${PORT}/`));
};

export const handler = async (req, res) => {
	if (req.method === 'POST' && req.url === '/rename') return rename(req, res);
	if (req.method === 'POST' && req.url === '/layout') return layout(req, res);
	if (req.url === '/api/routes') return req.method === 'GET' ? api(res) : fail(res, 405);
	if (req.url === '/api/menubar') return req.method === 'GET' ? menu(res) : fail(res, 405);
	if (req.url === '/manifest.webmanifest') return serve(res, 'application/manifest+json', MANIFEST);
	if (req.url === '/icon.svg') return serve(res, 'image/svg+xml', ICON_SVG);
	if (req.url === '/icon.png') return serve(res, 'image/png', ICON_PNG);
	if (req.url === '/icon-512.png') return serve(res, 'image/png', ICON_PNG_512);
	// Peers are fetched alongside the local probes, never after them.
	const [{ routes, up, names, pinned }, ...peers] = await Promise.all([localApps(), ...readPeers(PEERS).map((p) => fetchPeer(p))]);
	const rows = routes.map((r, i) => card(r, up[i], names, pinned.has(r.hostname))).join('');
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	res.end(page(directory(hostname(), rows, peers), hasTailnetAddr(networkInterfaces())));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) createServer(handler).listen(PORT, '127.0.0.1');
