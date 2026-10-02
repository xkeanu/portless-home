import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMetadata, parseMetadata, fetchAccountPeer, mergeMetadata } from './account-sync.mjs';
import { chooseAccount } from './account-routing.mjs';

const now = '2026-10-02T12:00:00.000Z';
const row = (id, options = {}) => ({
	id, provider: 'codex', accountId: `provider-${id}`, email: `${id}@example.test`, label: id, tier: 'pro',
	active: false, availableLocally: true, disabled: false,
	priority: 1, reservePercent: 20,
	usageStatus: 'fresh', observedAt: '2026-10-02T11:59:00.000Z',
	windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: '2026-10-09T12:00:00.000Z', windowMinutes: 10080 }],
	...options,
});
const peer = { url: 'https://device.example.test/api/accounts/metadata', token: 'local-test-bearer' };
const response = (snapshot, options) => new Response(JSON.stringify(snapshot), { status: 200, ...options });

test('metadata contains only allowed fields, including safe nested window and schedule shapes', () => {
	const input = row('one', {
		accessToken: 'secret-a', refreshToken: 'secret-b', credentials: { password: 'secret-c' },
		authPath: '/Users/someone/.codex/auth.json', token: 'secret-d', __proto__: { inherited: 'secret-e' },
		reserveSchedule: [{ days: [1], start: '09:00', end: '17:00', reservePercent: 30, secret: 'secret-f' }],
		windows: [{ ...row('one').windows[0], model: 'gpt-test', token: 'secret-g' }],
	});
	const snapshot = sanitizeMetadata([input]);
	assert.equal(snapshot.schemaVersion, 1);
	assert.equal(snapshot.accounts.length, 1);
	assert.equal(snapshot.accounts[0].windows[0].model, 'gpt-test');
	const serialized = JSON.stringify(snapshot);
	assert.doesNotMatch(serialized, /secret-|credentials|authPath|\/Users\//);
	assert.deepEqual(snapshot.accounts[0].reserveSchedule[0], { days: [1], start: '09:00', end: '17:00', reservePercent: 30 });
	assert.equal(input.accessToken, 'secret-a');
});

test('metadata rejects unknown schema, oversized snapshots, and invalid account policies', () => {
	assert.equal(parseMetadata('not json'), null);
	assert.equal(parseMetadata({ schemaVersion: 2, accounts: [] }), null);
	assert.equal(parseMetadata({ schemaVersion: 1, accounts: Array(101).fill(row('one')) }), null);
	assert.equal(parseMetadata(' '.repeat(256 * 1024 + 1)), null);
	assert.equal(sanitizeMetadata(Array.from({ length: 120 }, (_, id) => row(String(id)))).accounts.length, 100);
	assert.deepEqual(sanitizeMetadata([row('bad', { reservePercent: 100 }), row('bad-schedule', { reserveSchedule: [{ days: [10], start: '10:00', end: '11:00', reservePercent: 20 }] })]).accounts, []);
	assert.equal(sanitizeMetadata([row('duplicate'), row('other', { accountId: 'provider-duplicate' })]).accounts.length, 1);
	assert.equal(sanitizeMetadata([row('malformed-disabled', { disabled: 'false' })]).accounts.length, 0);
	for (const overrides of [{ id: 'x'.repeat(65) }, { accountId: 'x'.repeat(257) }, { priority: 101 }, { reservePercent: 1.5 }, { reserveSchedule: Array(21).fill({ days: [1], start: '09:00', end: '17:00', reservePercent: 20 }) }]) {
		assert.equal(sanitizeMetadata([row('invalid-bound', overrides)]).accounts.length, 0);
	}
	const rich = Array.from({ length: 100 }, (_, id) => row(String(id), {
		windows: Array.from({ length: 16 }, (_, key) => ({ ...row('one').windows[0], key: String(key), models: Array(16).fill('model-'.repeat(20)) })),
	}));
	const bounded = sanitizeMetadata(rich);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 256 * 1024);
	assert.ok(parseMetadata(JSON.stringify(bounded)));
});

test('malformed or incomplete limits are unavailable rather than partially trusted', () => {
	for (const windows of [[{ ...row('one').windows[0], usedPercent: '10' }], Array(17).fill(row('one').windows[0]), [row('one').windows[0], row('one').windows[0]]]) {
		const result = sanitizeMetadata([row('one', { windows })]).accounts[0];
		assert.equal(result.usageStatus, 'unavailable');
		assert.deepEqual(result.windows, []);
	}
	assert.equal(sanitizeMetadata([row('missing-observation', { observedAt: null })]).accounts[0].usageStatus, 'unavailable');
	assert.equal(sanitizeMetadata([row('not-iso', { observedAt: '2026-10-02' })]).accounts[0].usageStatus, 'unavailable');
	assert.equal(sanitizeMetadata([row('long-label', { label: 'x'.repeat(129) })]).accounts[0].label, 'long-label');
});

