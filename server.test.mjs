import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTailnetAddr, probe, orderRoutes, mergePinned } from './server.mjs';
import { page } from './render.mjs';
import { JSDOM } from 'jsdom';

const documentOf = (html) => new JSDOM(html).window.document;

// Missing fixture files must never fall back to the developer's registry or peers.
beforeEach((t) => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-config-'));
	const keys = ['PORTLESS_ROUTES', 'PORTLESS_NAMES', 'PORTLESS_LAYOUT', 'PORTLESS_PEERS', 'PORTLESS_APPS'];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) process.env[key] = join(dir, key + '.json');
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});
});

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

const getPath = (port, path, method = 'GET') =>
	new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, method, path }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () =>
				resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks).toString('latin1') })
			);
		});
		req.on('error', reject);
		req.end();
	});

const post = (port, path, body) =>
	new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, method: 'POST', path }, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => resolve({ status: res.statusCode, data }));
		});
		req.on('error', reject);
		if (typeof body === 'string') req.end(body);
		else req.end(JSON.stringify(body));
	});

test('probe resolves true when a real server answers HEAD', async () => {
	const srv = createServer((req, res) => res.end());
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	try {
		// The first loopback connect on a cold Windows CI runner can exceed the
		// 300ms default; the deadline itself is covered by the tests below.
		const result = await probe(port, 5000);
		assert.equal(result, true);
	} finally {
		srv.close();
	}
});

test('orderRoutes puts pinned routes first in pin order; unpinned keep file order', () => {
	const routes = ['a', 'b', 'c', 'd'].map((n) => ({ hostname: `${n}.localhost` }));
	const out = orderRoutes(routes, ['c.localhost', 'a.localhost', 'ghost.localhost']);
	assert.deepEqual(
		out.map((r) => r.hostname),
		['c.localhost', 'a.localhost', 'b.localhost', 'd.localhost']
	);
});

test('orderRoutes with no pins returns routes unchanged', () => {
	const routes = ['a', 'b'].map((n) => ({ hostname: `${n}.localhost` }));
	assert.deepEqual(orderRoutes(routes, []), routes);
});

test('mergePinned keeps pins for apps that are not currently running', () => {
	const next = mergePinned(['b.localhost'], ['gone.localhost', 'a.localhost'], ['a.localhost', 'b.localhost']);
	assert.deepEqual(next, ['b.localhost', 'gone.localhost']);
});

test('mergePinned drops unknown hostnames and duplicates from the request', () => {
	const next = mergePinned(['x.localhost', 'a.localhost', 'a.localhost'], [], ['a.localhost']);
	assert.deepEqual(next, ['a.localhost']);
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
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		const doc = documentOf(body.data);
		assert.equal(doc.querySelector('li[data-host="demo.localhost"] .dot').getAttribute('aria-label'), 'online');
		assert.equal(doc.querySelector('li[data-host="demo.localhost"] .name').textContent, 'demo');
		assert.equal(doc.querySelector('li[data-host="blog.localhost"] .dot').getAttribute('aria-label'), 'offline');
		assert.equal(doc.querySelector('li[data-host="blog.localhost"] .name').textContent, 'blog');
	} finally {
		app.close();
		live.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('handler returns 200 with an empty page when the routes file is missing', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const missingPath = join(dir, 'does-not-exist.json');

	process.env.PORTLESS_ROUTES = missingPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		assert.ok(documentOf(body.data).querySelector('.empty'));
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
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

test('GET renders the override label from names.json instead of the hostname', async () => {
	const live = createServer((req, res) => res.end());
	await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
	const livePort = live.address().port;

	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([
			{ hostname: 'demo.localhost', port: livePort, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' },
		])
	);
	const namesPath = join(dir, 'names.json');
	writeFileSync(namesPath, JSON.stringify({ 'demo.localhost': 'My Demo' }));

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = namesPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.equal(documentOf(body.data).querySelector('.name[data-host="demo.localhost"]').textContent, 'My Demo');
	} finally {
		app.close();
		live.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('GET still renders when names.json is missing', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'demo.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' }])
	);
	const namesPath = join(dir, 'does-not-exist.json');

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = namesPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		assert.equal(documentOf(body.data).querySelector('.name[data-host="demo.localhost"]').textContent, 'demo');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('GET still renders when names.json is corrupt', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'demo.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' }])
	);

	for (const contents of ['{not json', '["array", "not", "object"]']) {
		const namesPath = join(dir, 'names.json');
		writeFileSync(namesPath, contents);

		process.env.PORTLESS_ROUTES = routesPath;
		process.env.PORTLESS_NAMES = namesPath;
		const { handler } = await import(`./server.mjs?fixture=${Date.now()}-${Math.random()}`);

		const app = createServer(handler);
		await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
		const { port } = app.address();
		try {
			const body = await get(port);
			assert.equal(body.status, 200);
		assert.equal(documentOf(body.data).querySelector('.name[data-host="demo.localhost"]').textContent, 'demo');
		} finally {
			app.close();
			delete process.env.PORTLESS_ROUTES;
			delete process.env.PORTLESS_NAMES;
		}
	}
});

