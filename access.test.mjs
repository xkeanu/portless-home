import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { readAccess, viewer, mayWrite, decodeLogin } from './access.mjs';

const OWNER = 'owner@example.com';
const FRIEND = 'friend@example.com';
// Tailscale Serve proxies from loopback with the tailnet host name and
// forwarding headers; identity headers come only from Serve.
const serve = (login) => ({ host: 'home.example.ts.net', 'x-forwarded-for': '100.64.0.2', ...(login ? { 'tailscale-user-login': login } : {}) });

let dir;
beforeEach((t) => {
	dir = mkdtempSync(join(tmpdir(), 'portless-home-access-'));
	const keys = ['ROUTES', 'NAMES', 'LAYOUT', 'PEERS', 'APPS', 'EXTERNAL_APPS', 'ACCOUNTS', 'ACCESS'];
	const previous = new Map(keys.map((key) => [key, process.env[`PORTLESS_${key}`]]));
	for (const key of keys) process.env[`PORTLESS_${key}`] = join(dir, `${key}.json`);
	writeFileSync(join(dir, 'ROUTES.json'), JSON.stringify([{ hostname: 'demo.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' }]));
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[`PORTLESS_${key}`];
			else process.env[`PORTLESS_${key}`] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});
});

const owners = (list) => writeFileSync(join(dir, 'ACCESS.json'), JSON.stringify({ owners: list }));

const send = (port, method, path, headers = {}, body) =>
	new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => resolve({ status: res.statusCode, data }));
		});
		req.on('error', reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});

const directory = async (t) => {
	const { handler } = await import(`./server.mjs?access=${Date.now()}-${Math.random()}`);
	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	t.after(() => app.close());
	return app.address().port;
};

const fakeReq = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress, localPort: 5995 } });

test('readAccess: no file or no owners key is unconfigured; anything malformed is invalid', () => {
	const read = (name, text) => {
		writeFileSync(join(dir, name), text);
		return readAccess(join(dir, name));
	};
	assert.deepEqual(read('ok.json', JSON.stringify({ owners: [' Owner@Example.com '] })), { owners: [OWNER] });
	assert.deepEqual(readAccess(join(dir, 'missing.json')), { owners: [] });
	assert.deepEqual(read('empty.json', '{}'), { owners: [] });
	const invalid = { owners: [], invalid: true };
	assert.deepEqual(read('comma.json', '{"owners":["owner@example.com"],}'), invalid);
	assert.deepEqual(read('null.json', 'null'), invalid);
	assert.deepEqual(read('string.json', '{"owners":"owner@example.com"}'), invalid);
	assert.deepEqual(read('blank.json', '{"owners":["owner@example.com",""]}'), invalid);
	assert.deepEqual(read('number.json', '{"owners":[42]}'), invalid);
	assert.deepEqual(read('long.json', JSON.stringify({ owners: ['x'.repeat(300)] })), invalid);
});

test('decodeLogin reads the RFC 2047 words Serve sends for non-ASCII logins', () => {
	assert.equal(decodeLogin('=?utf-8?q?jos=C3=A9@example.com?='), 'josé@example.com');
	assert.equal(decodeLogin('=?UTF-8?Q?Jos=C3=A9_x@example.com?='), 'josé x@example.com');
	assert.equal(decodeLogin('=?utf-8?q?jos=C3?= =?utf-8?q?=A9@example.com?='), 'josé@example.com');
	assert.equal(decodeLogin(' Owner@Example.com '), OWNER);
	assert.equal(decodeLogin('=?utf-8?q?bad=ZZ?='), '');
	assert.equal(decodeLogin('=?utf-8?q?=FF?='), '');
	assert.equal(decodeLogin('=?iso-8859-1?q?jos=E9?='), '');
	assert.equal(decodeLogin(undefined), '');
});

test('viewer: loopback and owners edit; other logins and Serve without identity read', () => {
	const access = { owners: [OWNER] };
	assert.deepEqual(viewer(fakeReq({ host: '127.0.0.1:5995' }), access), { login: '', canEdit: true });
	assert.deepEqual(viewer(fakeReq(serve('OWNER@example.com')), access), { login: OWNER, canEdit: true });
	assert.deepEqual(viewer(fakeReq(serve(FRIEND)), access), { login: FRIEND, canEdit: false });
	assert.deepEqual(viewer(fakeReq(serve()), access), { login: '', canEdit: false });
	// An identity header on a loopback request means a proxy sent it, so the
	// request is judged by that login, not trusted as this device.
	assert.equal(viewer(fakeReq({ host: '127.0.0.1:5995', 'tailscale-user-login': FRIEND }), access).canEdit, false);
	// With no owners configured, everyone keeps edit access as before.
	assert.equal(viewer(fakeReq(serve(FRIEND)), { owners: [] }).canEdit, true);
	// A broken access.json locks remote edits but never this device.
	assert.equal(viewer(fakeReq(serve(FRIEND)), { owners: [], invalid: true }).canEdit, false);
	assert.equal(viewer(fakeReq({ host: '127.0.0.1:5995' }), { owners: [], invalid: true }).canEdit, true);
	// Serve Q-encodes a non-ASCII login; it still matches the owner.
	assert.deepEqual(viewer(fakeReq(serve('=?utf-8?q?jos=C3=A9@example.com?=')), { owners: ['josé@example.com'] }), { login: 'josé@example.com', canEdit: true });
});

