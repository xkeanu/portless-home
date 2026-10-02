import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMacKeychain, createProviders, identifyCodex, claudeKeychainService, codexWindows, ProviderError } from './account-providers.mjs';

const now = Date.parse('2026-10-02T12:00:00Z');
const reset = '2026-10-02T17:00:00Z';
const claudePayload = (id = 'alice') => ({
	oauthAccount: { accountUuid: id, emailAddress: `${id}@example.com`, organizationUuid: 'org', organizationName: 'Work' },
	credentials: { claudeAiOauth: { accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}`, expiresAt: now + 3600_000, subscriptionType: 'max' } },
});
const idToken = (user, account = 'workspace') => `fixture.${Buffer.from(JSON.stringify({ sub: user, email: `${user}@example.com`, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'pro' } })).toString('base64url')}.fixture`;
const codexPayload = (user = 'alice', account = 'workspace') => ({ auth: { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: idToken(user, account), account_id: account, access_token: `fixture-codex-access-${user}`, refresh_token: `fixture-codex-refresh-${user}` }, last_refresh: '2026-10-01T12:00:00Z' } });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) });
const claudeUsage = { five_hour: { utilization: 25, resets_at: reset }, seven_day: { utilization: 70, resets_at: '2026-10-05T12:00:00Z' } };
const codexUsage = { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 }, secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: Date.parse('2026-10-05T12:00:00Z') / 1000 } } };

async function fixture(t, deps = {}) {
	const home = await mkdtemp(join(tmpdir(), 'portless-home-providers-test-'));
	t.after(() => rm(home, { recursive: true, force: true }));
	const config = { claudeDir: join(home, '.claude'), claudeConfig: join(home, '.claude.json'), codexHome: join(home, '.codex'), codexSystemConfig: join(home, 'system.toml'), codexRequirements: join(home, 'requirements.toml') };
	await mkdir(config.claudeDir); await mkdir(config.codexHome);
	const dependencies = { home, platform: 'linux', env: {}, clock: () => now, tmpdir: home, ...deps };
	return { home, config, dependencies, providers: createProviders(config, dependencies) };
}
const json = (path, data) => writeFile(path, JSON.stringify(data));
async function assertPrivateMode(path) {
	// Windows inherits profile ACLs; chmod does not distinguish POSIX owner bits.
	if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
}

test('Claude captures only account login and identity, and releases native locks', async (t) => {
	const f = await fixture(t);
	const payload = claudePayload();
	await json(f.config.claudeConfig, { oauthAccount: payload.oauthAccount, projects: { fixture: true } });
	await json(join(f.config.claudeDir, '.credentials.json'), { ...payload.credentials, mcpOAuth: { private: 'fixture-other-service' } });
	const saved = await f.providers.claude.capture();
	assert.deepEqual(saved.identity, { provider: 'claude', accountId: 'alice:org', email: 'alice@example.com', tier: 'max' });
	assert.deepEqual(saved.payload, payload);
	assert.deepEqual(await readdir(f.config.claudeDir), ['.credentials.json']);
	await f.providers.claude.capture();
});

test('Claude activation preserves native settings and shared OAuth fields with private atomic files', async (t) => {
	const f = await fixture(t);
	await json(f.config.claudeConfig, { oauthAccount: claudePayload().oauthAccount, preferences: { theme: 'dark' } });
	await json(join(f.config.claudeDir, '.credentials.json'), { ...claudePayload().credentials, mcpOAuth: { keep: true } });
	await f.providers.claude.activate(claudePayload('bob'));
	const native = JSON.parse(await readFile(join(f.config.claudeDir, '.credentials.json'), 'utf8'));
	assert.equal(native.claudeAiOauth.accessToken, 'fixture-access-bob');
	assert.deepEqual(native.mcpOAuth, { keep: true });
	assert.deepEqual(JSON.parse(await readFile(f.config.claudeConfig, 'utf8')).preferences, { theme: 'dark' });
	await assertPrivateMode(join(f.config.claudeDir, '.credentials.json'));
	await assertPrivateMode(f.config.claudeConfig);
	assert.ok(!(await readdir(f.home)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')));
});

test('macOS Claude uses effective Keychain credentials and leaves fileless users fileless', async (t) => {
	let value = JSON.stringify(claudePayload().credentials);
	const calls = [];
	const f = await fixture(t, { platform: 'darwin', username: 'fixture-user', keychain: { read: async (...args) => { calls.push(args); return value; }, write: async (...args) => { calls.push(args.slice(0, 2)); value = args[2]; } } });
	await json(f.config.claudeConfig, { oauthAccount: claudePayload().oauthAccount });
	const captured = await f.providers.claude.capture();
	assert.deepEqual(captured.payload.credentials, claudePayload().credentials);
	assert.equal(calls[0][0], claudeKeychainService(f.config.claudeDir));
	await f.providers.claude.activate(claudePayload('bob'));
	assert.equal(JSON.parse(value).claudeAiOauth.accessToken, 'fixture-access-bob');
	assert.deepEqual(await readdir(f.config.claudeDir), []);
});

test('Keychain failures never silently capture a stale file', async (t) => {
	const f = await fixture(t, { platform: 'darwin', keychain: { read: async () => { throw new ProviderError('KEYCHAIN_UNAVAILABLE', 'Unlock the macOS Keychain and try again.'); } } });
	await json(f.config.claudeConfig, { oauthAccount: claudePayload().oauthAccount });
	await json(join(f.config.claudeDir, '.credentials.json'), claudePayload().credentials);
	await assert.rejects(f.providers.claude.capture(), { code: 'KEYCHAIN_UNAVAILABLE' });
});

test('macOS writes secret bytes on stdin only and reports safe errors', async () => {
	let call;
	const keychain = createMacKeychain(async (command, args, options) => { call = { command, args, options }; return { code: 0, stdout: '' }; });
	const secret = JSON.stringify({ fixture: 'quote " backslash \\ newline\n secret' });
	await keychain.write('Claude Code-credentials', 'fixture-user', secret);
	assert.deepEqual(call.args, ['-i']);
	assert.ok(!JSON.stringify(call.args).includes(secret));
	assert.ok(call.options.input.endsWith(`-X ${Buffer.from(secret).toString('hex')}\n`));
	await assert.rejects(keychain.write('bad"\ncommand', 'fixture', secret), { code: 'UNSUPPORTED_STORE' });
	const denied = createMacKeychain(async () => ({ code: 1, stdout: secret }));
	await assert.rejects(denied.write('fixture', 'fixture', secret), (error) => error.code === 'KEYCHAIN_UNAVAILABLE' && !error.message.includes('secret'));
});

test('macOS reads hex-encoded Keychain JSON without losing Unicode or escaped controls', async () => {
	const value = JSON.stringify({ fixture: 'Unicode 🧪 and escaped newline\n' });
	const keychain = createMacKeychain(async () => ({ code: 0, stdout: Buffer.from(value).toString('hex').toUpperCase() + '\n' }));
	assert.equal(await keychain.read('fixture', 'fixture'), value);
	const invalid = createMacKeychain(async () => ({ code: 0, stdout: 'FFFE\n' }));
	await assert.rejects(invalid.read('fixture', 'fixture'), { code: 'INVALID_CREDENTIALS' });
});

test('Claude usage preserves plan-scaled percentages and scoped weekly reset windows', async (t) => {
	let calls = 0;
	const f = await fixture(t, { fetch: async (url, options) => { calls++; assert.equal(options.headers.Authorization, 'Bearer fixture-access-alice'); return response({ ...claudeUsage, limits: [{ scope: { model: { display_name: 'Opus' } }, percent: 40, resets_at: reset }] }); } });
	const result = await f.providers.claude.usage(claudePayload());
	assert.equal(calls, 1);
	assert.deepEqual(result.windows.map((entry) => [entry.key, entry.usedPercent, entry.windowMinutes]), [['five_hour', 25, 300], ['seven_day', 70, 10080], ['model:opus', 40, 10080]]);
	assert.equal(result.windows[2].model, 'opus');
	assert.equal(result.observedAt, new Date(now).toISOString());
});

test('active Claude does not rotate its saved refresh token', async (t) => {
	const f = await fixture(t, { fetch: async () => assert.fail('Must not make a refresh request') });
	const payload = claudePayload(); payload.credentials.claudeAiOauth.expiresAt = now - 1;
	await assert.rejects(f.providers.claude.usage(payload, { allowRefresh: false }), { code: 'LOGIN_EXPIRED' });
	assert.equal(payload.credentials.claudeAiOauth.refreshToken, 'fixture-refresh-alice');
});

test('Claude native model quotas preserve exhausted Sonnet and Opus constraints', async (t) => {
	const f = await fixture(t, { fetch: async () => response({ ...claudeUsage, seven_day_sonnet: { utilization: 100, resets_at: reset }, seven_day_opus: { utilization: 90, resets_at: reset } }) });
	const result = await f.providers.claude.usage(claudePayload(), { allowRefresh: false });
	assert.deepEqual(result.windows.filter((entry) => entry.model).map((entry) => [entry.key, entry.model, entry.usedPercent, entry.windowMinutes]), [['seven_day_sonnet', 'sonnet', 100, 10080], ['seven_day_opus', 'opus', 90, 10080]]);
});

test('Codex ignores additional quota buckets without a usable native feature identity', () => {
	const bucket = { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: Date.parse(reset) / 1000 } };
	const result = codexWindows({ rate_limit: bucket, additional_rate_limits: [{ rate_limit: bucket }, { metered_feature: null, rate_limit: bucket }, { metered_feature: 'review', rate_limit: bucket }] }, true);
	assert.deepEqual(result.map((entry) => entry.key), ['codex:primary', 'review:primary']);
});

test('inactive Claude renews once and returns rotated tokens without changing native state', async (t) => {
	const urls = [];
	let checkpoint;
	const f = await fixture(t, { fetch: async (url, options) => {
		urls.push(url);
		if (options.method === 'POST') return response({ access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh', expires_in: 3600, account: { uuid: 'alice' }, organization: { uuid: 'org' } });
		assert.equal(checkpoint.payload.credentials.claudeAiOauth.refreshToken, 'fixture-new-refresh');
		assert.equal(options.headers.Authorization, 'Bearer fixture-new-access'); return response(claudeUsage);
	} });
	const saved = claudePayload(); saved.credentials.claudeAiOauth.expiresAt = now - 1;
	const result = await f.providers.claude.usage(saved, { onUpdate: async (payload, identity) => { checkpoint = { payload, identity }; } });
	assert.equal(urls.length, 2);
	assert.equal(result.payload.credentials.claudeAiOauth.refreshToken, 'fixture-new-refresh');
	assert.equal(saved.credentials.claudeAiOauth.refreshToken, 'fixture-refresh-alice');
	assert.equal(checkpoint.identity.accountId, 'alice:org');
	assert.deepEqual(await readdir(f.config.claudeDir), []);
});

test('post-refresh Claude quota failure preserves the new login for the encrypted vault', async (t) => {
	const f = await fixture(t, { fetch: async (url, options) => response(options.method === 'POST' ? { access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh', expires_in: 3600 } : { detail: 'fixture-private-body' }, options.method === 'POST' ? 200 : 500) });
	const saved = claudePayload(); saved.credentials.claudeAiOauth.expiresAt = now - 1;
	await assert.rejects(f.providers.claude.usage(saved), (error) => error.code === 'USAGE_UNAVAILABLE' && error.updatedPayload.credentials.claudeAiOauth.refreshToken === 'fixture-new-refresh' && !JSON.stringify(error).includes('fixture'));
});

test('Claude rejects a refreshed identity mismatch', async (t) => {
	const f = await fixture(t, { fetch: async () => response({ access_token: 'fixture-foreign-access', expires_in: 3600, account: { uuid: 'bob' } }) });
	const saved = claudePayload(); saved.credentials.claudeAiOauth.expiresAt = now - 1;
	await assert.rejects(f.providers.claude.usage(saved), (error) => error.code === 'IDENTITY_MISMATCH' && !error.updatedPayload);
});

test('Codex identity distinguishes users sharing a workspace', () => {
	assert.equal(identifyCodex(codexPayload()).accountId, 'alice:workspace');
	assert.notEqual(identifyCodex(codexPayload()).accountId, identifyCodex(codexPayload('bob')).accountId);
	const wrong = codexPayload(); wrong.auth.tokens.account_id = 'other-workspace';
	assert.throws(() => identifyCodex(wrong), { code: 'IDENTITY_MISMATCH' });
});

test('Codex captures and activates supported file credentials atomically', async (t) => {
	const f = await fixture(t);
	await json(join(f.config.codexHome, 'auth.json'), codexPayload().auth);
	assert.deepEqual((await f.providers.codex.capture()).payload, codexPayload());
	await f.providers.codex.activate(codexPayload('bob'));
	assert.deepEqual(JSON.parse(await readFile(join(f.config.codexHome, 'auth.json'), 'utf8')), codexPayload('bob').auth);
	await assertPrivateMode(join(f.config.codexHome, 'auth.json'));
});

test('Codex rejects encrypted, ephemeral and ambiguous profile storage without using stale auth files', async (t) => {
	const f = await fixture(t, { platform: 'darwin', keychain: { read: async () => assert.fail('Unsupported storage must not read Keychain') } });
	await json(join(f.config.codexHome, 'auth.json'), codexPayload().auth);
	for (const config of ['cli_auth_credentials_store = "ephemeral"', 'cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = true', 'cli_auth_credentials_store = "auto"', '[profiles.work]\ncli_auth_credentials_store = "file"', '"cli_auth_credentials_store" = "ephemeral"', 'profiles.work.cli_auth_credentials_store = "file"']) {
		await writeFile(join(f.config.codexHome, 'config.toml'), config);
		await assert.rejects(f.providers.codex.capture(), { code: 'UNSUPPORTED_STORE' });
	}
});

test('explicit direct macOS Codex Keychain uses the native service and hashed home identity', async (t) => {
	const calls = [];
	const f = await fixture(t, { platform: 'darwin', keychain: { read: async (...args) => { calls.push(args); return JSON.stringify(codexPayload().auth); }, write: async (...args) => { calls.push(args.slice(0, 2)); } } });
	await writeFile(join(f.config.codexHome, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = false');
	await json(join(f.config.codexHome, 'auth.json'), codexPayload('stale-fallback').auth);
	assert.deepEqual((await f.providers.codex.capture()).payload, codexPayload());
	await f.providers.codex.activate(codexPayload('bob'));
	assert.ok(calls.every(([service, account]) => service === 'Codex Auth' && /^cli\|[a-f0-9]{16}$/.test(account)));
	await assert.rejects(readFile(join(f.config.codexHome, 'auth.json')), { code: 'ENOENT' });
});

test('active Codex reads published quota endpoint using the workspace header without refreshing', async (t) => {
	const f = await fixture(t, { appServer: async () => assert.fail('Active account must not spawn a managed refresh copy'), fetch: async (url, options) => {
		assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
		assert.equal(options.headers['ChatGPT-Account-Id'], 'workspace');
		assert.equal(options.headers.Authorization, 'Bearer fixture-codex-access-alice');
		return response({ account_id: 'workspace', plan_type: 'pro', rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 18000, reset_at: Date.parse(reset) / 1000 } } });
	} });
	const result = await f.providers.codex.usage(codexPayload(), { allowRefresh: false, onUpdate: async () => assert.fail('A quota read must not checkpoint refreshed credentials') });
	assert.equal(result.windows[0].usedPercent, 60); assert.equal(result.windows[0].windowMinutes, 300);
	assert.deepEqual(result.payload, codexPayload());
});

test('isolated Codex refresh returns native rotated tokens and removes temporary plaintext', async (t) => {
	const checkpoints = [];
	const f = await fixture(t, { env: { PATH: process.env.PATH, CODEX_HOME: 'must-not-inherit', OPENAI_API_KEY: 'fixture-never-inherit' }, appServer: async (command, temporary, env) => {
		assert.equal(command, 'codex'); assert.equal(env.HOME, temporary); assert.equal(env.CODEX_HOME, temporary); assert.equal(env.OPENAI_API_KEY, undefined);
		const auth = JSON.parse(await readFile(join(temporary, 'auth.json'), 'utf8'));
		auth.tokens.refresh_token = 'fixture-renewed-codex';
		await json(join(temporary, 'auth.json'), auth);
		return { account: { type: 'chatgpt', email: 'alice@example.com', planType: 'pro' }, usage: codexUsage };
	} });
	const result = await f.providers.codex.usage(codexPayload(), { onUpdate: async (payload, identity) => { checkpoints.push({ payload, identity }); } });
	assert.equal(result.payload.auth.tokens.refresh_token, 'fixture-renewed-codex');
	assert.equal(result.windows[1].windowMinutes, 10080);
	assert.equal(checkpoints.length, 1);
	assert.equal(checkpoints[0].identity.accountId, 'alice:workspace');
	assert.ok(!(await readdir(f.home)).some((name) => name.startsWith('portless-home-codex-')));
});

test('Windows Codex subprocess homes and temporary paths are private and never inherited', async (t) => {
	const f = await fixture(t, { platform: 'win32', env: { USERPROFILE: 'must-not-inherit-profile', APPDATA: 'must-not-inherit-roaming', LOCALAPPDATA: 'must-not-inherit-local', TMPDIR: 'must-not-inherit-temp' }, appServer: async (command, temporary, env) => {
		for (const key of ['HOME', 'CODEX_HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP']) assert.equal(env[key], temporary);
		assert.equal(env.APPDATA, join(temporary, 'AppData', 'Roaming'));
		assert.equal(env.LOCALAPPDATA, join(temporary, 'AppData', 'Local'));
		assert.ok((await stat(env.APPDATA)).isDirectory()); assert.ok((await stat(env.LOCALAPPDATA)).isDirectory());
		return { account: { type: 'chatgpt', email: 'alice@example.com', planType: 'pro' }, usage: codexUsage };
	} });
	await f.providers.codex.usage(codexPayload());
	assert.ok(!(await readdir(f.home)).some((name) => name.startsWith('portless-home-codex-')));
});

test('Windows service account-home defaults use the configured profile and preserve native CLI directory overrides', async (t) => {
	const f = await fixture(t);
	await json(f.config.claudeConfig, { oauthAccount: claudePayload().oauthAccount });
	await json(join(f.config.claudeDir, '.credentials.json'), claudePayload().credentials);
	await json(join(f.config.codexHome, 'auth.json'), codexPayload().auth);
	const config = { codexSystemConfig: f.config.codexSystemConfig, codexRequirements: f.config.codexRequirements };
	const deps = { ...f.dependencies, home: undefined, platform: 'win32', env: { PORTLESS_ACCOUNT_HOME: f.home } };
	let providers = createProviders(config, deps);
	assert.equal((await providers.claude.capture()).identity.email, 'alice@example.com');
	assert.equal((await providers.codex.capture()).identity.email, 'alice@example.com');
	const claudeDir = join(f.home, 'explicit-claude'), codexHome = join(f.home, 'explicit-codex');
	await mkdir(claudeDir); await mkdir(codexHome);
	await json(join(claudeDir, '.claude.json'), { oauthAccount: claudePayload('bob').oauthAccount });
	await json(join(claudeDir, '.credentials.json'), claudePayload('bob').credentials);
	await json(join(codexHome, 'auth.json'), codexPayload('bob').auth);
	providers = createProviders(config, { ...deps, env: { PORTLESS_ACCOUNT_HOME: f.home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome } });
	assert.equal((await providers.claude.capture()).identity.email, 'bob@example.com');
	assert.equal((await providers.codex.capture()).identity.email, 'bob@example.com');
});

test('Codex retains rotated tokens even when quota RPC subsequently fails', async (t) => {
	let checkpoint;
	const f = await fixture(t, { appServer: async (command, temporary) => {
		const auth = codexPayload().auth; auth.tokens.refresh_token = 'fixture-renewed-after-failure';
		await json(join(temporary, 'auth.json'), auth);
		throw new Error('fixture-secret-in-raw-child-error');
	} });
	await assert.rejects(f.providers.codex.usage(codexPayload(), { onUpdate: async (payload) => { checkpoint = payload; } }), (error) => error.updatedPayload.auth.tokens.refresh_token === 'fixture-renewed-after-failure' && !JSON.stringify(error).includes('fixture'));
	assert.equal(checkpoint.auth.tokens.refresh_token, 'fixture-renewed-after-failure');
});

test('Codex native protocol handshake performs account reads without any agent turn', { skip: process.platform === 'win32' ? 'The disposable executable fixture uses a POSIX shebang.' : false }, async (t) => {
	const f = await fixture(t, { env: { PATH: process.env.PATH } });
	const command = join(f.home, 'codex-fixture');
	const checkpointPath = join(f.home, 'checkpoint.json'), pidPath = join(f.home, 'child-pid');
	const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
if (!process.argv.includes('cli_auth_credentials_store="file"') || !process.argv.includes('features.secret_auth_storage=false')) process.exit(3);
let initialized = false;
createInterface({ input: process.stdin }).on('line', (line) => {
 const request = JSON.parse(line);
 if (request.method === 'initialize') return setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n'), 5);
 if (request.method === 'initialized') { initialized = true; return; }
 if (!initialized || !['account/read', 'account/rateLimits/read'].includes(request.method)) process.exit(2);
 if (request.method === 'account/read') {
  const path = process.env.CODEX_HOME + '/auth.json';
  const auth = JSON.parse(readFileSync(path, 'utf8')); auth.tokens.refresh_token = 'fixture-native-refresh'; writeFileSync(path, JSON.stringify(auth));
  process.stdout.write(JSON.stringify({ id: request.id, result: { account: { type: 'chatgpt', email: 'alice@example.com', planType: 'pro' } } }) + '\\n');
 }
 else {
  const checkpoint = JSON.parse(readFileSync(${JSON.stringify(checkpointPath)}, 'utf8'));
  if (checkpoint.auth.tokens.refresh_token !== 'fixture-native-refresh') process.exit(4);
  process.stdout.write(JSON.stringify({ id: request.id, result: ${JSON.stringify(codexUsage)} }) + '\\n');
 }
});\n`;
	await writeFile(command, script); await chmod(command, 0o700);
	f.config.codexCommand = command;
	const result = await createProviders(f.config, f.dependencies).codex.usage(codexPayload(), { onUpdate: async (payload) => json(checkpointPath, payload) });
	assert.equal(result.payload.auth.tokens.refresh_token, 'fixture-native-refresh');
	const childPid = Number(await readFile(pidPath, 'utf8'));
	assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

test('unsupported and malformed logins expose only safe messages', async (t) => {
	const f = await fixture(t);
	await json(join(f.config.codexHome, 'auth.json'), { OPENAI_API_KEY: 'fixture-private-api-key' });
	await assert.rejects(f.providers.codex.capture(), (error) => error.code === 'UNSUPPORTED_LOGIN' && !error.message.includes('fixture'));
	await writeFile(join(f.config.codexHome, 'auth.json'), '{ fixture-private-broken-json');
	await assert.rejects(f.providers.codex.capture(), (error) => error.code === 'INVALID_CREDENTIALS' && !error.message.includes('fixture'));
});

test('activation refuses environment credentials that would override the restored CLI login', async (t) => {
	const f = await fixture(t, { env: { ANTHROPIC_API_KEY: 'fixture-api-key', CODEX_ACCESS_TOKEN: 'fixture-external-token' } });
	await assert.rejects(f.providers.claude.activate(claudePayload()), { code: 'UNSUPPORTED_LOGIN' });
	await assert.rejects(f.providers.codex.activate(codexPayload()), { code: 'UNSUPPORTED_LOGIN' });
	assert.deepEqual(await readdir(f.config.claudeDir), []);
	assert.deepEqual(await readdir(f.config.codexHome), []);
});

test('Claude restores the prior config when Keychain activation is denied', async (t) => {
	const writes = [];
	const f = await fixture(t, { platform: 'darwin', keychain: { read: async () => JSON.stringify(claudePayload().credentials), write: async (service, account, value) => { writes.push(JSON.parse(value)); throw new ProviderError('KEYCHAIN_UNAVAILABLE', 'The Keychain is locked.'); } } });
	const original = { oauthAccount: claudePayload().oauthAccount, preferences: { keep: true } };
	await json(f.config.claudeConfig, original);
	await assert.rejects(f.providers.claude.activate(claudePayload('bob')), { code: 'ACTIVATION_FAILED' });
	assert.deepEqual(JSON.parse(await readFile(f.config.claudeConfig, 'utf8')), original);
	assert.equal(writes[0].claudeAiOauth.accessToken, 'fixture-access-bob');
	assert.equal(writes[1].claudeAiOauth.accessToken, 'fixture-access-alice');
});