test('POST /rename writes the file; a following GET shows the new label', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'demo.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' }])
	);
	const namesPath = join(dir, 'sub', 'names.json');

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = namesPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const res = await post(port, '/rename', { hostname: 'demo.localhost', label: 'New Label' });
		assert.equal(res.status, 204);
		const body = await get(port);
		assert.equal(documentOf(body.data).querySelector('.name[data-host="demo.localhost"]').textContent, 'New Label');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('POST with empty label clears an existing override', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'demo.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' }])
	);
	const namesPath = join(dir, 'names.json');
	writeFileSync(namesPath, JSON.stringify({ 'demo.localhost': 'My Demo' }));

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = namesPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const res = await post(port, '/rename', { hostname: 'demo.localhost', label: '   ' });
		assert.equal(res.status, 204);
		const body = await get(port);
		assert.equal(documentOf(body.data).querySelector('.name[data-host="demo.localhost"]').textContent, 'demo');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('POST /rename rejects unknown hostname, malformed JSON, and over-long labels', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'demo.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' }])
	);
	const namesPath = join(dir, 'names.json');

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = namesPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const unknown = await post(port, '/rename', { hostname: 'nope.localhost', label: 'x' });
		assert.equal(unknown.status, 404);

		const malformed = await post(port, '/rename', '{not json');
		assert.equal(malformed.status, 400);

		const nullPayload = await post(port, '/rename', 'null');
		assert.equal(nullPayload.status, 400);

		const tooLong = await post(port, '/rename', { hostname: 'demo.localhost', label: 'x'.repeat(65) });
		assert.equal(tooLong.status, 400);
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('a label with markup renders escaped in the page', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'demo.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' }])
	);
	const namesPath = join(dir, 'names.json');
	writeFileSync(namesPath, JSON.stringify({ 'demo.localhost': '<script>alert(1)</script>"' }));

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = namesPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.doesNotMatch(body.data, /<script>alert/);
		assert.equal(documentOf(body.data).querySelector('.name').textContent, '<script>alert(1)</script>"');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('page renders a rename control and references the bundled Svelte client', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'demo.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://demo.example.ts.net' }])
	);

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		const doc = documentOf(body.data);
		assert.equal(doc.querySelector('.name[data-host="demo.localhost"]').textContent, 'demo');
		assert.equal(doc.querySelector('script[type="module"]').getAttribute('src'), '/assets/ui.js');
		assert.equal(doc.querySelector('link[rel="stylesheet"]').getAttribute('href'), '/assets/ui.css');
		assert.equal(JSON.parse(doc.querySelector('#page-data').textContent).routes[0].hostname, 'demo.localhost');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('GET renders pinned apps first, in layout.json order', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify(
			['alpha', 'beta', 'gamma'].map((n) => ({
				hostname: `${n}.localhost`, port: 1, pid: process.pid, tailscaleUrl: `https://${n}.example.ts.net`,
			}))
		)
	);
	writeFileSync(join(dir, 'layout.json'), JSON.stringify({ pinned: ['gamma.localhost', 'beta.localhost'] }));

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	process.env.PORTLESS_LAYOUT = join(dir, 'layout.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		const pos = (host) => body.data.indexOf(`data-host="${host}"`);
		assert.ok(pos('gamma.localhost') !== -1 && pos('beta.localhost') !== -1 && pos('alpha.localhost') !== -1);
		assert.ok(pos('gamma.localhost') < pos('beta.localhost'), 'first pin renders first');
		assert.ok(pos('beta.localhost') < pos('alpha.localhost'), 'unpinned renders after pins');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
		delete process.env.PORTLESS_LAYOUT;
	}
});

