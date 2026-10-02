import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, rmdir, utimes } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_BYTES = 1024 * 1024;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' && value.length > 0;
const copy = (value) => structuredClone(value);

export class ProviderError extends Error {
	constructor(code, message) { super(message); this.name = 'ProviderError'; this.code = code; }
}
const fail = (code, message) => { throw new ProviderError(code, message); };
function refreshedFailure(error, payload, identity) {
	const safe = error instanceof ProviderError ? error : new ProviderError('USAGE_UNAVAILABLE', 'The provider usage service is unavailable.');
	if (safe.code !== 'IDENTITY_MISMATCH') {
		Object.defineProperty(safe, 'updatedPayload', { value: payload });
		Object.defineProperty(safe, 'identity', { value: identity });
	}
	throw safe;
}
const guarded = (operation) => async (...args) => {
	try { return await operation(...args); }
	catch (error) {
		if (error instanceof ProviderError) throw error;
		fail('PROVIDER_UNAVAILABLE', 'The provider credential store is unavailable.');
	}
};

export function parseProviderJson(text) {
	try {
		if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error();
		const value = JSON.parse(text);
		if (!object(value)) throw new Error();
		return value;
	} catch { fail('INVALID_CREDENTIALS', 'The provider login data is not valid.'); }
}

async function readJson(path, optional = false) {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('UNSUPPORTED_STORE', 'This credential file is not supported.');
		return parseProviderJson(await readFile(path, 'utf8'));
	} catch (error) {
		if (optional && error.code === 'ENOENT') return null;
		if (error.code === 'ENOENT') fail('LOGIN_REQUIRED', 'Sign in to the provider CLI first.');
		throw error;
	}
}

export async function writeProviderJson(path, value) {
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > MAX_BYTES) fail('INVALID_CREDENTIALS', 'The provider login data is too large.');
	try { if (!(await lstat(path)).isFile()) fail('UNSUPPORTED_STORE', 'This credential file is not supported.'); }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		const file = await open(temporary, 'wx', 0o600);
		try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
		await rename(temporary, path);
		await chmod(path, 0o600);
	} finally { await rm(temporary, { force: true }); }
}

async function run(command, args, options = {}) {
	return await new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env, cwd: options.cwd, windowsHide: true });
		let stdout = '', size = 0, failure;
		const timer = setTimeout(() => { failure = new ProviderError('PROVIDER_TIMEOUT', 'The provider did not respond in time.'); child.kill('SIGKILL'); }, options.timeout ?? 15_000);
		child.stdout.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BYTES) { failure = new ProviderError('PROVIDER_UNAVAILABLE', 'The provider response was too large.'); child.kill('SIGKILL'); }
			else stdout += chunk;
		});
		child.stderr.resume();
		child.stdin.on('error', () => {});
		child.on('error', () => { clearTimeout(timer); reject(new ProviderError('PROVIDER_NOT_INSTALLED', 'The provider command is unavailable.')); });
		child.on('close', (code) => { clearTimeout(timer); failure ? reject(failure) : resolveRun({ code, stdout }); });
		child.stdin.end(options.input ?? '');
	});
}

// A single security command goes through stdin. Hex data avoids the interactive
// parser's quoting rules and keeps credential bytes out of the process arguments.
export function createMacKeychain(runCommand = run) {
	const check = (value) => { if (!/^[\w .@|+-]{1,256}$/.test(value)) fail('UNSUPPORTED_STORE', 'The Keychain item name is not supported.'); };
	return {
		async read(service, account) {
			check(service); check(account);
			const result = await runCommand('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w']);
			if (result.code === 44) return null;
			if (result.code !== 0) fail('KEYCHAIN_UNAVAILABLE', 'Unlock the macOS Keychain and try again.');
			return result.stdout.replace(/\r?\n$/, '');
		},
		async write(service, account, value) {
			check(service); check(account);
			const hex = Buffer.from(value, 'utf8').toString('hex');
			const input = `add-generic-password -U -s "${service}" -a "${account}" -X ${hex}\n`;
			const result = await runCommand('/usr/bin/security', ['-i'], { input });
			if (result.code !== 0) fail('KEYCHAIN_UNAVAILABLE', 'The macOS Keychain could not save this login.');
		},
		async remove(service, account) {
			check(service); check(account);
			const result = await runCommand('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account]);
			if (result.code !== 0 && result.code !== 44) fail('KEYCHAIN_UNAVAILABLE', 'The macOS Keychain could not remove this login.');
		},
	};
}

