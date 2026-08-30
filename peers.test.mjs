import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parsePeers, parsePeerSnapshot, fetchPeer } from './peers.mjs';

const listen = async (srv) => {
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${srv.address().port}`;
};

test('fetchPeer requests /api/routes and returns the validated snapshot', async () => {
	let path;
	const srv = createServer((req, res) => {
		path = req.url;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ device: 'laptop', apps: [{ hostname: 'web.localhost', label: 'Web', up: true }] }));
	});
	const base = await listen(srv);
	try {
		const snap = await fetchPeer(`${base}/`);
		assert.equal(path, '/api/routes');
		assert.deepEqual(snap, { device: 'laptop', apps: [{ hostname: 'web.localhost', label: 'Web', up: true }] });
	} finally {
		srv.close();
	}
});

test('fetchPeer resolves null when the peer refuses, errors, or sends non-JSON', async () => {
	const gone = createServer(() => {});
	const base = await listen(gone);
	await new Promise((resolve) => gone.close(resolve));
	assert.equal(await fetchPeer(base), null);

	const failing = createServer((req, res) => res.writeHead(500).end('nope'));
	const html = createServer((req, res) => res.end('<html>not json</html>'));
	const array = createServer((req, res) => res.end('[1,2,3]'));
	try {
		assert.equal(await fetchPeer(await listen(failing)), null);
		assert.equal(await fetchPeer(await listen(html)), null);
		assert.equal(await fetchPeer(await listen(array)), null);
	} finally {
		failing.close();
		html.close();
		array.close();
	}
});

test('fetchPeer does not follow redirects: the redirect target is never requested', async () => {
	let targetHits = 0;
	const target = createServer((req, res) => {
		targetHits++;
		res.end(JSON.stringify({ device: 'internal', apps: [] }));
	});
	const targetBase = await listen(target);
	const peer = createServer((req, res) => res.writeHead(302, { location: `${targetBase}/internal` }).end());
	const base = await listen(peer);
	try {
		assert.equal(await fetchPeer(base), null);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(targetHits, 0);
	} finally {
		peer.close();
		target.close();
	}
});

test('fetchPeer gives up after the timeout when the peer sends headers but never finishes the body', async () => {
	const stall = createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.write('{"device":"laptop","apps":[');
	});
	const base = await listen(stall);
	try {
		const start = Date.now();
		assert.equal(await fetchPeer(base, 100), null);
		assert.ok(Date.now() - start < 1000, 'should not wait for the body');
	} finally {
		stall.closeAllConnections();
		stall.close();
	}
});

test('fetchPeer stops reading an oversized body at the cap instead of buffering until the timeout', async () => {
	const timers = new Set();
	const firehose = createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		const t = setInterval(() => res.write('x'.repeat(64 * 1024)), 1);
		timers.add(t);
		res.on('close', () => clearInterval(t));
	});
	const base = await listen(firehose);
	try {
		const start = Date.now();
		assert.equal(await fetchPeer(base, 5000), null);
		assert.ok(Date.now() - start < 2000, 'should bail on size, well before the 5s timeout');
	} finally {
		timers.forEach(clearInterval);
		firehose.closeAllConnections();
		firehose.close();
	}
});

test('fetchPeer gives up after the timeout when the peer never answers', async () => {
	const hang = createServer(() => {});
	const base = await listen(hang);
	try {
		const start = Date.now();
		assert.equal(await fetchPeer(base, 100), null);
		assert.ok(Date.now() - start < 1000, 'should not wait for the peer');
	} finally {
		hang.closeAllConnections();
		hang.close();
	}
});

test('parsePeerSnapshot keeps well-formed apps and only https tailnet links', () => {
	const snap = parsePeerSnapshot(
		{
			device: 'laptop',
			apps: [
				{ hostname: 'web.localhost', label: 'Web', tailscaleUrl: 'https://laptop.example.ts.net:8443', up: true },
				{ hostname: 'evil.localhost', label: 'x', tailscaleUrl: 'javascript:alert(1)', up: 'yes' },
				{ hostname: 'local.localhost', up: false },
				{ label: 'no hostname' },
				'garbage',
			],
		},
		'fallback.example.ts.net'
	);
	assert.deepEqual(snap, {
		device: 'laptop',
		apps: [
			{ hostname: 'web.localhost', label: 'Web', tailscaleUrl: 'https://laptop.example.ts.net:8443', up: true },
			{ hostname: 'evil.localhost', label: 'x', up: false },
			{ hostname: 'local.localhost', up: false },
		],
	});
});

test('parsePeerSnapshot falls back to the peer host as device name and rejects non-snapshots', () => {
	assert.equal(parsePeerSnapshot({ apps: [] }, 'laptop.example.ts.net').device, 'laptop.example.ts.net');
	assert.equal(parsePeerSnapshot({ device: '  ', apps: [] }, 'h').device, 'h');
	assert.equal(parsePeerSnapshot({ device: 'x'.repeat(200), apps: [] }, 'h').device.length, 64);
	assert.equal(parsePeerSnapshot(null, 'h'), null);
	assert.equal(parsePeerSnapshot([], 'h'), null);
	assert.equal(parsePeerSnapshot({ device: 'laptop' }, 'h'), null);
	assert.equal(parsePeerSnapshot({ apps: 'nope' }, 'h'), null);
});

test('parsePeerSnapshot caps the number of apps and the label length', () => {
	const apps = Array.from({ length: 150 }, (_, i) => ({ hostname: `a${i}.localhost`, label: 'L'.repeat(200), up: true }));
	const snap = parsePeerSnapshot({ device: 'd', apps }, 'h');
	assert.equal(snap.apps.length, 100);
	assert.equal(snap.apps[0].label.length, 64);
});

test('parsePeers reads the peers list and drops entries that are not http(s) URLs', () => {
	const text = JSON.stringify({
		peers: ['https://mac.example.ts.net', 'http://127.0.0.1:5996/', 'ftp://nope', 'not a url', 42, null],
	});
	assert.deepEqual(parsePeers(text), ['https://mac.example.ts.net', 'http://127.0.0.1:5996/']);
});

test('parsePeers returns an empty list for corrupt or wrongly shaped files', () => {
	assert.deepEqual(parsePeers('{not json'), []);
	assert.deepEqual(parsePeers('[]'), []);
	assert.deepEqual(parsePeers('{"peers": "https://mac.example.ts.net"}'), []);
	assert.deepEqual(parsePeers('null'), []);
});
