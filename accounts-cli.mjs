#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createAccountManager } from './accounts.mjs';
import { AccountError, privateWrite, readAccountSettings } from './account-store.mjs';

const invocation = 'node accounts-cli.mjs';
const commands = {
	enable: { args: '', flags: [], description: 'Enable local CLI account management. Existing pairing settings stay intact.', example: 'enable' },
	disable: { args: '', flags: [], description: 'Disable account management without deleting saved accounts.', example: 'disable' },
	status: { args: '', flags: [], description: 'Print account metadata, usage, provider availability and pending switches as JSON.', example: 'status' },
	capture: { args: 'claude|codex [--label text]', flags: ['label'], description: 'Save the login currently installed by the provider CLI. Sign in through that CLI first.', example: 'capture claude --label Work', positionals: 1 },
	refresh: { args: '', flags: [], description: 'Check usage and configured peers. This command prepares recommendations without applying switches.', example: 'refresh' },
	switch: { args: 'account-id', flags: [], description: 'Apply a saved login after all sessions for that provider have stopped. Relaunch the CLI yourself.', example: 'switch claude-0123456789abcdef01234567', positionals: 1 },
	sync: { args: '', flags: [], description: 'Fetch metadata from configured peers. Logins stay on each device.', example: 'sync' },
	edit: { args: 'account-id [--label text] [--priority -100..100] [--reserve 0..99] [--disabled true|false] [--schedule file.json]', flags: ['label', 'priority', 'reserve', 'disabled', 'schedule'], description: 'Update local account preferences. A schedule file contains an array of UTC reserve intervals.', example: 'edit claude-0123456789abcdef01234567 --priority 10 --reserve 20', positionals: 1 },
	policy: { args: '[--strategy best|consume-first] [--threshold 1..100] [--auto true|false] [--use-first account-id|none]', flags: ['strategy', 'threshold', 'auto', 'use-first'], description: 'Set routing preferences. Auto prepares pending switches; the watcher applies them only when explicitly started.', example: 'policy --strategy consume-first --threshold 90 --auto true' },
	auto: { args: '--once | --interval seconds', flags: ['once', 'interval'], description: 'Opt in to applying recommended switches while CLIs are stopped. Interval must be at least 60 seconds. No sessions are killed or restarted. Stop the watcher with Ctrl-C.', example: 'auto --once' },
};

class UsageError extends Error {}
const help = (name) => {
	if (name) {
		const command = commands[name];
		return `Usage: ${invocation} ${name} ${command.args}\n\n${command.description}\n\nExamples:\n  ${invocation} ${command.example}\n${name === 'auto' ? `  ${invocation} auto --interval 60\n` : ''}`;
	}
	return `Usage: ${invocation} <command> [options]\n\nCommands:\n${Object.keys(commands).map((name) => `  ${name}`).join('\n')}\n\nUse <command> --help for options and examples.\nConfiguration: PORTLESS_ACCOUNTS or ~/.portless-home/accounts/config.json\nSuccess writes JSON to stdout. Errors write JSON to stderr. No prompts.\n\nExamples:\n  ${invocation} enable\n  ${invocation} capture claude --label Work\n  ${invocation} status\n`;
};

function parse(argv) {
	const [name, ...args] = argv;
	if (!name || name === '--help' || name === '-h') return { help: help() };
	if (!Object.hasOwn(commands, name)) throw new UsageError(`Unknown account command. Run ${invocation} --help.`);
	if (args.includes('--help') || args.includes('-h')) return { help: help(name) };
	const flags = {};
	const positionals = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg.startsWith('--')) { positionals.push(arg); continue; }
		const equals = arg.indexOf('=');
		const flag = arg.slice(2, equals < 0 ? undefined : equals);
		if (!commands[name].flags.includes(flag) || Object.hasOwn(flags, flag)) throw new UsageError(`Unknown or duplicate option. Example: ${invocation} ${commands[name].example}`);
		if (flag === 'once') {
			if (equals >= 0) throw new UsageError(`Use --once without a value. Example: ${invocation} auto --once`);
			flags.once = true;
			continue;
		}
		const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
		if (value === undefined || value.startsWith('--')) throw new UsageError(`An option value is missing. Example: ${invocation} ${commands[name].example}`);
		flags[flag] = value;
	}
	if (positionals.length !== (commands[name].positionals ?? 0)) throw new UsageError(`Expected ${commands[name].args || 'no arguments'}. Example: ${invocation} ${commands[name].example}`);
	return { name, flags, positionals };
}

function integer(value, min, max, flag) {
	if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new UsageError(`${flag} must be an integer from ${min} to ${max}.`);
	return Number(value);
}

function boolean(value, flag) {
	if (!['true', 'false'].includes(value)) throw new UsageError(`${flag} must be true or false.`);
	return value === 'true';
}

function label(value) {
	if (value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) throw new UsageError('--label must contain at most 64 characters without control characters.');
	return value;
}

function schedule(path) {
	let value;
	try {
		if (statSync(path).size > 64 * 1024) throw new Error();
		value = JSON.parse(readFileSync(path, 'utf8'));
	} catch { throw new UsageError('Could not read the reserve schedule. Use a JSON file smaller than 64 KiB.'); }
	if (!Array.isArray(value)) throw new UsageError('The reserve schedule must be a JSON array.');
	return value;
}

