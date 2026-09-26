import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { chmodSync, realpathSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localRequest, readRegistry } from './launch.mjs';
import { launchCard, page } from './render.mjs';
import { strings } from './i18n.mjs';
import { runInNewContext } from 'node:vm';
import { Readable } from 'node:stream';

const send = (port, { path = '/', method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
	const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
		let data = '';
		res.on('data', (chunk) => { data += chunk; });
		res.on('end', () => resolve({ status: res.statusCode, data }));
	});
	req.on('error', reject);
	req.end(body === undefined ? undefined : JSON.stringify(body));
});

const until = async (condition) => {
	const deadline = Date.now() + 5000;
	while (!await condition()) {
		assert.ok(Date.now() < deadline, 'condition did not become true');
		await delay(20);
	}
};

test('registry requires explicit opt-in and rejects malformed entries as a whole', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-registry-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, 'apps.json');
	const app = { hostname: 'demo.localhost', cwd: dir, command: 'node app.mjs' };
	assert.deepEqual(readRegistry(path), []);
	for (const value of [null, {}, { apps: [app] }, { enabled: false, apps: [app] },
		{ enabled: true, apps: [null] }, { enabled: true, apps: [app, app] },
		{ enabled: true, apps: [{ ...app, cwd: 'relative' }] },
		{ enabled: true, apps: [{ ...app, hostname: '<script>.localhost' }] },
		{ enabled: true, apps: [{ ...app, command: '' }] },
		{ enabled: true, apps: [{ ...app, command: 'node\0' }] }]) {
		writeFileSync(path, JSON.stringify(value));
		assert.deepEqual(readRegistry(path), []);
	}
	writeFileSync(path, '{broken');
	assert.deepEqual(readRegistry(path), []);
	writeFileSync(path, JSON.stringify({ enabled: true, apps: [app] }));
	assert.deepEqual(readRegistry(path), [app]);
	if (process.platform !== 'win32') {
		chmodSync(path, 0o666);
		assert.deepEqual(readRegistry(path), []);
		chmodSync(path, 0o600);
		assert.deepEqual(readRegistry(path), [app]);
	}
});

test('local request check requires a loopback socket, expected Host and no proxy headers', () => {
	const req = { socket: { remoteAddress: '127.0.0.1', localPort: 5995 }, headers: { host: 'localhost:5995' } };
	assert.equal(localRequest(req), true);
	for (const remoteAddress of ['100.64.0.1', '192.168.1.2', undefined]) {
		assert.equal(localRequest({ ...req, socket: { ...req.socket, remoteAddress } }), false);
	}
	for (const host of ['evil.example:5995', 'localhost:80', 'localhost', '127.0.0.1', 'localhost.evil:5995', undefined]) {
		assert.equal(localRequest({ ...req, headers: { host } }), false);
	}
	for (const host of ['localhost', '127.0.0.1', 'localhost:80', '127.0.0.1:80']) {
		assert.equal(localRequest({ socket: { ...req.socket, localPort: 80 }, headers: { host } }), true);
	}
});