test('POST /layout saves the pin order; a following GET renders it', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify(
			['alpha', 'beta'].map((n) => ({
				hostname: `${n}.localhost`, port: 1, pid: process.pid, tailscaleUrl: `https://${n}.example.ts.net`,
			}))
		)
	);

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	process.env.PORTLESS_LAYOUT = join(dir, 'sub', 'layout.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const res = await post(port, '/layout', { pinned: ['beta.localhost'] });
		assert.equal(res.status, 204);
		const body = await get(port);
		const pos = (host) => body.data.indexOf(`data-host="${host}"`);
		assert.ok(pos('beta.localhost') < pos('alpha.localhost'), 'pinned app renders first');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
		delete process.env.PORTLESS_LAYOUT;
	}
});

test('POST /layout keeps pins for apps that are not currently running', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'alpha.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://alpha.example.ts.net' }])
	);
	const layoutPath = join(dir, 'layout.json');
	writeFileSync(layoutPath, JSON.stringify({ pinned: ['gone.localhost'] }));

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	process.env.PORTLESS_LAYOUT = layoutPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const res = await post(port, '/layout', { pinned: ['alpha.localhost'] });
		assert.equal(res.status, 204);
		assert.deepEqual(JSON.parse(readFileSync(layoutPath, 'utf8')), {
			pinned: ['alpha.localhost', 'gone.localhost'],
		});
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
		delete process.env.PORTLESS_LAYOUT;
	}
});

test('POST /layout: a later save replaces the order of an earlier one', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify(
			['alpha', 'beta'].map((n) => ({
				hostname: `${n}.localhost`, port: 1, pid: process.pid, tailscaleUrl: `https://${n}.example.ts.net`,
			}))
		)
	);
	const layoutPath = join(dir, 'layout.json');

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	process.env.PORTLESS_LAYOUT = layoutPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		await post(port, '/layout', { pinned: ['beta.localhost'] });
		await post(port, '/layout', { pinned: ['alpha.localhost', 'beta.localhost'] });
		assert.deepEqual(JSON.parse(readFileSync(layoutPath, 'utf8')), {
			pinned: ['alpha.localhost', 'beta.localhost'],
		});
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
		delete process.env.PORTLESS_LAYOUT;
	}
});

test('POST /layout rejects malformed JSON, non-array pins, non-string entries, and oversized lists', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify([{ hostname: 'alpha.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://alpha.example.ts.net' }])
	);

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	process.env.PORTLESS_LAYOUT = join(dir, 'layout.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		for (const body of ['{not json', 'null', '{}', '{"pinned":"alpha.localhost"}', '{"pinned":[42]}']) {
			const res = await post(port, '/layout', body);
			assert.equal(res.status, 400, `expected 400 for ${body}`);
		}
		const tooMany = await post(port, '/layout', { pinned: Array.from({ length: 101 }, (_, i) => `${i}.localhost`) });
		assert.equal(tooMany.status, 400);
		const tooLong = await post(port, '/layout', { pinned: [`${'x'.repeat(254)}.localhost`] });
		assert.equal(tooLong.status, 400);
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
		delete process.env.PORTLESS_LAYOUT;
	}
});

