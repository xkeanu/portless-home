import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { menubar } from './menubar.mjs';

const HOME = 'http://127.0.0.1:5995/';

test('menubar: title counts healthy apps; each app is a line with a dot and its tailnet link', () => {
	const routes = [
		{ hostname: 'blog.localhost', port: 4000, tailscaleUrl: 'https://mini.example.ts.net:8443' },
		{ hostname: 'recipe-box.localhost', port: 4001, tailscaleUrl: 'https://mini.example.ts.net:8444' },
	];
	const out = menubar(routes, [true, false], {}, HOME);
	assert.deepEqual(out.split('\n'), [
		'⌂ 1',
		'---',
		`Open home page | href=${HOME}`,
		'---',
		'● blog | href=https://mini.example.ts.net:8443 emojize=false symbolize=false',
		'○ recipe-box | href=https://mini.example.ts.net:8444 color=gray emojize=false symbolize=false',
	]);
});

test('menubar: a local-only app links to its localhost port; without a port it is a disabled line', () => {
	const routes = [
		{ hostname: 'scratchpad.localhost', port: 4003 },
		{ hostname: 'noport.localhost' },
	];
	const lines = menubar(routes, [true, false], {}, HOME).split('\n').slice(4);
	assert.deepEqual(lines, [
		'● scratchpad — local only | href=http://127.0.0.1:4003/ emojize=false symbolize=false',
		'○ noport — local only | disabled=true color=gray emojize=false symbolize=false',
	]);
});

test('menubar: renamed labels are used, and a label cannot start params or a new line', () => {
	const routes = [{ hostname: 'blog.localhost', port: 4000, tailscaleUrl: 'https://mini.example.ts.net:8443' }];
	const names = { 'blog.localhost': 'My | Blog\nRefresh | refresh=true' };
	const lines = menubar(routes, [true], names, HOME).split('\n');
	assert.equal(lines.length, 5);
	assert.equal(lines[4], '● My   Blog Refresh   refresh=true | href=https://mini.example.ts.net:8443 emojize=false symbolize=false');
});

test('menubar: a tailscaleUrl that is not a clean https URL never reaches href; the app falls back to its port', () => {
	const routes = [
		{ hostname: 'a.localhost', port: 4000, tailscaleUrl: 'https://mini.example.ts.net:8443\nRun | shell=/bin/sh' },
		{ hostname: 'b.localhost', port: 4001, tailscaleUrl: 'https://mini.example.ts.net:8444 | refresh=true' },
		{ hostname: 'c.localhost', port: 4002, tailscaleUrl: 'javascript:alert(1)' },
		{ hostname: 'd.localhost', tailscaleUrl: 'not a url' },
	];
	const lines = menubar(routes, [true, true, true, true], {}, HOME).split('\n').slice(4);
	assert.deepEqual(lines, [
		'● a — local only | href=http://127.0.0.1:4000/ emojize=false symbolize=false',
		'● b — local only | href=http://127.0.0.1:4001/ emojize=false symbolize=false',
		'● c — local only | href=http://127.0.0.1:4002/ emojize=false symbolize=false',
		'● d — local only | disabled=true emojize=false symbolize=false',
	]);
});

// --- the plugin script itself, run against a fake server ---

const PLUGIN = resolve('menubar/portless-home.15s.sh');

const runPlugin = (env) =>
	new Promise((done, fail) =>
		execFile('sh', [PLUGIN], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) =>
			err ? fail(Object.assign(err, { stderr })) : done(stdout)
		)
	);