test('authenticated fetch uses exact endpoint, rejects redirects, and strips peer credential fields', async () => {
	let request;
	const result = await fetchAccountPeer(peer, async (url, options) => {
		request = { url: url.href, ...options };
		return response({ schemaVersion: 1, accounts: [row('one', { token: 'peer-secret' })], token: 'snapshot-secret' });
	});
	assert.equal(request.url, peer.url);
	assert.equal(request.headers.authorization, `Bearer ${peer.token}`);
	assert.equal(request.redirect, 'error');
	assert.equal(result.accounts.length, 1);
	assert.doesNotMatch(JSON.stringify(result), /peer-secret|snapshot-secret|local-test-bearer/);
	assert.equal(await fetchAccountPeer(peer, async () => new Response('', { status: 302, headers: { location: 'https://another.example.test' } })), null);
	assert.equal(await fetchAccountPeer(peer, async () => ({ ok: true, redirected: true })), null);
});

test('insecure nonloopback URLs, userinfo, invalid tokens, and failed responses do not fetch', async () => {
	let calls = 0;
	const fetch = async () => { calls++; return response(sanitizeMetadata([])); };
	for (const url of ['http://device.example.test/api/accounts/metadata', 'ftp://127.0.0.1/meta', 'https://user:password@device.example.test/meta', 'https://device.example.test/meta#fragment', 'bad url']) {
		assert.equal(await fetchAccountPeer({ ...peer, url }, fetch), null);
	}
	assert.equal(await fetchAccountPeer({ ...peer, token: 'bad\nheader' }, fetch), null);
	assert.equal(await fetchAccountPeer(null, fetch), null);
	assert.equal(calls, 0);
	for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.ok(await fetchAccountPeer({ ...peer, url: `http://${host}:12345/meta` }, fetch));
	assert.equal(await fetchAccountPeer(peer, async () => new Response('', { status: 403 })), null);
	assert.equal(await fetchAccountPeer(peer, async () => { throw new Error('unreachable'); }), null);
});

test('response byte cap applies to both headers and streamed bytes', async () => {
	assert.equal(await fetchAccountPeer(peer, async () => new Response('{}', { headers: { 'content-length': String(256 * 1024 + 1) } })), null);
	assert.equal(await fetchAccountPeer(peer, async () => new Response('x'.repeat(256 * 1024 + 1))), null);
	assert.equal(await fetchAccountPeer(peer, async () => new Response('not JSON')), null);
});

test('deadline bounds connection and response body even when a mock ignores abort', async () => {
	const start = Date.now();
	assert.equal(await fetchAccountPeer(peer, () => new Promise(() => {}), 10), null);
	let cancelled = false;
	const stream = new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => { cancelled = true; } });
	assert.equal(await fetchAccountPeer(peer, async () => new Response(stream), 10), null);
	assert.equal(cancelled, true);
	assert.ok(Date.now() - start < 1000);
});

test('merge takes newer fresh usage while preserving local ownership and routing policy', () => {
	const local = row('local', { active: true, priority: 10, reservePercent: 60, disabled: true });
	const remote = row('different-row-id', {
		accountId: local.accountId, observedAt: '2026-10-02T11:59:30.000Z',
		active: false, priority: 99, reservePercent: 0, disabled: false,
		windows: [{ ...local.windows[0], usedPercent: 70 }], token: 'never-copy',
	});
	const merged = mergeMetadata([local], [remote]);
	assert.equal(merged.length, 1);
	assert.deepEqual({ id: merged[0].id, active: merged[0].active, availableLocally: merged[0].availableLocally, priority: merged[0].priority, reservePercent: merged[0].reservePercent, disabled: merged[0].disabled }, { id: 'local', active: true, availableLocally: true, priority: 10, reservePercent: 60, disabled: true });
	assert.equal(merged[0].windows[0].usedPercent, 70);
	assert.equal(local.windows[0].usedPercent, 10);
	assert.doesNotMatch(JSON.stringify(merged), /never-copy/);
	assert.equal(mergeMetadata([local], [{ ...remote, usageStatus: 'stale' }])[0].windows[0].usedPercent, 10);
	assert.equal(mergeMetadata([local], [{ ...remote, observedAt: '2026-10-02T11:58:30.000Z' }])[0].windows[0].usedPercent, 10);
});

