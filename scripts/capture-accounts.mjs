// Run after npm run build. Requires the optional Playwright CLI, never a runtime dependency.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startAccountPreview, scenarios } from './account-preview.mjs';

const output = resolve(process.argv[2] || join(tmpdir(), 'portless-account-captures'));
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'portless-account-browser-'));
const preview = await startAccountPreview();
const session = `account-captures-${process.pid}`;
const command = process.env.PORTLESS_PLAYWRIGHT_CLI ? process.execPath : 'npx';
const prefix = process.env.PORTLESS_PLAYWRIGHT_CLI ? [process.env.PORTLESS_PLAYWRIGHT_CLI] : ['--yes', '--package', '@playwright/cli@0.1.22', 'playwright-cli'];

async function run(args) {
	const child = spawn(command, [...prefix, `--session=${session}`, ...args], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	child.stdout.on('data', (data) => { log += data; });
	child.stderr.on('data', (data) => { log += data; });
	const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000);
	try {
		const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
		writeFileSync(join(output, `${args[0]}.log`), log);
		if (code !== 0 || /^### Error/m.test(log)) throw new Error(`Playwright ${args[0]} failed. See ${join(output, `${args[0]}.log`)}`);
	} finally { clearTimeout(timeout); }
}

// The CLI supplies page; keeping the whole capture in one browser avoids per-state launches.
const browserCode = `async (page) => {
	const base = ${JSON.stringify(preview.url)};
	const output = ${JSON.stringify(output)};
	const scenarios = ${JSON.stringify(scenarios)};
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	const check = (condition, message) => { if (!condition) throw new Error(message); };
	const ready = () => page.waitForLoadState('networkidle');
	const manifest = [];
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 900 });
		for (const state of scenarios) {
			await page.goto(base + '/fixture?state=' + state);
			await ready();
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
			check(!overflow, state + ' overflows at ' + width);
			check(await page.locator('h1').textContent() === 'CLI accounts', 'Missing account screen');
			if (state === 'remote-only') check(await page.locator('[data-switch]').isDisabled(), 'Remote switch must be disabled');
			if (state === 'busy') check(await page.locator('[data-provider="claude"] [data-switch]').first().isDisabled(), 'Busy switch must be disabled');
			if (state === 'stale') check((await page.locator('.usage').first().textContent()).includes('Last reported'), 'Stale quota needs qualification');
			await page.screenshot({ path: output + '/' + state + '-' + width + '.png', fullPage: true });
			manifest.push({ state, width, overflow });
		}
	}
	await page.goto(base + '/fixture?state=detected');
	await ready();
	for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
	check(await page.evaluate(() => document.activeElement?.matches('[data-save-current="claude"]')), 'Tab path missed Save account');
	await page.keyboard.press('Enter');
	await page.locator('[data-provider="claude"] [data-account]').waitFor();
	check(await page.locator('[data-provider="claude"] [data-account]').count() === 1, 'First save missing');
	await page.request.get(base + '/fixture/login?provider=claude&name=work');
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await page.locator('[data-save-current="claude"]').waitFor();
	check(await page.locator('[data-provider="claude"] [data-account]').count() === 1, 'Previous saved login lost');
	// Change again after display: Save must reject the stale identity, not capture Personal.
	await page.request.get(base + '/fixture/login?provider=claude&name=personal');
	await page.locator('[data-save-current="claude"]').click();
	await page.getByRole('alert').waitFor();
	check((await page.getByRole('alert').textContent()).includes('CLI login changed'), 'Missing changed-login recovery');
	check(await page.locator('[data-provider="claude"] [data-account]').count() === 1, 'Changed identity persisted');
	await page.getByRole('button', { name: 'Reload accounts', exact: true }).click();
	await page.locator('[data-save-current="claude"]').waitFor({ state: 'detached' });
	await page.request.get(base + '/fixture/login?provider=claude&name=work');
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await page.locator('[data-save-current="claude"]').waitFor();
	await page.locator('[data-save-current="claude"]').click();
	await page.waitForFunction(() => document.querySelectorAll('[data-provider="claude"] [data-account]').length === 2);
	await page.screenshot({ path: output + '/saved-lifecycle-390.png', fullPage: true });
	await page.goto(base + '/fixture?state=populated');
	await ready();
	await page.locator('[data-provider="claude"] [data-switch]:not([disabled])').focus();
	await page.keyboard.press('Enter');
	const confirmation = page.locator('.switch-confirm');
	await confirmation.waitFor();
	check(await confirmation.getByRole('button', { name: 'Switch login', exact: true }).isDisabled(), 'Switch skipped confirmation');
	await page.screenshot({ path: output + '/switch-confirm-390.png', fullPage: true });
	await confirmation.getByRole('checkbox').focus();
	await page.keyboard.press('Space');
	await page.keyboard.press('Tab');
	check(await page.evaluate(() => document.activeElement.textContent === 'Switch login'), 'Keyboard path missed switch submit');
	await page.keyboard.press('Enter');
	await confirmation.waitFor({ state: 'detached' });
	check((await page.locator('.notice').textContent()).includes('restart your CLI'), 'Manual relaunch guidance missing');
	await page.locator('.routing > summary').focus();
	await page.keyboard.press('Enter');
	check(await page.locator('.routing').getAttribute('open') !== null, 'Keyboard disclosure failed');
	await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 900 });
		for (const state of ['detected', 'populated', 'stale']) {
			await page.goto(base + '/fixture?state=' + state);
			await ready();
			check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'Dark layout overflows');
			await page.screenshot({ path: output + '/' + state + '-dark-' + width + '.png', fullPage: true });
		}
	}
	check(errors.length === 0, errors.join('; '));
	return { captures: manifest, lifecycle: 'passed', returnEvent: 'passed', staleSave: 'passed', keyboard: 'passed', pageErrors: errors };
}`;
const script = join(scratch, 'capture.js');
writeFileSync(script, browserCode);

try {
	await run(['open', preview.url + '/accounts']);
	await run(['run-code', '--filename', script]);
	console.log(`Account captures and browser checks passed: ${output}`);
} finally {
	try { await run(['close']); } finally {
		await preview.close();
		rmSync(scratch, { recursive: true, force: true });
	}
}