test('HTTP launcher enforces local-only opt-in, executes config, prevents duplicates and reports failure', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-launch-'));
	const paths = { PORTLESS_ROUTES: 'routes.json', PORTLESS_NAMES: 'names.json', PORTLESS_LAYOUT: 'layout.json', PORTLESS_PEERS: 'peers.json', PORTLESS_APPS: 'apps.json' };
	const previous = {};
	for (const [key, name] of Object.entries(paths)) { previous[key] = process.env[key]; process.env[key] = join(dir, name); }
	writeFileSync(join(dir, 'routes.json'), '[]');
	// A foreground child records its cwd and waits for a test-owned release file.
	writeFileSync(join(dir, 'fixture.cjs'), `const fs = require('node:fs');
fs.appendFileSync('launches.txt', process.cwd() + '\\n');
const timer = setInterval(() => { if (fs.existsSync('release')) { clearInterval(timer); process.exit(7); } }, 20);
setTimeout(() => process.exit(8), 10000).unref();`);
	const command = `"${process.execPath}" fixture.cjs`;
	const app = { hostname: 'demo.localhost', cwd: dir, command };
	const config = (apps = [app], enabled = true) => writeFileSync(join(dir, 'apps.json'), JSON.stringify({ enabled, apps }));
	const { handler } = await import(`./server.mjs?launcher=${Date.now()}`);
	for (const key of Object.keys(paths)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		writeFileSync(join(dir, 'release'), '');
		await new Promise((resolve) => server.close(resolve));
		await delay(150);
		rmSync(dir, { recursive: true, force: true });
	});
	const { port } = server.address();
	const headers = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
	const start = (body = { hostname: app.hostname }, overrides = {}) => send(port, { path: '/start', method: 'POST', body, headers: { ...headers, ...overrides } });
	assert.equal((await start()).status, 404);
	// Exercise the real handler with port 80 metadata without binding a privileged port.
	for (const host of ['localhost', '127.0.0.1', 'localhost:80', '127.0.0.1:80']) {
		const req = Readable.from([JSON.stringify({ hostname: app.hostname })]);
		Object.assign(req, {
			method: 'POST', url: '/start', socket: { remoteAddress: '127.0.0.1', localPort: 80 },
			headers: { ...headers, host, origin: `http://${host.replace(':80', '')}` },
		});
		let code;
		await handler(req, { writeHead: (status) => { code = status; return { end() {} }; } });
		assert.equal(code, 404, `${host} should pass access checks and reach the empty registry`);
	}
	config([app], false);
	assert.equal((await start()).status, 404);
	assert.doesNotMatch((await send(port)).data, /data-start="/);
	config();
	const stopped = (await send(port)).data;
	assert.match(stopped, /data-start="demo.localhost"/);
	assert.match(stopped, />Stopped</);
	assert.ok(!stopped.includes(dir));
	assert.ok(!stopped.includes(command));
	for (const override of [
		{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: '' },
		{ host: `evil.example:${port}`, origin: `http://evil.example:${port}` },
		{ 'sec-fetch-site': 'cross-site' }, { forwarded: 'for=127.0.0.1' },
		{ 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-host': `localhost:${port}` },
		{ 'tailscale-user-login': 'viewer@example.com' },
	]) assert.equal((await start(undefined, override)).status, 403);
	assert.equal((await start(undefined, { 'content-type': 'text/plain' })).status, 415);
	for (const body of [null, [], {}, { hostname: app.hostname, command: 'echo unsafe' }, { hostname: app.hostname, cwd: dir }]) {
		assert.equal((await start(body)).status, 400);
	}
	assert.equal((await start({ hostname: 'missing.localhost' })).status, 404);
	assert.equal((await send(port, { path: '/start' })).status, 405);
	assert.equal(existsSync(join(dir, 'launches.txt')), false);
	const remote = await send(port, { headers: { host: 'device.tailnet.ts.net', 'x-forwarded-for': '100.64.0.2' } });
	assert.doesNotMatch(remote.data, /data-start="/);
	assert.doesNotMatch((await send(port, { path: '/api/routes' })).data, /demo\.localhost|fixture\.cjs/);

	const starts = await Promise.all([start(), start()]);
	assert.deepEqual(starts.map((r) => r.status).sort(), [202, 409]);
	await until(() => existsSync(join(dir, 'launches.txt')));
	assert.deepEqual(readFileSync(join(dir, 'launches.txt'), 'utf8').trim().split('\n'), [realpathSync(dir)]);
	assert.match((await send(port)).data, /data-start="demo.localhost" disabled/);
	writeFileSync(join(dir, 'routes.json'), JSON.stringify([{ hostname: app.hostname, pid: process.pid, port: 1, tailscaleUrl: 'https://demo.example.ts.net' }]));
	assert.doesNotMatch((await send(port)).data, /data-start="demo.localhost"/);
	assert.equal((await start()).status, 409);
	writeFileSync(join(dir, 'release'), '');
	writeFileSync(join(dir, 'routes.json'), '[]');
	await until(async () => (await send(port)).data.includes('role="status">Could not start the app.'));
	config([{ ...app, cwd: join(dir, 'missing-directory') }]);
	assert.equal((await start()).status, 500);
	config([{ ...app, command: `"${process.execPath}" -e "process.exit(0)"` }]);
	assert.equal((await start()).status, 202);
	await until(async () => !(await send(port)).data.includes('data-start="demo.localhost" disabled'));
	writeFileSync(join(dir, 'routes.json'), JSON.stringify([{ hostname: app.hostname, pid: process.pid, port: 1 }]));
	assert.equal((await start()).status, 409);
});

test('launch cards escape names and provide translated pending and error states', () => {
	assert.match(launchCard('demo.localhost', { 'demo.localhost': '<img onerror="bad">' }, 'stopped'), /&#60;img onerror=&#34;bad&#34;&#62;/);
	assert.match(launchCard('demo.localhost', {}, 'starting', strings('de')), /disabled>Wird gestartet/);
	assert.match(launchCard('demo.localhost', {}, 'failed'), /role="status">Could not start/);
});

test('Start control submits only the hostname, disables while pending and recovers on error', async () => {
	const script = page('', true, strings('de')).match(/<script>([\s\S]*?)<\/script>/)[1].split("document.querySelectorAll('.name[data-host]')")[0];
	let click, sent, reloads = 0;
	const status = {};
	const button = { dataset: { start: 'demo.localhost' }, disabled: false, closest: () => ({ querySelector: () => status }), addEventListener: (_, callback) => { click = callback; } };
	const context = {
		document: { querySelectorAll: () => [button], querySelector: () => null },
		location: { reload: () => { reloads++; } },
		fetch: async (path, options) => { sent = { path, ...options }; return { ok: false, status: 500 }; },
	};
	runInNewContext(script, context);
	const pending = click();
	assert.equal(button.disabled, true);
	await pending;
	assert.equal(button.disabled, false);
	assert.match(status.textContent, /Start fehlgeschlagen/);
	assert.equal(sent.path, '/start');
	assert.deepEqual(JSON.parse(sent.body), { hostname: 'demo.localhost' });
	context.fetch = async () => ({ ok: true, status: 202 });
	await click();
	assert.equal(reloads, 1);
});
