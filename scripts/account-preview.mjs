// Isolated browser fixture: the real account manager and HTTP layer, synthetic providers.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountManager, accountId } from '../accounts.mjs';
import { accountHttp } from '../accounts-http.mjs';
import { accountVault, privateWrite } from '../account-store.mjs';
import { page } from '../render.mjs';

export const scenarios = ['detected', 'populated', 'empty', 'unavailable', 'remote-only', 'busy', 'error', 'stale', 'long-content', 'disabled'];
const observedAt = '2026-10-25T12:00:00.000Z';
const windows = (usedPercent) => [
	{ key: 'five-hour', label: 'Five hours', usedPercent, resetsAt: '2026-10-25T15:00:00.000Z', windowMinutes: 300 },
	{ key: 'weekly', label: 'Weekly', usedPercent: usedPercent + 8, resetsAt: '2026-10-28T12:00:00.000Z', windowMinutes: 10080 },
];
const login = (provider, name) => ({
	identity: { provider, accountId: `${name}:fixture`, email: `${name}@example.test`, tier: provider === 'claude' ? 'Max' : 'Pro' },
	payload: { fixture: name },
});
const saved = (provider, name, usedPercent) => ({
	...login(provider, name).identity, id: accountId(provider, `${name}:fixture`), payload: login(provider, name).payload,
	label: name[0].toUpperCase() + name.slice(1), priority: 0, reservePercent: 0, disabled: false,
	usageStatus: 'fresh', observedAt, windows: windows(usedPercent), preferencesUpdatedAt: observedAt,
});

export async function startAccountPreview() {
	const directory = mkdtempSync(join(tmpdir(), 'portless-account-preview-'));
	const configPath = join(directory, 'config.json');
	const vault = accountVault(`${configPath}.vault`);
	let scenario;
	let current;
	let busy;
	class ProviderError extends Error {}
	const providers = Object.fromEntries(['claude', 'codex'].map((provider) => [provider, {
		async capture() {
			if (!current[provider]) throw new ProviderError(scenario === 'unavailable' ? 'The credential store is unavailable. Try again after unlocking it.' : 'Sign in through this CLI, then reload accounts.');
			return login(provider, current[provider]);
		},
		async activate(payload) { current[provider] = payload.fixture; },
		async usage(payload) { return { payload, windows: windows(28), observedAt }; },
	}]));
	const manager = createAccountManager({ configPath, providersFactory: () => providers, inspectProcesses: () => busy, clock: () => new Date(observedAt) });
	async function reset(name) {
		if (!scenarios.includes(name)) throw new Error('Unknown account preview scenario.');
		scenario = name;
		current = { claude: 'personal', codex: 'work' };
		busy = { claude: name === 'busy', codex: false };
		privateWrite(configPath, JSON.stringify({ enabled: name !== 'disabled' }));
		await vault.update((state) => {
			state.accounts = ['detected', 'empty', 'remote-only', 'disabled'].includes(name) ? [] : [saved('claude', 'personal', 74), saved('claude', 'work', 22), saved('codex', 'work', 18)];
			state.remote = [];
			state.pending = name === 'busy' ? [{ provider: 'claude', id: accountId('claude', 'work:fixture'), reason: 'Work has more allowance. Waiting for your confirmation.' }] : [];
			state.policy = { strategy: 'best', threshold: 90, auto: false };
			if (['empty', 'unavailable', 'remote-only'].includes(name)) current = {};
			if (name === 'long-content') {
				state.accounts[0].label = 'Product engineering / Europe / alternate subscription';
				state.accounts[0].email = 'engineer.with.a.long.account.identifier@organization.example.test';
			}
			if (name === 'stale') state.accounts[0].observedAt = '2026-10-24T12:00:00.000Z';
			if (name === 'error') state.accounts[0].error = 'Usage check failed. Sign in again through the CLI, then check usage.';
			if (name === 'remote-only') state.remote = [{ accounts: [saved('claude', 'travel', 32)] }];
		});
	}
	await reset('detected');
	const render = (accounts) => page({ view: 'accounts', accounts });
	const handleAccounts = accountHttp(manager, render);
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url, 'http://localhost');
			if (url.pathname === '/fixture') {
				await reset(url.searchParams.get('state') || 'detected');
				res.writeHead(302, { Location: '/accounts' }).end();
				return;
			}
			if (url.pathname === '/fixture/login') {
				const provider = url.searchParams.get('provider');
				const name = url.searchParams.get('name');
				if (!['claude', 'codex'].includes(provider) || !['personal', 'work'].includes(name)) throw new Error('Unknown fixture login.');
				current[provider] = name;
				res.writeHead(204).end();
				return;
			}
			if (url.pathname === '/assets/ui.js' || url.pathname === '/assets/ui.css') {
				res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
				res.end(readFileSync(new URL(`../dist/${url.pathname.split('/').at(-1)}`, import.meta.url)));
				return;
			}
			if (await handleAccounts(req, res)) return;
			res.writeHead(204).end();
		} catch (error) { res.writeHead(500).end(error.message); }
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		async close() { await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); },
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const preview = await startAccountPreview();
	console.log(preview.url);
	for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await preview.close(); process.exit(); });
}
