// Opt-in local launcher. Commands are trusted local configuration, never request data.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';

export const localRequest = (req) => {
	if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
	const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
	if (req.socket.localPort === 80) hosts.push('127.0.0.1', 'localhost');
	if (!hosts.includes(req.headers.host)) return false;
	return !Object.keys(req.headers).some((h) => /^(forwarded$|x-forwarded-|tailscale-)/i.test(h));
};

export const readRegistry = (path) => {
	let fd;
	try {
		fd = openSync(path, 'r');
		const stat = fstatSync(fd);
		if (!stat.isFile() || (process.platform !== 'win32' &&
			(stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) return [];
		const config = JSON.parse(readFileSync(fd, 'utf8'));
		if (config?.enabled !== true || !Array.isArray(config.apps) || config.apps.length > 100) return [];
		const hosts = new Set();
		for (const app of config.apps) {
			if (!app || typeof app.hostname !== 'string' || app.hostname.length > 253 ||
				!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.localhost$/.test(app.hostname) || hosts.has(app.hostname) ||
				typeof app.cwd !== 'string' || !isAbsolute(app.cwd) || app.cwd.includes('\0') ||
				typeof app.command !== 'string' || !app.command.trim() || app.command.includes('\0')) return [];
			hosts.add(app.hostname);
		}
		return config.apps;
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

// Track only launches owned by this server. Child events release the launch lock;
// existing running apps are still determined by routes.json on each request.
export const launcher = () => {
	const launches = new Map();
	return {
		state: (host) => launches.get(host)?.state ?? 'stopped',
		start: (app) => new Promise((resolve) => {
			if (launches.get(app.hostname)?.state === 'starting') return resolve(409);
			const entry = { state: 'starting' };
			launches.set(app.hostname, entry);
			let child;
			try {
				child = spawn(app.command, { cwd: app.cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: true });
			} catch {
				entry.state = 'failed';
				return resolve(500);
			}
			child.once('error', () => { entry.state = 'failed'; resolve(500); });
			child.once('exit', (code) => { entry.state = code === 0 ? 'stopped' : 'failed'; });
			child.once('spawn', () => { child.unref(); resolve(202); });
		}),
	};
};