test('page renders pin controls and reorder handles only on pinned cards', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(
		routesPath,
		JSON.stringify(
			['alpha', 'beta'].map((n) => ({
				hostname: `${n}.localhost`, port: 1, pid: process.pid, tailscaleUrl: `https://${n}.example.ts.net`,
			}))
		)
	);
	writeFileSync(join(dir, 'layout.json'), JSON.stringify({ pinned: ['beta.localhost'] }));

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	process.env.PORTLESS_LAYOUT = join(dir, 'layout.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		const doc = documentOf(body.data);
		const beta = doc.querySelector('li[data-host="beta.localhost"]');
		const alpha = doc.querySelector('li[data-host="alpha.localhost"]');
		assert.equal(beta.querySelector('.pin').getAttribute('aria-pressed'), 'true');
		assert.equal(alpha.querySelector('.pin').getAttribute('aria-pressed'), 'false');
		assert.ok(beta.classList.contains('pinned'));
		assert.ok(beta.querySelector('.handle'));
		assert.equal(alpha.querySelector('.handle'), null);
		assert.equal(doc.querySelector('[draggable="true"]'), null);
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
		delete process.env.PORTLESS_LAYOUT;
	}
});

test('GET /manifest.webmanifest returns an installable web app manifest', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	process.env.PORTLESS_ROUTES = join(dir, 'routes.json');
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const res = await getPath(port, '/manifest.webmanifest');
		assert.equal(res.status, 200);
		assert.equal(res.headers['content-type'], 'application/manifest+json');
		const manifest = JSON.parse(res.data);
		assert.equal(manifest.name, 'dev apps');
		assert.equal(manifest.start_url, '/');
		assert.equal(manifest.display, 'standalone');
		assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest lists icons');
		assert.ok(
			manifest.icons.some((i) => i.purpose === 'any maskable'),
			'a maskable icon for Android adaptive shapes'
		);
		for (const sizes of ['192x192', '512x512']) {
			const icon = manifest.icons.find((i) => i.sizes === sizes);
			assert.ok(icon, `a ${sizes} raster icon (Chromium installability criteria)`);
			assert.equal(icon.type, 'image/png');
			const served = await getPath(port, icon.src);
			assert.equal(served.status, 200);
			assert.equal(served.headers['content-type'], 'image/png');
			assert.equal(served.data.slice(0, 8), '\x89PNG\r\n\x1a\n');
			const px = Number(sizes.split('x')[0]);
			const be32 = (s, o) => (s.charCodeAt(o) << 24) | (s.charCodeAt(o + 1) << 16) | (s.charCodeAt(o + 2) << 8) | s.charCodeAt(o + 3);
			assert.deepEqual([be32(served.data, 16), be32(served.data, 20)], [px, px], `IHDR matches ${sizes}`);
		}
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('GET /icon.svg returns an SVG image', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	process.env.PORTLESS_ROUTES = join(dir, 'routes.json');
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const res = await getPath(port, '/icon.svg');
		assert.equal(res.status, 200);
		assert.equal(res.headers['content-type'], 'image/svg+xml');
		assert.match(res.data, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('GET /icon.png returns a PNG image', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	process.env.PORTLESS_ROUTES = join(dir, 'routes.json');
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const res = await getPath(port, '/icon.png');
		assert.equal(res.status, 200);
		assert.equal(res.headers['content-type'], 'image/png');
		assert.equal(res.data.slice(0, 8), '\x89PNG\r\n\x1a\n', 'body starts with the PNG signature');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('page head links the manifest, icons, and theme color', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	process.env.PORTLESS_ROUTES = join(dir, 'routes.json');
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.match(body.data, /<link rel="manifest" href="\/manifest\.webmanifest">/);
		assert.match(body.data, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml">/);
		assert.match(body.data, /<link rel="apple-touch-icon" href="\/icon\.png">/);
		assert.match(body.data, /<meta name="theme-color" content="#101014">/);
		assert.match(body.data, /<meta name="apple-mobile-web-app-capable" content="yes">/);
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('hasTailnetAddr spots a Tailscale IPv4 (100.64.0.0/10) on a non-internal interface', () => {
	const ifaces = {
		lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
		utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
	};
	assert.equal(hasTailnetAddr(ifaces), true);
});

test('hasTailnetAddr spots a Tailscale IPv6 (fd7a:115c:a1e0::/48)', () => {
	const ifaces = {
		utun4: [{ address: 'fd7a:115c:a1e0:ab12:4843:cd96:6255:1234', family: 'IPv6', internal: false }],
	};
	assert.equal(hasTailnetAddr(ifaces), true);
});

test('hasTailnetAddr is false for ordinary interfaces and when Tailscale is down', () => {
	const ifaces = {
		lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
		en0: [
			{ address: '192.168.1.10', family: 'IPv4', internal: false },
			{ address: 'fe80::1c2d:3e4f:5a6b:7c8d', family: 'IPv6', internal: false },
		],
	};
	assert.equal(hasTailnetAddr(ifaces), false);
	assert.equal(hasTailnetAddr({}), false);
});

test('hasTailnetAddr rejects 100.x addresses outside the CGNAT range', () => {
	const ifaces = {
		utun4: [
			{ address: '100.63.255.254', family: 'IPv4', internal: false },
			{ address: '100.128.0.1', family: 'IPv4', internal: false },
		],
	};
	assert.equal(hasTailnetAddr(ifaces), false);
});

test('hasTailnetAddr ignores CGNAT addresses on non-tunnel interfaces (ISP/cellular CGNAT)', () => {
	const ifaces = {
		en0: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
		eth0: [{ address: '100.64.1.2', family: 'IPv4', internal: false }],
	};
	assert.equal(hasTailnetAddr(ifaces), false);
});

test('hasTailnetAddr accepts a CGNAT IPv4 on a Linux tailscale0 interface', () => {
	const ifaces = {
		tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
	};
	assert.equal(hasTailnetAddr(ifaces), true);
});

test('hasTailnetAddr accepts a CGNAT IPv4 on the Windows "Tailscale" adapter', () => {
	const ifaces = {
		Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
	};
	assert.equal(hasTailnetAddr(ifaces), true);
});

test('page shows the Tailscale banner with a reconnect hint only when the tailnet is down', () => {
	const down = page({ tailnetUp: false });
	assert.match(documentOf(down).querySelector('.banner[role="status"]').textContent, /Tailscale not running/);
	assert.equal(documentOf(down).querySelector('.banner code').textContent, 'tailscale up');

	const up = page();
	assert.equal(documentOf(up).querySelector('.banner'), null);
	assert.doesNotMatch(up, /Tailscale not running/);
});

test('GET / reflects the machine tailnet state in the banner', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	process.env.PORTLESS_ROUTES = join(dir, 'routes.json');
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		// The wiring under test: banner present exactly when this machine has no tailnet address.
		assert.equal(Boolean(documentOf(body.data).querySelector('.banner')), !hasTailnetAddr(networkInterfaces()));
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

// Boot the handler against a fresh fixture dir. Callers write routes/names/
// layout/peers files into `dir` before calling; missing files are fine.
const bootFixture = async (dir, files) => {
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
	}
	process.env.PORTLESS_ROUTES = join(dir, 'routes.json');
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	process.env.PORTLESS_LAYOUT = join(dir, 'layout.json');
	process.env.PORTLESS_PEERS = join(dir, 'peers.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}-${Math.random()}`);
	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const close = () => {
		app.close();
		for (const key of ['PORTLESS_ROUTES', 'PORTLESS_NAMES', 'PORTLESS_LAYOUT', 'PORTLESS_PEERS']) delete process.env[key];
	};
	return { port: app.address().port, close };
};

test('GET /api/routes returns this device and its apps as JSON, with labels and health', async () => {
	const live = createServer((req, res) => res.end());
	await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
	const livePort = live.address().port;
	const dead = createServer((req, res) => res.end());
	await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
	const deadPort = dead.address().port;
	await new Promise((resolve) => dead.close(resolve));

	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const { port, close } = await bootFixture(dir, {
		'routes.json': [
			{ hostname: 'demo.localhost', port: livePort, pid: process.pid, tailscaleUrl: 'https://mac.example.ts.net:8443' },
			{ hostname: 'blog.localhost', port: deadPort, pid: process.pid, tailscaleUrl: 'https://mac.example.ts.net:8444' },
			{ hostname: 'scratch.localhost', port: deadPort, pid: process.pid },
			{ hostname: 'gone.localhost', port: deadPort, pid: 4194305, tailscaleUrl: 'https://mac.example.ts.net:8445' },
		],
		'names.json': { 'demo.localhost': 'My Demo' },
	});
	try {
		const res = await getPath(port, '/api/routes');
		assert.equal(res.status, 200);
		assert.match(res.headers['content-type'], /^application\/json/);
		const body = JSON.parse(res.data);
		assert.equal(typeof body.device, 'string');
		assert.ok(body.device.length > 0);
		assert.deepEqual(body.apps, [
			{ hostname: 'demo.localhost', label: 'My Demo', tailscaleUrl: 'https://mac.example.ts.net:8443', up: true },
			{ hostname: 'blog.localhost', label: 'blog', tailscaleUrl: 'https://mac.example.ts.net:8444', up: false },
			{ hostname: 'scratch.localhost', label: 'scratch', up: false },
		]);
		assert.equal((await post(port, '/api/routes', {})).status, 405);
	} finally {
		close();
		live.close();
	}
});

const jsonServer = async (body) => {
	const srv = createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify(body));
	});
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	return { srv, base: `http://127.0.0.1:${srv.address().port}` };
};

test('GET / merges configured peers under per-device headings; unreachable peers are skipped', async () => {
	const live = createServer((req, res) => res.end());
	await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
	const peer = await jsonServer({
		device: 'laptop <b>',
		apps: [
			{ hostname: 'web.localhost', label: 'Web <i>', tailscaleUrl: 'https://laptop.example.ts.net:8443', up: true },
			{ hostname: 'notes.localhost', up: false },
		],
	});
	const gone = createServer(() => {});
	await new Promise((resolve) => gone.listen(0, '127.0.0.1', resolve));
	const goneBase = `http://127.0.0.1:${gone.address().port}`;
	await new Promise((resolve) => gone.close(resolve));

	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const { port, close } = await bootFixture(dir, {
		'routes.json': [
			{ hostname: 'demo.localhost', port: live.address().port, pid: process.pid, tailscaleUrl: 'https://mac.example.ts.net:8443' },
		],
		'peers.json': { peers: [peer.base, goneBase] },
	});
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		const doc = documentOf(body.data);
		const sections = [...doc.querySelectorAll('section')];
		assert.equal(sections.length, 2);
		assert.equal(sections[1].querySelector('h2').textContent, 'laptop <b>');
		assert.equal(sections[0].querySelector('.name[data-host="demo.localhost"]').textContent, 'demo');
		assert.equal(sections[1].querySelector('a').getAttribute('href'), 'https://laptop.example.ts.net:8443');
		assert.equal(sections[1].querySelector('.name').textContent, 'Web <i>');
		assert.equal(sections[1].querySelector('.local .name').textContent, 'notes');
		assert.match(sections[1].querySelector('.local .url').textContent, /local only — notes.localhost/);
		assert.equal(sections[1].querySelector('[data-host], .pin, .handle'), null);
		assert.equal(doc.querySelectorAll('.pin').length, 1);
	} finally {
		close();
		live.close();
		peer.srv.close();
	}
});

test('GET / with a reachable peer that has nothing running shows its heading with an empty note', async () => {
	const peer = await jsonServer({ device: 'laptop', apps: [] });
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const { port, close } = await bootFixture(dir, { 'peers.json': { peers: [peer.base] } });
	try {
		const body = await get(port);
		const peerSection = documentOf(body.data).querySelectorAll('section')[1];
		assert.equal(peerSection.querySelector('h2').textContent, 'laptop');
		assert.equal(peerSection.querySelector('.empty').textContent, 'Nothing running.');
	} finally {
		close();
		peer.srv.close();
	}
});

test('GET / with no peers configured renders no device headings', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const { port, close } = await bootFixture(dir, { 'routes.json': [] });
	try {
		const body = await get(port);
		assert.equal(body.status, 200);
		assert.equal(documentOf(body.data).querySelector('h2'), null);
		assert.match(body.data, /Nothing running\. Start an app through portless\./);
	} finally {
		close();
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

test('GET /api/menubar returns the xbar/SwiftBar dropdown as text: title, home link, one line per app', async () => {
	const live = createServer((req, res) => res.end());
	await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
	const livePort = live.address().port;
	const dead = createServer((req, res) => res.end());
	await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
	const deadPort = dead.address().port;
	await new Promise((resolve) => dead.close(resolve));

	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const { port, close } = await bootFixture(dir, {
		'routes.json': [
			{ hostname: 'demo.localhost', port: livePort, pid: process.pid, tailscaleUrl: 'https://mac.example.ts.net:8443' },
			{ hostname: 'blog.localhost', port: deadPort, pid: process.pid, tailscaleUrl: 'https://mac.example.ts.net:8444' },
			{ hostname: 'gone.localhost', port: deadPort, pid: 4194305, tailscaleUrl: 'https://mac.example.ts.net:8445' },
		],
		'names.json': { 'demo.localhost': 'My Demo' },
	});
	try {
		const res = await getPath(port, '/api/menubar');
		assert.equal(res.status, 200);
		assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
		assert.deepEqual(Buffer.from(res.data, 'latin1').toString('utf8').split('\n'), [
			'⌂ 1',
			'---',
			'Open home page | href=http://127.0.0.1:5995/',
			'---',
			'● My Demo | href=https://mac.example.ts.net:8443 emojize=false symbolize=false',
			'○ blog | href=https://mac.example.ts.net:8444 color=gray emojize=false symbolize=false',
		]);
		assert.equal((await post(port, '/api/menubar', {})).status, 405);
	} finally {
		close();
		live.close();
	}
});

const getLang = (port, acceptLanguage) =>
	new Promise((resolve, reject) => {
		const headers = acceptLanguage === undefined ? {} : { 'Accept-Language': acceptLanguage };
		const req = request({ host: '127.0.0.1', port, method: 'GET', headers }, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => resolve(data));
		});
		req.on('error', reject);
		req.end();
	});

test('GET translates the heading, local-only label, and empty state from Accept-Language', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(routesPath, JSON.stringify([{ hostname: 'notes.localhost', port: 1, pid: process.pid }]));

	process.env.PORTLESS_ROUTES = routesPath;
	process.env.PORTLESS_NAMES = join(dir, 'names.json');
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	try {
		const de = await getLang(port, 'de-CH,de;q=0.9,en;q=0.8');
		assert.match(de, /<html lang="de">/);
		assert.match(de, /<title>Dev-Apps<\/title>/);
		assert.equal(documentOf(de).querySelector('h1').textContent, 'Dev-Apps');
		assert.match(de, /nur lokal — notes\.localhost/);

		const en = await getLang(port, undefined);
		assert.match(en, /<html lang="en">/);
		assert.equal(documentOf(en).querySelector('h1').textContent, 'dev apps');
		assert.match(en, /local only — notes\.localhost/);

		writeFileSync(routesPath, '[]');
		const empty = await getLang(port, 'fr');
		assert.equal(documentOf(empty).querySelector('.empty').textContent, 'Rien ne tourne. Lance une app via portless.');
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('GET /events opens a server-sent-events stream; other methods get 405', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-test-'));
	const routesPath = join(dir, 'routes.json');
	writeFileSync(routesPath, '[]');
	process.env.PORTLESS_ROUTES = routesPath;
	const { handler } = await import(`./server.mjs?fixture=${Date.now()}`);

	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	const { port } = app.address();
	let stream;
	try {
		const denied = await post(port, '/events', {});
		assert.equal(denied.status, 405);
		stream = await new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port, path: '/events' }, (res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => {
					text += chunk;
					if (text.includes('\n\n')) resolve({ res, req, text });
				});
			});
			req.on('error', reject);
			req.end();
		});
		assert.equal(stream.res.statusCode, 200);
		assert.equal(stream.res.headers['content-type'], 'text/event-stream');
		// The page embeds the stamp of the routes.json it rendered; the stream opens with the current one.
		const html = await get(port);
		const { stamp: embedded } = JSON.parse(documentOf(html.data).querySelector('#page-data').textContent);
		assert.equal(stream.text, `data: ${embedded}\n\n`);
	} finally {
		stream?.req.destroy();
		app.close();
		delete process.env.PORTLESS_ROUTES;
	}
});