test('mayWrite refuses cross-site browser requests even for an owner', () => {
	const owner = { login: OWNER, canEdit: true };
	assert.equal(mayWrite(fakeReq({}), owner), true);
	assert.equal(mayWrite(fakeReq({ 'sec-fetch-site': 'same-origin' }), owner), true);
	assert.equal(mayWrite(fakeReq({ 'sec-fetch-site': 'same-site' }), owner), false);
	assert.equal(mayWrite(fakeReq({ 'sec-fetch-site': 'cross-site' }), owner), false);
	assert.equal(mayWrite(fakeReq({}), { login: FRIEND, canEdit: false }), false);
});

test('owner login and loopback may rename and reorder; the edits are saved', async (t) => {
	owners([OWNER]);
	const port = await directory(t);
	assert.equal((await send(port, 'POST', '/rename', serve(OWNER), { hostname: 'demo.localhost', label: 'Owner' })).status, 204);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, 'NAMES.json'), 'utf8')), { 'demo.localhost': 'Owner' });
	assert.equal((await send(port, 'POST', '/layout', serve(OWNER), { pinned: ['demo.localhost'] })).status, 204);
	assert.equal((await send(port, 'POST', '/rename', {}, { hostname: 'demo.localhost', label: 'Local' })).status, 204);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, 'NAMES.json'), 'utf8')), { 'demo.localhost': 'Local' });
	assert.equal((await send(port, 'POST', '/layout', {}, { pinned: [] })).status, 204);
});

test('another login or Serve without identity gets 403 on every mutating route and writes nothing', async (t) => {
	owners([OWNER]);
	const port = await directory(t);
	const routes = [
		['POST', '/rename', { hostname: 'demo.localhost', label: 'x' }],
		['POST', '/layout', { pinned: ['demo.localhost'] }],
		['POST', '/start', { hostname: 'demo.localhost' }],
		['POST', '/api/accounts/refresh', {}],
		['POST', '/api/accounts/switch', { id: 'a' }],
		['DELETE', '/api/accounts/account', { id: 'a' }],
		['PUT', '/api/routes', {}],
	];
	for (const headers of [serve(FRIEND), serve()]) {
		for (const [method, path, body] of routes) {
			// The shared gate answers with an empty body, before any route's own checks.
			assert.deepEqual(await send(port, method, path, { ...headers, 'content-type': 'application/json' }, body), { status: 403, data: '' }, `${method} ${path}`);
		}
	}
	assert.equal(existsSync(join(dir, 'NAMES.json')), false);
	assert.equal(existsSync(join(dir, 'LAYOUT.json')), false);
	// Reads stay open to them, including the peer snapshot other devices fetch.
	assert.equal((await send(port, 'GET', '/api/routes', serve(FRIEND))).status, 200);
	assert.equal((await send(port, 'GET', '/', serve())).status, 200);
});

test('a malformed access.json makes tailnet viewers read-only; localhost still edits', async (t) => {
	writeFileSync(join(dir, 'ACCESS.json'), '{"owners":["owner@example.com"],}');
	const port = await directory(t);
	assert.equal((await send(port, 'POST', '/rename', serve(FRIEND), { hostname: 'demo.localhost', label: 'x' })).status, 403);
	assert.equal((await send(port, 'POST', '/rename', serve(OWNER), { hostname: 'demo.localhost', label: 'x' })).status, 403);
	assert.equal(existsSync(join(dir, 'NAMES.json')), false);
	assert.equal((await send(port, 'POST', '/rename', {}, { hostname: 'demo.localhost', label: 'Local' })).status, 204);
});

test('a cross-site browser request from the owner is refused', async (t) => {
	owners([OWNER]);
	const port = await directory(t);
	const res = await send(port, 'POST', '/rename', { ...serve(OWNER), 'sec-fetch-site': 'cross-site' }, { hostname: 'demo.localhost', label: 'x' });
	assert.equal(res.status, 403);
	assert.equal(existsSync(join(dir, 'NAMES.json')), false);
});

test('with no owners configured, any tailnet login keeps edit access as before', async (t) => {
	const port = await directory(t);
	assert.equal((await send(port, 'POST', '/rename', serve(FRIEND), { hostname: 'demo.localhost', label: 'Friend' })).status, 204);
	assert.equal((await send(port, 'POST', '/rename', serve(), { hostname: 'demo.localhost', label: 'Tagged' })).status, 204);
});

const controls = (doc) => ({
	rename: !!doc.querySelector('button.name'),
	pin: !!doc.querySelector('.pin'),
	viewer: doc.querySelector('.viewer')?.textContent ?? null,
	data: JSON.parse(doc.querySelector('#page-data').textContent).viewer,
});

test('the page shows edit controls and identity per viewer', async (t) => {
	owners([OWNER]);
	const port = await directory(t);
	const page = async (headers) => controls(new JSDOM((await send(port, 'GET', '/', headers)).data).window.document);
	assert.deepEqual(await page({}), { rename: true, pin: true, viewer: null, data: { login: '', canEdit: true } });
	assert.deepEqual(await page(serve(OWNER)), { rename: true, pin: true, viewer: `Viewing as ${OWNER}`, data: { login: OWNER, canEdit: true } });
	assert.deepEqual(await page(serve(FRIEND)), { rename: false, pin: false, viewer: `Viewing as ${FRIEND} · read-only`, data: { login: FRIEND, canEdit: false } });
	assert.deepEqual(await page(serve()), { rename: false, pin: false, viewer: 'read-only', data: { login: '', canEdit: false } });
});

test('a hostile login renders as text', async (t) => {
	owners([OWNER]);
	const port = await directory(t);
	const res = await send(port, 'GET', '/', serve('<img src=x onerror=alert(1)>@x'));
	assert.doesNotMatch(res.data, /<img src=x/);
	assert.equal(new JSDOM(res.data).window.document.querySelector('.viewer .login').textContent, '<img src=x onerror=alert(1)>@x');
});
