'use strict';
// governor/subagent-budget.js — PreToolUse on Task|Agent.
// Rewrites every subagent spawn prompt to carry (a) the durable-output
// contract — the fix for lost subagent work — and (b) the current budget
// band so subagents inherit restraint from the account-level pressure.
//
// NOTE (validation item): we return ONLY updatedInput, never a
// permissionDecision, so the normal permission flow is untouched. If the
// running Claude Code version ignores updatedInput without a decision,
// this hook degrades to a no-op — it can never make things worse.

const c = require('./lib/common');

const CONTRACT =
  '[governor] Durable-output contract: write your substantive findings/results ' +
  'to a file under .governor/subagents/ (or the project itself) BEFORE your final ' +
  'message. Your final message is a pointer to that file plus a short summary — ' +
  'the file is the deliverable, the message is not durable.';

function main() {
  const input = c.readStdinJson();
  const ti = input.tool_input;
  if (!ti || typeof ti.prompt !== 'string') return;

  const cfg = c.loadConfig();
  const view = c.freshestState(input.session_id || 'unknown');
  const a = view.own || view.quota ? c.assess(view, cfg) : null;

  let preamble = CONTRACT;
  if (a && a.band >= c.BAND.ECONOMY) {
    preamble +=
      '\n[governor] Budget at spawn: ' +
      c.budgetLine(a).replace(/^\[governor\] /, '') +
      '\nWork accordingly: be economical with reads and output.';
  }

  c.hookOutput('PreToolUse', null, {
    updatedInput: { ...ti, prompt: ti.prompt + '\n\n' + preamble },
  });
}

try {
  main();
} catch {
  /* never block spawns */
}
process.exit(0);