test('page preserves scripts-off refresh and passes the snapshot stamp to hydration', () => {
	const html = page({ stamp: 'abc123def456' });
	assert.match(html, /<noscript><meta http-equiv="refresh" content="15"><\/noscript>/);
	assert.equal(html.match(/http-equiv="refresh"/g).length, 1);
	const doc = documentOf(html);
	assert.equal(JSON.parse(doc.querySelector('#page-data').textContent).stamp, 'abc123def456');
	assert.equal(doc.querySelector('script[type="module"]').getAttribute('src'), '/assets/ui.js');
});

test('hydration data round-trips hostile labels without creating executable markup', () => {
	const hostile = '</script><script>globalThis.compromised=true</script><img src=x onerror=bad>&"';
	const html = page({
		device: hostile,
		routes: [{ hostname: 'demo.localhost', label: hostile, up: true, pinned: true, tailscaleUrl: 'https://example.test/?q="<x>' }],
		registered: [{ hostname: 'stopped.localhost', label: hostile, state: 'stopped' }],
		peers: [{ device: hostile, apps: [{ hostname: 'peer.localhost', label: hostile, up: false }] }],
	});
	const doc = documentOf(html);
	assert.equal(doc.querySelectorAll('script').length, 2);
	assert.equal(doc.querySelector('script:not([id]):not([src])'), null);
	assert.equal(doc.querySelector('img'), null);
	assert.equal(doc.querySelector('.name').textContent, hostile);
	const model = JSON.parse(doc.querySelector('#page-data').textContent);
	assert.equal(model.routes[0].label, hostile);
	assert.equal(model.registered[0].label, hostile);
	assert.equal(model.peers[0].device, hostile);
});

test('UI assets have correct MIME types and only public bundles are served', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-home-assets-'));
	const { port, close } = await bootFixture(dir, {});
	try {
		for (const [name, type] of [['ui.js', 'text/javascript'], ['ui.css', 'text/css']]) {
			const result = await getPath(port, `/assets/${name}`);
			assert.equal(result.status, 200);
			assert.ok(result.headers['content-type'].startsWith(type));
			assert.equal(result.headers['cache-control'], 'no-cache');
			assert.equal(result.headers['x-content-type-options'], 'nosniff');
			assert.equal(result.data, readFileSync(new URL(`./dist/${name}`, import.meta.url)).toString('latin1'));
			const head = await getPath(port, `/assets/${name}`, 'HEAD');
			assert.equal(head.status, 200);
			assert.equal(head.data, '');
			assert.equal(head.headers['content-length'], result.headers['content-length']);
			assert.equal((await post(port, `/assets/${name}`, {})).status, 405);
		}
		for (const path of ['/assets/ui-server.mjs', '/assets/../server.mjs', '/assets/%2e%2e/server.mjs', '/assets/missing.js']) {
			assert.equal((await getPath(port, path)).status, 404);
		}
	} finally {
		close();
	}
});
