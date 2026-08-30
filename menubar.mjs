// portless-home menu bar: the dropdown for the xbar/SwiftBar plugin in
// menubar/, served as text at GET /api/menubar. Plugin format: line 1 is the
// menu bar title, `---` separates sections, and `|` starts a line's params.
import { displayName } from './render.mjs';

// One menu line. `|` would start the params and a newline would start a new
// item, so neither may come from a label; both are user-influenced (rename).
const line = (text, params) => `${text.replace(/[|\r\n]/g, ' ')} | ${params.join(' ')}`;

// emojize/symbolize off: a label like ":house:" must not turn into an icon.
const NO_ICONS = ['emojize=false', 'symbolize=false'];

// A tailnet URL fit for `href=`: https only, and nothing that could end the
// param (space), start another (`|`) or another line. Anything else from
// routes.json is treated as no tailnet URL at all.
const tailnetUrl = (s) => {
	if (typeof s !== 'string' || /[\s|"]/.test(s)) return null;
	try {
		return new URL(s).protocol === 'https:' ? s : null;
	} catch {
		return null;
	}
};

// The menu bar sits on the machine the apps run on, so an app without a
// tailnet URL is still one click away on its localhost port.
const link = (url, r) => {
	if (url) return `href=${url}`;
	if (Number.isInteger(r.port)) return `href=http://127.0.0.1:${r.port}/`;
	return 'disabled=true';
};

const app = (r, up, names) => {
	const dot = up ? '●' : '○';
	const url = tailnetUrl(r.tailscaleUrl);
	const suffix = url ? '' : ' — local only';
	const params = [link(url, r), ...(up ? [] : ['color=gray']), ...NO_ICONS];
	return line(`${dot} ${displayName(r.hostname, names)}${suffix}`, params);
};

const EMPTY = 'Nothing running. Start an app through portless. | disabled=true';

// The whole dropdown for this device's apps; the plugin appends the service
// controls (start/stop) itself, since those must work when the server is down.
export const menubar = (routes, up, names, homeUrl) =>
	[
		`⌂ ${up.filter(Boolean).length}`,
		'---',
		`Open home page | href=${homeUrl}`,
		'---',
		...(routes.length ? routes.map((r, i) => app(r, up[i], names)) : [EMPTY]),
	].join('\n');