export function claudeKeychainService(configDir) {
	return configDir ? `Claude Code-credentials-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}` : 'Claude Code-credentials';
}

async function withClaudeLocks(directory, config, operation) {
	const owned = [];
	let heartbeat;
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await mkdir(dirname(config), { recursive: true, mode: 0o700 });
		heartbeat = setInterval(() => { const now = new Date(); for (const path of owned) void utimes(path, now, now).catch(() => {}); }, 3_000);
		for (const path of [...new Set([join(directory, '.oauth_refresh.lock'), `${directory}.lock`, `${config}.lock`])]) {
			const deadline = Date.now() + 9_000;
			while (true) {
				try { await mkdir(path); owned.push(path); break; }
				catch (error) {
					if (error.code !== 'EEXIST') throw error;
					if (Date.now() >= deadline) fail('PROVIDER_BUSY', 'Claude Code is updating its login. Try again when it is idle.');
					await new Promise((done) => setTimeout(done, 50));
				}
			}
		}
		return await operation();
	} finally {
		clearInterval(heartbeat);
		for (const path of owned.reverse()) await rmdir(path).catch(() => {});
	}
}

const CLAUDE_FIELDS = ['accountUuid', 'emailAddress', 'organizationUuid', 'organizationName', 'displayName', 'hasExtraUsage', 'billingType', 'isAnthropicEmployee'];
export function identifyClaude(payload) {
	const account = payload?.oauthAccount, oauth = payload?.credentials?.claudeAiOauth;
	if (!object(account) || !string(account.accountUuid) || !string(account.emailAddress) || account.organizationUuid != null && !string(account.organizationUuid) || !string(oauth?.accessToken)) fail('INVALID_CREDENTIALS', 'Claude Code has no supported subscription login.');
	return { provider: 'claude', accountId: `${account.accountUuid}:${account.organizationUuid ?? ''}`, email: account.emailAddress, tier: string(oauth.subscriptionType) ? oauth.subscriptionType : null };
}

