import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountVault, privateRead, readAccountSettings } from './account-store.mjs';

const fixture = (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'portless-account-store-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, vault: accountVault(directory) };
};

test('vault encrypts credentials, persists updates and restricts file access', async (t) => {
	const { directory, vault } = fixture(t);
	await vault.update((state) => state.accounts.push({ id: 'claude-one', payload: { token: 'fixture-secret' } }));
	assert.equal(accountVault(directory).read().accounts[0].payload.token, 'fixture-secret');
	assert.ok(!readFileSync(join(directory, 'vault.json'), 'utf8').includes('fixture-secret'));
	if (process.platform !== 'win32') for (const file of ['key', 'vault.json']) assert.equal(statSync(join(directory, file)).mode & 0o077, 0);
});

test('authenticated vault rejects corruption without overwriting evidence', async (t) => {
	const { directory, vault } = fixture(t);
	await vault.update((state) => state.accounts.push({ id: 'one' }));
	const path = join(directory, 'vault.json');
	const data = JSON.parse(readFileSync(path, 'utf8'));
	data.data = Buffer.from('tampered fixture').toString('base64');
	writeFileSync(path, JSON.stringify(data));
	const evidence = readFileSync(path);
	await assert.rejects(vault.update(() => {}), { code: 'vault-integrity' });
	assert.deepEqual(readFileSync(path), evidence);
});

test('failed mutation preserves prior credentials and releases its lock', async (t) => {
	const { vault } = fixture(t);
	await vault.update((state) => state.accounts.push({ id: 'first' }));
	await assert.rejects(vault.update((state) => { state.accounts = []; throw new Error('fixture failure'); }));
	assert.equal(vault.read().accounts[0].id, 'first');
	await vault.update((state) => state.accounts.push({ id: 'second' }));
	assert.equal(vault.read().accounts.length, 2);
});

test('concurrent writers cannot overwrite a credential transaction', async (t) => {
	const { directory, vault } = fixture(t);
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const first = vault.update(async (state) => { await gate; state.accounts.push({ id: 'first' }); });
	await assert.rejects(accountVault(directory).update((state) => state.accounts.push({ id: 'second' })), { code: 'busy' });
	release();
	await first;
	assert.deepEqual(vault.read().accounts.map((a) => a.id), ['first']);
});

test('oversized writes preserve the existing readable vault and release its lock', async (t) => {
	const { vault } = fixture(t);
	await vault.update((state) => state.accounts.push({ id: 'first', payload: 'small' }));
	await assert.rejects(vault.update((state) => state.accounts.push({ id: 'oversized', payload: 'x'.repeat(7 * 1024 * 1024) })), { code: 'vault-size' });
	assert.deepEqual(vault.read().accounts, [{ id: 'first', payload: 'small' }]);
	await vault.update((state) => state.accounts.push({ id: 'next' }));
	assert.equal(vault.read().accounts.length, 2);
});

test('settings reject unsafe permissions and malformed content', (t) => {
	const { directory } = fixture(t);
	const path = join(directory, 'config.json');
	assert.deepEqual(readAccountSettings(path), { enabled: false });
	writeFileSync(path, '{', { mode: 0o600 });
	assert.throws(() => readAccountSettings(path), { code: 'settings' });
	writeFileSync(path, '{"enabled":true}');
	assert.equal(readAccountSettings(path).enabled, true);
	if (process.platform !== 'win32') {
		chmodSync(path, 0o644);
		assert.throws(() => privateRead(path), { code: 'private-file' });
	}
});
