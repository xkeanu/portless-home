import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExternalApps, readExternalApps } from './external.mjs';

test('external links preserve order, normalize URLs, and ignore invalid or duplicate entries', () => {
	const first = { label: ' Demo ', url: ' HTTPS://EXAMPLE.TEST:443/path?q=a%20b#preview ' };
	const local = { label: '<img src=x onerror=bad()>', url: 'http://localhost:3000/' };
	const invalid = [null, {}, { label: '', url: first.url },
		{ label: 'x'.repeat(65), url: first.url }, { label: 'Demo', url: 'javascript:alert(1)' },
		{ label: 'Demo', url: 'data:text/html,hello' }, { label: 'Demo', url: '//example.test/' },
		{ label: 'Demo', url: 'http:example.test' }, { label: 'Demo', url: 'https://user:secret@example.test/' },
		{ label: 'Demo', url: 'https://user@example.test/' }, { label: 'Demo', url: 'https://[invalid' },
		{ label: 'Demo', url: 'https://example.test/\npath' }, { label: 'Demo', url: 42 },
		{ label: 'Demo', url: 'https://example.test/' + 'x'.repeat(2048) }];
	assert.deepEqual(parseExternalApps(JSON.stringify({ apps: [first, ...invalid, local, { label: 'Duplicate', url: 'https://example.test/path?q=a%20b#preview' }] })), [
		{ label: 'Demo', url: 'https://example.test/path?q=a%20b#preview' }, local,
	]);
	for (const text of ['{broken', 'null', '[]', '{}', '{"apps":{}}']) assert.deepEqual(parseExternalApps(text), []);
	const many = Array.from({ length: 101 }, (_, i) => ({ label: `App ${i}`, url: `https://example.test/${i}` }));
	assert.equal(parseExternalApps(JSON.stringify({ apps: many })).length, 100);
});

test('external configuration is optional and reread after edits or malformed JSON', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'portless-external-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, 'external-apps.json');
	assert.deepEqual(readExternalApps(path), []);
	for (const label of ['First', 'Second']) {
		const apps = [{ label, url: 'https://example.test/' }];
		writeFileSync(path, JSON.stringify({ apps }));
		assert.deepEqual(readExternalApps(path), apps);
	}
	writeFileSync(path, '{broken');
	assert.deepEqual(readExternalApps(path), []);
});
