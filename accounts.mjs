import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { AccountError, accountVault, readAccountSettings } from './account-store.mjs';
import { runningClis } from './account-processes.mjs';

export const accountId = (provider, identity) => `${provider}-${createHash('sha256').update(`${provider}\0${identity}`).digest('hex').slice(0, 24)}`;
const providerIds = ['claude', 'codex'];
const defaultPolicy = { strategy: 'best', threshold: 90, auto: false };
const safeFailure = (error) => error instanceof AccountError || error?.constructor?.name === 'ProviderError'
	? error.message : 'The provider operation failed. No credential details were returned.';
const text = (value, max, field, optional = false) => {
	if (optional && value === undefined) return undefined;
	if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new AccountError('input', `Invalid ${field}.`);
	return value.trim();
};
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const identityOf = (provider, capture) => {
	if (!capture || !capture.identity || !capture.payload) throw new AccountError('provider-data', 'The provider did not return a usable login.', 502);
	const identity = capture.identity;
	const identityId = text(identity.accountId, 256, 'account identity');
	if (!identityId || identity.provider !== provider) throw new AccountError('provider-data', 'The provider login identity did not match.', 502);
	return { id: accountId(provider, identityId), provider, accountId: identityId,
		email: text(identity.email ?? '', 254, 'email'), tier: text(identity.tier ?? '', 64, 'subscription tier') };
};
const publicRow = (row, activeId, now) => ({
	id: row.id, provider: row.provider, accountId: row.accountId, email: row.email, label: row.label, tier: row.tier,
	disabled: row.disabled === true, priority: row.priority ?? 0, reservePercent: row.reservePercent ?? 0,
	...(row.reserveSchedule ? { reserveSchedule: row.reserveSchedule } : {}), preferencesUpdatedAt: row.preferencesUpdatedAt,
	active: row.id === activeId, availableLocally: true,
	usageStatus: row.usageStatus === 'fresh' && timestamp(row.observedAt) && now - Date.parse(row.observedAt) <= 120_000 && Date.parse(row.observedAt) <= now + 300_000 ? 'fresh' : row.observedAt ? 'stale' : 'unavailable',
	observedAt: row.observedAt ?? null, windows: row.windows ?? [], error: row.error ?? null,
});

