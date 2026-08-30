// portless-home peers: other portless-home instances on the tailnet, read from
// ~/.portless-home/peers.json ({ "peers": ["https://<device>.<tailnet>.ts.net"] })
// and fetched through their GET /api/routes. This module owns that wire format
// in both directions: snapshot() produces it, parsePeerSnapshot() checks it.
// Peer responses are untrusted input.
import { readFileSync } from 'node:fs';
import { displayName } from './render.mjs';

// JSON twin of the cards: { device, apps: [{ hostname, label, tailscaleUrl?, up }] }.
export const snapshot = (device, routes, up, names) => ({
	device,
	apps: routes.map((r, i) => ({
		hostname: r.hostname,
		label: displayName(r.hostname, names),
		...(r.tailscaleUrl ? { tailscaleUrl: r.tailscaleUrl } : {}),
		up: up[i],
	})),
});

const isHttpUrl = (s) => {
	if (typeof s !== 'string') return false;
	try {
		return /^https?:$/.test(new URL(s).protocol);
	} catch {
		return false;
	}
};

const MAX_APPS = 100;
const MAX_LABEL = 64;

const parseApp = (a) => {
	if (!a || typeof a.hostname !== 'string' || a.hostname.length > 253) return null;
	const app = { hostname: a.hostname };
	if (typeof a.label === 'string') app.label = a.label.slice(0, MAX_LABEL);
	// Only https links: a peer's tailscaleUrl lands in an href, and esc() does
	// not stop javascript: or data: schemes.
	if (typeof a.tailscaleUrl === 'string' && /^https:\/\//i.test(a.tailscaleUrl)) app.tailscaleUrl = a.tailscaleUrl;
	app.up = a.up === true;
	return app;
};

// Validate a peer's /api/routes body into { device, apps }; null when it is
// not a snapshot at all. `fallbackDevice` names the section when the peer
// sent no usable device name.
export const parsePeerSnapshot = (data, fallbackDevice) => {
	if (!data || typeof data !== 'object' || !Array.isArray(data.apps)) return null;
	const sent = typeof data.device === 'string' ? data.device.trim().slice(0, MAX_LABEL) : '';
	return {
		device: sent || fallbackDevice,
		apps: data.apps.slice(0, MAX_APPS).map(parseApp).filter(Boolean),
	};
};

export const parsePeers = (text) => {
	try {
		const peers = JSON.parse(text)?.peers;
		return Array.isArray(peers) ? peers.filter(isHttpUrl) : [];
	} catch {
		return [];
	}
};

// Configured peer URLs; a missing or unreadable file means no peers.
export const readPeers = (path) => {
	try {
		return parsePeers(readFileSync(path, 'utf8'));
	} catch {
		return [];
	}
};

// Long enough for a DERP-relayed round trip plus the peer's own 300ms probes;
// short enough that a dead peer does not make the page feel stuck.
export const PEER_TIMEOUT_MS = 1500;
const MAX_BODY = 256 * 1024;

// Read the body while counting bytes, so an oversized peer response is cut off
// at the cap rather than buffered in full and discarded afterwards.
const readCapped = async (body, limit) => {
	const chunks = [];
	let size = 0;
	for await (const chunk of body) {
		size += chunk.length;
		if (size > limit) throw new Error('peer response too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
};

// One peer's snapshot, or null for anything short of a valid answer in time:
// the page never waits on, or breaks for, a peer that is off or unreachable.
// The one AbortSignal covers connect, headers and body, so a peer that stalls
// mid-body is cut off at the same deadline. Redirects are refused: a peer must
// not be able to point this server at some other (internal) URL.
export const fetchPeer = async (base, timeoutMs = PEER_TIMEOUT_MS) => {
	const url = new URL('/api/routes', base);
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
			redirect: 'error',
			headers: { accept: 'application/json' },
		});
		if (!res.ok) return null;
		return parsePeerSnapshot(JSON.parse(await readCapped(res.body, MAX_BODY)), url.hostname);
	} catch {
		return null;
	}
};
