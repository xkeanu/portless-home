import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');

const svelte = (generate, styles) => ({
	name: `svelte-${generate}`,
	setup(builder) {
		builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const source = await readFile(path, 'utf8');
			const result = compile(source, { filename: path, generate, css: 'external' });
			if (result.css) styles.set(path, result.css.code);
			return { contents: result.js.code, loader: 'js', resolveDir: resolve(path, '..') };
		});
	},
});

await mkdir(dist, { recursive: true });
const licenses = await Promise.all([
	['Svelte', 'svelte/LICENSE.md'],
	['clsx', 'clsx/license'],
	['esm-env', 'esm-env/LICENSE'],
].map(async ([name, path]) => `${name}\n${await readFile(resolve(root, 'node_modules', path), 'utf8')}`));
const licenseBanner = `/*\n${licenses.join('\n\n')}\n*/`;
const styles = new Map();
await build({
	entryPoints: [resolve(root, 'src/ui/server.mjs')],
	outfile: resolve(dist, 'ui-server.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	banner: { js: licenseBanner },
	plugins: [svelte('server', styles)],
});
await build({
	entryPoints: [resolve(root, 'src/ui/client.mjs')],
	outfile: resolve(dist, 'ui.js'),
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2022',
	minify: true,
	banner: { js: licenseBanner },
	plugins: [svelte('client', styles)],
});
await writeFile(resolve(dist, 'ui.css'), [...styles.values()].join('\n'));
