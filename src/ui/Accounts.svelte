<script>
	let { model } = $props();
	let snapshot = $state.raw(null);
	let working = $state('');
	let error = $state('');
	let notice = $state('');
	let captureProvider = $state('');
	let captureLabel = $state('');
	let switchId = $state('');
	let stopped = $state(false);
	const data = $derived(snapshot ?? model.accounts);
	const rows = $derived(data.accounts ?? []);
	const providers = $derived(data.providers ?? []);
	const supported = $derived(providers.filter((provider) => provider.supported));
	const selected = $derived(rows.find((account) => account.id === switchId));
	const providerLabel = (id) => providers.find((provider) => provider.id === id)?.label ?? id;
	const accountLabel = (account) => account.label || account.email || account.accountId;
	const date = (value) => {
		if (!value) return 'Unknown';
		const parsed = new Date(value);
		return Number.isNaN(parsed.valueOf()) ? 'Unknown' : `${parsed.toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} UTC`;
	};
	const usageLabel = (status) => ({ fresh: 'Usage checked', ok: 'Usage checked', stale: 'Usage is stale', unknown: 'Usage unknown', error: 'Usage check failed', unsupported: 'Usage unavailable' })[status] ?? 'Usage unknown';
	const percent = (value) => Number.isFinite(value) ? `${Math.round(value)}%` : 'Unknown';

	async function request(action, path, body, message, method = 'POST') {
		if (working) return false;
		working = action;
		error = '';
		notice = '';
		try {
			const response = await fetch(path, {
				method,
				...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
			});
			const result = await response.json();
			if (!response.ok || result.error) {
				error = result.error || 'The account action failed. Try again.';
				return false;
			}
			snapshot = result.accounts?.accounts ? result.accounts : result;
			notice = message;
			return true;
		} catch {
			error = 'Could not reach the account manager. Reload the page and try again.';
			return false;
		} finally {
			working = '';
		}
	}

	async function capture(event) {
		event.preventDefault();
		if (await request('capture', '/api/accounts/capture', { provider: captureProvider, label: captureLabel }, 'Current CLI login saved.')) captureLabel = '';
	}

	function choose(account) {
		switchId = account.id;
		stopped = false;
		error = '';
		notice = '';
	}

	async function switchAccount(event) {
		event.preventDefault();
		if (!stopped || !selected) return;
		if (await request('switch', '/api/accounts/switch', { id: selected.id }, 'CLI login switched. Start a new session or restart your CLI when ready.')) {
			switchId = '';
			stopped = false;
		}
	}

	function saveAccount(event, account) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		return request(`account:${account.id}`, '/api/accounts/account', {
			id: account.id,
			label: form.get('label'),
			priority: Number(form.get('priority')),
			reservePercent: Number(form.get('reservePercent')),
			disabled: form.has('disabled'),
		}, 'Account settings saved.');
	}

	function savePolicy(event) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		return request('policy', '/api/accounts/policy', {
			strategy: form.get('strategy'),
			threshold: Number(form.get('threshold')),
			auto: form.has('auto'),
			useFirst: form.get('useFirst') || '',
		}, 'Routing preferences saved.');
	}
</script>

