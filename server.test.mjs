import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from './server.mjs';

const get = (port) =>
	new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, method: 'GET' }, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => resolve({ status: res.statusCode, data }));
		});
		req.on('error', reject);
		req.end();
	});

test('probe resolves true when a real server answers HEAD', async () => {
	const srv = createServer((req, res) => res.end());
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	try {
		const result = await probe(port);
		assert.equal(result, true);
	} finally {
		srv.close();
	}
});

test('probe resolves false on connection refused', async () => {
	const srv = createServer((req, res) => res.end());
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	await new Promise((resolve) => srv.close(resolve));
	const result = await probe(port);
	assert.equal(result, false);
});

test('probe resolves false when the server never responds', async () => {
	const srv = createServer();
	srv.on('request', () => {});
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	try {
		const start = Date.now();
		const result = await probe(port, 100);
		const elapsed = Date.now() - start;
		assert.equal(result, false);
		assert.ok(elapsed < 2000, `expected probe to time out quickly, took ${elapsed}ms`);
	} finally {
		srv.close();
	}
});

test('probes run in parallel, not sequentially', async () => {
	const servers = [1, 2, 3].map(() => {
		const srv = createServer();
		srv.on('request', () => {});
		return srv;
	});
	await Promise.all(servers.map((srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))));
	const ports = servers.map((srv) => srv.address().port);
	try {
		const start = Date.now();
		const results = await Promise.all(ports.map((port) => probe(port, 150)));
		const elapsed = Date.now() - start;
		assert.deepEqual(results, [false, false, false]);
		assert.ok(elapsed < 400, `expected parallel probes to finish well under 450ms, took ${elapsed}ms`);
	} finally {
		servers.forEach((srv) => srv.close());
	}
});

test('handler renders a green dot for a live port and a plain dot for a dead one', async () => {
	const live = createServer((req, res) => res.end());
	await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
	const livePort = live.address().port;

	const dead = createServer((req, res) => res.end());
	await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
	const deadPort = dead.address().port;
	await new Promise((resolve) => dead.close(resolve));

	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([
			{ hostname: 'demo.localhost', port: livePort, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' },
			{ hostname: 'blog.localhost', port: deadPort, pid: process.pid, tailscaleUrl: 'https://blog.example.ts.net' },
		])
	);

	process.env.PORTLESS_ROUTES = routesPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		assert.match(body.data, /<span class="dot up" role="img" aria-label="online"><\/span><span class="name">demo<\/span>/);
		assert.match(body.data, /<span class="dot" role="img" aria-label="offline"><\/span><span class="name">blog<\/span>/);
	} finally {
		app.close();
		live.close();
		delete process.env.PORTLESS_ROUTES;
	}
});

test('handler returns 200 with an empty page when the routes file is missing', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const missingPath = join(dir, 'does-not-exist.json');

	process.env.PORTLESS_ROUTES = missingPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		assert.match(body.data, /class="empty"/);
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
	}
});

test('probe resolves false when a peer trickles bytes forever', async () => {
	const socks = [];
	const srv = createTcpServer((sock) => {
		socks.push(sock);
		const drip = setInterval(() => sock.write('HTTP/1.1 200 OK\r\nX-Drip: '), 100);
		sock.on('close', () => clearInterval(drip));
	});
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	try {
		const start = Date.now();
		const result = await Promise.race([
			probe(port, 150),
			new Promise((resolve) => setTimeout(() => resolve('hung'), 1500)),
		]);
		const elapsed = Date.now() - start;
		assert.equal(result, false);
		assert.ok(elapsed < 1000, `expected the hard deadline to fire, took ${elapsed}ms`);
	} finally {
		socks.forEach((sock) => sock.destroy());
		srv.close();
	}
});

test('probe resolves true when the server responds with a non-2xx status', async () => {
	const srv = createServer((req, res) => {
		res.writeHead(405);
		res.end();
	});
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	try {
		const result = await probe(port);
		assert.equal(result, true);
	} finally {
		srv.close();
	}
});