test('remote-only accounts cannot route locally, and conflicting row IDs do not overwrite identities', () => {
	const local = row('shared-id', { active: true });
	const remote = row('shared-id', { accountId: 'another-provider-account', active: true });
	const merged = mergeMetadata([local], [remote]);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].accountId, local.accountId);
	assert.notEqual(merged[1].id, local.id);
	assert.equal(merged[1].active, false);
	assert.equal(merged[1].availableLocally, false);
	assert.equal(chooseAccount([merged[1]], { provider: 'codex', now }).accountId, null);
});

test('malformed local policy stays ineligible after merging remote metadata', () => {
	const local = row('local', { reservePercent: '60' });
	const remote = row('remote', { accountId: local.accountId, observedAt: '2026-10-02T11:59:30.000Z' });
	const merged = mergeMetadata([local], [remote]);
	assert.equal(merged[0].disabled, true);
	assert.equal(chooseAccount(merged, { provider: 'codex', now }).accountId, null);
});

test('newer peer preferences sync independently of usage while local activity and ownership stay local', () => {
	const local = row('local', { active: true, priority: 1, reservePercent: 20, preferencesUpdatedAt: '2026-10-02T11:00:00.000Z' });
	const remote = row('remote', {
		accountId: local.accountId, active: false, availableLocally: false, label: 'Work account', disabled: true,
		priority: 2, reservePercent: 50, reserveSchedule: [{ days: [1], start: '09:00', end: '17:00', reservePercent: 60 }],
		preferencesUpdatedAt: '2026-10-02T11:30:00.000Z', observedAt: '2026-10-02T10:00:00.000Z', usageStatus: 'stale',
	});
	const merged = mergeMetadata([local], [remote], { now })[0];
	assert.equal(merged.id, local.id);
	assert.equal(merged.active, true);
	assert.equal(merged.availableLocally, true);
	assert.equal(merged.label, 'Work account');
	assert.equal(merged.disabled, true);
	assert.equal(merged.priority, 2);
	assert.equal(merged.reservePercent, 50);
	assert.equal(merged.reserveSchedule[0].reservePercent, 60);
	assert.equal(merged.observedAt, local.observedAt);
	assert.equal(mergeMetadata([local], [{ ...remote, preferencesUpdatedAt: '2026-10-02T10:00:00.000Z' }], { now })[0].label, local.label);
	const cleared = mergeMetadata([local], [{ ...remote, priority: undefined, reservePercent: undefined, reserveSchedule: undefined }], { now })[0];
	assert.equal(Object.hasOwn(cleared, 'reservePercent'), false);
});

test('impossible future timestamps cannot poison preference or usage reconciliation', () => {
	const local = row('local', { preferencesUpdatedAt: '2026-10-02T11:00:00.000Z' });
	const remote = row('remote', { accountId: local.accountId, label: 'Do not import', preferencesUpdatedAt: '2099-10-02T12:00:00.000Z', observedAt: '2099-10-02T12:00:00.000Z' });
	const merged = mergeMetadata([local], [remote], { now })[0];
	assert.equal(merged.label, local.label);
	assert.equal(merged.observedAt, local.observedAt);
	const remoteOnly = mergeMetadata([], [remote], { now })[0];
	assert.equal(remoteOnly.preferencesUpdatedAt, null);
	assert.equal(remoteOnly.observedAt, null);
	assert.equal(remoteOnly.usageStatus, 'unavailable');
});

test('optional global policy is validated and copied through the snapshot allowlist', () => {
	const policy = { strategy: 'consume-first', threshold: 85, auto: true, useFirst: 'one', token: 'never-copy' };
	const snapshot = sanitizeMetadata([row('one')], { policy, policyUpdatedAt: now });
	assert.deepEqual(snapshot.policy, { strategy: 'consume-first', threshold: 85, auto: true, useFirst: 'one' });
	assert.equal(snapshot.policyUpdatedAt, now);
	assert.deepEqual(parseMetadata(JSON.stringify(snapshot)), snapshot);
	assert.equal(Object.hasOwn(sanitizeMetadata([], { policy: { ...policy, auto: 'yes' }, policyUpdatedAt: now }), 'policy'), false);
	assert.equal(Object.hasOwn(sanitizeMetadata([], { policy, policyUpdatedAt: 'bad' }), 'policy'), false);
	assert.equal(sanitizeMetadata([], { policy: { ...policy, threshold: 100 }, policyUpdatedAt: now }).policy.threshold, 100);
});
