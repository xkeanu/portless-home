#!/usr/bin/env node
// Creates the prebuilt source archive for a tagged release. It deliberately
// copies an explicit list, so development output and node_modules cannot leak
// into a release.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const epoch = new Date('1980-01-01T00:00:00Z');

export const releaseFiles = [
	'LICENSE',
	'README.md',
	'install.sh',
	'install.ps1',
	'uninstall.sh',
	'uninstall.ps1',
	'server.mjs',
	'render.mjs',
	'i18n.mjs',
	'peers.mjs',
	'menubar.mjs',
	'live.mjs',
	'launch.mjs',
	'dist/ui-server.mjs',
	'dist/ui.js',
	'dist/ui.css',
	'docs/fixtures/routes.example.json',
	'docs/screenshot.png',
	'docs/tailnet-sharing.md',
	'menubar/portless-home.15s.sh',
	'tray/portless-home-tray.ps1',
];

// SemVer 2.0.0, with the v prefix used by GitHub release tags.
export const isReleaseTag = (tag) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag);

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const fail = (message) => {
	throw new Error(message);
};

const requireFiles = (source) => {
	for (const file of releaseFiles) {
		const path = join(source, file);
		if (!existsSync(path) || !statSync(path).isFile()) fail(`Missing required release file: ${file}. Run npm ci && npm run build first.`);
	}
};

const copyReleaseFile = (source, staging, file) => {
	const destination = join(staging, file);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(join(source, file), destination);
	utimesSync(destination, epoch, epoch);
};

const run = (command, args, options) => {
	const result = spawnSync(command, args, { encoding: 'utf8', ...options });
	if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
	if (result.status !== 0) fail(`${command} failed: ${result.stderr || result.stdout}`.trim());
};

export const tarOwnershipArgs = (version) =>
	/\bGNU tar\b/i.test(version)
		? ['--owner=0', '--group=0', '--numeric-owner']
		: ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'];

const localTarOwnershipArgs = () => tarOwnershipArgs(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout || '');

export const packageRelease = ({ tag, output = join(root, 'release'), source = root } = {}) => {
	if (!isReleaseTag(tag)) fail(`Expected a SemVer release tag such as v1.2.3, got ${tag || '(empty)'}.`);
	output = resolve(output);
	source = resolve(source);
	requireFiles(source);
	mkdirSync(output, { recursive: true });
	const name = `portless-home-${tag}`;
	const temp = mkdtempSync(join(tmpdir(), 'portless-home-release-'));
	const staging = join(temp, name);
	try {
		mkdirSync(staging);
		for (const file of releaseFiles) copyReleaseFile(source, staging, file);
		const manifest = [...releaseFiles]
			.map((file) => `${sha256(join(staging, file))}  ${file}`)
			.join('\n') + '\n';
		writeFileSync(join(staging, 'RELEASE_MANIFEST.txt'), manifest);
		utimesSync(join(staging, 'RELEASE_MANIFEST.txt'), epoch, epoch);

		const archiveFiles = [...releaseFiles, 'RELEASE_MANIFEST.txt'];
		const tarPath = join(output, `${name}.tar`);
		const tarball = join(output, `${name}.tar.gz`);
		const zipball = join(output, `${name}.zip`);
		const checksumFile = join(output, `${name}.sha256`);
		for (const file of [tarPath, tarball, zipball, checksumFile]) rmSync(file, { force: true });
		// BSD tar and GNU tar both preserve the supplied order. Node writes the
		// gzip header with a fixed timestamp, and zip -X strips host metadata.
		// GNU tar and BSD tar use different flags to normalize ownership.
		run('tar', [...localTarOwnershipArgs(), '-cf', tarPath, '-C', temp, ...archiveFiles.map((file) => `${name}/${file}`)]);
		writeFileSync(tarball, gzipSync(readFileSync(tarPath), { mtime: 0 }));
		rmSync(tarPath);
		run('zip', ['-X', '-q', zipball, ...archiveFiles.map((file) => `${name}/${file}`)], { cwd: temp });

		const checksums = [tarball, zipball].map((file) => `${sha256(file)}  ${basename(file)}`).join('\n') + '\n';
		writeFileSync(checksumFile, checksums);
		return { name, tarball, zipball, checksumFile };
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
};

const main = () => {
	const [tag, ...args] = process.argv.slice(2);
	let output;
	if (args.length === 2 && args[0] === '--output') output = resolve(args[1]);
	else if (args.length) fail('Usage: node scripts/package.mjs v1.2.3 [--output directory]');
	const result = packageRelease({ tag, output });
	console.log(`Created ${result.tarball}`);
	console.log(`Created ${result.zipball}`);
	console.log(`Created ${result.checksumFile}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
