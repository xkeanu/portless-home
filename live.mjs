// portless-home live updates: a server-sent-events stream that fires when
// routes.json changes, so the page can reload the moment apps start or stop.
// One fs.watch is shared by every open stream and exists only while a stream
// is open — an idle server holds no watcher (CONTRIBUTING, principle 4).
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';

// Watch the file's directory, not the file: a watch on the file's inode goes
// quiet once a write replaces it. A burst of events from one write collapses
// into a single callback.
export const watchFile = (file, onChange, settleMs = 100) => {
	let timer;
	const watcher = watch(dirname(file), (_, name) => {
		if (name && name !== basename(file)) return;
		clearTimeout(timer);
		timer = setTimeout(onChange, settleMs);
	});
	return () => {
		clearTimeout(timer);
		watcher.close();
	};
};

// Handler for GET /events. Returns false without touching the response when
// the directory cannot be watched, so the caller can answer 503 and the page
// falls back to its refresh timer.
export const events = (file) => {
	const streams = new Set();
	let stop;
	const broadcast = () => streams.forEach((res) => res.write('data: change\n\n'));
	return (res) => {
		if (!streams.size) {
			try {
				stop = watchFile(file, broadcast);
			} catch {
				return false;
			}
		}
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
		res.write(': connected\n\n');
		streams.add(res);
		res.on('close', () => {
			streams.delete(res);
			if (!streams.size) stop();
		});
		return true;
	};
};
