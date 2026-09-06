import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { events, watchFile } from './live.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (check, timeoutMs = 3000) => {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await wait(25);
	}
};

const routesFixture = () => {
	const file = join(mkdtempSync(join(tmpdir(), 'portless-home-live-')), 'routes.json');
	writeFileSync(file, '[]');
	return file;
};

const listen = async (handler) => {
	const app = createServer(handler);
	await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
	return app;
};

// Opens GET path and resolves once headers arrive; the body keeps streaming into `text`.
const open = (port, path) =>
	new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path }, (res) => {
			const stream = { status: res.statusCode, headers: res.headers, text: '', close: () => req.destroy() };
			res.setEncoding('utf8');
			res.on('data', (chunk) => (stream.text += chunk));
			resolve(stream);
		});
		req.on('error', reject);
		req.end();
	});

// fs.watch shows up as FSEventWrap on macOS and FSWatcher elsewhere; closing is async.
const watchers = () => process.getActiveResourcesInfo().filter((r) => /^FS(Event|Watch)/.test(r)).length;

test('watchFile fires once for a burst of writes and only for the watched file', async () => {
	const file = routesFixture();
	let hits = 0;
	const stop = watchFile(file, () => hits++, 100);
	try {
		// macOS FSEvents may still report the fixture write; let that settle first.
		await wait(300);
		hits = 0;
		writeFileSync(join(file, '..', 'other.json'), '{}');
		writeFileSync(file, '[1]');
		writeFileSync(file, '[2]');
		writeFileSync(file, '[3]');
		await until(() => hits > 0);
		await wait(300);
		assert.equal(hits, 1);
	} finally {
		stop();
	}
});

test('GET /events streams text/event-stream and sends a change event when routes.json is written', async () => {
	const file = routesFixture();
	const live = events(file);
	const app = await listen((req, res) => live(res) || res.writeHead(503).end());
	const stream = await open(app.address().port, '/events');
	try {
		assert.equal(stream.status, 200);
		assert.equal(stream.headers['content-type'], 'text/event-stream');
		assert.equal(stream.headers['cache-control'], 'no-cache');
		await until(() => stream.text.includes(': connected\n\n'));
		writeFileSync(file, '[{"hostname":"demo.localhost"}]');
		await until(() => stream.text.includes('data: change\n\n'));
	} finally {
		stream.close();
		app.close();
	}
});

test('the watcher opens with the first stream and closes with the last', async () => {
	const file = routesFixture();
	const live = events(file);
	const app = await listen((req, res) => live(res) || res.writeHead(503).end());
	const { port } = app.address();
	await until(() => watchers() === 0);
	const streams = [];
	try {
		streams.push(await open(port, '/events'), await open(port, '/events'));
		assert.equal(watchers(), 1);
		streams.shift().close();
		await wait(100);
		assert.equal(watchers(), 1);
		streams.shift().close();
		await until(() => watchers() === 0);
		// A stream after the idle gap gets a fresh watcher and still sees writes.
		streams.push(await open(port, '/events'));
		assert.equal(watchers(), 1);
		writeFileSync(file, '[1]');
		await until(() => streams[0].text.includes('data: change'));
		streams.shift().close();
		await until(() => watchers() === 0);
	} finally {
		streams.forEach((s) => s.close());
		app.close();
	}
});

test('events reports failure without writing a response when the routes directory is missing', async () => {
	const live = events(join(tmpdir(), 'portless-home-nowhere', 'routes.json'));
	const app = await listen((req, res) => live(res) || res.writeHead(503).end());
	const stream = await open(app.address().port, '/events');
	try {
		assert.equal(stream.status, 503);
	} finally {
		stream.close();
		app.close();
	}
});
