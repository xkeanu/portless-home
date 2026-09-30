import { readFileSync } from 'node:fs';

const parseApp = (app) => {
	if (!app || typeof app.label !== 'string' || typeof app.url !== 'string') return null;
	const label = app.label.trim();
	const value = app.url.trim();
	if (!label || label.length > 64 || value.length > 2048 ||
		!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return null;
	try {
		const url = new URL(value);
		if (url.username || url.password) return null;
		return { label, url: url.href };
	} catch {
		return null;
	}
};

export const parseExternalApps = (text) => {
	try {
		const apps = JSON.parse(text)?.apps;
		if (!Array.isArray(apps)) return [];
		const seen = new Set();
		return apps.slice(0, 100).map(parseApp).filter((app) => {
			if (!app || seen.has(app.url)) return false;
			seen.add(app.url);
			return true;
		});
	} catch {
		return [];
	}
};

export const readExternalApps = (path) => {
	try {
		return parseExternalApps(readFileSync(path, 'utf8'));
	} catch {
		return [];
	}
};
