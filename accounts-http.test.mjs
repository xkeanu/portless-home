import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import { accountHttp } from './accounts-http.mjs';
import { AccountError } from './account-store.mjs';
import { sanitizeMetadata } from './account-sync.mjs';

const secret = 'fixture-only-credential-value';
const pairingToken = 'fixture-pairing-token-'.repeat(3);
const publicAccount = {
	id: 'codex-fixture', provider: 'codex', accountId: 'fixture-account', label: 'Fixture account', tier: 'pro',
	email: 'fixture@example.test', availableLocally: true, active: true, disabled: false,
	usageStatus: 'fresh', observedAt: '2026-10-02T12:00:00.000Z',
	windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 10, windowMinutes: 10080, resetsAt: '2026-10-09T12:00:00.000Z' }],
};

function fakeManager() {
	const config = { enabled: true, snapshotToken: pairingToken, credentials: secret };
	const failures = {};
	const calls = [];
	const snapshot = { enabled: true, accounts: [publicAccount], policy: { strategy: 'best', threshold: 90, auto: false }, pending: [] };
	const manager = { config, failures, calls, settings: () => config };
	for (const name of ['snapshot', 'capture', 'refresh', 'switchAccount', 'remove', 'edit', 'policy', 'synchronize', 'metadata']) {
		manager[name] = async (...args) => {
			calls.push({ name, args });
			if (failures[name]) throw failures[name];
			return name === 'metadata'
				? sanitizeMetadata([{ ...publicAccount, payload: { accessToken: secret }, authPath: '/Users/fixture/.codex/auth.json' }])
				: snapshot;
		};
	}
	return manager;
}

const send = (port, { path = '/api/accounts', method = 'GET', headers = {}, raw, body } = {}) => new Promise((resolve, reject) => {
	const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
	const req = request({ hostname: '127.0.0.1', port, path, method, headers: { ...(payload === undefined || headers['transfer-encoding'] ? {} : { 'content-length': Buffer.byteLength(payload) }), ...headers } }, (res) => {
		const chunks = [];
		res.on('data', (chunk) => chunks.push(chunk));
		res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
		res.on('error', reject);
	});
	req.on('error', reject);
	req.end(payload);
});

