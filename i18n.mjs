// portless-home i18n: the page's few UI strings, keyed by language.
// The Accept-Language header only selects a key here; nothing from it
// reaches the HTML.
export const STRINGS = {
	en: { start: 'Start', starting: 'Starting…', stopped: 'Stopped', startFailed: 'Could not start the app. Check the configured command and try again.', title: 'dev apps', local: 'local only', empty: 'Nothing running. Start an app through portless.', peerEmpty: 'Nothing running.' },
	de: { start: 'Starten', starting: 'Wird gestartet…', stopped: 'Gestoppt', startFailed: 'Start fehlgeschlagen. Prüfe den konfigurierten Befehl und versuche es erneut.', title: 'Dev-Apps', local: 'nur lokal', empty: 'Nichts läuft. Starte eine App über portless.', peerEmpty: 'Nichts läuft.' },
	es: { start: 'Iniciar', starting: 'Iniciando…', stopped: 'Detenida', startFailed: 'No se pudo iniciar la app. Revisa el comando configurado e inténtalo de nuevo.', title: 'apps de desarrollo', local: 'solo local', empty: 'Nada en ejecución. Inicia una app con portless.', peerEmpty: 'Nada en ejecución.' },
	fr: { start: 'Démarrer', starting: 'Démarrage…', stopped: 'Arrêtée', startFailed: 'Impossible de démarrer. Vérifiez la commande configurée et réessayez.', title: 'apps de dev', local: 'local uniquement', empty: 'Rien ne tourne. Lance une app via portless.', peerEmpty: 'Rien ne tourne.' },
	pt: { start: 'Iniciar', starting: 'Iniciando…', stopped: 'Parado', startFailed: 'Não foi possível iniciar. Verifique o comando configurado e tente novamente.', title: 'apps de dev', local: 'apenas local', empty: 'Nada em execução. Inicie um app pelo portless.', peerEmpty: 'Nada em execução.' },
	ja: { start: '起動', starting: '起動中…', stopped: '停止中', startFailed: '起動できませんでした。設定したコマンドを確認して再試行してください。', title: '開発アプリ', local: 'ローカルのみ', empty: '起動中のアプリはありません。portless でアプリを起動してください。', peerEmpty: '起動中のアプリはありません。' },
};

// Best supported language from an Accept-Language header: highest q wins,
// ties keep header order, and region subtags fold into the base language
// (en-GB → en). Weights outside 0..1 are invalid and drop the entry. English
// when nothing matches or the header is absent.
export const pickLang = (header = '') =>
	String(header)
		.split(',')
		.map((part, i) => {
			const [tag, ...params] = part.split(';').map((s) => s.trim());
			const q = params.find((p) => p.startsWith('q='));
			return { lang: tag.toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1, i };
		})
		.filter((e) => Object.hasOwn(STRINGS, e.lang) && e.q > 0 && e.q <= 1)
		.sort((a, b) => b.q - a.q || a.i - b.i)[0]?.lang ?? 'en';

export const strings = (header) => {
	const lang = pickLang(header);
	return { lang, ...STRINGS[lang] };
};
