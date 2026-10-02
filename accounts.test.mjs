import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountManager, accountId } from './accounts.mjs';
import { accountVault, privateWrite } from './account-store.mjs';

const date = new Date('2026-10-02T12:00:00Z');
class ProviderError extends Error { constructor(code, message) { super(message); this.code = code; } }
const login = (name, provider = 'claude', token = `fixture-secret-${name}`) => ({ identity: { provider, accountId: `${name}:workspace`, email: `${name}@example.test`, tier: 'pro' }, payload: { token } });
const windows = [{ key: 'five_hour', label: 'Five hours', usedPercent: 20, resetsAt: '2026-10-02T15:00:00Z', windowMinutes: 300 }, { key: 'seven_day', label: 'Weekly', usedPercent: 40, resetsAt: '2026-10-05T12:00:00Z', windowMinutes: 10080 }];
const fixture = (t, options = {}) => {
	const dir = mkdtempSync(join(tmpdir(), 'accounts-manager-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = join(dir, 'config.json');
	privateWrite(configPath, JSON.stringify({ enabled: true, ...options.config }));
	let current = login('alice');
	let busy = { claude: false, codex: false };
	const activations = [];
	const usageCalls = [];
	const adapter = {
		async capture() { if (!current) throw new ProviderError('LOGIN_REQUIRED', 'Log in to this CLI first.'); return current; },
		async activate(payload) { activations.push(payload); },
		async usage(payload, settings) { usageCalls.push({ payload, settings }); return { payload, windows, observedAt: date.toISOString() }; },
	};
	const codex = { ...adapter, async capture() { throw new ProviderError('LOGIN_REQUIRED', 'Log in to Codex first.'); } };
	const manager = createAccountManager({ configPath, providersFactory: () => ({ claude: adapter, codex }), inspectProcesses: () => busy, clock: () => date, ...options.manager });
	return { manager, adapter, activations, usageCalls, vault: accountVault(`${configPath}.vault`), configPath, setCurrent(value) { current = value; }, setBusy(value) { busy = value; } };
};

test('disabled module does not inspect credentials, processes or peers', async (t) => {
	const f = fixture(t, { config: { enabled: false }, manager: { providersFactory() { throw new Error('unexpected credential read'); }, inspectProcesses() { throw new Error('unexpected process read'); } } });
	assert.equal((await f.manager.snapshot()).enabled, false);
	await assert.rejects(f.manager.capture('claude'), { code: 'disabled' });
});

test('capture identities distinguish users within one workspace and public views exclude opaque credentials', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude', 'Personal');
	f.setCurrent(login('bob'));
	const view = await f.manager.capture('claude', 'Work');
	assert.equal(view.accounts.length, 2);
	assert.notEqual(view.accounts[0].id, view.accounts[1].id);
	assert.equal(view.accounts.filter((row) => row.active).length, 1);
	assert.equal(JSON.stringify(view).includes('fixture-secret'), false);
	assert.equal(JSON.stringify(await f.manager.metadata()).includes('fixture-secret'), false);
	assert.equal(f.vault.read().accounts[0].payload.token, 'fixture-secret-alice');
});

test('active login never rotates in usage checks, even idle; inactive saved login can renew', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude');
	f.setCurrent(login('bob'));
	await f.manager.capture('claude');
	await f.manager.refresh();
	assert.deepEqual(f.usageCalls.map((call) => call.settings.allowRefresh), [true, false]);
	f.setBusy({ claude: true, codex: false });
	f.usageCalls.length = 0;
	await f.manager.refresh();
	assert.deepEqual(f.usageCalls.map((call) => call.settings.allowRefresh), [true, false]);
	assert.equal(f.activations.length, 0);
});

test('unreadable active identity prevents renewal rather than guessing', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude');
	f.adapter.capture = async () => { throw new ProviderError('UNSUPPORTED_STORE', 'This store cannot be read.'); };
	await f.manager.refresh();
	assert.equal(f.usageCalls[0].settings.allowRefresh, false);
});

test('renewal checkpoint survives a later quota failure and does not leak credentials', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude');
	f.setCurrent(login('bob'));
	f.adapter.usage = async (_payload, { onUpdate }) => {
		const next = login('alice', 'claude', 'fixture-secret-renewed');
		await onUpdate(next.payload, next.identity);
		assert.equal(f.vault.read().accounts[0].payload.token, 'fixture-secret-renewed');
		throw new ProviderError('USAGE_UNAVAILABLE', 'Usage is unavailable. Try again later.');
	};
	const view = await f.manager.refresh();
	assert.equal(f.vault.read().accounts[0].payload.token, 'fixture-secret-renewed');
	assert.equal(view.accounts[0].usageStatus, 'unavailable');
	assert.equal(JSON.stringify(view).includes('fixture-secret'), false);
});