const textServer = async (body) => {
	const srv = createServer((req, res) => {
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.end(req.url === '/api/menubar' ? body : 'wrong path');
	});
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	return { srv, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}` };
};

// A HOME with the launchd plist install.sh writes, so the plugin sees a service.
const homeWithPlist = (label, port) => {
	const home = mkdtempSync(join(tmpdir(), 'portless-home-menubar-'));
	mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
	const env = port ? `<key>EnvironmentVariables</key><dict><key>PORT</key><string>${port}</string></dict>` : '';
	writeFileSync(
		join(home, 'Library', 'LaunchAgents', `${label}.plist`),
		`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string>${env}</dict></plist>`
	);
	return home;
};

test('plugin: prints the server menu, then a Refresh item; no service controls without a plist', async () => {
	const { srv, base } = await textServer('⌂ 2\n---\nOpen home page | href=http://127.0.0.1:5995/\n---\n● blog | href=https://a.example.ts.net:8443\n');
	try {
		// A trailing slash on the override must not turn the path into //api/menubar.
		const out = await runPlugin({ HOME: mkdtempSync(join(tmpdir(), 'portless-home-menubar-')), PORTLESS_HOME_URL: `${base}/` });
		assert.deepEqual(out.split('\n'), [
			'⌂ 2',
			'---',
			'Open home page | href=http://127.0.0.1:5995/',
			'---',
			'● blog | href=https://a.example.ts.net:8443',
			'---',
			'Refresh | refresh=true',
			'',
		]);
	} finally {
		srv.close();
	}
});

test('plugin: with the server up and a plist, offers Restart and Stop (xbar: shell=, SwiftBar: bash=)', async () => {
	const { srv, base } = await textServer('⌂ 1\n---\nx\n');
	const home = homeWithPlist('sh.portless.home');
	try {
		const xbar = await runPlugin({ HOME: home, PORTLESS_HOME_URL: base });
		assert.deepEqual(xbar.split('\n').slice(3), [
			'---',
			`Restart service | shell="${PLUGIN}" param1=restart terminal=false refresh=true`,
			`Stop service | shell="${PLUGIN}" param1=stop terminal=false refresh=true`,
			'---',
			'Refresh | refresh=true',
			'',
		]);
		const swiftbar = await runPlugin({ HOME: home, PORTLESS_HOME_URL: base, SWIFTBAR: '1' });
		assert.equal(swiftbar.split('\n')[4], `Restart service | bash="${PLUGIN}" param1=restart terminal=false refresh=true`);
	} finally {
		srv.close();
	}
});

test('plugin: with the server down, shows a grey title, says so, and offers Start (or an install hint)', async () => {
	const { srv, port } = await textServer('');
	await new Promise((resolve) => srv.close(resolve));
	const down = `http://127.0.0.1:${port}`;
	const withService = await runPlugin({ HOME: homeWithPlist('homebrew.mxcl.portless-home'), PORTLESS_HOME_URL: down });
	assert.deepEqual(withService.split('\n'), [
		'⌂ – | color=gray',
		'---',
		'portless-home is not running | disabled=true color=gray',
		`Start service | shell="${PLUGIN}" param1=start terminal=false refresh=true`,
		'---',
		'Refresh | refresh=true',
		'',
	]);
	const noService = await runPlugin({ HOME: mkdtempSync(join(tmpdir(), 'portless-home-menubar-')), PORTLESS_HOME_URL: down });
	assert.equal(noService.split('\n')[3], 'No login service found — ./install.sh or brew services start portless-home | disabled=true color=gray');
});

test('plugin: reads the port from the install.sh plist when PORTLESS_HOME_URL is unset', { skip: process.platform !== 'darwin' && 'needs plutil' }, async () => {
	const { srv, port } = await textServer('⌂ 0\n---\nfrom plist port\n');
	try {
		const out = await runPlugin({ HOME: homeWithPlist('sh.portless.home', port) });
		assert.equal(out.split('\n')[2], 'from plist port');
	} finally {
		srv.close();
	}
});

test('menubar: with nothing running, the title shows 0 and the list says so', () => {
	assert.deepEqual(menubar([], [], {}, HOME).split('\n'), [
		'⌂ 0',
		'---',
		`Open home page | href=${HOME}`,
		'---',
		'Nothing running. Start an app through portless. | disabled=true',
	]);
});
