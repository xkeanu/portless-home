import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { autoOnce, runCli } from './accounts-cli.mjs';
import { AccountError, privateWrite } from './account-store.mjs';

const fixture = (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'portless-account-cli-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, configPath: join(directory, 'accounts', 'config.json') };
};
async function invoke(argv, options = {}) {
	let stdout = '', stderr = '';
	const code = await runCli(argv, { ...options, stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } });
	return { code, stdout, stderr, data: stdout && !argv.includes('--help') && argv.length && argv[0] !== '--help' ? JSON.parse(stdout) : null };
}

test('help is layered, includes examples, and never loads account settings', async () => {
	const top = await invoke(['--help'], { configPath: '/missing/non-private/config' });
	assert.equal(top.code, 0);
	assert.match(top.stdout, /PORTLESS_ACCOUNTS/);
	assert.match(top.stdout, /Examples:/);
	for (const name of ['enable', 'disable', 'status', 'capture', 'refresh', 'switch', 'remove', 'sync', 'edit', 'policy', 'auto']) {
		const result = await invoke([name, '--help']);
		assert.equal(result.code, 0);
		assert.match(result.stdout, new RegExp(`accounts-cli.mjs ${name}`));
		assert.match(result.stdout, /Examples:/);
		assert.equal(result.stderr, '');
	}
});

test('remove previews only local metadata and requires explicit confirmation before forgetting a login', async () => {
	const local = { id: 'claude-local', provider: 'claude', label: 'Work', availableLocally: true, active: true, payload: 'fixture-private-login' };
	const snapshot = { accounts: [local, { id: 'codex-remote', provider: 'codex', availableLocally: false }], snapshotToken: 'fixture-pairing-secret' };
	const removed = { enabled: true, accounts: [] };
	const calls = [];
	const manager = {
		snapshot: async () => { calls.push(['snapshot']); return snapshot; },
		remove: async (id) => { calls.push(['remove', id]); return removed; },
	};
	const preview = await invoke(['remove', 'claude-local', '--dry-run'], { manager });
	assert.equal(preview.code, 0);
	assert.deepEqual(preview.data.account, { id: local.id, provider: local.provider, label: local.label });
	assert.equal(preview.data.dryRun, true);
	assert.match(preview.data.action, /CLI stays signed in/);
	assert.equal(preview.stdout.includes('fixture-private-login'), false);
	assert.equal(preview.stdout.includes('fixture-pairing-secret'), false);
	assert.deepEqual(calls, [['snapshot']]);
	calls.length = 0;
	const confirmed = await invoke(['remove', 'claude-local', '--yes'], { manager });
	assert.equal(confirmed.code, 0);
	assert.deepEqual(confirmed.data, removed);
	assert.deepEqual(calls, [['snapshot'], ['remove', 'claude-local']]);
	calls.length = 0;
	for (const id of ['codex-remote', 'missing-local']) {
		const rejected = await invoke(['remove', id, '--yes'], { manager });
		assert.equal(rejected.code, 2);
		assert.equal(rejected.stdout, '');
		assert.match(rejected.stderr, /No saved login.*status/);
	}
	assert.deepEqual(calls, [['snapshot'], ['snapshot']]);
});

test('enable is private and idempotent; disable preserves settings and pairing secrets', async (t) => {
	const { configPath } = fixture(t);
	const first = await invoke(['enable'], { configPath });
	assert.deepEqual(first.data, { enabled: true });
	const original = JSON.parse(readFileSync(configPath, 'utf8'));
	assert.match(original.snapshotToken, /^[a-f0-9]{64}$/);
	assert.deepEqual(original.providers, {});
	assert.deepEqual(original.peers, []);
	assert.equal(first.stdout.includes(original.snapshotToken), false);
	original.providers = { codexHome: '/fixture/codex' };
	original.peers = [{ url: 'https://fixture.example/api/accounts/metadata', token: 'fixture-pairing-secret' }];
	privateWrite(configPath, JSON.stringify(original));
	assert.equal((await invoke(['enable'], { configPath })).code, 0);
	assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), original);
	const disabled = await invoke(['disable'], { configPath });
	assert.deepEqual(disabled.data, { enabled: false });
	assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { ...original, enabled: false });
	assert.equal(disabled.stdout.includes('fixture-pairing-secret'), false);
	if (process.platform !== 'win32') assert.equal(statSync(configPath).mode & 0o077, 0);
});