function jwt(token) {
	try { return parseProviderJson(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
	catch { fail('INVALID_CREDENTIALS', 'The Codex login identity is not valid.'); }
}
export function identifyCodex(payload) {
	const auth = payload?.auth;
	if (!object(auth) || auth.OPENAI_API_KEY || auth.auth_mode && auth.auth_mode !== 'chatgpt') fail('UNSUPPORTED_LOGIN', 'Only Codex ChatGPT subscription logins are supported.');
	const tokens = auth.tokens;
	if (!string(tokens?.access_token) || !string(tokens?.id_token) || !string(tokens?.refresh_token)) fail('INVALID_CREDENTIALS', 'Codex has no supported subscription login.');
	const claims = jwt(tokens.id_token), metadata = claims['https://api.openai.com/auth'] ?? {};
	const accountId = tokens.account_id ?? metadata.chatgpt_account_id;
	if (!string(claims.sub) || !string(accountId) || metadata.chatgpt_account_id && metadata.chatgpt_account_id !== accountId) fail('IDENTITY_MISMATCH', 'The Codex login identity is incomplete or belongs to a different account.');
	return { provider: 'codex', accountId: `${claims.sub}:${accountId}`, email: string(claims.email) ? claims.email : null, tier: string(metadata.chatgpt_plan_type) ? metadata.chatgpt_plan_type : null };
}

function codexWorkspace(payload) {
	return payload.auth.tokens.account_id ?? jwt(payload.auth.tokens.id_token)['https://api.openai.com/auth'].chatgpt_account_id;
}

const iso = (value) => { const date = new Date(value); return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : null; };
const window = (key, label, usedPercent, resetsAt, windowMinutes) => {
	if (!Number.isFinite(usedPercent) || usedPercent < 0 || !Number.isFinite(windowMinutes) || windowMinutes <= 0 || !resetsAt) fail('USAGE_UNAVAILABLE', 'The provider usage data is incomplete.');
	return { key, label, usedPercent, resetsAt, windowMinutes };
};
export function claudeWindows(data) {
	const result = [];
	for (const [key, label, minutes] of [['five_hour', '5 hours', 300], ['seven_day', 'Weekly', 10080]]) {
		if (object(data[key])) result.push(window(key, label, data[key].utilization, iso(data[key].resets_at), minutes));
	}
	for (const model of ['sonnet', 'opus']) {
		const key = `seven_day_${model}`;
		if (object(data[key])) result.push({ ...window(key, `${model === 'sonnet' ? 'Sonnet' : 'Opus'} weekly`, data[key].utilization, iso(data[key].resets_at), 10080), model });
	}
	for (const limit of data.limits ?? []) {
		const scoped = limit.scope?.model;
		const name = string(scoped) ? scoped : scoped?.display_name ?? scoped?.id ?? scoped?.model_id;
		if (!string(name)) continue;
		const family = name.match(/sonnet|opus|haiku/i)?.[0].toLowerCase();
		const model = family ?? scoped?.id ?? scoped?.model_id ?? name;
		result.push({ ...window(`model:${model}`, `${name} weekly`, limit.percent, iso(limit.resets_at), 10080), model });
	}
	if (!result.length) fail('USAGE_UNAVAILABLE', 'The provider has not reported usage windows.');
	return result;
}
export function codexWindows(data, native = false) {
	const buckets = native ? { codex: data.rate_limit, ...Object.fromEntries((data.additional_rate_limits ?? []).filter((entry) => string(entry?.metered_feature) && object(entry.rate_limit)).map((entry) => [entry.metered_feature, entry.rate_limit])) } : data.rateLimitsByLimitId ?? { codex: data.rateLimits };
	const result = [];
	for (const [id, bucket] of Object.entries(buckets)) {
		for (const key of ['primary', 'secondary']) {
			const value = bucket?.[native ? `${key}_window` : key];
			if (!object(value)) continue;
			const minutes = native ? value.limit_window_seconds / 60 : value.windowDurationMins;
			result.push(window(`${id}:${key}`, `${id === 'codex' ? '' : `${id} `}${minutes >= 10080 ? 'Weekly' : minutes === 300 ? '5 hours' : `${minutes} minutes`}`, native ? value.used_percent : value.usedPercent, iso((native ? value.reset_at : value.resetsAt) * 1000), minutes));
		}
	}
	if (!result.length) fail('USAGE_UNAVAILABLE', 'The provider has not reported usage windows.');
	return result;
}

async function requestJson(fetcher, url, options = {}) {
	let response;
	try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
	catch { fail('USAGE_UNAVAILABLE', 'The provider usage service is unavailable.'); }
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) fail('LOGIN_EXPIRED', 'Sign in to this provider account again.');
		fail('USAGE_UNAVAILABLE', 'The provider usage service is unavailable.');
	}
	const text = await response.text();
	return parseProviderJson(text);
}