const known = (error) => error instanceof AccountError || error?.constructor?.name === 'ProviderError';
const safeError = (error) => known(error) ? error.message : 'The account operation failed. No credential details were returned.';

export async function autoOnce(manager, { signal } = {}) {
	if (signal?.aborted) return { stopped: true, switched: [], blocked: [] };
	let snapshot = await manager.refresh({ forceAuto: true });
	const switched = [];
	const blocked = [];
	for (const pending of snapshot.pending ?? []) {
		if (signal?.aborted) break;
		try {
			snapshot = await manager.switchAccount(pending.id);
			switched.push({ id: pending.id, provider: pending.provider });
		} catch (error) {
			if (!known(error) || error.status !== 409) throw error;
			blocked.push({ id: pending.id, provider: pending.provider, error: safeError(error) });
		}
	}
	return { snapshot, switched, blocked, restartRequired: switched.length > 0, ...(signal?.aborted ? { stopped: true } : {}) };
}

export async function runCli(argv, options = {}) {
	const stdout = options.stdout ?? ((value) => process.stdout.write(value));
	const stderr = options.stderr ?? ((value) => process.stderr.write(value));
	const json = (value) => stdout(`${JSON.stringify(value)}\n`);
	try {
		const parsed = parse(argv);
		if (parsed.help) { stdout(parsed.help); return 0; }
		const { name, flags, positionals } = parsed;
		const configPath = options.configPath ?? (process.env.PORTLESS_ACCOUNTS || join(homedir(), '.portless-home', 'accounts', 'config.json'));
		const manager = options.manager ?? createAccountManager({ configPath });
		if (name === 'enable' || name === 'disable') {
			const config = readAccountSettings(configPath);
			config.enabled = name === 'enable';
			if (name === 'enable') {
				if (!Object.hasOwn(config, 'snapshotToken')) config.snapshotToken = randomBytes(32).toString('hex');
				config.providers ??= {};
				config.peers ??= [];
			}
			await (options.write ?? privateWrite)(configPath, JSON.stringify(config));
			json({ enabled: config.enabled });
			return 0;
		}
		if (name === 'auto') {
			if (Boolean(flags.once) === Object.hasOwn(flags, 'interval')) throw new UsageError(`Choose --once or --interval. Example: ${invocation} auto --interval 60`);
			const milliseconds = flags.once ? null : integer(flags.interval, 60, 2147483, '--interval') * 1000;
			const signal = options.signal;
			do {
				if (signal?.aborted) return 0;
				try { json(await autoOnce(manager, { signal })); }
				catch (error) {
					if (!known(error) || error.status !== 409) throw error;
					json({ switched: [], blocked: [{ error: safeError(error) }] });
				}
				if (flags.once || signal?.aborted) return 0;
				try { await (options.wait ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(milliseconds, signal); }
				catch (error) { if (signal?.aborted && error.name === 'AbortError') return 0; throw error; }
			} while (!signal?.aborted);
			return 0;
		}
		let result;
		switch (name) {
			case 'status': result = await manager.snapshot(); break;
			case 'capture': {
				if (!['claude', 'codex'].includes(positionals[0])) throw new UsageError(`Choose claude or codex. Example: ${invocation} capture claude --label Work`);
				const capturedLabel = flags.label === undefined ? undefined : label(flags.label);
				result = await manager.capture(positionals[0], capturedLabel); break;
			}
			case 'refresh': result = await manager.refresh(); break;
			case 'switch': result = await manager.switchAccount(positionals[0]); break;
			case 'sync': result = await manager.synchronize(); break;
			case 'edit': {
				if (!Object.keys(flags).length) throw new UsageError(`Choose an account setting. Example: ${invocation} ${commands.edit.example}`);
				const input = { id: positionals[0] };
				if (flags.label !== undefined) input.label = label(flags.label);
				if (flags.priority !== undefined) input.priority = integer(flags.priority, -100, 100, '--priority');
				if (flags.reserve !== undefined) input.reservePercent = integer(flags.reserve, 0, 99, '--reserve');
				if (flags.disabled !== undefined) input.disabled = boolean(flags.disabled, '--disabled');
				if (flags.schedule !== undefined) input.reserveSchedule = schedule(flags.schedule);
				result = await manager.edit(input); break;
			}
			case 'policy': {
				if (!Object.keys(flags).length) throw new UsageError(`Choose a routing preference. Example: ${invocation} ${commands.policy.example}`);
				const input = {};
				if (flags.strategy !== undefined) {
					if (!['best', 'consume-first'].includes(flags.strategy)) throw new UsageError('--strategy must be best or consume-first.');
					input.strategy = flags.strategy;
				}
				if (flags.threshold !== undefined) input.threshold = integer(flags.threshold, 1, 100, '--threshold');
				if (flags.auto !== undefined) input.auto = boolean(flags.auto, '--auto');
				if (flags['use-first'] !== undefined) input.useFirst = flags['use-first'] === 'none' ? '' : flags['use-first'];
				result = await manager.policy(input); break;
			}
		}
		json(result);
		return 0;
	} catch (error) {
		stderr(`${JSON.stringify({ error: error instanceof UsageError ? error.message : safeError(error) })}\n`);
		return error instanceof UsageError ? 2 : 1;
	}
}

const isEntrypoint = () => {
	if (!process.argv[1]) return false;
	try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
	catch { return false; }
};

if (isEntrypoint()) {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
	try { process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal }); }
	finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