test('commands forward exact typed arguments without credentials or prompts', async (t) => {
	const { directory } = fixture(t);
	const schedule = [{ days: [1, 2], start: '09:00', end: '18:00', reservePercent: 30 }];
	const path = join(directory, 'reserve.json');
	writeFileSync(path, JSON.stringify(schedule));
	const calls = [];
	const snapshot = { enabled: true, accounts: [{ id: 'fixture', label: 'Work', provider: 'claude' }] };
	const manager = Object.fromEntries(['snapshot', 'capture', 'refresh', 'switchAccount', 'synchronize', 'edit', 'policy'].map((method) => [method, async (...args) => { calls.push({ method, args }); return snapshot; }]));
	for (const argv of [
		['status'], ['capture', 'claude', '--label', 'Work'], ['capture', 'codex'], ['refresh'], ['switch', 'fixture'], ['sync'],
		['edit', 'fixture', '--label=', '--priority', '-10', '--reserve', '20', '--disabled', 'true', '--schedule', path],
		['policy', '--strategy', 'consume-first', '--threshold', '80', '--auto', 'false', '--use-first', 'none'],
	]) {
		const result = await invoke(argv, { manager });
		assert.equal(result.code, 0);
		assert.deepEqual(result.data, snapshot);
		assert.equal(result.stderr, '');
	}
	assert.deepEqual(calls, [
		{ method: 'snapshot', args: [] }, { method: 'capture', args: ['claude', 'Work'] }, { method: 'capture', args: ['codex', undefined] },
		{ method: 'refresh', args: [] }, { method: 'switchAccount', args: ['fixture'] }, { method: 'synchronize', args: [] },
		{ method: 'edit', args: [{ id: 'fixture', label: '', priority: -10, reservePercent: 20, disabled: true, reserveSchedule: schedule }] },
		{ method: 'policy', args: [{ strategy: 'consume-first', threshold: 80, auto: false, useFirst: '' }] },
	]);
});

test('invalid and incomplete commands fail before mutations with no interactive fallback', async () => {
	const manager = new Proxy({}, { get() { throw new Error('manager must not run'); } });
	for (const argv of [
		['unknown'], ['capture'], ['capture', 'desktop'], ['capture', 'claude', '--label'], ['capture', 'claude', '--label', 'x'.repeat(65)],
		['status', '--unknown'], ['switch'], ['edit', 'fixture'], ['edit', 'fixture', '--priority', '101'], ['edit', 'fixture', '--reserve', '100'],
		['remove'], ['remove', 'fixture'], ['remove', 'fixture', '--yes', '--dry-run'], ['remove', 'fixture', '--yes=true'],
		['remove', 'fixture', '--dry-run=false'], ['remove', 'fixture', '--yes', '--yes'],
		['policy'], ['policy', '--strategy', 'unknown'], ['policy', '--auto', 'yes'], ['policy', '--threshold', 'NaN'],
		['auto'], ['auto', '--once', '--interval', '60'], ['auto', '--interval', '59'], ['auto', '--once=true'],
	]) {
		const result = await invoke(argv, { manager });
		assert.equal(result.code, 2, argv.join(' '));
		assert.equal(result.stdout, '');
		assert.equal(typeof JSON.parse(result.stderr).error, 'string');
	}
	assert.match((await invoke(['capture'])).stderr, /Example: node accounts-cli.mjs capture claude/);
});

test('errors expose safe provider guidance and suppress unknown exception details', async () => {
	const manager = { snapshot: async () => { throw new Error('private-access-token=fixture-secret'); } };
	const unexpected = await invoke(['status'], { manager });
	assert.equal(unexpected.code, 1);
	assert.equal(unexpected.stdout, '');
	assert.equal(unexpected.stderr.includes('fixture-secret'), false);
	const known = await invoke(['switch', 'fixture'], { manager: { switchAccount: async () => { throw new AccountError('cli-busy', 'Stop the CLI and try again.', 409); } } });
	assert.equal(known.code, 1);
	assert.match(known.stderr, /Stop the CLI and try again/);
});

