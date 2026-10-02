import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const accountFiles = ['accounts.mjs', 'accounts-http.mjs', 'accounts-cli.mjs', 'account-store.mjs', 'account-providers.mjs', 'account-processes.mjs', 'account-routing.mjs', 'account-sync.mjs'];
const runtimeFiles = ['server.mjs', 'render.mjs', 'i18n.mjs', 'peers.mjs', 'menubar.mjs', 'live.mjs', 'launch.mjs', 'external.mjs', ...accountFiles, 'dist/ui-server.mjs', 'dist/ui.js', 'dist/ui.css'];

function fixture(t, missing, windows) {
	const root = mkdtempSync(join(tmpdir(), 'portless-install-preflight-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, 'source');
	const profile = join(root, 'profile');
	const install = join(profile, '.portless-home');
	mkdirSync(source);
	mkdirSync(install, { recursive: true });
	writeFileSync(join(install, 'server.mjs'), 'existing server, preserve this\n');
	writeFileSync(join(install, 'service.env'), 'existing service configuration\n');
	for (const file of runtimeFiles) {
		if (file === missing) continue;
		const destination = join(source, file);
		mkdirSync(join(destination, '..'), { recursive: true });
		writeFileSync(destination, `${file}\n`);
	}
	const name = windows ? 'install.ps1' : 'install.sh';
	const original = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
	// Relocate only the profile reference in this fixture. The process's HOME and
	// real native services remain untouched even if an installer preflight breaks.
	const relocated = windows ? original.replaceAll('$env:USERPROFILE', '$env:PORTLESS_INSTALL_TEST_PROFILE') : original.replaceAll('$HOME', '$PORTLESS_INSTALL_TEST_PROFILE');
	writeFileSync(join(source, name), relocated);
	return { root, source, profile, install, activity: join(root, 'service-activity') };
}

function assertUnchanged(value) {
	assert.equal(readFileSync(join(value.install, 'server.mjs'), 'utf8'), 'existing server, preserve this\n');
	assert.equal(readFileSync(join(value.install, 'service.env'), 'utf8'), 'existing service configuration\n');
	assert.deepEqual(readdirSync(value.install).sort(), ['server.mjs', 'service.env']);
	assert.equal(existsSync(value.activity), false, 'no service operation may run before preflight finishes');
}

test('POSIX install rejects every missing account runtime before changing an existing installation', { skip: process.platform === 'win32' && 'POSIX installer runs on macOS and Linux' }, (t) => {
	for (const missing of accountFiles) {
		const value = fixture(t, missing, false);
		const bin = join(value.root, 'bin');
		mkdirSync(bin);
		for (const command of ['launchctl', 'systemctl', 'tailscale', 'curl', 'sleep']) {
			writeFileSync(join(bin, command), '#!/bin/sh\nprintf "%s\\n" "${0##*/}" >> "$PORTLESS_INSTALL_TEST_ACTIVITY"\nexit 91\n', { mode: 0o755 });
		}
		const result = spawnSync('sh', [join(value.source, 'install.sh')], {
			encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PORTLESS_INSTALL_TEST_PROFILE: value.profile, PORTLESS_INSTALL_TEST_ACTIVITY: value.activity },
		});
		assert.equal(result.status, 1, `${missing}: ${result.stderr}`);
		assert.match(result.stdout, new RegExp(`Missing ${missing.replaceAll('.', '\\.')}`));
		assertUnchanged(value);
	}
});

test('Windows install rejects every missing account runtime before replacing files or scheduled tasks', { skip: process.platform !== 'win32' && 'Windows PowerShell installer is verified on Windows CI' }, (t) => {
	for (const missing of accountFiles) {
		const value = fixture(t, missing, true);
		const wrapper = join(value.source, 'preflight.ps1');
		const serviceCommands = ['New-ScheduledTaskAction', 'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'New-ScheduledTaskTrigger', 'Get-ScheduledTask', 'Stop-ScheduledTask', 'Unregister-ScheduledTask', 'Register-ScheduledTask', 'Start-ScheduledTask', 'Get-CimInstance', 'Invoke-WebRequest', 'Start-Process'];
		writeFileSync(wrapper, serviceCommands.map((command) => `function global:${command} { Add-Content -LiteralPath $env:PORTLESS_INSTALL_TEST_ACTIVITY -Value '${command}'; throw 'Unexpected service operation' }`).join('\n') + '\n& "$PSScriptRoot\\install.ps1"\nexit $LASTEXITCODE\n');
		const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
			encoding: 'utf8', env: { ...process.env, PORTLESS_INSTALL_TEST_PROFILE: value.profile, PORTLESS_INSTALL_TEST_ACTIVITY: value.activity },
		});
		assert.equal(result.status, 1, `${missing}: ${result.stderr}`);
		assert.match(result.stdout, new RegExp(`Missing ${missing.replaceAll('.', '\\.')}`));
		assertUnchanged(value);
	}
});
