import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const exec = promisify(execFile);
const windowsProcesses = [
	'$ErrorActionPreference = "Stop";',
	'Get-CimInstance Win32_Process | ForEach-Object {',
	'if ($_.Name -in @("claude.exe", "codex.exe")) { "$($_.ProcessId) $($_.Name)" }',
	'elseif ($_.Name -eq "node.exe") {',
	'if (!$_.CommandLine) { throw "Process inspection unavailable" };',
	'$command = $_.CommandLine.Replace([char]92, [char]47);',
	'if ($command -match "@anthropic-ai/claude-code/cli\\.js") { "$($_.ProcessId) claude" };',
	'if ($command -match "@openai/codex/bin/codex\\.js") { "$($_.ProcessId) codex" }',
	'} }',
].join(' ');

export const parseCliProcesses = (text) => {
	const busy = { claude: false, codex: false };
	for (const line of text.split('\n')) {
		const match = /^\s*\d+\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const executable = basename(match[1]).toLowerCase().replace(/\.exe$/, '');
		if (executable === 'claude' || executable === 'codex') busy[executable] = true;
	}
	return busy;
};

export const parseNodeWrappers = (text) => {
	const busy = { claude: false, codex: false };
	for (const line of text.split('\n')) {
		if (!/^\s*\d+\s+.*?\bnode(?:\.exe)?\s/.test(line)) continue;
		if (/@anthropic-ai[\\/]claude-code[\\/]cli\.js(?:\s|$)/.test(line)) busy.claude = true;
		if (/@openai[\\/]codex[\\/]bin[\\/]codex\.js(?:\s|$)/.test(line)) busy.codex = true;
	}
	return busy;
};

export const runningClis = async (run = exec) => {
	try {
		const options = { timeout: 3000, maxBuffer: 1024 * 1024 };
		if (process.platform === 'win32') {
			const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsProcesses], options);
			return parseCliProcesses(result.stdout);
		}
		const [native, wrappers] = await Promise.all([
			run('ps', ['-u', String(process.getuid()), '-o', 'pid=,comm='], options),
			run('ps', ['-u', String(process.getuid()), '-o', 'pid=,args='], options),
		]);
		const direct = parseCliProcesses(native.stdout);
		const node = parseNodeWrappers(wrappers.stdout);
		return { claude: direct.claude || node.claude, codex: direct.codex || node.codex };
	} catch {
		return { claude: true, codex: true, unavailable: true };
	}
};