test('auto once applies idle recommendations serially, leaves busy switches pending and asks for manual relaunch', async () => {
	const pending = [{ id: 'claude-two', provider: 'claude' }, { id: 'codex-two', provider: 'codex' }];
	const calls = [];
	let inFlight = false;
	const manager = {
		refresh: async (input) => { calls.push(['refresh', input]); return { pending }; },
		switchAccount: async (id) => {
			assert.equal(inFlight, false);
			inFlight = true;
			await Promise.resolve();
			calls.push(['switch', id]);
			inFlight = false;
			if (id === 'codex-two') throw new AccountError('cli-busy', 'Codex is running.', 409);
			return { pending: [pending[1]] };
		},
	};
	const result = await invoke(['auto', '--once'], { manager });
	assert.equal(result.code, 0);
	assert.deepEqual(calls, [['refresh', { forceAuto: true }], ['switch', 'claude-two'], ['switch', 'codex-two']]);
	assert.deepEqual(result.data.switched, [pending[0]]);
	assert.deepEqual(result.data.blocked, [{ ...pending[1], error: 'Codex is running.' }]);
	assert.deepEqual(result.data.snapshot.pending, [pending[1]]);
	assert.equal(result.data.restartRequired, true);
});

test('watcher waits between finished cycles, continues through lock contention and cleans up on abort', async () => {
	const controller = new AbortController();
	let cycles = 0, waits = 0;
	const output = [];
	const manager = { refresh: async () => {
		cycles++;
		if (cycles === 1) throw new AccountError('busy', 'Another account operation is running.', 409);
		return { pending: [] };
	} };
	const code = await runCli(['auto', '--interval', '60'], {
		manager, signal: controller.signal, stdout: (value) => output.push(JSON.parse(value)),
		wait: async (milliseconds, signal) => {
			assert.equal(milliseconds, 60000);
			assert.equal(signal, controller.signal);
			waits++;
			if (waits === 2) controller.abort();
		},
	});
	assert.equal(code, 0);
	assert.equal(cycles, 2);
	assert.equal(waits, 2);
	assert.match(output[0].blocked[0].error, /Another account operation/);
	assert.deepEqual(output[1].switched, []);
});

test('abort during a refresh prevents later credential writes', async () => {
	const controller = new AbortController();
	let switches = 0;
	const result = await autoOnce({
		refresh: async () => { controller.abort(); return { pending: [{ id: 'fixture', provider: 'claude' }] }; },
		switchAccount: async () => { switches++; },
	}, { signal: controller.signal });
	assert.equal(result.stopped, true);
	assert.equal(switches, 0);
});

test('direct watcher process exits on SIGTERM without touching login stores', { timeout: 3000, skip: process.platform === 'win32' && 'Windows force-terminates child processes instead of delivering SIGTERM' }, async (t) => {
	const { directory, configPath } = fixture(t);
	copyFileSync(new URL('./accounts-cli.mjs', import.meta.url), join(directory, 'accounts-cli.mjs'));
	copyFileSync(new URL('./account-store.mjs', import.meta.url), join(directory, 'account-store.mjs'));
	writeFileSync(join(directory, 'accounts.mjs'), 'export const createAccountManager = () => ({ refresh: async () => ({ pending: [] }) });');
	const child = spawn(process.execPath, [join(directory, 'accounts-cli.mjs'), 'auto', '--interval', '60'], {
		env: { ...process.env, PORTLESS_ACCOUNTS: configPath }, stdio: ['ignore', 'pipe', 'pipe'],
	});
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
	const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
	let stderr = '';
	child.stderr.on('data', (value) => { stderr += value; });
	const ready = await Promise.race([
		new Promise((resolve) => child.stdout.once('data', (value) => resolve(JSON.parse(value)))),
		done.then(() => { throw new Error(`Watcher exited before its first cycle: ${stderr}`); }),
	]);
	assert.deepEqual(ready.switched, []);
	child.kill('SIGTERM');
	assert.deepEqual(await done, { code: 0, signal: null });
	assert.equal(stderr, '');
});
