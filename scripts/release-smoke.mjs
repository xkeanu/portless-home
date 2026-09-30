#!/usr/bin/env node
// Checks the tarball as a Node-only user receives it: no node_modules, a
// server that renders HTML, and the built browser assets it references.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

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

const waitForServer = async (port, child, stderr) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (child.exitCode !== null) fail(`Packaged server exited with ${child.exitCode}: ${stderr()}`);
		try {
			return await get(port, '/');
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	fail(`Packaged server did not start: ${stderr()}`);
};

const startServer = async (app, env) => {
	const program = [
		"import { createServer } from 'node:http';",
		"import { handler } from './server.mjs';",
		"const server = createServer(handler);",
		"server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));",
	].join(' ');
	const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	child.stderr.on('data', (chunk) => (stderr += chunk));
	let port;
	try {
		port = await new Promise((resolve, reject) => {
			let output = '';
			const timeout = setTimeout(() => reject(new Error(`Packaged server did not choose a port: ${stderr}`)), 5000);
			child.stdout.on('data', (chunk) => {
				output += chunk;
				const match = output.match(/^(\d+)\n/);
				if (match) {
					clearTimeout(timeout);
					resolve(Number(match[1]));
				}
			});
			child.once('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once('exit', (code, signal) => {
				clearTimeout(timeout);
				reject(new Error(`Packaged server exited before listening (${code ?? signal}): ${stderr}`));
			});
		});
	} catch (error) {
		await stopServer(child);
		throw error;
	}
	return { child, port, stderr: () => stderr };
};

const stopServer = async (child) => {
	if (child.exitCode !== null) return;
	const exited = new Promise((resolve) => child.once('exit', resolve));
	child.kill('SIGTERM');
	await exited;
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
		const names = join(temp, 'names.json');
		const layout = join(temp, 'layout.json');
		const peers = join(temp, 'peers.json');
		const apps = join(temp, 'apps.json');
		const external = join(temp, 'external-apps.json');
		const externalLabel = 'External fixture';
		const externalUrl = 'https://external-fixture.example.ts.net:8443/path?view=home';
		writeFileSync(routes, JSON.stringify([{ hostname: 'fixture.localhost', port: 1, pid: process.pid, tailscaleUrl: 'https://fixture.example.ts.net' }]));
		writeFileSync(peers, JSON.stringify({ peers: [] }));
		writeFileSync(apps, JSON.stringify({ enabled: false, apps: [] }));
		writeFileSync(external, JSON.stringify({ apps: [{ label: externalLabel, url: externalUrl }] }));
		const server = await startServer(app, {
			...process.env,
			PORTLESS_ROUTES: routes,
			PORTLESS_NAMES: names,
			PORTLESS_LAYOUT: layout,
			PORTLESS_PEERS: peers,
			PORTLESS_APPS: apps,
			PORTLESS_EXTERNAL_APPS: external,
		});
		try {
			const page = await waitForServer(server.port, server.child, server.stderr);
			assert.equal(page.status, 200);
			assert.match(page.body, /fixture/);
			assert.ok(page.body.includes(externalLabel), 'configured external app label was missing');
			assert.ok(page.body.includes(`href="${externalUrl}"`), 'configured external app link was missing');
			assert.match(page.body, /(?:src|href)="\/assets\/ui\.(?:js|css)"/);
			for (const path of ['/api/routes', '/api/menubar']) {
				const result = await get(server.port, path);
				assert.equal(result.status, 200);
				assert.ok(!result.body.includes(externalLabel), `external app label leaked into ${path}`);
				assert.ok(!result.body.includes(externalUrl), `external app URL leaked into ${path}`);
			}
			const script = await get(server.port, '/assets/ui.js');
			assert.equal(script.status, 200);
			assert.match(script.headers['content-type'] || '', /javascript/);
			assert.ok(script.body.length > 0, 'ui.js was empty');
			const css = await get(server.port, '/assets/ui.css');
			assert.equal(css.status, 200);
			assert.match(css.headers['content-type'] || '', /text\/css/);
			assert.ok(css.body.length > 0, 'ui.css was empty');
		} finally {
			await stopServer(server.child);
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const archive = process.argv[2];
	if (archive) {
		smokeArchive(archive).catch((error) => {
			console.error(error.stack || error.message);
			process.exitCode = 1;
		});
	} else {
		console.error('Usage: node scripts/release-smoke.mjs path/to/portless-home-v1.2.3.tar.gz');
		process.exitCode = 1;
	}
}
