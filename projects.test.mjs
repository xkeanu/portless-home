import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appFields, composeService, groupProjects } from './projects.mjs';

// Captured from portless 0.16.0: `portless compose up` (web, api) plus `portless alias grafana 3000`.
const fixture = JSON.parse(readFileSync(new URL('./docs/fixtures/routes.compose.json', import.meta.url), 'utf8'));
const byHost = (hostname) => fixture.find((r) => r.hostname === hostname);

test('composeService reads project and service from a static <service>.<project>.localhost route', () => {
	assert.deepEqual(composeService(byHost('web.shop.localhost')), { project: 'shop', service: 'web' });
	assert.deepEqual(composeService({ hostname: '8080.api.shop.localhost', pid: 0 }), { project: 'shop', service: '8080.api' });
});

test('composeService leaves aliases, plain apps and live worktree routes ungrouped', () => {
	assert.equal(composeService(byHost('grafana.localhost')), null);
	assert.equal(composeService(byHost('blog.localhost')), null);
	assert.equal(composeService({ hostname: 'feature-x.blog.localhost', pid: 4242 }), null);
});

test('appFields labels a service by its service name unless renamed, and plain apps as before', () => {
	assert.deepEqual(appFields(byHost('web.shop.localhost'), {}), { label: 'web', project: 'shop' });
	assert.deepEqual(appFields(byHost('web.shop.localhost'), { 'web.shop.localhost': 'Storefront' }), { label: 'Storefront', project: 'shop' });
	assert.deepEqual(appFields(byHost('blog.localhost'), {}), { label: 'blog' });
	assert.deepEqual(appFields(byHost('grafana.localhost'), {}), { label: 'grafana' });
});

test('groupProjects splits plain apps from project groups in first-seen order', () => {
	const apps = [
		{ hostname: 'a.localhost' },
		{ hostname: 'api.shop.localhost', project: 'shop' },
		{ hostname: 'web.docs.localhost', project: 'docs' },
		{ hostname: 'b.localhost' },
		{ hostname: 'web.shop.localhost', project: 'shop' },
	];
	const { apps: plain, projects } = groupProjects(apps);
	assert.deepEqual(plain.map((a) => a.hostname), ['a.localhost', 'b.localhost']);
	assert.deepEqual(projects.map((p) => [p.name, p.services.map((s) => s.hostname)]), [
		['shop', ['api.shop.localhost', 'web.shop.localhost']],
		['docs', ['web.docs.localhost']],
	]);
});
