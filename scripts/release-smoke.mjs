#!/usr/bin/env node
// Checks the tarball as a Node-only user receives it: no node_modules, a
// server that renders HTML, and the built browser assets it references.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';

const fail = (message) => {
	throw new Error(message);
};

const get = (port, path) =>
	new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
		});
		req.on('error', reject);
		req.end();
	});

const waitForServer = async (port, child) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (child.exitCode !== null) fail(`Packaged server exited with ${child.exitCode}.`);
		try {
			return await get(port, '/');
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	fail('Packaged server did not start.');
};

export const smokeArchive = async (archive) => {
	const temp = mkdtempSync(join(tmpdir(), 'portless-home-smoke-'));
	try {
		const extracted = spawnSync('tar', ['-xzf', archive, '-C', temp], { encoding: 'utf8' });
		if (extracted.status !== 0) fail(`Could not extract archive: ${extracted.stderr}`);
		const [directory] = readdirSync(temp);
		if (!directory) fail('Archive did not contain a top-level directory.');
		const app = join(temp, directory);
		const forbidden = spawnSync('find', [app, '-name', 'node_modules', '-type', 'd'], { encoding: 'utf8' });
		if (forbidden.status !== 0) fail(`Could not inspect archive: ${forbidden.stderr}`);
		assert.equal(forbidden.stdout.trim(), '', 'release archive must not contain node_modules');
		for (let directory = app; directory.startsWith(temp); directory = dirname(directory)) {
			assert.equal(existsSync(join(directory, 'node_modules')), false, `Node could resolve dependencies from ${directory}`);
			if (directory === temp) break;
		}
		const routes = join(temp, 'routes.json');
		writeFileSync(routes, JSON.stringify([{ hostname: 'fixture.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://fixture.example.ts.net' }]));
		const port = 6100 + Math.floor(Math.random() * 3000);
		const child = spawn(process.execPath, ['server.mjs'], {
			cwd: app,
			env: { ...process.env, PORT: String(port), PORTLESS_ROUTES: routes },
			stdio: 'ignore',
		});
		try {
			const page = await waitForServer(port, child);
			assert.equal(page.status, 200);
			assert.match(page.body, /fixture/);
			assert.match(page.body, /(?:src|href)="\/assets\/ui\.(?:js|css)"/);
			const script = await get(port, '/assets/ui.js');
			assert.equal(script.status, 200);
			assert.match(script.headers['content-type'] || '', /javascript/);
			assert.ok(script.body.length > 0, 'ui.js was empty');
			const css = await get(port, '/assets/ui.css');
			assert.equal(css.status, 200);
			assert.match(css.headers['content-type'] || '', /text\/css/);
			assert.ok(css.body.length > 0, 'ui.css was empty');
		} finally {
			child.kill('SIGTERM');
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
};

const archive = process.argv[2];
if (archive) {
	smokeArchive(archive).catch((error) => {
		console.error(error.stack || error.message);
		process.exitCode = 1;
	});
} else if (process.argv[1] && process.argv[1].endsWith('release-smoke.mjs')) {
	console.error('Usage: node scripts/release-smoke.mjs path/to/portless-home-v1.2.3.tar.gz');
	process.exitCode = 1;
}