test('usage refresh bounds concurrent providers, skips disabled accounts and continues after failures', { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const logins = Array.from({ length: 12 }, (_, i) => login(`user${i}`, 'codex'));
	await f.vault.update((state) => {
		state.accounts = logins.map(({ identity, payload }, i) => ({ ...identity, id: accountId('codex', identity.accountId), label: `Account ${i}`, payload, disabled: i === 11 }));
	});
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	t.after(() => release());
	let started;
	const firstBatch = new Promise((resolve) => { started = resolve; });
	let concurrent = 0;
	let maximum = 0;
	const checked = [];
	f.adapter.usage = async (payload, { onUpdate }) => {
		concurrent += 1;
		maximum = Math.max(maximum, concurrent);
		const index = logins.findIndex((entry) => entry.payload.token === payload.token);
		checked.push(index);
		try {
			if (index === 0) {
				await onUpdate({ token: 'renewed-user0' }, logins[0].identity);
				assert.equal(f.vault.read().accounts[0].payload.token, 'renewed-user0');
			}
			if (checked.length === 3) started();
			await gate;
			if (index === 4) throw new ProviderError('USAGE_UNAVAILABLE', 'Usage is unavailable.');
			return { windows, observedAt: date.toISOString() };
		} finally { concurrent -= 1; }
	};
	const manager = createAccountManager({ configPath: f.configPath, providersFactory: () => ({ claude: f.adapter, codex: { ...f.adapter, async capture() { throw new ProviderError('LOGIN_REQUIRED', 'Log in first.'); } } }), inspectProcesses: () => ({ claude: false, codex: false }), clock: () => date });
	const refreshing = manager.refresh({ syncPeers: false });
	await firstBatch;
	assert.equal(concurrent, 3);
	assert.equal(checked.length, 3);
	release();
	const view = await refreshing;
	assert.equal(maximum, 3);
	assert.deepEqual(checked.toSorted((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i));
	assert.equal(view.accounts[4].usageStatus, 'unavailable');
	assert.equal(view.accounts.filter((row) => row.usageStatus === 'fresh').length, 10);
	assert.equal(f.vault.read().accounts[0].payload.token, 'renewed-user0');
});

test('failure fallback persists verified renewed credentials but rejects a different identity', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude');
	f.setCurrent(login('bob'));
	f.adapter.usage = async () => { const error = new ProviderError('USAGE_UNAVAILABLE', 'Usage is unavailable.'); Object.assign(error, { updatedPayload: { token: 'renewed' }, identity: login('alice').identity }); throw error; };
	await f.manager.refresh();
	assert.equal(f.vault.read().accounts[0].payload.token, 'renewed');
	f.adapter.usage = async () => { const error = new ProviderError('USAGE_UNAVAILABLE', 'Usage is unavailable.'); Object.assign(error, { updatedPayload: { token: 'wrong-account' }, identity: login('charlie').identity }); throw error; };
	await f.manager.refresh();
	assert.equal(f.vault.read().accounts[0].payload.token, 'renewed');
});

test('switch refuses busy sessions and rechecks after awaiting departing capture', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude');
	const id = accountId('claude', 'alice:workspace');
	f.setBusy({ claude: true, codex: false });
	await assert.rejects(f.manager.switchAccount(id), { code: 'cli-busy' });
	f.setBusy({ claude: false, codex: false });
	f.adapter.capture = async () => { f.setBusy({ claude: true, codex: false }); return login('bob'); };
	await assert.rejects(f.manager.switchAccount(id), { code: 'cli-busy' });
	assert.equal(f.activations.length, 0);
	assert.equal(f.vault.read().accounts.some((row) => row.accountId === 'bob:workspace'), true);
});

