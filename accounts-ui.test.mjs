import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDirectory } from './dist/ui-server.mjs';
import { strings } from './i18n.mjs';

const bundle = readFileSync(new URL('./dist/ui.js', import.meta.url), 'utf8');
const fixture = () => ({
	enabled: true,
	providers: [{ id: 'claude', label: 'Claude Code CLI', supported: true }, { id: 'codex', label: 'Codex CLI', supported: true }],
	accounts: [],
	policy: { strategy: 'best', threshold: 90, auto: false },
	pending: [],
	busy: { claude: false, codex: false },
	sync: { configured: false, count: 0 },
});
const account = (id, changes = {}) => ({ id, provider: 'claude', accountId: id, email: `${id}@example.test`, label: id, tier: 'Max', active: false, availableLocally: true, disabled: false, priority: 0, reservePercent: 0, usageStatus: 'unknown', windows: [], ...changes });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const response = (data, ok = true) => ({ ok, json: async () => data });

async function mount(changes = {}, fetch) {
	const data = { ...fixture(), ...changes };
	const model = { view: 'accounts', accounts: data, t: strings('en') };
	const errors = [];
	const virtualConsole = new VirtualConsole();
	virtualConsole.on('jsdomError', (error) => errors.push(error));
	const html = `<div id="directory">${renderDirectory(model)}</div><script id="page-data" type="application/json">${JSON.stringify(model).replace(/</g, '\\u003c')}</script>`;
	const dom = new JSDOM(html, { url: 'http://localhost:5995/accounts', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
	const { window } = dom;
	const requests = [];
	const streams = [];
	window.EventSource = class { constructor(url) { streams.push(url); } };
	window.fetch = (path, init) => {
		requests.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
		return fetch?.(path, init) ?? Promise.resolve(response(data));
	};
	window.eval(bundle);
	await settle();
	return { dom, window, document: window.document, requests, streams, errors, close: () => window.close() };
}

function change(ui, input, value) {
	input.value = value;
	input.dispatchEvent(new ui.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

test('account page escapes metadata, isolates directory events and explains local capture', async () => {
	const ui = await mount({
		accounts: [account('remote', { label: '<img src=x onerror=evil()>', availableLocally: false })],
		sync: { configured: true, count: 1 },
	});
	try {
		assert.equal(ui.document.querySelector('main').getAttribute('lang'), 'en');
		assert.equal(ui.document.querySelector('h3').textContent, '<img src=x onerror=evil()>');
		assert.equal(ui.document.querySelector('img'), null);
		assert.equal(ui.document.querySelector('[data-switch]').disabled, true);
		assert.match(ui.document.querySelector('.state').textContent, /Sign in on this device/);
		assert.match(ui.document.querySelector('.scope-note').textContent, /Desktop app logins are separate/);
		assert.match(ui.document.querySelector('.sync').textContent, /Log in separately on each device/);
		ui.document.dispatchEvent(new ui.window.Event('visibilitychange'));
		assert.deepEqual(ui.requests, []);
		assert.deepEqual(ui.streams, []);
		assert.deepEqual(ui.errors, []);
	} finally { ui.close(); }
});

test('capture uses a provider and label only, prevents duplicate requests, and updates the page', async () => {
	let resolve;
	const pending = new Promise((done) => { resolve = done; });
	const ui = await mount({}, () => pending);
	try {
		const form = ui.document.querySelector('.capture form');
		change(ui, form.querySelector('select'), 'claude');
		change(ui, form.querySelector('input'), 'Work');
		await settle();
		form.requestSubmit();
		await settle();
		assert.deepEqual(ui.requests, [{ path: '/api/accounts/capture', method: 'POST', body: { provider: 'claude', label: 'Work' } }]);
		assert.equal(form.querySelector('button').disabled, true);
		form.requestSubmit();
		assert.equal(ui.requests.length, 1);
		resolve(response({ ...fixture(), accounts: [account('work', { label: 'Work' })] }));
		await settle();
		assert.equal(ui.document.querySelector('h3').textContent, 'Work');
		assert.equal(form.querySelector('input').value, '');
		assert.match(ui.document.querySelector('.notice').textContent, /Current CLI login saved/);
		assert.equal(form.querySelector('button').disabled, false);
		assert.deepEqual(ui.errors, []);
	} finally { ui.close(); }
});

test('switch waits for explicit stopped-session confirmation and preserves a rejected switch for retry', async () => {
	let succeeds = false;
	const rows = [account('first', { active: true }), account('second')];
	const ui = await mount({ accounts: rows }, () => Promise.resolve(succeeds
		? response({ ...fixture(), accounts: [account('first'), account('second', { active: true })] })
		: response({ error: 'Claude Code is still running. Stop it and try again.' }, false)));
	try {
		ui.document.querySelector('[data-switch="second"]').click();
		await settle();
		const form = ui.document.querySelector('.switch-confirm');
		assert.equal(form.querySelector('[type="submit"]').disabled, true);
		form.dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
		assert.deepEqual(ui.requests, []);
		form.querySelector('[type="checkbox"]').click();
		await settle();
		form.requestSubmit();
		await settle();
		assert.deepEqual(ui.requests[0], { path: '/api/accounts/switch', method: 'POST', body: { id: 'second' } });
		assert.match(ui.document.querySelector('[role="alert"]').textContent, /still running/);
		assert.equal(form.querySelector('[type="submit"]').disabled, false);
		succeeds = true;
		form.requestSubmit();
		await settle();
		assert.equal(ui.document.querySelector('.switch-confirm'), null);
		assert.equal(ui.document.querySelector('[data-switch="second"]').disabled, true);
		assert.match(ui.document.querySelector('.notice').textContent, /restart your CLI when ready/);
		assert.deepEqual(ui.errors, []);
	} finally { ui.close(); }
});

test('live CLIs block provider switches while another idle provider remains available', async () => {
	const ui = await mount({
		accounts: [account('claude'), account('codex', { provider: 'codex' })],
		busy: { claude: true, codex: false },
		pending: [{ id: 'claude', provider: 'claude', reason: 'Weekly allowance resets soon.' }],
	});
	try {
		assert.equal(ui.document.querySelector('[data-switch="claude"]').disabled, true);
		assert.equal(ui.document.querySelector('[data-switch="codex"]').disabled, false);
		assert.match(ui.document.querySelector('.busy-note').textContent, /Claude Code CLI is running/);
		assert.match(ui.document.querySelector('.pending').textContent, /Weekly allowance resets soon/);
		assert.deepEqual(ui.requests, []);
	} finally { ui.close(); }
});

test('account settings and routing preferences send typed metadata, including clearing use-first', async () => {
	const ui = await mount({ accounts: [account('first')], policy: { strategy: 'best', threshold: 90, auto: false, useFirst: 'first' } });
	try {
		const settings = ui.document.querySelector('.settings-form');
		change(ui, settings.querySelector('[name="label"]'), '<Work>');
		const priority = settings.querySelector('[name="priority"]');
		change(ui, priority, '101');
		settings.requestSubmit();
		assert.deepEqual(ui.requests, []);
		change(ui, priority, '-4');
		change(ui, settings.querySelector('[name="reservePercent"]'), '25');
		settings.querySelector('[name="disabled"]').click();
		settings.requestSubmit();
		await settle();
		assert.deepEqual(ui.requests[0].body, { id: 'first', label: '<Work>', priority: -4, reservePercent: 25, disabled: true });
		const policy = ui.document.querySelector('[aria-labelledby="routing-heading"] form');
		change(ui, policy.querySelector('[name="strategy"]'), 'consume-first');
		change(ui, policy.querySelector('[name="threshold"]'), '80');
		change(ui, policy.querySelector('[name="useFirst"]'), '');
		policy.querySelector('[name="auto"]').click();
		policy.requestSubmit();
		await settle();
		assert.deepEqual(ui.requests[1], { path: '/api/accounts/policy', method: 'POST', body: { strategy: 'consume-first', threshold: 80, auto: true, useFirst: '' } });
		assert.match(ui.document.querySelector('.notice').textContent, /Routing preferences saved/);
		assert.deepEqual(ui.errors, []);
	} finally { ui.close(); }
});

test('reload and explicit usage checks update safe snapshots and show retryable network errors', async () => {
	let reachable = true;
	const ui = await mount({ accounts: [account('first')] }, (path) => {
		if (!reachable) return Promise.reject(new Error('offline'));
		const data = { ...fixture(), accounts: [account('first', { usageStatus: 'fresh', windows: [{ key: 'five-hour', label: '5 hours', usedPercent: 76, resetsAt: '2026-10-02T15:00:00Z' }] })] };
		return Promise.resolve(response(path === '/api/accounts' ? { view: 'accounts', accounts: data } : data));
	});
	try {
		ui.document.querySelector('header button').click();
		await settle();
		assert.deepEqual(ui.requests[0], { path: '/api/accounts', method: 'GET', body: undefined });
		assert.match(ui.document.querySelector('.usage-windows').textContent, /76%/);
		assert.match(ui.document.querySelector('.reset').textContent, /UTC/);
		ui.document.querySelector('.section-heading button').click();
		await settle();
		assert.deepEqual(ui.requests[1], { path: '/api/accounts/refresh', method: 'POST', body: {} });
		reachable = false;
		ui.document.querySelector('header button').click();
		await settle();
		assert.match(ui.document.querySelector('[role="alert"]').textContent, /Reload the page and try again/);
		assert.equal(ui.document.querySelector('header button').disabled, false);
		assert.deepEqual(ui.errors, []);
	} finally { ui.close(); }
});

test('unsupported capture and disabled manager show actionable empty states', async () => {
	const ui = await mount({ providers: [{ id: 'claude', label: 'Claude Code CLI', supported: false, error: 'Keychain access is unavailable.' }] });
	try {
		assert.equal(ui.document.querySelector('.capture select').disabled, true);
		assert.equal(ui.document.querySelector('.capture button').disabled, true);
		assert.match(ui.document.querySelector('.capture').textContent, /Keychain access is unavailable/);
		assert.match(ui.document.querySelector('.empty').textContent, /sign in to that account through the same CLI and save again/);
	} finally { ui.close(); }
	const off = await mount({ enabled: false });
	try {
		assert.match(off.document.querySelector('.setup').textContent, /Enable the local account manager/);
		assert.equal(off.document.querySelector('.capture'), null);
	} finally { off.close(); }
});
