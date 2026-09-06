// portless-home i18n: the page's few UI strings, keyed by language.
// The Accept-Language header only selects a key here; nothing from it
// reaches the HTML.
export const STRINGS = {
	en: { title: 'dev apps', local: 'local only', empty: 'Nothing running. Start an app through portless.', peerEmpty: 'Nothing running.' },
	de: { title: 'Dev-Apps', local: 'nur lokal', empty: 'Nichts läuft. Starte eine App über portless.', peerEmpty: 'Nichts läuft.' },
	es: { title: 'apps de desarrollo', local: 'solo local', empty: 'Nada en ejecución. Inicia una app con portless.', peerEmpty: 'Nada en ejecución.' },
	fr: { title: 'apps de dev', local: 'local uniquement', empty: 'Rien ne tourne. Lance une app via portless.', peerEmpty: 'Rien ne tourne.' },
	pt: { title: 'apps de dev', local: 'apenas local', empty: 'Nada em execução. Inicie um app pelo portless.', peerEmpty: 'Nada em execução.' },
	ja: { title: '開発アプリ', local: 'ローカルのみ', empty: '起動中のアプリはありません。portless でアプリを起動してください。', peerEmpty: '起動中のアプリはありません。' },
};

// Best supported language from an Accept-Language header: highest q wins,
// ties keep header order, and region subtags fold into the base language
// (en-GB → en). English when nothing matches or the header is absent.
export const pickLang = (header = '') =>
	String(header)
		.split(',')
		.map((part, i) => {
			const [tag, ...params] = part.split(';').map((s) => s.trim());
			const q = params.find((p) => p.startsWith('q='));
			return { lang: tag.toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1, i };
		})
		.filter((e) => Object.hasOwn(STRINGS, e.lang) && e.q > 0)
		.sort((a, b) => b.q - a.q || a.i - b.i)[0]?.lang ?? 'en';

export const strings = (header) => {
	const lang = pickLang(header);
	return { lang, ...STRINGS[lang] };
};
