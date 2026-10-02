const PROVIDERS = new Set(['claude', 'codex']);
const TIER_PREFERENCE = {
	claude: { free: 0, pro: 1, max: 2, max5x: 2, max20x: 3 },
	codex: { free: 0, go: 1, plus: 2, pro: 3 },
};
const HYSTERESIS_PERCENT = 10;

const timestamp = (value) => typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN;
const percent = (value) => Number.isFinite(value) && value >= 0 && value <= 100;
const timeMinutes = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
	? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
const compareId = (a, b) => a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0;
const modelFamily = (model) => /(?:^|[-_])(sonnet|opus|haiku)(?:$|[-_])/i.exec(model)?.[1].toLowerCase();

// Schedules use UTC. Overnight intervals continue into the next day; start=end
// means the full selected day. Reserves affect ranking, never hard eligibility.
function reserveFor(account, now) {
	if (account.reservePercent != null && (!Number.isInteger(account.reservePercent) || account.reservePercent < 0 || account.reservePercent >= 100)) return null;
	let reserve = account.reservePercent ?? 0;
	if (account.reserveSchedule == null) return reserve;
	if (!Array.isArray(account.reserveSchedule) || account.reserveSchedule.length > 20) return null;
	const date = new Date(now);
	const day = date.getUTCDay();
	const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
	for (const slot of account.reserveSchedule) {
		if (!slot || !Array.isArray(slot.days) || !slot.days.length || slot.days.length > 7
			|| !slot.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
			|| !Number.isInteger(slot.reservePercent) || slot.reservePercent < 0 || slot.reservePercent >= 100) return null;
		const start = timeMinutes(slot.start);
		const end = timeMinutes(slot.end);
		if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
		const applies = start < end
			? slot.days.includes(day) && minute >= start && minute < end
			: start === end ? slot.days.includes(day)
				: slot.days.includes(day) && minute >= start || slot.days.includes((day + 6) % 7) && minute < end;
		if (applies) reserve = Math.max(reserve, slot.reservePercent);
	}
	return reserve;
}

function applicableWindows(windows, model) {
	if (!Array.isArray(windows) || !windows.length || windows.length > 16) return null;
	const selected = [];
	for (const window of windows) {
		if (!window || typeof window.key !== 'string' || !window.key.trim() || window.key.length > 64
			|| !percent(window.usedPercent) || !Number.isFinite(window.windowMinutes) || window.windowMinutes <= 0 || window.windowMinutes > 525600) return null;
		if (window.model != null && (typeof window.model !== 'string' || !window.model.trim() || window.model.length > 128)) return null;
		if (window.models != null && (!Array.isArray(window.models) || !window.models.length || window.models.length > 16
			|| !window.models.every((value) => typeof value === 'string' && value.trim() && value.length <= 128))) return null;
		if (window.model != null && window.models != null) return null;
		if (window.resetsAt != null && !Number.isFinite(timestamp(window.resetsAt))) return null;
		const models = window.models ?? (window.model ? [window.model] : null);
		const family = model && modelFamily(model);
		const matches = models?.some((scope) => scope.trim().toLowerCase() === model?.trim().toLowerCase() || family && modelFamily(scope) === family);
		// A new or unknown model name cannot prove that a scoped limit is irrelevant.
		const knownOtherFamily = family && models?.every((scope) => modelFamily(scope));
		if (!model || !models || matches || !knownOtherFamily) selected.push(window);
	}
	return selected.length ? selected : null;
}

