import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDirectory } from './dist/ui-server.mjs';
import { strings } from './i18n.mjs';

const bundle = readFileSync(new URL('./dist/ui.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./dist/ui.css', import.meta.url), 'utf8');
const base = {
	device: 'laptop',
	routes: [],
	peers: [],
	registered: [],
	external: [],
	tailnetUp: true,
	t: strings('en'),
	stamp: 'abc123',
};
const route = (hostname, extra = {}) => ({ hostname, label: hostname.replace(/\.localhost$/, ''), up: true, pinned: false, ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(changes = {}, options = {}) {
	const model = { ...base, ...changes };
	const errors = [];
	const virtualConsole = new VirtualConsole();
	virtualConsole.on('jsdomError', (error) => errors.push(error));
	const html = `<div id="directory">${renderDirectory(model)}</div><script id="page-data" type="application/json">${JSON.stringify(model).replace(/</g, '\\u003c')}</script>`;
	const dom = new JSDOM(html, { url: 'http://localhost:5995/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
	const { window } = dom;
	const requests = [];
	const alerts = [];
	const streams = [];
	const timers = [];
	const nativeTimeout = window.setTimeout.bind(window);
	window.setTimeout = (callback, delay) => {
		const id = nativeTimeout(callback, delay);
		timers.push({ id, delay });
		return id;
	};
	window.fetch = (path, init) => {
		requests.push({ path, body: JSON.parse(init.body), method: init.method });
		return options.fetch?.(path, init) ?? Promise.resolve({ ok: true, status: 204 });
	};
	window.prompt = options.prompt ?? (() => null);
	window.alert = (message) => alerts.push(message);
	if (options.eventSource !== false) window.EventSource = class {
		constructor(url) { this.url = url; this.closed = false; streams.push(this); }
		close() { this.closed = true; }
	};
	window.eval(bundle);
	await settle();
	return { dom, window, document: window.document, requests, alerts, streams, timers, errors, close: () => dom.window.close() };
}

test('directory exposes local account management only when explicitly enabled', async () => {
	for (const accountManagementEnabled of [undefined, false, 'true', true]) {
		const ui = await mount({ accountManagementEnabled, t: strings('de') });
		try {
			const link = ui.document.querySelector('a[href="/accounts"]');
			assert.equal(link !== null, accountManagementEnabled === true);
			if (link) {
				assert.equal(link.textContent, 'CLI accounts');
				assert.equal(link.getAttribute('lang'), 'en');
			}
			assert.deepEqual(ui.errors, []);
		} finally { ui.close(); }
	}
});

test('SSR escapes user data and hydrates without replacing the local controls', async () => {
	const model = {
		routes: [route('one.localhost', { label: '<img src=x onerror=evil()>' }), route('two.localhost', { tailscaleUrl: 'https://example.ts.net:8443' })],
		peers: [null, { device: '<peer>', apps: [route('shared.localhost', { label: '<b>Shared</b>', tailscaleUrl: 'https://peer.ts.net:8443' })] }],
	};
	const ui = await mount(model);
	try {
		assert.equal(ui.document.querySelector('img'), null);
		assert.equal(ui.document.querySelectorAll('section').length, 2);
		assert.equal(ui.document.querySelector('section h2').textContent, 'laptop');
		assert.equal(ui.document.querySelectorAll('button.name').length, 2);
		assert.equal(ui.document.querySelectorAll('.peer-link button').length, 0);
		assert.equal(ui.document.querySelector('.peer-link .name').textContent, '<b>Shared</b>');
		assert.equal(ui.document.querySelector('li.local .url').textContent, 'local only — one.localhost');
		assert.equal(ui.document.querySelector('a.url').getAttribute('href'), 'https://example.ts.net:8443');
		assert.match(styles, /a\.url\.[^:]+::after[^}]*inset:0/);
		assert.match(styles, /li\.linked[^}]*button[^}]*z-index:1/);
		assert.deepEqual(ui.errors, []);
	} finally { ui.close(); }
});

test('registered apps share the local list before peers and suppress the local empty state', async () => {
	const registered = [{ hostname: 'stopped.localhost', label: 'Stopped app', state: 'stopped' }];
	for (const peers of [[], [{ device: 'remote', apps: [] }]]) {
		const ui = await mount({ registered, peers });
		try {
			assert.equal(ui.document.querySelector('.empty')?.textContent, peers.length ? 'Nothing running.' : undefined);
			assert.equal(ui.document.querySelectorAll('.registered').length, 1);
			assert.equal(ui.document.querySelectorAll('ul').length, 1);
			assert.equal(ui.document.querySelector('section > ul > .registered') !== null, !!peers.length);
			assert.equal(ui.document.querySelector('[data-start]').dataset.start, 'stopped.localhost');
		} finally { ui.close(); }
	}
});

test('a peer may report the same hostname twice without breaking hydration', async () => {
	const ui = await mount({ peers: [{ device: 'remote', apps: [route('shared.localhost'), route('shared.localhost', { label: 'second' })] }] });
	try {
		assert.deepEqual([...ui.document.querySelectorAll('section:nth-of-type(2) .name')].map((name) => name.textContent), ['shared', 'second']);
		assert.deepEqual(ui.errors, []);
	} finally { ui.close(); }
});

test('rename posts the hostname and label; failure leaves a retryable control', async () => {
	let response = { ok: false, status: 500 };
	const ui = await mount({ routes: [route('one.localhost')] }, {
		prompt: () => '<Renamed>',
		fetch: async () => response,
	});
	try {
		ui.document.querySelector('button.name').click();
		await settle();
		assert.deepEqual(ui.requests, [{ path: '/rename', method: 'POST', body: { hostname: 'one.localhost', label: '<Renamed>' } }]);
		assert.deepEqual(ui.alerts, ['Rename failed']);
		response = { ok: true, status: 204 };
		ui.document.querySelector('button.name').click();
		await settle();
		assert.equal(ui.requests.length, 2);
	} finally { ui.close(); }
});

test('pin saves the current pinned order and preserves route order in SSR', async () => {
	const ui = await mount({ routes: [route('a.localhost', { pinned: true }), route('b.localhost'), route('c.localhost')] }, {
		fetch: async () => ({ ok: false, status: 500 }),
	});
	try {
		assert.deepEqual([...ui.document.querySelectorAll('li[data-host]')].map((li) => li.dataset.host), ['a.localhost', 'b.localhost', 'c.localhost']);
		ui.document.querySelector('li[data-host="b.localhost"] .pin').click();
		await settle();
		assert.deepEqual(ui.requests[0].body, { pinned: ['a.localhost', 'b.localhost'] });
		assert.deepEqual(ui.alerts, ['Save failed']);
	} finally { ui.close(); }
});

test('keyboard reorder keeps focus and serializes layout snapshots', async () => {
	let releaseFirst;
	const first = new Promise((resolve) => { releaseFirst = resolve; });
	let calls = 0;
	const ui = await mount({ routes: [route('a.localhost', { pinned: true }), route('b.localhost', { pinned: true }), route('c.localhost', { pinned: true })] }, {
		fetch: () => ++calls === 1 ? first : Promise.resolve({ ok: true, status: 204 }),
	});
	try {
		const handle = ui.document.querySelector('li[data-host="b.localhost"] .handle');
		handle.focus();
		handle.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		await settle();
		assert.equal(ui.document.activeElement, handle);
		handle.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await settle();
		assert.equal(ui.requests.length, 1);
		assert.deepEqual(ui.requests[0].body, { pinned: ['b.localhost', 'a.localhost', 'c.localhost'] });
		releaseFirst({ ok: true, status: 204 });
		await settle();
		assert.deepEqual(ui.requests[1].body, { pinned: ['a.localhost', 'b.localhost', 'c.localhost'] });
	} finally { ui.close(); }
});

test('pointer reorder saves only a changed pinned list', async () => {
	const ui = await mount({ routes: [route('a.localhost', { pinned: true }), route('b.localhost', { pinned: true }), route('c.localhost')] });
	try {
		const a = ui.document.querySelector('li[data-host="a.localhost"]');
		const b = ui.document.querySelector('li[data-host="b.localhost"]');
		ui.document.elementFromPoint = () => b;
		a.querySelector('.handle').dispatchEvent(new ui.window.Event('pointerdown', { bubbles: true, cancelable: true }));
		const move = new ui.window.Event('pointermove', { bubbles: true });
		Object.defineProperties(move, { clientX: { value: 2 }, clientY: { value: 1 } });
		ui.document.dispatchEvent(move);
		ui.document.dispatchEvent(new ui.window.Event('pointerup'));
		await settle();
		assert.deepEqual(ui.requests[0].body, { pinned: ['b.localhost', 'a.localhost'] });
	} finally { ui.close(); }
});

test('launch shows pending, failure and retry; request sends hostname only', async () => {
	let release;
	const pending = new Promise((resolve) => { release = resolve; });
	const ui = await mount({ registered: [{ hostname: 'demo.localhost', label: 'Demo', state: 'stopped' }] }, { fetch: () => pending });
	try {
		const button = ui.document.querySelector('[data-start]');
		button.click();
		await settle();
		assert.equal(button.disabled, true);
		assert.equal(button.textContent, 'Starting…');
		assert.deepEqual(ui.requests[0].body, { hostname: 'demo.localhost' });
		release({ ok: false, status: 500 });
		await settle();
		assert.equal(button.disabled, false);
		assert.match(ui.document.querySelector('.launch-status').textContent, /Could not start/);
		button.click();
		await settle();
		assert.equal(ui.requests.length, 2);
	} finally { ui.close(); }
});

test('successful rename and a 409 launch request trigger a refresh', async () => {
	const ui = await mount({ routes: [route('one.localhost')], registered: [{ hostname: 'demo.localhost', label: 'Demo', state: 'stopped' }] }, {
		prompt: () => 'new name',
		fetch: (path) => Promise.resolve(path === '/start' ? { ok: false, status: 409 } : { ok: true, status: 204 }),
	});
	try {
		ui.document.querySelector('button.name').click();
		await settle();
		ui.document.querySelector('[data-start]').click();
		await settle();
		assert.equal(ui.errors.filter((error) => /navigation/.test(error.message)).length, 2);
	} finally { ui.close(); }
});

test('a starting launcher schedules a two-second refresh', async () => {
	const ui = await mount({ registered: [{ hostname: 'demo.localhost', label: 'Demo', state: 'starting' }] });
	try {
		assert.equal(ui.document.querySelector('[data-start]').disabled, true);
		assert.ok(ui.timers.some((timer) => timer.delay === 2000));
	} finally { ui.close(); }
});

test('configured links survive hydration in order without health or mutation controls', async () => {
	const external = [
		{ label: '</script><img src=x onerror=evil()>', url: 'https://example.test/preview?q=%3Cscript%3E#view' },
		{ label: 'Local app', url: 'http://localhost:3000/' },
	];
	const ui = await mount({ external, t: strings('de'), routes: [route('demo.localhost')], peers: [{ device: 'Other device', apps: [] }] });
	try {
		const section = ui.document.querySelector('.external-apps');
		assert.equal(section.querySelector('h2').textContent, 'Weitere Apps');
		assert.deepEqual([...section.querySelectorAll('a')].map((a) => a.getAttribute('href')), external.map((app) => app.url));
		assert.deepEqual([...section.querySelectorAll('.name')].map((name) => name.textContent), external.map((app) => app.label));
		assert.equal(section.querySelector('.dot,button,[data-host],[data-start]'), null);
		assert.equal(ui.document.querySelector('img'), null);
		assert.equal(ui.document.querySelectorAll('section').length, 3);
		assert.ok(ui.document.querySelector('button.name[data-host="demo.localhost"]'));
		assert.deepEqual(ui.requests, []);
		assert.deepEqual(ui.errors, []);
	} finally { ui.close(); }
});

test('SSE ignores unchanged stamps, refreshes on changes and visibility, and falls back on error', async () => {
	const ui = await mount();
	try {
		assert.equal(ui.streams[0].url, '/events');
		ui.streams[0].onmessage({ data: 'abc123' });
		assert.deepEqual(ui.errors, []);
		ui.streams[0].onmessage({ data: 'different' });
		assert.match(ui.errors[0].message, /navigation/);
		ui.document.dispatchEvent(new ui.window.Event('visibilitychange'));
		assert.match(ui.errors[1].message, /navigation/);
		ui.streams[0].onerror();
		assert.equal(ui.streams[0].closed, true);
		assert.ok(ui.timers.some((timer) => timer.delay === 15000));
	} finally { ui.close(); }
	const noSse = await mount({}, { eventSource: false });
	try {
		assert.equal(noSse.streams.length, 0);
		assert.ok(noSse.timers.some((timer) => timer.delay === 15000));
	} finally { noSse.close(); }
});
