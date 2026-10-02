<script>
	import { onMount, tick } from 'svelte';
	import Accounts from './Accounts.svelte';

	let { model } = $props();
	let routes = $derived(model.routes);
	let startStates = $state({});
	let dragHost = $state(null);
	let beforeDrag = '';
	let saving = Promise.resolve();
	const t = $derived(model.t);
	const label = (route) => route.label || route.hostname.replace(/\.localhost$/, '');

	const pinnedHosts = () => routes.filter((route) => route.pinned).map((route) => route.hostname);
	const refresh = () => window.location.reload();
	const post = (path, body) => fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	function saveLayout(pinned, reload) {
		saving = saving.then(async () => {
			try {
				const response = await post('/layout', { pinned });
				if (!response.ok) window.alert('Save failed');
				else if (reload) refresh();
			} catch {
				window.alert('Save failed');
			}
		});
	}

	async function rename(route) {
		const nextLabel = window.prompt('Rename', label(route));
		if (nextLabel === null) return;
		try {
			const response = await post('/rename', { hostname: route.hostname, label: nextLabel });
			if (response.ok) refresh();
			else window.alert('Rename failed');
		} catch {
			window.alert('Rename failed');
		}
	}

	function togglePin(route) {
		const pinned = pinnedHosts();
		saveLayout(route.pinned
			? pinned.filter((hostname) => hostname !== route.hostname)
			: [...pinned, route.hostname], true);
	}

	async function reorder(hostname, direction, handle) {
		const index = routes.findIndex((route) => route.hostname === hostname);
		const nextIndex = index + direction;
		if (index < 0 || !routes[nextIndex]?.pinned) return;
		const next = [...routes];
		[next[index], next[nextIndex]] = [next[nextIndex], next[index]];
		routes = next;
		await tick();
		handle.focus();
		saveLayout(pinnedHosts(), false);
	}

	function handleKeydown(event, hostname) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault();
		reorder(hostname, event.key === 'ArrowUp' ? -1 : 1, event.currentTarget);
	}

	function handlePointerdown(event, hostname) {
		event.preventDefault();
		dragHost = hostname;
		beforeDrag = pinnedHosts().join();
	}

	function pointerMove(event) {
		if (!dragHost) return;
		const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('li.pinned');
		const target = over?.dataset.host;
		if (!target || target === dragHost) return;
		const below = event.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2;
		const next = [...routes];
		const from = next.findIndex((route) => route.hostname === dragHost);
		if (from < 0) return;
		const [moved] = next.splice(from, 1);
		const to = next.findIndex((route) => route.hostname === target);
		next.splice(to + Number(below), 0, moved);
		routes = next;
	}

	function drop() {
		if (!dragHost) return;
		dragHost = null;
		if (pinnedHosts().join() !== beforeDrag) saveLayout(pinnedHosts(), false);
	}

	async function start(hostname) {
		startStates[hostname] = 'starting';
		try {
			const response = await post('/start', { hostname });
			if (response.ok || response.status === 409) {
				refresh();
				return;
			}
		} catch { /* Show the same retry state for network errors. */ }
		startStates[hostname] = 'failed';
	}

	onMount(() => {
		if (model.view === 'accounts') return;
		let fallbackTimer;
		let startingTimer;
		let stream;
		const fallback = () => { fallbackTimer = setTimeout(refresh, 15000); };
		if (typeof EventSource === 'undefined') fallback();
		else {
			stream = new EventSource('/events');
			stream.onmessage = (event) => {
				if (event.data !== model.stamp) refresh();
			};
			stream.onerror = () => {
				stream.close();
				fallback();
			};
		}
		if (model.registered.some((app) => app.state === 'starting')) startingTimer = setTimeout(refresh, 2000);
		return () => {
			stream?.close();
			clearTimeout(fallbackTimer);
			clearTimeout(startingTimer);
		};
	});

	function visibilityChange() {
		if (model.view === 'accounts') return;
		if (document.visibilityState === 'visible') refresh();
	}
</script>

