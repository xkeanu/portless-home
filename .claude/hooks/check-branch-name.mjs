#!/usr/bin/env node
// PreToolUse hook (Bash): deny git commands that create a branch whose name
// the GitHub "branch-naming" ruleset would reject at push time.
// Allowed: feature/** fix/** docs/** chore/** ci/** (lowercase kebab).

const ALLOWED = /^(feature|fix|docs|chore|ci)\/[a-z0-9][a-z0-9./_-]*$/;

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = JSON.parse(Buffer.concat(chunks).toString()).tool_input?.command ?? '';
  } catch {
    process.exit(0);
  }
  if (!/\bgit\b/.test(cmd)) process.exit(0);

  const created = [];
  // Subcommand must directly follow `git` (bar global -flags), so prose in a
  // commit message or echo string can't false-positive.
  const patterns = [
    /\bgit\s+(?:-\S+\s+)*checkout\s+[^;|&]*?-[bB]\s+("?[^\s;|&"']+)/g,
    /\bgit\s+(?:-\S+\s+)*switch\s+[^;|&]*?-[cC]\s+("?[^\s;|&"']+)/g,
    /\bgit\s+(?:-\S+\s+)*worktree\s+add\s+[^;|&]*?-[bB]\s+("?[^\s;|&"']+)/g,
    /\bgit\s+(?:-\S+\s+)*branch\s+([^-\s"'][^\s;|&]*)/g,
  ];
  for (const re of patterns) {
    for (const m of cmd.matchAll(re)) created.push(m[1].replace(/^"|"$/g, ''));
  }

  const bad = created.filter((name) => !ALLOWED.test(name));
  if (bad.length === 0) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Branch name(s) ${bad.join(', ')} will be rejected by GitHub's branch-naming ` +
          `ruleset (GH013). Use type/short-kebab-description with type one of: ` +
          `feature/ fix/ docs/ chore/ ci/ (e.g. feature/12-linux-systemd). ` +
          `Note: "feat/" is NOT allowed — use "feature/". Re-run with a conforming name.`,
      },
    }),
  );
});
