import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isReleaseTag, packageRelease, releaseFiles } from './package.mjs';

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

test('packageRelease creates a deterministic, explicit archive with checksums', () => {
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
		assert.match(checksums, /portless-home-v1\.2\.3\.tar\.gz/);
		assert.match(checksums, /portless-home-v1\.2\.3\.zip/);
		assert.doesNotMatch(readFileSync(a.tarball).toString('latin1'), /node_modules/);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(first, { recursive: true, force: true });
		rmSync(second, { recursive: true, force: true });
	}
});
