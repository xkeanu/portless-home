import { timingSafeEqual } from 'node:crypto';
import { localRequest } from './launch.mjs';
import { AccountError } from './account-store.mjs';

const reply = (res, status, value) => {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
	res.end(JSON.stringify(value));
};
const origin = (req) => new URL(`http://${req.headers.host}`).origin;
const ownerRequest = (req) => localRequest(req) && (!req.headers.origin || req.headers.origin === origin(req)) &&
	(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
const bearer = (req, secret) => {
	if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) return false;
	const value = req.headers.authorization;
	if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
	const expected = Buffer.from(secret);
	const actual = Buffer.from(value.slice(7));
	return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const body = async (req) => {
	const chunks = [];
	let size = 0;
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > 32 * 1024) { req.resume(); throw new AccountError('body', 'The account request is too large.', 413); }
		chunks.push(chunk);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
	catch { throw new AccountError('body', 'The account request must be valid JSON.'); }
};
const only = (input, keys) => {
	if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new AccountError('input', 'Invalid account request.');
	return input;
};

export const accountHttp = (manager, renderPage) => async (req, res) => {
	if (req.url !== '/accounts' && req.url !== '/api/accounts' && !req.url?.startsWith('/api/accounts/')) return false;
	try {
		if (req.url === '/api/accounts/metadata') {
			if (req.method !== 'GET') { reply(res, 405, { error: 'Use GET for account metadata.' }); return true; }
			const config = manager.settings();
			if (config.enabled !== true || !bearer(req, config.snapshotToken)) { reply(res, 403, { error: 'Account metadata requires this device’s pairing token.' }); return true; }
			reply(res, 200, await manager.metadata());
			return true;
		}
		if (!ownerRequest(req)) { reply(res, 403, { error: 'Account management is available only on this device’s localhost address.' }); return true; }
		if (req.url === '/accounts') {
			if (req.method !== 'GET') { reply(res, 405, { error: 'Use GET for the accounts page.' }); return true; }
			const model = await manager.snapshot();
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(renderPage(model));
			return true;
		}
		if (req.url === '/api/accounts') {
			if (req.method !== 'GET') { reply(res, 405, { error: 'Use GET to read accounts.' }); return true; }
			reply(res, 200, await manager.snapshot());
			return true;
		}
		if (!['POST', 'DELETE'].includes(req.method)) { reply(res, 405, { error: 'This account action requires POST.' }); return true; }
		if (req.headers.origin !== origin(req) || req.headers['sec-fetch-site'] === 'none') { reply(res, 403, { error: 'Account changes require a same-origin request.' }); return true; }
		if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { reply(res, 415, { error: 'Use application/json for account changes.' }); return true; }
		const input = await body(req);
		let model;
		switch (req.url) {
			case '/api/accounts/capture': { only(input, ['provider', 'label']); if (req.method !== 'POST') throw new AccountError('method', 'Use POST to capture a login.', 405); model = await manager.capture(input.provider, input.label); break; }
			case '/api/accounts/refresh': only(input, []); if (req.method !== 'POST') throw new AccountError('method', 'Use POST to check usage.', 405); model = await manager.refresh(); break;
			case '/api/accounts/switch': only(input, ['id']); if (req.method !== 'POST') throw new AccountError('method', 'Use POST to switch accounts.', 405); model = await manager.switchAccount(input.id); break;
			case '/api/accounts/account': model = req.method === 'DELETE' ? await manager.remove(only(input, ['id']).id) : await manager.edit(input); break;
			case '/api/accounts/policy': if (req.method !== 'POST') throw new AccountError('method', 'Use POST to update policy.', 405); model = await manager.policy(input); break;
			case '/api/accounts/sync': only(input, []); if (req.method !== 'POST') throw new AccountError('method', 'Use POST to sync metadata.', 405); model = await manager.synchronize(); break;
			default: reply(res, 404, { error: 'Unknown account action.' }); return true;
		}
		reply(res, 200, model);
	} catch (error) {
		const known = error instanceof AccountError || error?.constructor?.name === 'ProviderError';
		reply(res, known ? error.status || 400 : 500, { error: known ? error.message : 'The account operation failed. Credential details were not returned.' });
	}
	return true;
};