<svelte:document onpointermove={pointerMove} onpointerup={drop} onpointercancel={drop} onvisibilitychange={visibilityChange} />

{#snippet card(route, interactive)}
	<li class:local={!route.tailscaleUrl} class:linked={!!route.tailscaleUrl} class:pinned={interactive && route.pinned} class:drag={interactive && dragHost === route.hostname} data-host={interactive ? route.hostname : undefined}>
		{#if interactive}
			<div class="row">
				<span class:up={route.up} class="dot" role="img" aria-label={route.up ? 'online' : 'offline'}></span>
				<button type="button" class="name" data-host={route.hostname} onclick={() => rename(route)}>{label(route)}</button>
				{#if route.pinned}
					<button type="button" class="handle" aria-label="reorder: drag, or arrow keys" onkeydown={(event) => handleKeydown(event, route.hostname)} onpointerdown={(event) => handlePointerdown(event, route.hostname)}>⠿</button>
				{/if}
				<button type="button" class:pinned={route.pinned} class="pin" data-host={route.hostname} aria-pressed={route.pinned} aria-label={route.pinned ? 'unpin' : 'pin'} onclick={() => togglePin(route)}>{route.pinned ? '★' : '☆'}</button>
			</div>
			{#if route.tailscaleUrl}
				<a class="url" href={route.tailscaleUrl}>{route.tailscaleUrl.replace('https://', '')}</a>
			{:else}
				<span class="url">{t.local} — {route.hostname}</span>
			{/if}
		{:else if route.tailscaleUrl}
			<a class="peer-link" href={route.tailscaleUrl}>
				<span class="row"><span class:up={route.up} class="dot" role="img" aria-label={route.up ? 'online' : 'offline'}></span><span class="name">{label(route)}</span></span>
				<span class="url">{route.tailscaleUrl.replace('https://', '')}</span>
			</a>
		{:else}
			<span class="row"><span class:up={route.up} class="dot" role="img" aria-label={route.up ? 'online' : 'offline'}></span><span class="name">{label(route)}</span></span>
			<span class="url">{t.local} — {route.hostname}</span>
		{/if}
	</li>
{/snippet}

{#snippet localApps()}
	{#if routes.length || model.registered.length}
		<ul>
			{#each routes as route (route.hostname)}{@render card(route, true)}{/each}
			{#each model.registered as app (app.hostname)}
				{@const state = startStates[app.hostname] ?? app.state}
				<li class="registered">
					<span class="row"><span class="name">{app.label}</span><button type="button" class="start" data-start={app.hostname} disabled={state === 'starting'} onclick={() => start(app.hostname)}>{state === 'starting' ? t.starting : t.start}</button></span>
					<span class="launch-status" role="status">{state === 'failed' ? t.startFailed : state === 'starting' ? t.starting : t.stopped}</span>
				</li>
			{/each}
		</ul>
	{:else}<p class="empty">{t.empty}</p>{/if}
{/snippet}

{#snippet externalApps()}
	{#if model.external?.length}
		<section class="external-apps" aria-labelledby="external-apps-heading">
			<h2 id="external-apps-heading">{t.external}</h2>
			<p class="external-note">{t.externalNote}</p>
			<ul>
				{#each model.external as app (app.url)}
					<li class="linked">
						<a class="peer-link" href={app.url}>
							<span class="name">{app.label}</span>
							<span class="url">{app.url}</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/snippet}

{#if model.view === 'accounts'}
	<Accounts {model} />
{:else}
<main>
	<h1>{t.title}</h1>
	{#if model.accountManagementEnabled === true}
		<p class="account-management"><a href="/accounts" lang="en">CLI accounts</a></p>
	{/if}
	{#if !model.tailnetUp}
		<p class="banner" role="status">Tailscale not running — tailnet links won't work. Reconnect: <code>tailscale up</code> or open the Tailscale app.</p>
	{/if}
	{#if model.peers.length}
		<section>
			<h2>{model.device}</h2>
			{@render localApps()}
		</section>
		{@render externalApps()}
		{#each model.peers as peer, peerIndex (peerIndex)}
			{#if peer}
				<section>
					<h2>{peer.device}</h2>
					{#if peer.apps.length}
						<ul>{#each peer.apps as app, appIndex (appIndex)}{@render card(app, false)}{/each}</ul>
					{:else}<p class="empty">{t.peerEmpty}</p>{/if}
				</section>
			{/if}
		{/each}
	{:else}
		{@render localApps()}
		{@render externalApps()}
	{/if}
</main>
{/if}

<style>
	:global(body){font-family:ui-sans-serif,system-ui;background:#101014;color:#e6e6ea;margin:0;display:flex;justify-content:center;padding:48px 16px}
	:global(#directory){width:100%;max-width:420px}
	main{width:100%}
	h1{font-size:14px;font-weight:500;color:#8a8a94;letter-spacing:.08em;text-transform:uppercase}
	h2{font-size:12px;font-weight:500;color:#5e5e68;letter-spacing:.08em;text-transform:uppercase;margin:28px 0 8px}
	section>ul,section>.empty{margin-top:0}
	ul{list-style:none;padding:0;margin:16px 0}
	li{list-style:none;position:relative}
	li:not(.registered){display:flex;flex-direction:column;gap:2px;padding:14px 16px;margin-bottom:8px;background:#1a1a20;border:1px solid #2a2a32;border-radius:10px}
	li.local{opacity:.5}
	li.linked:active{background:#22222a}
	.row{display:flex;align-items:center;gap:8px}
	.dot{width:8px;height:8px;border-radius:50%;background:#4a4a54;flex:none}
	.dot.up{background:#34c759}
	.name{color:#e6e6ea;font-size:16px;font-weight:600}
	button.name{font-family:inherit;line-height:inherit;padding:0;border:0;background:none;text-align:left;cursor:pointer}
	li.linked button{position:relative;z-index:1}
	.pin,.handle{font-family:inherit;line-height:inherit;border:0;background:none}
	.pin{margin-left:auto;color:#4a4a54;font-size:15px;padding:0 2px;cursor:pointer}
	.pin.pinned{color:#e8b761}
	.handle{margin-left:auto;color:#4a4a54;font-size:14px;padding:0 2px;cursor:grab;touch-action:none}
	.handle+.pin{margin-left:0}
	li.drag{opacity:.5;pointer-events:none}
	.url{color:#8a8a94;font-size:12px;font-family:ui-monospace,monospace}
	a.url,.peer-link{text-decoration:none}
	a.url::after,.peer-link::after{content:"";position:absolute;inset:0}
	.peer-link{display:flex;flex-direction:column;gap:2px}
	.external-apps h2{color:#8a8a94}
	.external-note{color:#8a8a94;font-size:13px;margin:0 0 12px}
	.account-management{font-size:13px;margin:12px 0 20px}
	.account-management a{color:#a4a4ae;text-underline-offset:3px}
	.account-management a:hover{color:#e6e6ea}
	.external-apps .name,.external-apps .url{overflow-wrap:anywhere}
	.empty{color:#8a8a94;font-size:14px}
	.banner{background:#2a2014;border:1px solid #574018;border-radius:10px;color:#e8b761;font-size:13px;padding:12px 16px;margin:16px 0}
	.banner code{font-family:ui-monospace,monospace;color:#f0cf8e}
	li.registered{padding:14px 16px;margin-bottom:8px;background:#1a1a20;border:1px solid #2a2a32;border-radius:10px}
	.registered .name{color:#a4a4ae;overflow-wrap:anywhere;min-width:0}
	.start{margin-left:auto;min-height:44px;padding:8px 14px;flex:none;font:inherit;color:#e6e6ea;background:#2a2a32;border:1px solid #6e6e7a;border-radius:6px;cursor:pointer}
	.start:hover{background:#383842}
	.start:active{background:#454550}
	.start:disabled{color:#a4a4ae;cursor:wait}
	.launch-status{display:block;margin-top:4px;color:#a4a4ae;font-size:13px;overflow-wrap:anywhere}
	button:focus-visible,a:focus-visible{outline:2px solid #e8b761;outline-offset:3px}
</style>
