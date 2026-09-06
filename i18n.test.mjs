import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLang, strings, STRINGS } from './i18n.mjs';

test('pickLang falls back to English when the header is missing, empty, or unsupported', () => {
	assert.equal(pickLang(), 'en');
	assert.equal(pickLang(''), 'en');
	assert.equal(pickLang('xx, *;q=0.5'), 'en');
});

test('pickLang folds region subtags into the base language', () => {
	assert.equal(pickLang('de-CH'), 'de');
	assert.equal(pickLang('PT-br'), 'pt');
});

test('pickLang honours q-weights and keeps header order on ties', () => {
	assert.equal(pickLang('en;q=0.5, fr;q=0.9'), 'fr');
	assert.equal(pickLang('xx, ja, de'), 'ja');
	assert.equal(pickLang('fr ; q=0.8 , es'), 'es');
});

test('pickLang skips languages the client rejects with q=0 and garbage weights', () => {
	assert.equal(pickLang('de;q=0, es;q=0.1'), 'es');
	assert.equal(pickLang('de;q=abc, es'), 'es');
	assert.equal(pickLang('de;q=2, es;q=0.5'), 'es');
	assert.equal(pickLang('de;q=Infinity, es'), 'es');
});

test('strings returns the chosen language code alongside its dictionary', () => {
	assert.deepEqual(strings('de'), { lang: 'de', ...STRINGS.de });
	assert.equal(strings().title, 'dev apps');
});

test('every language provides every string', () => {
	const keys = Object.keys(STRINGS.en).sort();
	for (const [lang, dict] of Object.entries(STRINGS)) assert.deepEqual(Object.keys(dict).sort(), keys, lang);
});
