import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTailnetAddr, probe, orderRoutes, mergePinned } from './server.mjs';
import { page } from './render.mjs';

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

const getPath = (port, path) =>
	new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
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
		const result = await probe(port);
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
		assert.match(body.data, /<span class="dot up" role="img" aria-label="online"><\/span><span class="name" data-host="demo\.localhost" role="button" tabindex="0">demo<\/span>/);
		assert.match(body.data, /<span class="dot" role="img" aria-label="offline"><\/span><span class="name" data-host="blog\.localhost" role="button" tabindex="0">blog<\/span>/);
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
		assert.match(body.data, /class="empty"/);
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
		assert.match(body.data, /<span class="name" data-host="demo\.localhost" role="button" tabindex="0">My Demo<\/span>/);
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
		assert.match(body.data, /<span class="name" data-host="demo\.localhost" role="button" tabindex="0">demo<\/span>/);
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
			assert.match(body.data, /<span class="name" data-host="demo\.localhost" role="button" tabindex="0">demo<\/span>/);
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
		assert.match(body.data, /<span class="name" data-host="demo\.localhost" role="button" tabindex="0">New Label<\/span>/);
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
		assert.match(body.data, /<span class="name" data-host="demo\.localhost" role="button" tabindex="0">demo<\/span>/);
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
		assert.match(body.data, /&#60;script&#62;alert\(1\)&#60;\/script&#62;&#34;/);
	} finally {
		app.close();
		delete process.env.PORTLESS_ROUTES;
		delete process.env.PORTLESS_NAMES;
	}
});

test('page contains the rename wiring: data-host attribute and a POST to /rename in the inline script', async () => {
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
		assert.match(body.data, /<span class="name" data-host="demo\.localhost" role="button" tabindex="0">demo<\/span>/);
		assert.match(body.data, /<script>[\s\S]*\/rename[\s\S]*<\/script>/);
		assert.match(body.data, /fetch\(['"]\/rename['"]/);
		assert.match(body.data, /keydown/);
		assert.match(body.data, /r\.ok/);
		assert.match(body.data, /\.catch\(/);
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

test('page script chains layout saves: a second save waits for the first request to settle', async () => {
	const script = page('', true).match(/<script>([\s\S]*)<\/script>/)[1];
	const clicks = [];
	const fakePin = {
		dataset: { host: 'demo.localhost' },
		addEventListener: (type, fn) => {
			if (type === 'click') clicks.push(fn);
		},
	};
	const fetchCalls = [];
	let settleFirst;
	const fakeFetch = (url, opts) => {
		fetchCalls.push(JSON.parse(opts.body));
		return new Promise((resolve) => {
			if (fetchCalls.length === 1) settleFirst = () => resolve({ ok: true });
			else resolve({ ok: true });
		});
	};
	const alerts = [];
	const fakeDocument = {
		querySelectorAll: (sel) => (sel === '.pin' ? [fakePin] : []),
		addEventListener: () => {},
	};
	new Function('document', 'fetch', 'alert', 'location', script)(
		fakeDocument,
		fakeFetch,
		(msg) => alerts.push(msg),
		{ reload: () => {} }
	);
	const evt = { preventDefault: () => {}, stopPropagation: () => {} };
	clicks[0](evt);
	clicks[0](evt);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fetchCalls.length, 1, 'second save must not start while the first is in flight');
	settleFirst();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fetchCalls.length, 2, 'second save runs once the first settles');
	assert.deepEqual(fetchCalls[1], { pinned: ['demo.localhost'] });
	assert.deepEqual(alerts, []);
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

test('page contains the pin wiring: pin toggles, reorder handles on pinned cards, and a POST to /layout', async () => {
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
		assert.match(
			body.data,
			/<span class="pin pinned" data-host="beta\.localhost" role="button" tabindex="0" aria-pressed="true"/
		);
		assert.match(
			body.data,
			/<span class="pin" data-host="alpha\.localhost" role="button" tabindex="0" aria-pressed="false"/
		);
		assert.match(body.data, /<li class="pinned" data-host="beta\.localhost">/);
		// The pinned card carries a reorder handle; unpinned cards do not.
		// data-host="…"> only ends the <li> tag; on the inner spans more attributes follow.
		const [alphaCard, betaCard] = ['alpha', 'beta'].map((n) => {
			const from = body.data.indexOf(`data-host="${n}.localhost">`);
			return body.data.slice(from, body.data.indexOf('</li>', from));
		});
		assert.match(betaCard, /<span class="handle" role="button" tabindex="0" aria-label="[^"]*"/);
		assert.doesNotMatch(alphaCard, /class="handle"/);
		assert.match(body.data, /fetch\(['"]\/layout['"]/);
		// Reorder works with pointer events (mouse + touch) and arrow keys — not HTML5 DnD, which is inert on phones.
		assert.match(body.data, /pointerdown/);
		assert.match(body.data, /pointermove/);
		assert.match(body.data, /ArrowUp/);
		assert.doesNotMatch(body.data, /draggable="true"/);
		// Saves are chained so rapid reorders cannot land out of order on the read-merge-write endpoint.
		assert.match(body.data, /saving = saving\.then/);
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

test('page shows the Tailscale banner with a reconnect hint only when the tailnet is down', () => {
	const down = page('', false);
	assert.match(down, /<p class="banner" role="status">Tailscale not running/);
	assert.match(down, /<code>tailscale up<\/code>/);

	const up = page('', true);
	assert.doesNotMatch(up, /class="banner"/);
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
		assert.equal(body.data.includes('class="banner"'), !hasTailnetAddr(networkInterfaces()));
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
		const headings = [...body.data.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
		assert.equal(headings.length, 2, `expected local + one reachable peer, got ${JSON.stringify(headings)}`);
		assert.equal(headings[1], 'laptop &#60;b&#62;');
		// local card keeps its controls
		assert.match(body.data, /<span class="name" data-host="demo\.localhost" role="button" tabindex="0">demo<\/span>/);
		// peer cards: escaped label, working link, no rename/pin controls
		assert.match(body.data, /<a href="https:\/\/laptop\.example\.ts\.net:8443"><span class="row"><span class="dot up" role="img" aria-label="online"><\/span><span class="name">Web &#60;i&#62;<\/span><\/span>/);
		assert.match(body.data, /<li class="local"><span class="row"><span class="dot" role="img" aria-label="offline"><\/span><span class="name">notes<\/span><\/span><span class="url">local only — notes\.localhost<\/span><\/li>/);
		assert.equal((body.data.match(/class="pin/g) || []).length, 1);
		// local section comes first and holds the local card
		assert.ok(body.data.indexOf('demo.localhost') < body.data.indexOf('laptop &#60;b&#62;'));
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
		assert.match(body.data, /<h2>laptop<\/h2><p class="empty">Nothing running\.<\/p>/);
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
		assert.doesNotMatch(body.data, /<h2>/);
		assert.match(body.data, /Nothing running\. Start an app through portless\./);
	} finally {
		close();
	}
});

test('page script only wires rename onto names that carry a data-host', () => {
	const script = page('', true).match(/<script>([\s\S]*)<\/script>/)[1];
	assert.match(script, /querySelectorAll\('\.name\[data-host\]'\)/);
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