async function fixture(t) {
	const manager = fakeManager();
	const handler = accountHttp(manager, (model) => `<main>${model.accounts[0].label}</main>`);
	const server = createServer(async (req, res) => {
		if (!await handler(req, res)) { res.writeHead(204); res.end(); }
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	const { port } = server.address();
	const headers = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
	return { port, headers, manager, handler };
}

test('owner reads serve local accounts/page with no-store and deny remote or forwarded hosts', async (t) => {
	const { port, manager, handler } = await fixture(t);
	const response = await send(port);
	assert.equal(response.status, 200);
	assert.equal(JSON.parse(response.text).accounts[0].id, publicAccount.id);
	assert.equal(response.headers['cache-control'], 'no-store');
	assert.equal(response.headers['x-content-type-options'], 'nosniff');
	assert.match(response.headers['content-type'], /application\/json/);
	const page = await send(port, { path: '/accounts' });
	assert.equal(page.status, 200);
	assert.match(page.headers['content-type'], /text\/html/);
	assert.equal(page.text, '<main>Fixture account</main>');
	const before = manager.calls.length;
	for (const headers of [
		{ host: 'device.tailnet.ts.net' }, { host: `localhost.evil:${port}` },
		{ forwarded: 'for=127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' },
		{ 'x-forwarded-host': `localhost:${port}` }, { 'tailscale-user-login': 'owner@example.test' },
		{ origin: 'https://evil.example.test' }, { 'sec-fetch-site': 'cross-site' },
	]) assert.equal((await send(port, { headers })).status, 403);
	assert.equal(manager.calls.length, before);
	const req = Readable.from([]);
	Object.assign(req, { url: '/api/accounts', method: 'GET', headers: { host: `localhost:${port}` }, socket: { localPort: port, remoteAddress: '100.64.0.2' } });
	let code;
	assert.equal(await handler(req, { writeHead: (status) => { code = status; }, end() {} }), true);
	assert.equal(code, 403);
	assert.equal(manager.calls.length, before);
});

test('same-origin JSON mutations reach their intended manager methods', async (t) => {
	const { port, headers, manager } = await fixture(t);
	const actions = [
		['/api/accounts/capture', 'POST', { provider: 'codex', label: 'Personal' }, 'capture', ['codex', 'Personal']],
		['/api/accounts/refresh', 'POST', {}, 'refresh', []],
		['/api/accounts/switch', 'POST', { id: 'codex-fixture' }, 'switchAccount', ['codex-fixture']],
		['/api/accounts/account', 'POST', { id: 'codex-fixture', reservePercent: 20 }, 'edit', [{ id: 'codex-fixture', reservePercent: 20 }]],
		['/api/accounts/account', 'DELETE', { id: 'codex-fixture' }, 'remove', ['codex-fixture']],
		['/api/accounts/policy', 'POST', { threshold: 100 }, 'policy', [{ threshold: 100 }]],
		['/api/accounts/sync', 'POST', {}, 'synchronize', []],
	];
	for (const [path, method, body, name, args] of actions) {
		const response = await send(port, { path, method, body, headers });
		assert.equal(response.status, 200, path);
		assert.deepEqual(manager.calls.at(-1), { name, args });
	}
	assert.equal((await send(port, { path: '/api/accounts/refresh', method: 'POST', body: {}, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })).status, 200);
});

test('owner mutations accept the browser origin for a localhost host at default HTTP port', async () => {
	for (const host of ['localhost:80', 'localhost', '127.0.0.1:80']) {
		const manager = fakeManager();
		const handler = accountHttp(manager, () => '');
		const req = Readable.from([Buffer.from('{"provider":"codex"}')]);
		Object.assign(req, { url: '/api/accounts/capture', method: 'POST',
			headers: { host, origin: new URL(`http://${host}`).origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
			socket: { localPort: 80, remoteAddress: '127.0.0.1' } });
		let status;
		assert.equal(await handler(req, { writeHead: (code) => { status = code; }, end() {} }), true);
		assert.equal(status, 200, host);
		assert.deepEqual(manager.calls, [{ name: 'capture', args: ['codex', undefined] }]);
	}
});

test('mutations require local host, exact Origin, JSON, and valid bounded bodies', async (t) => {
	const { port, headers, manager } = await fixture(t);
	const post = (options = {}) => send(port, { path: '/api/accounts/capture', method: 'POST', body: { provider: 'codex' }, headers, ...options });
	for (const override of [
		{ origin: undefined }, { origin: 'null' }, { origin: 'https://evil.example.test' },
		{ host: 'device.tailnet.ts.net', origin: 'http://device.tailnet.ts.net', authorization: `Bearer ${pairingToken}` },
		{ 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'cross-site' }, { 'x-forwarded-for': '127.0.0.1' },
	]) {
		const requestHeaders = { ...headers, ...override };
		for (const [key, value] of Object.entries(requestHeaders)) if (value === undefined) delete requestHeaders[key];
		assert.equal((await post({ headers: requestHeaders })).status, 403, JSON.stringify(override));
	}
	assert.equal((await post({ headers: { ...headers, 'content-type': 'text/plain' } })).status, 415);
	const noContentType = { ...headers };
	delete noContentType['content-type'];
	assert.equal((await post({ headers: noContentType })).status, 415);
	for (const body of [null, [], { provider: 'codex', command: 'unsafe command' }, { provider: 'codex', payload: { accessToken: secret } }]) assert.equal((await post({ body })).status, 400);
	assert.equal((await post({ raw: '{bad' })).status, 400);
	assert.equal((await post({ raw: 'x'.repeat(32 * 1024 + 1) })).status, 413);
	assert.equal((await post({ raw: 'x'.repeat(32 * 1024 + 1), headers: { ...headers, 'transfer-encoding': 'chunked' } })).status, 413);
	assert.equal((await post({ method: 'GET' })).status, 405);
	assert.equal((await post({ method: 'DELETE' })).status, 405);
	assert.deepEqual(manager.calls, []);
});

test('remote metadata requires its bearer token and returns only safe metadata', async (t) => {
	const { port, manager, headers } = await fixture(t);
	const remote = { host: 'device.tailnet.ts.net', 'x-forwarded-for': '100.64.0.2' };
	for (const authorization of [undefined, 'Basic ignored', 'Bearer wrong', `bearer ${pairingToken}`, `Bearer ${pairingToken}extra`]) {
		const requestHeaders = { ...remote, ...(authorization ? { authorization } : {}) };
		assert.equal((await send(port, { path: '/api/accounts/metadata', headers: requestHeaders })).status, 403);
	}
	assert.deepEqual(manager.calls, []);
	const response = await send(port, { path: '/api/accounts/metadata', headers: { ...remote, authorization: `Bearer ${pairingToken}` } });
	assert.equal(response.status, 200);
	assert.equal(JSON.parse(response.text).schemaVersion, 1);
	assert.deepEqual(manager.calls, [{ name: 'metadata', args: [] }]);
	assert.doesNotMatch(response.text, /fixture-only-credential-value|fixture-pairing-token|accessToken|authPath|\/Users\//);
	assert.equal(response.headers['cache-control'], 'no-store');
	assert.equal((await send(port, { path: '/api/accounts/metadata', method: 'POST', headers: { ...remote, authorization: `Bearer ${pairingToken}` }, body: {} })).status, 405);
	assert.equal((await send(port, { path: '/api/accounts/switch', method: 'POST', headers: { ...headers, ...remote, authorization: `Bearer ${pairingToken}` }, body: { id: publicAccount.id } })).status, 403);
	manager.config.enabled = false;
	assert.equal((await send(port, { path: '/api/accounts/metadata', headers: { ...remote, authorization: `Bearer ${pairingToken}` } })).status, 403);
	manager.config.enabled = true;
	for (const token of [undefined, 'short', 'x'.repeat(257)]) {
		manager.config.snapshotToken = token;
		assert.equal((await send(port, { path: '/api/accounts/metadata', headers: { ...remote, authorization: `Bearer ${pairingToken}` } })).status, 403);
	}
});

test('errors expose safe known messages and hide unexpected credential details', async (t) => {
	const { port, headers, manager } = await fixture(t);
	manager.failures.refresh = new AccountError('busy', 'Wait until the provider is idle.', 409);
	let response = await send(port, { path: '/api/accounts/refresh', method: 'POST', headers, body: {} });
	assert.equal(response.status, 409);
	assert.deepEqual(JSON.parse(response.text), { error: 'Wait until the provider is idle.' });
	manager.failures.refresh = Object.assign(new Error(`Unexpected ${secret}`), { payload: { accessToken: secret }, stack: secret });
	response = await send(port, { path: '/api/accounts/refresh', method: 'POST', headers, body: {} });
	assert.equal(response.status, 500);
	assert.match(JSON.parse(response.text).error, /Credential details were not returned/);
	assert.doesNotMatch(response.text, /fixture-only-credential-value|accessToken|payload|stack/);
	class ProviderError extends Error { status = 502; }
	manager.failures.refresh = new ProviderError('The provider could not check usage.');
	response = await send(port, { path: '/api/accounts/refresh', method: 'POST', headers, body: {} });
	assert.equal(response.status, 502);
	assert.deepEqual(JSON.parse(response.text), { error: 'The provider could not check usage.' });
});

test('unrelated routes fall through, while unknown account actions remain inside the account API', async (t) => {
	const { port, headers, manager } = await fixture(t);
	for (const path of ['/', '/api/routes', '/events', '/api/accounts-extra']) assert.equal((await send(port, { path })).status, 204, path);
	assert.deepEqual(manager.calls, []);
	assert.equal((await send(port, { path: '/api/accounts/unknown', method: 'POST', headers, body: {} })).status, 404);
});
