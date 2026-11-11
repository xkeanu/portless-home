// Viewer authorization (#48): who is reading the directory, and may they edit it.
// Tailscale Serve (v1.92+) adds Tailscale-User-Login to tailnet requests it
// proxies and strips any copy the client sent. The header is trustworthy only
// because server.mjs listens on 127.0.0.1, so Serve is the one way in from the
// tailnet. Tagged devices and Funnel traffic arrive with no identity.
import { readFileSync } from 'node:fs';
import { localRequest } from './launch.mjs';

const normal = (value) => (typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim().toLowerCase() : '');

// Serve sends a non-ASCII login as RFC 2047 Q-encoded UTF-8 words
// (=?utf-8?q?jos=C3=A9@example.com?=), split by spaces when long. Anything
// malformed decodes to no login.
const utf8 = new TextDecoder('utf-8', { fatal: true });
export const decodeLogin = (value) => {
	if (typeof value !== 'string' || !value.startsWith('=?')) return normal(value);
	const bytes = [];
	for (const word of value.trim().split(/\s+/)) {
		const match = /^=\?utf-8\?q\?([^?]*)\?=$/i.exec(word);
		if (!match) return '';
		for (let i = 0; i < match[1].length; i++) {
			const c = match[1][i];
			if (c === '_') bytes.push(0x20);
			else if (c !== '=') bytes.push(c.charCodeAt(0));
			else if (/^[0-9a-f]{2}$/i.test(match[1].slice(i + 1, i + 3))) bytes.push(parseInt(match[1].slice(i + 1, (i += 2) + 1), 16));
			else return '';
		}
	}
	try {
		return normal(utf8.decode(Uint8Array.from(bytes)));
	} catch {
		return '';
	}
};

// ~/.homeport/access.json: { "owners": ["alice@example.com"] }.
// No file, or no owners key, means unconfigured: everyone may edit, as before
// #48. A file that cannot be read or parsed, or a malformed owners list, is
// `invalid`: remote viewers lose edit access rather than gain it.
export const readAccess = (path) => {
	let config;
	try {
		config = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		return error?.code === 'ENOENT' ? { owners: [] } : { owners: [], invalid: true };
	}
	if (!config || typeof config !== 'object' || Array.isArray(config)) return { owners: [], invalid: true };
	if (config.owners === undefined) return { owners: [] };
	const owners = Array.isArray(config.owners) ? config.owners.map(normal) : [];
	if (!Array.isArray(config.owners) || owners.includes('')) return { owners: [], invalid: true };
	return { owners };
};

const hinted = new Set();
const hint = (key, message) => {
	if (hinted.has(key)) return;
	hinted.add(key);
	console.warn(`homeport: ${message} See README "Owners and viewers".`);
};

// Loopback without proxy or identity headers is this device: full access.
// Through Serve, only an owner login may edit; another login, or none, reads.
export const viewer = (req, { owners, invalid = false }) => {
	const local = localRequest(req);
	if (!local && invalid) hint('invalid', 'access.json is unreadable or malformed, so tailnet viewers are read-only until it is fixed.');
	else if (!local && !owners.length) hint('open', 'no owners in access.json, so every tailnet viewer can rename and reorder apps.');
	const login = decodeLogin(req.headers['tailscale-user-login']);
	return { login, canEdit: local || (!invalid && !owners.length) || owners.includes(login) };
};

// The one gate for requests that change state (every method but GET and HEAD).
// A cross-site browser request is refused even for an owner, so another page
// the owner opens cannot edit with their Serve identity.
export const mayWrite = (req, who) => {
	const site = req.headers['sec-fetch-site'];
	return who.canEdit && (!site || site === 'same-origin' || site === 'none');
};
