import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAccount } from './account-routing.mjs';

const now = '2026-10-02T12:00:00.000Z';
const window = (key, usedPercent, options = {}) => ({
	key, label: key, usedPercent,
	resetsAt: '2026-10-03T12:00:00.000Z',
	windowMinutes: key === 'weekly' ? 10080 : 300, ...options,
});
const account = (id, options = {}) => ({
	id, provider: 'claude', accountId: `provider-${id}`, label: id, tier: 'pro',
	availableLocally: true, disabled: false, active: false,
	usageStatus: 'fresh', observedAt: '2026-10-02T11:59:30.000Z',
	windows: [window('five-hour', 20), window('weekly', 30)], ...options,
});
const choose = (accounts, options = {}) => chooseAccount(accounts, { provider: 'claude', now, ...options });

test('routing excludes either exhausted quota and selects a viable account', () => {
	const rows = [
		account('five-hour-full', { windows: [window('five-hour', 100), window('weekly', 1)] }),
		account('weekly-full', { windows: [window('five-hour', 1), window('weekly', 100)] }),
		account('usable', { windows: [window('five-hour', 70), window('weekly', 85)] }),
	];
	const result = choose(rows);
	assert.equal(result.accountId, 'usable');
	assert.deepEqual(result.blocked.map((row) => row.id), ['five-hour-full', 'weekly-full']);
	assert.equal(choose(rows.slice(0, 2), { useFirst: 'weekly-full' }).accountId, null);
});

test('unavailable credentials and stale, missing, malformed, or reset-passed usage cannot route', () => {
	const rows = [
		account('remote', { availableLocally: false }),
		account('disabled', { disabled: true }),
		account('stale', { usageStatus: 'stale' }),
		account('old', { observedAt: '2026-10-02T11:00:00.000Z' }),
		account('future', { observedAt: '2026-10-03T12:00:00.000Z' }),
		account('no-limits', { windows: [] }),
		account('malformed', { windows: [window('weekly', -1)] }),
		account('reset', { windows: [window('weekly', 80, { resetsAt: '2026-10-02T11:59:59.000Z' })] }),
	];
	const result = choose(rows);
	assert.equal(result.accountId, null);
	assert.equal(result.blocked.length, rows.length);
	assert.match(result.blocked.find((row) => row.id === 'reset').reason, /refresh usage/i);
	assert.equal(choose([account('refreshed', { windows: [window('weekly', 5)] })]).accountId, 'refreshed');
});

test('explicit priority and subscription preference never create guessed capacity', () => {
	const low = account('low', { tier: 'pro', priority: 10, windows: [window('weekly', 50)] });
	const high = account('high', { tier: 'max', windows: [window('weekly', 20)] });
	assert.equal(choose([high, low]).accountId, 'low');
	assert.equal(choose([{ ...low, priority: 0 }, high]).accountId, 'high');
	assert.equal(choose([account('unknown', { tier: 'unlimited', windows: [window('weekly', 100)] }), low]).accountId, 'low');
	assert.equal(choose([account('codex', { provider: 'codex' })]).accountId, null);
});

test('consume-first selects earliest measured weekly reset only among viable accounts', () => {
	const rows = [
		account('later', { windows: [window('weekly', 10, { resetsAt: '2026-10-08T12:00:00.000Z' })] }),
		account('short-reset', { windows: [window('five-hour', 1, { resetsAt: '2026-10-02T12:10:00.000Z' })] }),
		account('sooner', { windows: [window('weekly', 80, { resetsAt: '2026-10-02T13:00:00.000Z' })] }),
		account('exhausted-soonest', { windows: [window('weekly', 100, { resetsAt: '2026-10-02T12:01:00.000Z' })] }),
	];
	assert.equal(choose(rows, { strategy: 'consume-first' }).accountId, 'sooner');
});

test('best keeps active account through small fluctuations and switches for material improvement', () => {
	const active = account('active', { active: true, windows: [window('weekly', 50)] });
	assert.equal(choose([active, account('small', { windows: [window('weekly', 45)] })]).accountId, 'active');
	assert.equal(choose([active, account('large', { windows: [window('weekly', 35)] })]).accountId, 'large');
	assert.equal(choose([active, account('preferred', { priority: 1 })]).accountId, 'preferred');
	assert.equal(choose([{ ...active, windows: [window('weekly', 100)] }, account('other')]).accountId, 'other');
});