export const createAccountManager = ({ configPath, providersFactory, inspectProcesses = runningClis, clock = () => new Date(), fetchImpl = fetch } = {}) => {
	const settings = () => readAccountSettings(configPath);
	const now = () => clock().toISOString();
	const vault = () => accountVault(`${configPath}.vault`);
	const enabled = () => {
		const config = settings();
		if (config.enabled !== true) throw new AccountError('disabled', 'Account management is disabled. Enable it with the account CLI first.', 404);
		return config;
	};
	const providers = async (config) => (providersFactory ?? (await import('./account-providers.mjs')).createProviders)(config.providers ?? {});
	const routing = () => import('./account-routing.mjs');
	const sync = () => import('./account-sync.mjs');
	const checkProvider = (id) => {
		if (!providerIds.includes(id)) throw new AccountError('provider', 'Choose Claude Code or Codex CLI.');
	};
	const active = async (adapters) => {
		const result = {};
		const availability = [];
		for (const id of providerIds) {
			try {
				const capture = await adapters[id].capture();
				result[id] = identityOf(id, capture);
				availability.push({ id, label: id === 'claude' ? 'Claude Code CLI' : 'Codex CLI', supported: true });
			} catch (error) {
				availability.push({ id, label: id === 'claude' ? 'Claude Code CLI' : 'Codex CLI', supported: false, error: safeFailure(error) });
			}
		}
		return { ids: result, availability };
	};
	const rowsOf = async (state, activeIds) => {
		const { mergeMetadata } = await sync();
		let rows = state.accounts.map((row) => publicRow(row, activeIds[row.provider]?.id, clock().getTime()));
		for (const remote of state.remote) rows = mergeMetadata(rows, remote.accounts, { now: clock() });
		return rows;
	};
	const recommendations = async (rows, policy) => {
		const { chooseAccount } = await routing();
		return Object.fromEntries(providerIds.map((provider) => [provider, chooseAccount(rows, { ...policy, provider, now: clock() })]));
	};
	const snapshot = async () => {
		const config = settings();
		if (config.enabled !== true) return { enabled: false, accounts: [], providers: [], pending: [], busy: {}, policy: defaultPolicy, sync: { configured: false, count: 0 } };
		const state = vault().read();
		const adapters = await providers(config);
		const [{ ids, availability }, busy] = await Promise.all([active(adapters), inspectProcesses()]);
		const rows = await rowsOf(state, ids);
		return { enabled: true, accounts: rows, providers: availability, pending: state.pending, busy,
			policy: { ...defaultPolicy, ...state.policy }, recommendations: await recommendations(rows, state.policy),
			sync: { configured: Array.isArray(config.peers) && config.peers.length > 0, count: state.remote.length } };
	};
	const saveCapture = (state, provider, capture, label) => {
		const identity = identityOf(provider, capture);
		let row = state.accounts.find((account) => account.id === identity.id);
		if (!row) {
			if (state.accounts.length >= 100) throw new AccountError('limit', 'The account limit is 100.');
			row = { ...identity, label: label || identity.email || `${provider} account`, disabled: false, priority: 0, reservePercent: 0, preferencesUpdatedAt: now(), usageStatus: 'unavailable', windows: [] };
			state.accounts.push(row);
		}
		Object.assign(row, identity, { payload: capture.payload });
		if (label) { row.label = label; row.preferencesUpdatedAt = now(); }
		return row;
	};
	const capture = async (provider, label) => {
		checkProvider(provider);
		label = text(label, 64, 'label', true);
		const adapters = await providers(enabled());
		await vault().update(async (state) => saveCapture(state, provider, await adapters[provider].capture(), label));
		return snapshot();
	};
	const refresh = async ({ syncPeers = true, forceAuto = false } = {}) => {
		const config = enabled();
		const adapters = await providers(config);
		const busy = await inspectProcesses();
		await vault().update(async (state, checkpoint) => {
			const ids = {};
			const loggedOut = {};
			for (const provider of providerIds) {
				try {
					const current = await adapters[provider].capture();
					const identity = identityOf(provider, current);
					ids[provider] = identity;
					if (state.accounts.some((row) => row.id === identity.id)) saveCapture(state, provider, current);
				} catch (error) { loggedOut[provider] = error.code === 'LOGIN_REQUIRED'; }
			}
			checkpoint();
			await Promise.all(state.accounts.map(async (row) => {
				if (row.disabled) return;
				try {
					const onUpdate = async (payload, identity) => {
						if (!identity || identityOf(row.provider, { identity, payload }).id !== row.id) throw new AccountError('identity', 'Refreshed credentials belonged to a different login.', 502);
						row.payload = payload;
						checkpoint();
					};
					const allowRefresh = (ids[row.provider] && ids[row.provider].id !== row.id) || (loggedOut[row.provider] && !busy[row.provider]);
					const usage = await adapters[row.provider].usage(row.payload, { allowRefresh: Boolean(allowRefresh), onUpdate });
					if (usage.identity && identityOf(row.provider, { identity: usage.identity, payload: usage.payload ?? row.payload }).id !== row.id) throw new AccountError('identity', 'The usage response belonged to a different login.', 502);
					if (!Array.isArray(usage.windows) || !usage.windows.length || usage.windows.length > 50 ||
						usage.windows.some((w) => typeof w.key !== 'string' || w.key.length > 64 || typeof w.label !== 'string' || w.label.length > 128 || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 || !timestamp(w.resetsAt))) throw new AccountError('usage', 'The provider usage response was incomplete.', 502);
					row.payload = usage.payload ?? row.payload;
					if (usage.identity?.tier) row.tier = text(usage.identity.tier, 64, 'subscription tier');
					row.windows = usage.windows;
					row.observedAt = usage.observedAt ?? now();
					row.usageStatus = 'fresh';
					row.error = null;
				} catch (error) {
					if (error.updatedPayload && error.identity && identityOf(row.provider, { identity: error.identity, payload: error.updatedPayload }).id === row.id) {
						row.payload = error.updatedPayload;
						checkpoint();
					}
					row.usageStatus = row.observedAt ? 'stale' : 'unavailable'; row.error = safeFailure(error);
				}
			}));
			if (syncPeers) await synchronize(state, config);
			const rows = await rowsOf(state, ids);
			const proposed = await recommendations(rows, state.policy);
			state.pending = (state.policy.auto || forceAuto) ? providerIds.flatMap((provider) => {
				const choice = proposed[provider];
				return choice.accountId && choice.accountId !== ids[provider]?.id ? [{ id: choice.accountId, provider, reason: choice.reason }] : [];
			}) : [];
		});
		return snapshot();
	};
	const synchronize = async (state, config) => {
		const { fetchAccountPeer, mergeMetadata } = await sync();
		if (!Array.isArray(config.peers) || config.peers.length > 20) return;
		const responses = await Promise.all(config.peers.map((peer) => fetchAccountPeer(peer, fetchImpl)));
		state.remote = responses.filter(Boolean);
		for (const response of state.remote) {
			const merged = mergeMetadata(state.accounts.map((row) => publicRow(row, null, clock().getTime())), response.accounts, { now: clock() });
			for (const row of state.accounts) {
				const metadata = merged.find((entry) => entry.id === row.id);
				for (const field of ['label', 'disabled', 'priority', 'reservePercent', 'reserveSchedule', 'preferencesUpdatedAt']) {
					if (Object.hasOwn(metadata, field)) row[field] = metadata[field];
					else delete row[field];
				}
			}
			if (timestamp(response.policyUpdatedAt) && Date.parse(response.policyUpdatedAt) <= clock().getTime() + 300_000 &&
				Date.parse(response.policyUpdatedAt) > (Date.parse(state.policyUpdatedAt) || 0) && response.policy) {
				state.policy = { ...response.policy };
				if (state.policy.useFirst) {
					const preferred = response.accounts.find((row) => row.id === state.policy.useFirst);
					if (preferred) state.policy.useFirst = accountId(preferred.provider, preferred.accountId);
					else delete state.policy.useFirst;
				}
				state.policyUpdatedAt = response.policyUpdatedAt;
			}
		}
	};
	const switchAccount = async (id) => {
		id = text(id, 64, 'account ID');
		const config = enabled();
		const adapters = await providers(config);
		let provider;
		await vault().update(async (state, checkpoint) => {
			const row = state.accounts.find((account) => account.id === id);
			if (!row) throw new AccountError('missing', 'This account is not saved on this device.', 404);
			provider = row.provider;
			const busy = await inspectProcesses();
			if (busy[row.provider]) throw new AccountError('cli-busy', 'Stop this provider’s CLI sessions before applying the switch. Then relaunch the CLI yourself.', 409);
			const adapter = adapters[row.provider];
			try { saveCapture(state, row.provider, await adapter.capture()); } catch (error) {
				if (error instanceof AccountError) throw error;
				// No current login is acceptable; an unreadable store is not.
				if (!['LOGIN_REQUIRED', 'not-signed-in', 'missing-login', 'no-login'].includes(error.code)) throw error;
			}
			checkpoint();
			if ((await inspectProcesses())[row.provider]) throw new AccountError('cli-busy', 'A CLI session started while preparing the switch. Stop it before trying again.', 409);
			await adapter.activate(row.payload);
			state.pending = state.pending.filter((entry) => entry.provider !== row.provider);
		});
		return { ...await snapshot(), switch: { id, provider, appliedTo: 'cli-login', restartRequired: true } };
	};
	const edit = async (input) => {
		enabled();
		const allowed = ['id', 'label', 'disabled', 'priority', 'reservePercent', 'reserveSchedule'];
		if (!input || Object.keys(input).some((key) => !allowed.includes(key))) throw new AccountError('input', 'Invalid account settings.');
		const id = text(input.id, 64, 'account ID');
		await vault().update((state) => {
			const row = state.accounts.find((account) => account.id === id);
			if (!row) throw new AccountError('missing', 'This account is not saved on this device.', 404);
			if (input.label !== undefined) row.label = text(input.label, 64, 'label') || row.email || row.provider;
			if (input.disabled !== undefined) { if (typeof input.disabled !== 'boolean') throw new AccountError('input', 'Invalid disabled setting.'); row.disabled = input.disabled; }
			for (const [field, min, max] of [['priority', -100, 100], ['reservePercent', 0, 99]]) if (input[field] !== undefined) {
				if (!Number.isInteger(input[field]) || input[field] < min || input[field] > max) throw new AccountError('input', `Invalid ${field}.`);
				row[field] = input[field];
			}
			if (input.reserveSchedule !== undefined) {
				if (!Array.isArray(input.reserveSchedule) || input.reserveSchedule.length > 20 || input.reserveSchedule.some((entry) =>
					!entry || !Array.isArray(entry.days) || !entry.days.length || entry.days.length > 7 || entry.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
					!/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.end) ||
					!Number.isInteger(entry.reservePercent) || entry.reservePercent < 0 || entry.reservePercent > 99)) throw new AccountError('input', 'Invalid reserve schedule.');
				row.reserveSchedule = input.reserveSchedule.map(({ days, start, end, reservePercent }) => ({ days, start, end, reservePercent }));
			}
			row.preferencesUpdatedAt = now();
		});
		return snapshot();
	};
	const policy = async (input) => {
		enabled();
		if (!input || Object.keys(input).some((key) => !['strategy', 'threshold', 'auto', 'useFirst'].includes(key))) throw new AccountError('input', 'Invalid routing policy.');
		await vault().update((state) => {
			if (input.strategy !== undefined) { if (!['best', 'consume-first'].includes(input.strategy)) throw new AccountError('input', 'Invalid routing strategy.'); state.policy.strategy = input.strategy; }
			if (input.threshold !== undefined) { if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > 100) throw new AccountError('input', 'Invalid switch threshold.'); state.policy.threshold = input.threshold; }
			if (input.auto !== undefined) { if (typeof input.auto !== 'boolean') throw new AccountError('input', 'Invalid automatic selection setting.'); state.policy.auto = input.auto; }
			if (input.useFirst !== undefined) {
				const id = text(input.useFirst, 64, 'use-first account');
				if (id && !state.accounts.some((row) => row.id === id)) throw new AccountError('input', 'The use-first account must be saved locally.');
				if (id) state.policy.useFirst = id; else delete state.policy.useFirst;
			}
			state.policyUpdatedAt = now();
		});
		return snapshot();
	};
	const metadata = async () => {
		enabled();
		const state = vault().read();
		const { sanitizeMetadata } = await sync();
		return { ...sanitizeMetadata(state.accounts.map((row) => publicRow(row, null, clock().getTime())), { policy: state.policy, policyUpdatedAt: state.policyUpdatedAt }), device: hostname().slice(0, 64) };
	};
	return { snapshot, capture, refresh, switchAccount, edit, policy, metadata,
		async synchronize() { const config = enabled(); await vault().update((state) => synchronize(state, config)); return snapshot(); },
		async remove(id) { enabled(); id = text(id, 64, 'account ID'); await vault().update((state) => { state.accounts = state.accounts.filter((row) => row.id !== id); state.pending = state.pending.filter((entry) => entry.id !== id); if (state.policy.useFirst === id) { delete state.policy.useFirst; state.policyUpdatedAt = now(); } }); return snapshot(); },
		settings,
	};
};
