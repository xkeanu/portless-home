// portless-home live updates: a server-sent-events stream that fires when
// routes.json changes, so the page can reload the moment apps start or stop.
// One fs.watch is shared by every open stream and exists only while a stream
// is open — an idle server holds no watcher (CONTRIBUTING, principle 4).
import { createHash } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';

export const readText = (file) => {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return '';
	}
};

// Identity of the routes.json content a page was rendered from. Every event
// carries the current one, so the page reloads only when what it shows is
// stale — not for a same-content rewrite, a stray event for another file in
// the directory, or an event that arrives without a filename.
export const stamp = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);

// Watch the file's directory, not the file: a watch on the file's inode goes
// quiet once a write replaces it. A burst of events from one write collapses
// into a single callback.
export const watchFile = (file, onChange, onError) => {
	let timer;
	const watcher = watch(dirname(file), (_, name) => {
		if (name && name !== basename(file)) return;
		clearTimeout(timer);
		timer = setTimeout(onChange, 100);
	});
	watcher.on('error', onError);
	return () => {
		clearTimeout(timer);
		watcher.close();
	};
};

// Handler for GET /events. Returns false without touching the response when
// the directory cannot be watched, so the caller can answer 503 and the page
// falls back to its refresh timer; a watcher error ends every open stream for
// the same reason. The first event is the current stamp, so a write that
// landed between the page render and this request is not missed.
export const events = (file) => {
	const streams = new Set();
	let stop;
	const event = () => `data: ${stamp(readText(file))}\n\n`;
	const broadcast = () => {
		const data = event();
		streams.forEach((res) => res.write(data));
	};
	const dropAll = () => streams.forEach((res) => res.end());
	return (res) => {
		if (!streams.size) {
			try {
				stop = watchFile(file, broadcast, dropAll);
			} catch {
				return false;
			}
		}
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
		res.write(event());
		streams.add(res);
		res.on('close', () => {
			streams.delete(res);
			if (!streams.size) stop();
		});
		return true;
	};
};