test('reserves and warning thresholds need an explicit viable use-first fallback', () => {
	const reserved = account('reserved', { reservePercent: 50, windows: [window('weekly', 55)] });
	const warning = account('warning', { windows: [window('weekly', 95)] });
	assert.equal(choose([reserved, warning]).accountId, null);
	const fallback = choose([reserved, warning], { useFirst: 'reserved' });
	assert.equal(fallback.accountId, 'reserved');
	assert.equal(fallback.warnings.length, 1);
	assert.equal(choose([reserved, account('green')], { useFirst: 'reserved' }).accountId, 'green');
	assert.equal(choose([reserved], { useFirst: 'absent' }).accountId, null);
});

test('UTC weekday reserves cover daytime, overnight, and full-day boundaries', () => {
	const rows = [account('scheduled', {
		windows: [window('weekly', 60, { resetsAt: '2026-10-09T12:00:00.000Z' })],
		reserveSchedule: [{ days: [5], start: '22:00', end: '06:00', reservePercent: 50 }],
	})];
	const at = (date) => choose(rows.map((row) => ({ ...row, observedAt: date })), { now: date });
	assert.equal(at('2026-10-02T21:59:00.000Z').accountId, 'scheduled');
	assert.equal(at('2026-10-02T22:00:00.000Z').accountId, null);
	assert.equal(at('2026-10-03T05:59:00.000Z').accountId, null);
	assert.equal(at('2026-10-03T06:00:00.000Z').accountId, 'scheduled');
	const day = account('day', { windows: [window('weekly', 60)], reserveSchedule: [{ days: [5], start: '09:00', end: '09:00', reservePercent: 50 }] });
	assert.equal(choose([day]).accountId, null);
	assert.equal(choose([{ ...day, reserveSchedule: [{ days: [5], start: '10:00', end: '11:00', reservePercent: 50 }] }]).accountId, 'day');
});

test('model-specific limits apply only to that model, and unspecified models are conservative', () => {
	const row = account('models', {
		windows: [window('weekly', 10), window('sonnet-weekly', 100, { model: 'sonnet' })],
	});
	assert.equal(choose([row], { model: 'opus' }).accountId, 'models');
	assert.equal(choose([row], { model: 'sonnet' }).accountId, null);
	assert.equal(choose([row], { model: 'claude-sonnet-4-5' }).accountId, null);
	assert.equal(choose([row], { model: 'unrecognized-model' }).accountId, null);
	assert.equal(choose([row]).accountId, null);
	assert.equal(choose([account('unknown-scope', { windows: [window('sonnet', 1, { models: ['sonnet'] })] })], { model: 'opus' }).accountId, null);
	assert.equal(choose([account('malformed-scope', { windows: [window('weekly', 1, { models: [] })] })], { model: 'opus' }).accountId, null);
});

test('ties are deterministic and invalid policies or duplicate identities fail closed', () => {
	const rows = [account('z'), account('a')];
	assert.equal(choose(rows).accountId, 'a');
	assert.equal(choose([...rows].reverse()).accountId, 'a');
	assert.equal(choose([account('bad', { reservePercent: '20' })]).accountId, null);
	assert.equal(choose([account('bad', { reserveSchedule: [{ days: [8], start: '09:00', end: '10:00', reservePercent: 20 }] })]).accountId, null);
	assert.equal(choose([account('same'), account('same')]).accountId, null);
	assert.equal(choose(rows, { threshold: 101 }).accountId, null);
	assert.equal(choose([account('missing', { accountId: undefined })]).accountId, null);
	assert.equal(choose([account('too-long', { id: 'x'.repeat(65) })]).accountId, null);
	assert.equal(choose([account('bad-priority', { priority: 101 })]).accountId, null);
});

test('threshold 100 disables soft percentage switching without allowing exhausted quotas', () => {
	assert.equal(choose([account('near-limit', { windows: [window('weekly', 99)] })], { threshold: 100 }).accountId, 'near-limit');
	assert.equal(choose([account('exhausted', { windows: [window('weekly', 100)] })], { threshold: 100, useFirst: 'exhausted' }).accountId, null);
});