function simpleSettings(text) {
	let section = '', mode, secret;
	for (const line of text.split(/\r?\n/)) {
		const stripped = line.replace(/\s+#.*$/, '').trim();
		if (stripped.startsWith('[')) { section = stripped; continue; }
		const setting = stripped.match(/^(?:cli_auth_credentials_store|"cli_auth_credentials_store"|'cli_auth_credentials_store')\s*=\s*["'](\w+)["']\s*$/);
		if (setting) {
			if (section) fail('UNSUPPORTED_STORE', 'Profile-specific Codex credential storage is not supported.');
			mode = setting[1];
		} else if (stripped && !stripped.startsWith('#') && stripped.includes('cli_auth_credentials_store')) fail('UNSUPPORTED_STORE', 'The Codex credential storage configuration is not supported.');
		if (section === '[features]' && /^(?:secret_auth_storage|"secret_auth_storage"|'secret_auth_storage')\s*=/.test(stripped)) secret = stripped.match(/^(?:secret_auth_storage|"secret_auth_storage"|'secret_auth_storage')\s*=\s*(true|false)$/)?.[1];
		if (!section && /^features\.secret_auth_storage\s*=/.test(stripped)) secret = stripped.match(/^features\.secret_auth_storage\s*=\s*(true|false)$/)?.[1];
	}
	return { mode, secret };
}
async function settingsAt(path) {
	try { return simpleSettings(await readFile(path, 'utf8')); }
	catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

async function probeCodex(command, home, env, checkpoint) {
	return await new Promise((resolveProbe, reject) => {
		const child = spawn(command, ['app-server', '-c', 'cli_auth_credentials_store="file"', '-c', 'features.secret_auth_storage=false'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		const pending = new Map();
		let id = 0, bytes = 0, finished = false, outcome;
		const failure = () => new ProviderError('USAGE_UNAVAILABLE', 'Codex could not read usage for this account.');
		const timer = setTimeout(() => finish(new ProviderError('PROVIDER_TIMEOUT', 'Codex did not respond in time.')), 20_000);
		const finish = (error, result) => {
			if (finished) return;
			finished = true; outcome = { error, result }; clearTimeout(timer); child.kill('SIGKILL');
			for (const entry of pending.values()) entry.reject(error ?? failure());
			pending.clear();
		};
		const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
		const rpc = (method, params = {}) => new Promise((resolveRpc, rejectRpc) => { const key = ++id; pending.set(key, { resolve: resolveRpc, reject: rejectRpc }); send({ id: key, method, params }); });
		child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_BYTES) finish(failure()); });
		child.stderr.resume(); child.stdin.on('error', () => finish(failure()));
		child.on('error', () => finish(new ProviderError('PROVIDER_NOT_INSTALLED', 'Install Codex CLI to refresh its usage.')));
		child.on('close', () => {
			if (!finished) finish(failure());
			outcome.error ? reject(outcome.error) : resolveProbe(outcome.result);
		});
		const lines = createInterface({ input: child.stdout });
		lines.on('line', (line) => {
			let message;
			try { message = JSON.parse(line); } catch { finish(failure()); return; }
			const entry = pending.get(message.id);
			if (!entry) return;
			pending.delete(message.id); message.error ? entry.reject(failure()) : entry.resolve(message.result);
		});
		(async () => {
			await rpc('initialize', { clientInfo: { name: 'portless_home', title: 'Portless Home', version: '1.0.0' } });
			send({ method: 'initialized', params: {} });
			const account = await rpc('account/read', { refreshToken: false });
			await checkpoint();
			const usage = await rpc('account/rateLimits/read');
			await checkpoint();
			finish(null, { account: account.account, usage });
		})().catch((error) => finish(error instanceof ProviderError ? error : failure()));
	});
}

export function createProviders(config = {}, deps = {}) {
	const env = deps.env ?? process.env, home = deps.home ?? homedir(), platform = deps.platform ?? process.platform;
	const fetcher = deps.fetch ?? globalThis.fetch, clock = deps.clock ?? Date.now;
	const keychain = deps.keychain ?? createMacKeychain(deps.run ?? run);
	const rawClaudeDir = config.claudeDir ?? env.CLAUDE_CONFIG_DIR;
	const claudeDir = resolve(rawClaudeDir ?? join(home, '.claude'));
	const claudeConfig = resolve(config.claudeConfig ?? (rawClaudeDir ? join(claudeDir, '.claude.json') : join(home, '.claude.json')));
	const service = claudeKeychainService(rawClaudeDir), account = deps.username ?? userInfo().username;
	const codexHome = resolve(config.codexHome ?? env.CODEX_HOME ?? join(home, '.codex'));
	const rejectOverrides = (names) => { if (names.some((name) => env[name])) fail('UNSUPPORTED_LOGIN', 'An environment credential overrides this CLI login.'); };
	const readClaude = async (optional = false) => {
		if (platform === 'darwin') {
			const value = await keychain.read(service, account);
			if (value !== null) return { backend: 'keychain', credentials: parseProviderJson(value) };
		}
		const credentials = await readJson(join(claudeDir, '.credentials.json'), optional || platform === 'darwin');
		if (!credentials && !optional) fail('LOGIN_REQUIRED', 'Sign in to Claude Code CLI first.');
		return { backend: credentials ? 'file' : platform === 'darwin' ? 'keychain' : 'file', credentials };
	};
	const saveClaude = async (backend, credentials) => {
		if (backend === 'keychain') {
			const fallback = await readJson(join(claudeDir, '.credentials.json'), true);
			await keychain.write(service, account, JSON.stringify(credentials));
			if (fallback) await writeProviderJson(join(claudeDir, '.credentials.json'), credentials);
		} else await writeProviderJson(join(claudeDir, '.credentials.json'), credentials);
	};
	const codexBackend = async () => {
		const system = await settingsAt(config.codexSystemConfig ?? '/etc/codex/config.toml');
		const user = await settingsAt(join(codexHome, 'config.toml'));
		const required = await settingsAt(config.codexRequirements ?? '/etc/codex/requirements.toml');
		const mode = required.mode ?? user.mode ?? system.mode ?? 'file';
		if (mode === 'file') return { kind: 'file' };
		if (!['auto', 'keyring'].includes(mode) || platform !== 'darwin' || (required.secret ?? user.secret ?? system.secret) !== 'false') fail('UNSUPPORTED_STORE', 'This Codex credential backend is not supported. Use file storage or an explicitly configured direct macOS Keychain.');
		const canonical = await realpath(codexHome).catch(() => codexHome);
		const account = `cli|${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
		const text = await keychain.read('Codex Auth', account);
		return { kind: mode === 'auto' && text === null ? 'file' : 'keychain', account, text };
	};

	return {
		claude: {
			capture: guarded(async () => await withClaudeLocks(claudeDir, claudeConfig, async () => {
				rejectOverrides(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
				const native = await readJson(claudeConfig);
				if (native.primaryApiKey) fail('UNSUPPORTED_LOGIN', 'Only Claude Code subscription logins are supported.');
				const stored = await readClaude();
				const oauthAccount = Object.fromEntries(CLAUDE_FIELDS.filter((key) => key in (native.oauthAccount ?? {})).map((key) => [key, native.oauthAccount[key]]));
				const payload = { oauthAccount, credentials: { claudeAiOauth: copy(stored.credentials.claudeAiOauth) } };
				return { identity: identifyClaude(payload), payload };
			})),
			activate: guarded(async (payload) => {
				identifyClaude(payload);
				rejectOverrides(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
				await withClaudeLocks(claudeDir, claudeConfig, async () => {
					const original = await readClaude(true), originalConfig = await readJson(claudeConfig, true);
					if (originalConfig?.primaryApiKey) fail('UNSUPPORTED_LOGIN', 'Remove the overriding Claude API-key login first.');
					const credentials = { ...original.credentials, claudeAiOauth: copy(payload.credentials.claudeAiOauth) };
					try {
						await writeProviderJson(claudeConfig, { ...originalConfig, oauthAccount: copy(payload.oauthAccount) });
						await saveClaude(original.backend, credentials);
					} catch {
						if (original.credentials) await saveClaude(original.backend, original.credentials).catch(() => {});
						if (originalConfig) await writeProviderJson(claudeConfig, originalConfig).catch(() => {});
						else await rm(claudeConfig, { force: true }).catch(() => {});
						if (!original.credentials && original.backend === 'file') await rm(join(claudeDir, '.credentials.json'), { force: true }).catch(() => {});
						fail('ACTIVATION_FAILED', 'Claude Code could not restore this login.');
					}
				});
			}),
			usage: guarded(async (saved, { allowRefresh = true, onUpdate } = {}) => {
				const payload = copy(saved), identity = identifyClaude(payload), oauth = payload.credentials.claudeAiOauth;
				let refreshed = false;
				try {
				if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= clock() + 30_000) {
					if (!allowRefresh) fail('LOGIN_EXPIRED', 'Claude Code must renew its active login before usage can refresh.');
					if (!string(oauth.refreshToken)) fail('LOGIN_EXPIRED', 'Sign in to this Claude Code account again.');
					const renewed = await requestJson(fetcher, 'https://platform.claude.com/v1/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }) });
					if (!string(renewed.access_token) || !Number.isFinite(renewed.expires_in)) fail('INVALID_CREDENTIALS', 'Claude Code could not renew this login.');
					if (renewed.account?.uuid && renewed.account.uuid !== payload.oauthAccount.accountUuid || renewed.organization?.uuid && renewed.organization.uuid !== payload.oauthAccount.organizationUuid) fail('IDENTITY_MISMATCH', 'The refreshed Claude login belongs to another account.');
					oauth.accessToken = renewed.access_token; oauth.expiresAt = clock() + renewed.expires_in * 1000;
					if (string(renewed.refresh_token)) oauth.refreshToken = renewed.refresh_token;
					refreshed = true;
					await onUpdate?.(copy(payload), identity);
				}
				const data = await requestJson(fetcher, 'https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' } });
				return { payload, identity, windows: claudeWindows(data), observedAt: new Date(clock()).toISOString() };
				} catch (error) { if (refreshed) refreshedFailure(error, payload, identity); throw error; }
			}),
		},
		codex: {
			capture: guarded(async () => {
				rejectOverrides(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']);
				const backend = await codexBackend();
				const auth = backend.kind === 'file' ? await readJson(join(codexHome, 'auth.json')) : backend.text === null ? fail('LOGIN_REQUIRED', 'Sign in to Codex CLI first.') : parseProviderJson(backend.text);
				const payload = { auth };
				return { identity: identifyCodex(payload), payload };
			}),
			activate: guarded(async (payload) => {
				identifyCodex(payload);
				rejectOverrides(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']);
				const backend = await codexBackend();
				if (backend.kind === 'file') await writeProviderJson(join(codexHome, 'auth.json'), payload.auth);
				else {
					const path = join(codexHome, 'auth.json'), fallback = await readJson(path, true);
					try {
						await keychain.write('Codex Auth', backend.account, JSON.stringify(payload.auth));
						await rm(path, { force: true });
					} catch {
						if (backend.text !== null) await keychain.write('Codex Auth', backend.account, backend.text).catch(() => {});
						else await keychain.remove?.('Codex Auth', backend.account).catch(() => {});
						if (fallback) await writeProviderJson(path, fallback).catch(() => {});
						fail('ACTIVATION_FAILED', 'Codex could not restore this login.');
					}
				}
			}),
			usage: guarded(async (saved, { allowRefresh = true, onUpdate } = {}) => {
				const identity = identifyCodex(saved);
				if (!allowRefresh) {
					const workspace = codexWorkspace(saved);
					const data = await requestJson(fetcher, 'https://chatgpt.com/backend-api/wham/usage', { headers: { Authorization: `Bearer ${saved.auth.tokens.access_token}`, 'ChatGPT-Account-Id': workspace, 'User-Agent': 'portless-home' } });
					if (data.account_id && data.account_id !== workspace) fail('IDENTITY_MISMATCH', 'The Codex usage belongs to another account.');
					return { payload: copy(saved), windows: codexWindows(data, true), observedAt: new Date(clock()).toISOString(), identity: { ...identity, tier: data.plan_type ?? identity.tier } };
				}
				const temporary = await mkdtemp(join(deps.tmpdir ?? tmpdir(), 'portless-home-codex-'));
				await chmod(temporary, 0o700);
				let checkpointed = JSON.stringify(saved);
				const checkpoint = async () => {
					const payload = { auth: await readJson(join(temporary, 'auth.json')) }, updated = identifyCodex(payload);
					if (updated.accountId !== identity.accountId) fail('IDENTITY_MISMATCH', 'Codex renewed a different account.');
					const snapshot = JSON.stringify(payload);
					if (snapshot !== checkpointed) { await onUpdate?.(copy(payload), updated); checkpointed = snapshot; }
					return { payload, identity: updated };
				};
				try {
					await writeProviderJson(join(temporary, 'auth.json'), saved.auth);
					const childEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'].filter((key) => env[key]).map((key) => [key, env[key]]));
					Object.assign(childEnv, { CODEX_HOME: temporary, HOME: temporary });
					const result = await (deps.appServer ?? probeCodex)(config.codexCommand ?? 'codex', temporary, childEnv, checkpoint);
					const { payload, identity: updated } = await checkpoint();
					if (updated.accountId !== identity.accountId || result.account?.type !== 'chatgpt' || result.account.email && identity.email && result.account.email !== identity.email) fail('IDENTITY_MISMATCH', 'Codex renewed a different account.');
					return { payload, windows: codexWindows(result.usage), observedAt: new Date(clock()).toISOString(), identity: { ...updated, tier: result.account.planType ?? updated.tier } };
				} catch (error) {
					const payload = await readJson(join(temporary, 'auth.json'), true).then((auth) => auth && { auth }).catch(() => null);
					if (payload && identifyCodex(payload).accountId === identity.accountId && JSON.stringify(payload) !== JSON.stringify(saved)) {
						await checkpoint().catch(() => {});
						refreshedFailure(error, payload, identity);
					}
					throw error;
				} finally { await rm(temporary, { recursive: true, force: true }); }
			}),
		},
	};
}
