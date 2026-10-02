import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliProcesses, parseNodeWrappers, runningClis } from './account-processes.mjs';

test('process guard matches executable names rather than project paths or shell text', () => {
	assert.deepEqual(parseCliProcesses('100 /usr/local/bin/claude\n101 /opt/bin/codex\n102 /projects/codex-helper/node\n103 zsh'), { claude: true, codex: true });
	assert.deepEqual(parseCliProcesses('100 node\n101 Claude.app\n102 codex-helper'), { claude: false, codex: false });
	assert.deepEqual(parseCliProcesses('100 codex.exe'), { claude: false, codex: true });
	assert.deepEqual(parseCliProcesses('100 /Applications/Tools with spaces/claude'), { claude: true, codex: false });
});

test('npm CLI wrappers are recognized without treating every Node server as busy', () => {
	assert.deepEqual(parseNodeWrappers('100 /usr/bin/node /path with spaces/@anthropic-ai/claude-code/cli.js\n101 node /opt/node_modules/@openai/codex/bin/codex.js'), { claude: true, codex: true });
	assert.deepEqual(parseNodeWrappers('100 node /tmp/server.mjs\n101 zsh -c claude'), { claude: false, codex: false });
});

test('failed process inspection blocks switching instead of guessing that clients are idle', async () => {
	assert.deepEqual(await runningClis(async () => { throw new Error('fixture inspection failure'); }), { claude: true, codex: true, unavailable: true });
});
