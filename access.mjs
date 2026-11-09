// Viewer authorization (#48): who is reading the directory, and may they edit it.
// Tailscale Serve (v1.92+) adds Tailscale-User-Login to tailnet requests it
// proxies and strips any copy the client sent. The header is trustworthy only
// because server.mjs listens on 127.0.0.1, so Serve is the one way in from the
// tailnet. Tagged devices and Funnel traffic arrive with no identity.
import { readFileSync } from 'node:fs';
import { localRequest } from './launch.mjs';

const login = (value) => (typeof value === 'string' && value.length <= 256 ? value.trim().toLowerCase() : '');

// ~/.portless-home/access.json: { "owners": ["alice@example.com"] }.
// A missing or invalid file means no owners: everyone may edit, as before #48.
export const readAccess = (path) => {
	try {
		const { owners } = JSON.parse(readFileSync(path, 'utf8'));
		if (Array.isArray(owners)) return { owners: owners.map(login).filter(Boolean) };
	} catch {}
	return { owners: [] };
};

let hinted = false;

// Loopback without proxy or identity headers is this device: full access.
// Through Serve, only an owner login may edit; another login, or none, reads.
export const viewer = (req, { owners }) => {
	const local = localRequest(req);
	if (!owners.length && !local && !hinted) {
		hinted = true;
		console.warn('portless-home: no owners in access.json, so every tailnet viewer can rename and reorder apps. See README "Owners and viewers".');
	}
	const who = login(req.headers['tailscale-user-login']);
	return { login: who, canEdit: local || !owners.length || owners.includes(who) };
};

// The one gate for requests that change state (every method but GET and HEAD).
// A cross-site browser request is refused even for an owner, so another page
// the owner opens cannot edit with their Serve identity.
export const mayWrite = (req, who) => {
	const site = req.headers['sec-fetch-site'];
	return who.canEdit && (!site || site === 'same-origin' || site === 'none');
};