<main class="accounts" lang="en" aria-busy={!!working}>
	<nav aria-label="Account navigation"><a href="/">Back to apps</a></nav>
	<header>
		<div>
			<h1>CLI accounts</h1>
			<p>Save local logins and choose the account for your next CLI session.</p>
		</div>
		<button type="button" disabled={!!working} onclick={() => request('reload', '/api/accounts', undefined, 'Accounts reloaded.', 'GET')}>{working === 'reload' ? 'Reloading…' : 'Reload accounts'}</button>
	</header>
	<p class="scope-note">Claude Code CLI and Codex CLI only. After a switch, restart your CLI yourself. Desktop app logins are separate.</p>
	<div class="feedback" aria-live="polite" aria-atomic="true">
		{#if error || data.error}<p class="error" role="alert">{error || data.error}</p>{/if}
		{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	</div>
	{#if !data.enabled}
		<section class="setup">
			<h2>Account management is off</h2>
			<p>Enable the local account manager to save CLI logins on this device.</p>
		</section>
	{:else}
		{#if data.pending?.length}
			<section class="pending" aria-labelledby="pending-heading">
				<h2 id="pending-heading">Suggested switches</h2>
				{#each data.pending as pending (pending.provider)}
					{@const account = rows.find((row) => row.id === pending.id)}
					<p><strong>{providerLabel(pending.provider)}{account ? ` · ${accountLabel(account)}` : ''}</strong><br />{pending.reason || 'Finish your active CLI work, then choose this account below.'}</p>
				{/each}
				<p>Stop the provider's CLI sessions before switching. Restart the CLI yourself when ready.</p>
			</section>
		{/if}
		{#if providers.some((provider) => data.busy?.[provider.id])}
			<p class="busy-note" role="status">{providers.filter((provider) => data.busy?.[provider.id]).map((provider) => provider.label).join(' and ')} is running. Finish your work and close those CLI sessions, then reload accounts to enable switching.</p>
		{/if}
		{#if data.recommendations}
			<section aria-labelledby="recommendations-heading">
				<h2 id="recommendations-heading">Next account</h2>
				{#each providers as provider (provider.id)}
					{@const choice = data.recommendations[provider.id]}
					{@const account = rows.find((row) => row.id === choice?.accountId)}
					{#if choice}
						<p><strong>{provider.label}{account ? ` · ${accountLabel(account)}` : ''}</strong><br />{choice.reason}</p>
						{#each choice.warnings ?? [] as warning (warning)}<p class="warning" role="status">{warning}</p>{/each}
					{/if}
				{/each}
			</section>
		{/if}
		<section aria-labelledby="saved-heading">
			<div class="section-heading">
				<h2 id="saved-heading">Saved accounts <span>{rows.length}</span></h2>
				<button type="button" disabled={!!working || !rows.some((account) => account.availableLocally)} onclick={() => request('refresh', '/api/accounts/refresh', {}, 'Usage checked for local accounts.')}>{working === 'refresh' ? 'Checking usage…' : 'Check usage'}</button>
			</div>
			{#if rows.length}
				<ul class="account-list">
					{#each rows as account (account.id)}
						<li class="account" data-account={account.id}>
							<div class="account-heading">
								<div>
									<h3>{accountLabel(account)}</h3>
									<p class="identity">{providerLabel(account.provider)}{account.tier ? ` · ${account.tier}` : ''}{account.email && account.label ? ` · ${account.email}` : ''}</p>
								</div>
								<span class={['state', account.active && 'active']}>{account.active ? 'Active login' : !account.availableLocally ? 'Sign in on this device' : account.disabled ? 'Excluded from routing' : 'Saved locally'}</span>
							</div>
							{#if account.windows?.length}
								<dl class="usage-windows">
									{#each account.windows as window (window.key)}
										<div>
											<dt>{window.label}</dt>
											<dd><strong>{percent(window.usedPercent)}</strong> used</dd>
											<dd class="reset">Resets {date(window.resetsAt)}</dd>
										</div>
									{/each}
								</dl>
							{/if}
							<p class="usage-status">{usageLabel(account.usageStatus)}{account.observedAt ? ` · ${date(account.observedAt)}` : ''}</p>
							{#if account.error}<p class="error">{account.error}</p>{/if}
							<div class="account-actions">
								<button type="button" data-switch={account.id} disabled={!!working || account.active || !account.availableLocally || data.busy?.[account.provider]} onclick={() => choose(account)}>{account.active ? 'Current account' : 'Switch account'}</button>
								<span>{!account.availableLocally ? 'Use the provider CLI to sign in, then save its current login below.' : 'Login stays on this device.'}</span>
							</div>
							{#if switchId === account.id}
								<form class="switch-confirm" onsubmit={switchAccount} aria-label={`Confirm switch to ${accountLabel(account)}`}>
									<p>Switch the {providerLabel(account.provider)} login to <strong>{accountLabel(account)}</strong>. The manager will refuse while that CLI is running.</p>
									<label class="check"><input type="checkbox" bind:checked={stopped} required disabled={!!working} /> I have stopped this provider's CLI sessions.</label>
									<div class="buttons">
										<button type="submit" class="primary" disabled={!stopped || !!working || data.busy?.[account.provider]}>{working === 'switch' ? 'Switching…' : 'Switch login'}</button>
										<button type="button" disabled={!!working} onclick={() => { switchId = ''; stopped = false; }}>Cancel</button>
									</div>
								</form>
							{/if}
							<details>
								<summary>Account settings</summary>
								<form class="settings-form" onsubmit={(event) => saveAccount(event, account)} aria-label={`Settings for ${accountLabel(account)}`}>
									<div class="fields">
										<label class="wide">Label<input name="label" value={account.label || ''} maxlength="64" disabled={!!working} /></label>
										<label>Priority<input name="priority" type="number" min="-100" max="100" step="1" value={account.priority ?? 0} disabled={!!working} /></label>
										<label>Reserve %<input name="reservePercent" type="number" min="0" max="99" step="1" value={account.reservePercent ?? 0} disabled={!!working} /></label>
									</div>
									<p class="field-note">Higher priority wins before subscription preference and quota. Reserve marks allowance you want to keep for other work.</p>
									<label class="check"><input name="disabled" type="checkbox" checked={account.disabled} disabled={!!working} /> Exclude from automatic routing</label>
									<button type="submit" disabled={!!working}>{working === `account:${account.id}` ? 'Saving…' : 'Save settings'}</button>
								</form>
							</details>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="empty"><h3>Save your first CLI account</h3><p>Sign in to Claude Code or Codex in your terminal. Then use “Save current login” below. To add another account, sign in to that account through the same CLI and save again.</p></div>
			{/if}
		</section>
		<section class="capture" aria-labelledby="capture-heading">
			<h2 id="capture-heading">Save current login</h2>
			<p>Sign in with the provider's CLI first. This saves the login already present on this device.</p>
			<form onsubmit={capture}>
				<div class="fields">
					<label>Provider
						<select bind:value={captureProvider} required disabled={!!working || !supported.length}>
							<option value="" disabled>Choose a CLI</option>
							{#each providers as provider (provider.id)}
								<option value={provider.id} disabled={!provider.supported}>{provider.label}{provider.supported ? '' : ' · unavailable'}</option>
							{/each}
						</select>
					</label>
					<label>Account label<input bind:value={captureLabel} maxlength="64" placeholder="Optional, for example Work" disabled={!!working || !supported.length} /></label>
				</div>
				{#each providers.filter((provider) => !provider.supported) as provider (provider.id)}
					<p class="field-note">{provider.label}: {provider.error || 'Login capture is unavailable on this device.'}</p>
				{/each}
				<button type="submit" class="primary" disabled={!!working || !captureProvider || !supported.length}>{working === 'capture' ? 'Saving login…' : 'Save current login'}</button>
			</form>
		</section>
		<section aria-labelledby="routing-heading">
			<h2 id="routing-heading">Routing preferences</h2>
			<p>Usage checks can recommend the next account. Applying a switch still requires idle CLIs and your confirmation.</p>
			<form onsubmit={savePolicy}>
				<div class="fields">
					<label>Strategy
						<select name="strategy" value={data.policy?.strategy ?? 'best'} disabled={!!working}>
								<option value="best">Priority, tier, then quota</option>
								<option value="consume-first">Soonest weekly reset</option>
						</select>
					</label>
					<label>Switch threshold %<input name="threshold" type="number" min="1" max="100" step="1" value={data.policy?.threshold ?? 90} disabled={!!working} /></label>
					<label class="wide">Use first
						<select name="useFirst" value={data.policy?.useFirst ?? ''} disabled={!!working}>
							<option value="">Follow strategy</option>
								{#each rows.filter((row) => row.availableLocally && !row.disabled) as account (account.id)}
									<option value={account.id}>{providerLabel(account.provider)} · {accountLabel(account)}</option>
								{/each}
						</select>
					</label>
				</div>
				<p class="field-note">The threshold is the used allowance at which routing should consider another account. Unknown or stale usage does not count as available allowance.</p>
				<label class="check"><input type="checkbox" name="auto" checked={data.policy?.auto ?? false} disabled={!!working} /> Automatically prepare switches</label>
				<p class="field-note">Prepared switches wait for your confirmation. A running session's login will never change automatically.</p>
				<button type="submit" disabled={!!working}>{working === 'policy' ? 'Saving…' : 'Save preferences'}</button>
			</form>
		</section>
	{/if}
	<section class="sync" aria-labelledby="sync-heading">
		<h2 id="sync-heading">Between devices</h2>
		<p>{data.sync?.configured ? `Metadata sync is configured. ${data.sync.count ?? 0} devices have responded.` : 'Metadata sync is not configured on this device.'}</p>
		{#if data.sync?.configured}<button type="button" disabled={!!working} onclick={() => request('sync', '/api/accounts/sync', {}, 'Account metadata synced.')}>{working === 'sync' ? 'Syncing…' : 'Sync metadata'}</button>{/if}
		<p>Sync shares account labels, usage and routing preferences. Log in separately on each device to use an account there.</p>
	</section>
</main>

<style>
	:global(#directory:has(.accounts)){max-width:760px}
	.accounts{--surface:#1a1a20;--border:#2a2a32;--text:#e6e6ea;--muted:#a4a4ae;--control:#2a2a32;--control-hover:#383842;--accent:#e8b761;--success:#91dba5;--error:#ffb4ab;color:var(--text);font-size:14px;line-height:1.5;overflow-wrap:anywhere}
	.accounts ::selection{background:#e8b761;color:#101014}
	nav{margin-bottom:20px}
	a{color:var(--muted);text-underline-offset:4px}
	a:hover{color:var(--text)}
	header,.section-heading,.account-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
	header button,.section-heading button{flex:none}
	h1{font-size:24px;line-height:1.25;font-weight:650;letter-spacing:-.02em;margin:0 0 8px}
	h2{font-size:16px;line-height:1.4;font-weight:600;margin:0 0 8px}
	h2 span{font-size:13px;font-weight:400;color:var(--muted);margin-left:6px;font-variant-numeric:tabular-nums}
	h3{font-size:16px;font-weight:600;margin:0 0 3px}
	p{margin:0 0 16px;max-width:70ch;color:var(--muted)}
	header p{margin-bottom:0}
	.scope-note{margin-top:20px;padding-bottom:20px;border-bottom:1px solid var(--border)}
	section{margin-top:32px}
	.section-heading{align-items:center;margin-bottom:12px}
	.section-heading h2{margin:0}
	button,input,select{font:inherit;color:var(--text);border:1px solid #6e6e7a;border-radius:6px}
	button{min-height:44px;padding:8px 14px;background:var(--control);cursor:pointer;transition:background 150ms ease-out}
	button:hover{background:var(--control-hover)}
	button:active{background:var(--border)}
	button:disabled{color:var(--muted);opacity:.65;cursor:default}
	button.primary{border-color:var(--accent);background:var(--accent);color:#101014;font-weight:600}
	button.primary:hover{background:#f0cf8e}
	button.primary:active{background:#d7a34d}
	button.primary:disabled{color:#101014}
	button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
	input,select{box-sizing:border-box;min-height:44px;padding:8px 10px;min-width:0;width:100%;background:var(--surface);caret-color:var(--accent)}
	input:disabled,select:disabled{opacity:.65}
	input::placeholder{color:var(--muted);opacity:1}
	label{display:flex;flex-direction:column;gap:6px;font-size:13px;min-width:0}
	.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:16px 0}
	.fields .wide{grid-column:1/-1}
	.check{flex-direction:row;align-items:flex-start;gap:10px;font-size:14px;margin:16px 0}
	.check input{width:18px;min-height:18px;height:18px;margin:2px 0 0;flex:none;accent-color:var(--accent)}
	.field-note,.usage-status,.account-actions span{font-size:13px}
	.account-list{list-style:none;padding:0;margin:0}
	.account{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:12px}
	.identity{font-size:13px;margin:0}
	.state{font-size:12px;color:var(--muted);text-align:right;flex:none;max-width:150px}
	.state.active{color:var(--success)}
	.usage-windows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 24px;margin:20px 0 12px;font-variant-numeric:tabular-nums}
	.usage-windows dt{color:var(--muted);font-size:13px}
	.usage-windows dd{margin:0}
	.usage-windows strong{font-weight:600}
	.reset{color:var(--muted);font-size:12px}
	.usage-status{margin-top:14px;margin-bottom:16px}
	.account-actions{display:flex;align-items:center;gap:14px}
	.account-actions button{flex:none}
	.account-actions span{color:var(--muted)}
	details{margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}
	summary{color:var(--muted);cursor:pointer;font-size:13px;min-height:24px}
	summary:hover{color:var(--text)}
	.settings-form{padding-top:1px}
	.switch-confirm{margin-top:20px;padding-top:20px;border-top:1px solid var(--border)}
	.switch-confirm p{color:var(--text)}
	.buttons{display:flex;gap:10px;flex-wrap:wrap}
	.empty{padding:24px 0;border-block:1px solid var(--border)}
	.empty p{margin:6px 0 0}
	.capture{padding-top:24px;border-top:1px solid var(--border)}
	.pending,.error,.notice,.busy-note{border:1px solid var(--border);border-radius:12px;padding:14px 16px;background:var(--surface)}
	.pending h2{color:var(--accent)}
	.pending p{margin-bottom:12px}
	.pending p:last-child{margin:0}
	.error{color:var(--error);margin:0 0 12px}
	.notice{color:var(--success);margin:0 0 12px}
	.warning{color:var(--accent)}
	.sync{padding-top:24px;border-top:1px solid var(--border)}
	.sync p:last-child{margin-bottom:0}
	@media(max-width:540px){header,.account-heading{flex-direction:column;gap:12px}.account-heading .state{text-align:left;max-width:none}.fields{grid-template-columns:1fr}.fields .wide{grid-column:auto}.account-actions{align-items:flex-start;flex-direction:column;gap:8px}.account{padding:16px}.section-heading{align-items:flex-start;gap:12px}.section-heading button{font-size:13px;padding-inline:10px}.usage-windows{gap:12px}}
	@media(prefers-reduced-motion:reduce){button{transition:none}}
	@media(prefers-color-scheme:light){:global(body:has(.accounts)){background:#f5f5f7}.accounts{--surface:#fff;--border:#d8d8df;--text:#24242b;--muted:#62626e;--control:#ededf1;--control-hover:#e0e0e7;--accent:#805500;--success:#23743b;--error:#a12b23}.accounts ::selection{background:#e8b761;color:#24242b}button.primary{background:#e8b761;border-color:#9c721d;color:#24242b}button.primary:disabled{color:#24242b}}
</style>
