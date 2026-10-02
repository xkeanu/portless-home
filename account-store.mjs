import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export class AccountError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

export const privateRead = (path, limit = 8 * 1024 * 1024) => {
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > limit || (process.platform !== 'win32' &&
			(stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
			throw new AccountError('private-file', 'Account files must be owned by you and readable only by you.', 403);
		}
		return readFileSync(fd);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		if (error instanceof AccountError) throw error;
		throw new AccountError('private-file', 'Cannot safely read the account file.', 403);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

const privateDirectory = (path) => {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
		(stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
		throw new AccountError('private-directory', 'The account vault needs a private directory owned by you.', 403);
	}
};

export const privateWrite = (path, data) => {
	privateDirectory(dirname(path));
	const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
	let fd;
	try {
		fd = openSync(temporary, 'wx', 0o600);
		writeFileSync(fd, data);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(temporary)) unlinkSync(temporary);
	}
};

export const readAccountSettings = (path) => {
	const bytes = privateRead(path, 64 * 1024);
	if (!bytes) return { enabled: false };
	let settings;
	try { settings = JSON.parse(bytes.toString('utf8')); }
	catch { throw new AccountError('settings', 'The account settings are not valid JSON.'); }
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
		throw new AccountError('settings', 'The account settings must be an object.');
	}
	return settings;
};

const emptyState = () => ({ version: 1, accounts: [], remote: [], policy: { strategy: 'best', threshold: 90, auto: false }, pending: [] });
const aad = Buffer.from('portless-home account vault v1');
const maxVaultBytes = 8 * 1024 * 1024;

export const accountVault = (directory) => {
	const keyPath = join(directory, 'key');
	const vaultPath = join(directory, 'vault.json');
	const lockPath = join(directory, 'lock');
	const key = (create = false) => {
		let bytes = privateRead(keyPath, 32);
		if (!bytes && create) {
			privateDirectory(directory);
			try {
				const fd = openSync(keyPath, 'wx', 0o600);
				try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); }
				finally { closeSync(fd); }
			} catch (error) { if (error.code !== 'EEXIST') throw error; }
			bytes = privateRead(keyPath, 32);
		}
		if (bytes?.length !== 32) throw new AccountError('vault-key', 'The local account vault key is missing or invalid.', 500);
		return bytes;
	};
	const read = () => {
		const bytes = privateRead(vaultPath, maxVaultBytes);
		if (!bytes) return emptyState();
		try {
			const sealed = JSON.parse(bytes.toString('utf8'));
			if (sealed.version !== 1) throw new Error();
			const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(sealed.iv, 'base64'));
			decipher.setAAD(aad);
			decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
			const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
			const state = JSON.parse(plaintext.toString('utf8'));
			if (state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.remote) || !Array.isArray(state.pending)) throw new Error();
			return state;
		} catch (error) {
			if (error instanceof AccountError) throw error;
			throw new AccountError('vault-integrity', 'The account vault could not be authenticated. Its contents were not changed.', 500);
		}
	};
	const write = (state) => {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', key(true), iv);
		cipher.setAAD(aad);
		const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
		const sealed = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
		if (Buffer.byteLength(sealed) > maxVaultBytes) throw new AccountError('vault-size', 'The account vault is full. Remove an unused local account before saving another.', 413);
		privateWrite(vaultPath, sealed);
	};
	const lock = () => {
		privateDirectory(directory);
		try { return openSync(lockPath, 'wx', 0o600); }
		catch (error) {
			if (error.code !== 'EEXIST') throw error;
			throw new AccountError('busy', 'Another account operation holds the vault lock. If it crashed, verify it has stopped before removing the lock.', 409);
		}
	};
	return {
		read,
		async update(change) {
			const fd = lock();
			const inode = fstatSync(fd).ino;
			try {
				writeFileSync(fd, JSON.stringify({ pid: process.pid }));
				const state = read();
				const result = await change(state, () => write(state));
				write(state);
				return result;
			} finally {
				closeSync(fd);
				try { if (lstatSync(lockPath).ino === inode) unlinkSync(lockPath); }
				catch (error) { if (error.code !== 'ENOENT') throw error; }
			}
		},
	};
};
