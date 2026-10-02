const MAX_ACCOUNTS = 100;
const MAX_WINDOWS = 16;
const MAX_BODY_BYTES = 256 * 1024;
const PROVIDERS = new Set(['claude', 'codex']);
const USAGE_STATES = new Set(['fresh', 'stale', 'unavailable']);
const record = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const nonempty = (value, limit) => text(value, limit)?.trim() || null;
const percent = (value) => Number.isFinite(value) && value >= 0 && value <= 100;
const iso = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
	&& Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function cleanWindow(value) {
	if (!record(value)) return null;
	const key = nonempty(value.key, 64);
	const label = text(value.label ?? value.key, 128);
	if (!key || label == null || !percent(value.usedPercent) || !Number.isFinite(value.windowMinutes)
		|| value.windowMinutes <= 0 || value.windowMinutes > 525600) return null;
	const resetsAt = value.resetsAt == null ? null : iso(value.resetsAt);
	if (value.resetsAt != null && !resetsAt) return null;
	const result = { key, label, usedPercent: value.usedPercent, resetsAt, windowMinutes: value.windowMinutes };
	if (value.model != null) {
		if (!nonempty(value.model, 128) || value.models != null) return null;
		result.model = value.model.trim();
	}
	if (value.models != null) {
		if (!Array.isArray(value.models) || !value.models.length || value.models.length > 16
			|| !value.models.every((model) => nonempty(model, 128))) return null;
		result.models = [...new Set(value.models.map((model) => model.trim()))];
	}
	return result;
}

function cleanSchedule(value) {
	if (!Array.isArray(value) || value.length > 32) return null;
	const result = [];
	for (const slot of value) {
		if (!record(slot) || !Array.isArray(slot.days) || !slot.days.length || slot.days.length > 7
			|| !slot.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
			|| typeof slot.start !== 'string' || typeof slot.end !== 'string'
			|| !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.end)
			|| !percent(slot.reservePercent) || slot.reservePercent >= 100) return null;
		result.push({ days: [...new Set(slot.days)], start: slot.start, end: slot.end, reservePercent: slot.reservePercent });
	}
	return result;
}

function cleanAccount(value, { preserveInvalidPolicy = false } = {}) {
	if (!record(value) || !PROVIDERS.has(value.provider)) return null;
	const id = nonempty(value.id, 128);
	const accountId = nonempty(value.accountId, 256);
	if (!id || !accountId) return null;
	const result = {
		id, provider: value.provider, accountId,
		email: text(value.email, 256) ?? '',
		label: text(value.label, 128) ?? id,
		tier: text(value.tier, 64) ?? '',
		active: value.active === true,
		availableLocally: value.availableLocally === true,
		disabled: value.disabled === true,
		usageStatus: USAGE_STATES.has(value.usageStatus) ? value.usageStatus : 'unavailable',
		observedAt: iso(value.observedAt),
		preferencesUpdatedAt: iso(value.preferencesUpdatedAt),
		windows: [],
	};
	let invalidPolicy = value.disabled != null && typeof value.disabled !== 'boolean';
	if (value.priority != null) {
		if (!Number.isSafeInteger(value.priority) || Math.abs(value.priority) > 1000000) invalidPolicy = true;
		else result.priority = value.priority;
	}
	if (value.reservePercent != null) {
		if (!percent(value.reservePercent) || value.reservePercent >= 100) invalidPolicy = true;
		else result.reservePercent = value.reservePercent;
	}
	if (value.reserveSchedule != null) {
		const schedule = cleanSchedule(value.reserveSchedule);
		if (!schedule) invalidPolicy = true;
		else result.reserveSchedule = schedule;
	}
	if (invalidPolicy) {
		if (!preserveInvalidPolicy) return null;
		result.disabled = true;
	}
	if (Array.isArray(value.windows) && value.windows.length <= MAX_WINDOWS) {
		const windows = value.windows.map(cleanWindow);
		if (windows.every(Boolean) && new Set(windows.map((window) => window.key)).size === windows.length) result.windows = windows;
		else result.usageStatus = 'unavailable';
	} else result.usageStatus = 'unavailable';
	if (!result.observedAt || !result.windows.length) result.usageStatus = 'unavailable';
	return result;
}

// Build a new wire object from an allowlist; credential fields are never copied.
export function sanitizeMetadata(accounts, { policy, policyUpdatedAt } = {}) {
	const rows = Array.isArray(accounts) ? accounts : [];
	const identities = new Set();
	const snapshot = {
		schemaVersion: 1,
		accounts: rows.slice(0, MAX_ACCOUNTS).map((row) => cleanAccount(row)).filter((row) => {
			if (!row) return false;
			const identity = JSON.stringify([row.provider, row.accountId]);
			if (identities.has(identity)) return false;
			identities.add(identity);
			return true;
		}),
	};
	const clean = cleanPolicy(policy);
	const updated = iso(policyUpdatedAt);
	if (clean && updated) {
		snapshot.policy = clean;
		snapshot.policyUpdatedAt = updated;
	}
	let size = Buffer.byteLength(JSON.stringify({ ...snapshot, accounts: [] }));
	let count = 0;
	snapshot.accounts = snapshot.accounts.filter((row) => {
		const bytes = Buffer.byteLength(JSON.stringify(row)) + Number(count > 0);
		if (size + bytes > MAX_BODY_BYTES) return false;
		size += bytes;
		count++;
		return true;
	});
	return snapshot;
}