function candidate(account, { now, model, threshold, maxAgeMs }) {
	if (!account || typeof account.id !== 'string' || !account.id.trim() || account.id.length > 64
		|| typeof account.accountId !== 'string' || !account.accountId.trim() || account.accountId.length > 256
		|| /[\u0000-\u001f\u007f]/.test(account.id + account.accountId)) return { reason: 'Invalid account identity.' };
	if (account.disabled === true) return { reason: 'Account is disabled.' };
	if (account.availableLocally !== true) return { reason: 'Credentials are unavailable on this device.' };
	if (account.usageStatus !== 'fresh') return { reason: 'Usage is unavailable or stale.' };
	const observed = timestamp(account.observedAt);
	if (!Number.isFinite(observed) || observed > now + 5000 || now - observed > maxAgeMs) return { reason: 'Usage observation is missing, stale, or ahead of this device.' };
	if (account.priority != null && (!Number.isInteger(account.priority) || Math.abs(account.priority) > 100)) return { reason: 'Routing priority is invalid.' };
	const reserve = reserveFor(account, now);
	if (reserve == null) return { reason: 'Usage reserve policy is invalid.' };
	const windows = applicableWindows(account.windows, model);
	if (!windows) return { reason: 'Applicable usage limits are missing or malformed.' };
	if (windows.some((window) => window.resetsAt != null && timestamp(window.resetsAt) <= now)) return { reason: 'A usage window has reset; refresh usage before routing.' };
	if (windows.some((window) => window.usedPercent >= 100)) return { reason: 'An applicable usage window is exhausted.' };
	const headroom = Math.min(...windows.map((window) => 100 - window.usedPercent));
	const weeklyResets = windows.filter((window) => window.windowMinutes >= 10080 && window.resetsAt != null).map((window) => timestamp(window.resetsAt));
	return {
		account, headroom, reserve,
		soft: headroom <= reserve || windows.some((window) => window.usedPercent >= threshold),
		priority: account.priority ?? 0,
		tier: TIER_PREFERENCE[account.provider]?.[String(account.tier ?? '').toLowerCase().replace(/[\s_-]/g, '')] ?? 0,
		weeklyReset: weeklyResets.length ? Math.min(...weeklyResets) : Infinity,
	};
}

function rank(a, b, strategy) {
	if (strategy === 'consume-first' && a.weeklyReset !== b.weeklyReset) return a.weeklyReset < b.weeklyReset ? -1 : 1;
	return b.priority - a.priority || b.tier - a.tier || b.headroom - a.headroom || Number(b.account.active === true) - Number(a.account.active === true) || compareId(a, b);
}

// Tier names express subscription preference only; quota percentages always
// come from observed windows. Unknown tiers receive no guessed token capacity.
export function chooseAccount(accounts, {
	provider, strategy = 'best', model, threshold = 90, useFirst,
	now = new Date(), maxAgeMs = 120000,
} = {}) {
	const warnings = [];
	const blocked = [];
	const clock = timestamp(now);
	const result = (accountId, reason) => ({ accountId, reason, warnings, blocked });
	if (!Array.isArray(accounts) || !PROVIDERS.has(provider) || !['best', 'consume-first'].includes(strategy)
		|| !Number.isFinite(clock) || !Number.isInteger(threshold) || threshold <= 0 || threshold > 100
		|| !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || model != null && (typeof model !== 'string' || !model.trim() || model.length > 128)
		|| useFirst != null && (typeof useFirst !== 'string' || useFirst.length > 64)) return result(null, 'Routing options are invalid.');
	const viable = [];
	const ids = new Set();
	for (const account of accounts) {
		if (account?.provider !== provider) continue;
		const value = candidate(account, { now: clock, model, threshold, maxAgeMs });
		const id = typeof account?.id === 'string' ? account.id : '(invalid)';
		if (ids.has(id)) {
			blocked.push({ id, reason: 'Duplicate account identity.' });
			const previous = viable.findIndex((item) => item.account.id === id);
			if (previous >= 0) viable.splice(previous, 1);
		} else if (value.reason) blocked.push({ id, reason: value.reason });
		else viable.push(value);
		ids.add(id);
	}
	const green = viable.filter((value) => !value.soft).sort((a, b) => rank(a, b, strategy));
	if (!green.length) {
		const fallback = useFirst && viable.find((value) => value.account.id === useFirst);
		if (!fallback) return result(null, viable.length ? 'All usable accounts are reserved or above the warning threshold. Select a use-first account to continue.' : 'No account has fresh, usable limits and local credentials.');
		warnings.push('The selected use-first account is in a soft reserve or above the warning threshold.');
		return result(fallback.account.id, 'Using the explicitly selected fallback account.');
	}
	const best = green[0];
	const active = green.find((value) => value.account.active === true);
	if (strategy === 'best' && active && active !== best && best.priority <= active.priority
		&& best.headroom < active.headroom + HYSTERESIS_PERCENT) {
		return result(active.account.id, 'Keeping the active account because the available improvement is below 10 percentage points.');
	}
	return result(best.account.id, strategy === 'consume-first' ? 'Selected the usable account with the earliest weekly reset.' : 'Selected by priority, subscription preference, and measured headroom.');
}