test('switch saves refreshed departing login before native writes and allows restore after logout', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude');
	f.setCurrent(login('bob', 'claude', 'fresh-departing-secret'));
	f.adapter.activate = async () => {
		assert.equal(f.vault.read().accounts.find((row) => row.accountId === 'bob:workspace').payload.token, 'fresh-departing-secret');
		throw new ProviderError('WRITE_FAILED', 'The CLI login was not changed.');
	};
	await assert.rejects(f.manager.switchAccount(accountId('claude', 'alice:workspace')), { code: 'WRITE_FAILED' });
	f.setCurrent(null);
	f.adapter.activate = async (payload) => { f.activations.push(payload); };
	const result = await f.manager.switchAccount(accountId('claude', 'alice:workspace'));
	assert.equal(f.activations[0].token, 'fixture-secret-alice');
	assert.deepEqual(result.switch, { id: accountId('claude', 'alice:workspace'), provider: 'claude', appliedTo: 'cli-login', restartRequired: true });
});

test('metadata sync maps remote use-first identity and never grants local credentials', async (t) => {
	const remote = { schemaVersion: 1, accounts: [{ id: 'remote-alias', ...login('alice').identity, label: 'Synced label', preferencesUpdatedAt: '2026-10-02T12:01:00Z', priority: 3, reservePercent: 10 }, { id: 'remote-only', ...login('bob').identity, label: 'Other device', preferencesUpdatedAt: date.toISOString() }], policy: { strategy: 'consume-first', threshold: 95, auto: false, useFirst: 'remote-alias' }, policyUpdatedAt: '2026-10-02T12:01:00Z' };
	const f = fixture(t, { config: { peers: [{ url: 'https://peer.example.test/api/accounts/metadata', token: 'fixture-pairing-token' }] }, manager: { fetchImpl: async () => new Response(JSON.stringify(remote), { headers: { 'content-type': 'application/json' } }) } });
	await f.manager.capture('claude');
	await f.manager.edit({ id: accountId('claude', 'alice:workspace'), reserveSchedule: [{ days: [5], start: '12:00', end: '15:00', reservePercent: 50 }] });
	const view = await f.manager.synchronize();
	assert.equal(view.accounts.find((row) => row.accountId === 'alice:workspace').label, 'Synced label');
	assert.equal(view.policy.useFirst, accountId('claude', 'alice:workspace'));
	assert.equal(f.vault.read().accounts[0].reserveSchedule, undefined);
	assert.equal(view.accounts.find((row) => row.accountId === 'bob:workspace').availableLocally, false);
	await assert.rejects(f.manager.switchAccount('remote-only'), { code: 'missing' });
	assert.equal(f.vault.read().accounts.length, 1);
});

test('invalid preferences preserve the previous state; automatic policy only proposes', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude');
	const id = accountId('claude', 'alice:workspace');
	await assert.rejects(f.manager.edit({ id, label: 'should roll back', priority: 101 }), { code: 'input' });
	assert.notEqual(f.vault.read().accounts[0].label, 'should roll back');
	await f.manager.policy({ auto: true });
	f.setCurrent(login('bob'));
	await f.manager.refresh();
	assert.equal(f.vault.read().pending[0].id, id);
	assert.equal(f.activations.length, 0);
});

test('forgetting a saved login removes its backup and routing references without changing native login or remote metadata', async (t) => {
	const f = fixture(t);
	await f.manager.capture('claude', 'Personal');
	f.setCurrent(login('bob'));
	await f.manager.capture('claude', 'Work');
	const alice = accountId('claude', 'alice:workspace');
	const bob = accountId('claude', 'bob:workspace');
	await f.manager.policy({ useFirst: alice });
	await f.vault.update((state) => {
		state.pending = [{ id: alice, provider: 'claude' }, { id: bob, provider: 'claude' }];
		state.remote = [{ accounts: [{ ...login('alice').identity, id: alice, label: 'Other device', preferencesUpdatedAt: date.toISOString() }] }];
	});
	const view = await f.manager.remove(alice);
	const state = f.vault.read();
	assert.deepEqual(state.accounts.map((row) => row.id), [bob]);
	assert.equal(state.accounts[0].payload.token, 'fixture-secret-bob');
	assert.equal(JSON.stringify(state).includes('fixture-secret-alice'), false);
	assert.deepEqual(state.pending, [{ id: bob, provider: 'claude' }]);
	assert.equal(state.policy.useFirst, undefined);
	assert.equal(state.policyUpdatedAt, date.toISOString());
	assert.equal(view.accounts.find((row) => row.id === alice).availableLocally, false);
	assert.equal(view.accounts.find((row) => row.id === bob).active, true);
	assert.equal(f.activations.length, 0);
});