function cleanPolicy(value) {
	if (!record(value) || !['best', 'consume-first'].includes(value.strategy)
		|| !Number.isFinite(value.threshold) || value.threshold <= 0 || value.threshold >= 100
		|| typeof value.auto !== 'boolean' || value.useFirst != null && !nonempty(value.useFirst, 128)) return null;
	return { strategy: value.strategy, threshold: value.threshold, auto: value.auto, useFirst: value.useFirst ?? null };
}

export function parseMetadata(untrusted) {
	let data = untrusted;
	if (typeof data === 'string') {
		if (Buffer.byteLength(data) > MAX_BODY_BYTES) return null;
		try { data = JSON.parse(data); } catch { return null; }
	}
	if (!record(data) || data.schemaVersion !== 1 || !Array.isArray(data.accounts) || data.accounts.length > MAX_ACCOUNTS) return null;
	return sanitizeMetadata(data.accounts, { policy: data.policy, policyUpdatedAt: data.policyUpdatedAt });
}

function peerUrl(value) {
	if (typeof value !== 'string' || value.length > 2048) return null;
	try {
		const url = new URL(value);
		const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
		return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && loopback) ? url : null;
	} catch { return null; }
}

async function readCapped(body, signal) {
	if (!body?.getReader) throw new Error('Missing metadata response body.');
	const reader = body.getReader();
	const cancel = () => { void reader.cancel().catch(() => {}); };
	signal.addEventListener('abort', cancel, { once: true });
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) throw new Error('Invalid metadata response body.');
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				cancel();
				throw new Error('Metadata response is too large.');
			}
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks).toString('utf8');
	} finally {
		signal.removeEventListener('abort', cancel);
		reader.releaseLock();
	}
}

export async function fetchAccountPeer(peer = {}, fetchImpl = fetch, timeoutMs = 1500) {
	if (!record(peer)) return null;
	const { url, token } = peer;
	const endpoint = peerUrl(url);
	if (!endpoint || !nonempty(token, 4096) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error('Metadata request timed out.')), timeoutMs);
	const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
	try {
		return await Promise.race([aborted, (async () => {
			const response = await fetchImpl(endpoint, {
				signal: controller.signal, redirect: 'error',
				headers: { accept: 'application/json', authorization: `Bearer ${token}` },
			});
			if (!response.ok || response.redirected || response.status >= 300 && response.status < 400) return null;
			const length = response.headers?.get('content-length');
			if (length != null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
			return parseMetadata(await readCapped(response.body, controller.signal));
		})()]);
	} catch { return null; }
	finally {
		clearTimeout(timer);
		controller.abort();
	}
}

// Local IDs, credentials, and activity stay local. Authenticated peers can
// contribute newer observations and explicitly versioned routing preferences.
export function mergeMetadata(local, remote, { now = new Date() } = {}) {
	const clock = now instanceof Date ? now.getTime() : Date.parse(now);
	const newestAllowed = clock + 300000;
	const locals = Array.isArray(local) ? local : [];
	const result = locals.slice(0, MAX_ACCOUNTS).map((row) => cleanAccount(row, { preserveInvalidPolicy: true })).filter(Boolean);
	if (!Number.isFinite(clock)) return result;
	const index = new Map(result.map((row) => [JSON.stringify([row.provider, row.accountId]), row]));
	const ids = new Set(result.map((row) => row.id));
	for (const row of sanitizeMetadata(remote).accounts) {
		const key = JSON.stringify([row.provider, row.accountId]);
		const existing = index.get(key);
		if (existing) {
			if (row.usageStatus === 'fresh' && row.observedAt && Date.parse(row.observedAt) <= newestAllowed
				&& (!existing.observedAt || Date.parse(row.observedAt) > Date.parse(existing.observedAt))) {
				existing.usageStatus = row.usageStatus;
				existing.observedAt = row.observedAt;
				existing.windows = row.windows;
			}
			if (row.preferencesUpdatedAt && Date.parse(row.preferencesUpdatedAt) <= newestAllowed
				&& (!existing.preferencesUpdatedAt || Date.parse(row.preferencesUpdatedAt) > Date.parse(existing.preferencesUpdatedAt))) {
				for (const field of ['label', 'disabled', 'priority', 'reservePercent', 'reserveSchedule']) {
					if (Object.hasOwn(row, field)) existing[field] = row[field];
					else delete existing[field];
				}
				existing.preferencesUpdatedAt = row.preferencesUpdatedAt;
			}
			continue;
		}
		if (result.length >= MAX_ACCOUNTS) break;
		let id = row.id;
		if (ids.has(id)) {
			let suffix = 1;
			const base = `remote:${row.provider}:${row.id}`.slice(0, 115);
			do { id = `${base}:${suffix++}`; } while (ids.has(id));
		}
		const merged = { ...row, id, active: false, availableLocally: false };
		if (merged.observedAt && Date.parse(merged.observedAt) > newestAllowed) {
			merged.observedAt = null;
			merged.usageStatus = 'unavailable';
			merged.windows = [];
		}
		if (merged.preferencesUpdatedAt && Date.parse(merged.preferencesUpdatedAt) > newestAllowed) {
			merged.preferencesUpdatedAt = null;
			merged.disabled = true;
		}
		result.push(merged);
		index.set(key, merged);
		ids.add(id);
	}
	return result;
}
