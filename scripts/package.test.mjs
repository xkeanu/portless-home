import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isReleaseTag, packageRelease, releaseFiles, tarOwnershipArgs } from './package.mjs';

const makeFixture = () => {
	const root = mkdtempSync(join(tmpdir(), 'portless-home-package-test-'));
	for (const file of releaseFiles) {
		const path = join(root, file);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, `${file}\n`);
	}
	return root;
};

const listArchive = (archive) => {
	const result = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim().split('\n');
};

test('release tags accept SemVer 2.0.0 with a v prefix', () => {
	for (const tag of ['v0.0.0', 'v1.2.3', 'v10.20.30-rc.1', 'v1.2.3+build.5']) assert.equal(isReleaseTag(tag), true, tag);
	for (const tag of ['1.2.3', 'v01.2.3', 'v1.2', 'v1.2.3-', 'v1.2.3-01', 'v1.2.3+']) assert.equal(isReleaseTag(tag), false, tag);
});

test('package selects ownership flags supported by GNU and BSD tar', () => {
	assert.deepEqual(tarOwnershipArgs('tar (GNU tar) 1.35'), ['--owner=0', '--group=0', '--numeric-owner']);
	assert.deepEqual(tarOwnershipArgs('bsdtar 3.5.3'), ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']);
});

test('packageRelease rejects invalid tags and missing build output', () => {
	const source = makeFixture();
	const output = mkdtempSync(join(tmpdir(), 'portless-home-package-invalid-'));
	try {
		assert.throws(() => packageRelease({ tag: '1.2.3', source, output }), /Expected a SemVer release tag/);
		rmSync(join(source, 'dist/ui.css'));
		assert.throws(() => packageRelease({ tag: 'v1.2.3', source, output }), /Missing required release file: dist\/ui\.css/);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(output, { recursive: true, force: true });
	}
});

test('packageRelease creates a deterministic, explicit archive with checksums', { skip: process.platform === 'win32' && 'release archives are built on Ubuntu because Windows does not include zip' }, () => {
	const source = makeFixture();
	const first = mkdtempSync(join(tmpdir(), 'portless-home-package-first-'));
	const second = mkdtempSync(join(tmpdir(), 'portless-home-package-second-'));
	try {
		const a = packageRelease({ tag: 'v1.2.3', source, output: first });
		const b = packageRelease({ tag: 'v1.2.3', source, output: second });
		const expected = releaseFiles.map((file) => 'portless-home-v1.2.3/' + file);
		assert.deepEqual(listArchive(a.tarball), [...expected, 'portless-home-v1.2.3/RELEASE_MANIFEST.txt']);
		assert.equal(readFileSync(a.tarball).equals(readFileSync(b.tarball)), true, 'tarball must be reproducible');
		assert.equal(readFileSync(a.zipball).equals(readFileSync(b.zipball)), true, 'zipball must be reproducible');
		const checksums = readFileSync(a.checksumFile, 'utf8');
		const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
		assert.equal(checksums, `${hash(a.tarball)}  portless-home-v1.2.3.tar.gz\n${hash(a.zipball)}  portless-home-v1.2.3.zip\n`);
		const extracted = mkdtempSync(join(tmpdir(), 'portless-home-package-extracted-'));
		try {
			const extraction = spawnSync('tar', ['-xzf', a.tarball, '-C', extracted], { encoding: 'utf8' });
			assert.equal(extraction.status, 0, extraction.stderr);
			const manifest = readFileSync(join(extracted, 'portless-home-v1.2.3', 'RELEASE_MANIFEST.txt'), 'utf8');
			const expectedManifest = releaseFiles.map((file) => `${hash(join(source, file))}  ${file}`).join('\n') + '\n';
			assert.equal(manifest, expectedManifest);
		} finally {
			rmSync(extracted, { recursive: true, force: true });
		}
		assert.doesNotMatch(readFileSync(a.tarball).toString('latin1'), /node_modules/);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(first, { recursive: true, force: true });
		rmSync(second, { recursive: true, force: true });
	}
});
