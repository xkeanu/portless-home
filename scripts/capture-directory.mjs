// Run after npm run build. Captures the directory with the Compose fixture
// (docs/fixtures/routes.compose.json) at phone width in light and dark mode.
// Requires the optional Playwright CLI, never a runtime dependency.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const output = resolve(process.argv[2] || join(tmpdir(), 'portless-directory-captures'));
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'portless-directory-browser-'));
const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));

// Every fixture app answers the probe except the api service, so both dot states show.
const app = createServer((req, res) => res.end());
const livePort = await listen(app);
const closed = createServer();
const deadPort = await listen(closed);
await new Promise((done) => closed.close(done));
const fixture = JSON.parse(readFileSync(new URL('../docs/fixtures/routes.compose.json', import.meta.url), 'utf8'));
const routes = fixture.map((r) => ({ ...r, pid: r.pid && process.pid, port: r.hostname.startsWith('api.') ? deadPort : livePort }));
for (const [key, value] of Object.entries({ ROUTES: routes, NAMES: {}, LAYOUT: {}, PEERS: {}, APPS: [], EXTERNAL_APPS: {}, ACCOUNTS: {}, ACCESS: { owners: ['owner@example.com'] } })) {
	const path = join(scratch, `${key}.json`);
	writeFileSync(path, JSON.stringify(value));
	process.env[`PORTLESS_${key}`] = path;
}
const { handler } = await import('../server.mjs');
const directory = createServer(handler);
const url = `http://127.0.0.1:${await listen(directory)}/`;

const session = `directory-captures-${process.pid}`;
const command = process.env.PORTLESS_PLAYWRIGHT_CLI ? process.execPath : 'npx';
const prefix = process.env.PORTLESS_PLAYWRIGHT_CLI ? [process.env.PORTLESS_PLAYWRIGHT_CLI] : ['--yes', '--package', '@playwright/cli@0.1.22', 'playwright-cli'];

async function run(args) {
	const child = spawn(command, [...prefix, `--session=${session}`, ...args], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	child.stdout.on('data', (data) => { log += data; });
	child.stderr.on('data', (data) => { log += data; });
	const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000);
	try {
		const code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done); });
		writeFileSync(join(output, `${args[0]}.log`), log);
		if (code !== 0 || /^### Error/m.test(log)) throw new Error(`Playwright ${args[0]} failed. See ${join(output, `${args[0]}.log`)}`);
	} finally { clearTimeout(timeout); }
}

const browserCode = `async (page) => {
	const url = ${JSON.stringify(url)};
	const output = ${JSON.stringify(output)};
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const check = (condition, message) => { if (!condition) throw new Error(message); };
	for (const [scheme, width] of [['light', 390], ['dark', 390], ['dark', 1280]]) {
		await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
		await page.setViewportSize({ width, height: 844 });
		await page.goto(url);
		await page.locator('li.project').waitFor();
		check(await page.locator('li.project .services li').count() === 2, 'Compose project needs two services');
		check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), scheme + ' overflows at ' + width);
		await page.screenshot({ path: output + '/compose-' + scheme + '-' + width + '.png', fullPage: true });
	}
	// Viewers as Tailscale Serve presents them: forwarded, with or without a login (#48).
	for (const [name, login, canEdit] of [['owner', 'owner@example.com', true], ['viewer', 'friend@example.com', false], ['no-identity', '', false]]) {
		await page.setExtraHTTPHeaders({ 'x-forwarded-for': '100.64.0.2', ...(login ? { 'tailscale-user-login': login } : {}) });
		for (const scheme of ['light', 'dark']) {
			await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(url);
			await page.locator('li.project').waitFor();
			check((await page.locator('.pin').count() > 0) === canEdit, name + ' edit controls');
			check((await page.locator('.viewer').textContent()).includes(canEdit ? 'Viewing as' : 'read-only'), name + ' viewer line');
			check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), name + ' overflows');
			await page.screenshot({ path: output + '/viewer-' + name + '-' + scheme + '-390.png', fullPage: true });
		}
	}
	await page.setExtraHTTPHeaders({});
	check(errors.length === 0, errors.join('; '));
	return { pageErrors: errors };
}`;
const script = join(scratch, 'capture.js');
writeFileSync(script, browserCode);

try {
	await run(['open', url]);
	await run(['run-code', '--filename', script]);
	console.log(`Directory captures passed: ${output}`);
} finally {
	try { await run(['close']); } finally {
		directory.close();
		app.close();
		rmSync(scratch, { recursive: true, force: true });
	}
}
