'use strict';
// governor/subagent-budget.js — PreToolUse on Task|Agent.
// Rewrites every subagent spawn prompt to carry (a) the durable-output
// contract — the fix for lost subagent work — and (b) the current budget
// band so subagents inherit restraint from the account-level pressure.
//
// contractMode (config):
//   "allow"   (default) — return permissionDecision:"allow" + updatedInput.
//             Live-validated: some Claude Code versions ignore updatedInput
//             unless a decision accompanies it. Note: this auto-approves the
//             spawn itself (subagent spawns are typically auto-allowed
//             anyway; set "passive" if you want prompts preserved).
//   "passive" — updatedInput only, normal permission flow untouched;
//             degrades to a no-op on versions that require a decision.
//   "off"     — hook does nothing.
//
// Every invocation appends one line to runtime/subagent-budget.log so a
// failed contract injection can be diagnosed (fired-but-ignored vs never-fired).

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

const CONTRACT =
  '[governor] Durable-output contract: write your substantive findings/results ' +
  'to a file under .governor/subagents/ (or the project itself) BEFORE your final ' +
  'message. Your final message is a pointer to that file plus a short summary — ' +
  'the file is the deliverable, the message is not durable.';

function trace(entry) {
  try {
    c.ensureDirs();
    const f = path.join(c.GOV_HOME, 'runtime', 'subagent-budget.log');
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 256 * 1024) fs.unlinkSync(f);
    } catch { /* best-effort */ }
    fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* never fail on tracing */ }
}

function main() {
  const input = c.readStdinJson();
  // Registered without a matcher (live testing showed plugin regex matchers
  // not applying on some builds) — filter by tool name here instead.
  if (!/^(task|agent)$/i.test(String(input.tool_name || ''))) return;

  const cfg = c.loadConfig();
  const mode = cfg.contractMode || 'allow';
  const ti = input.tool_input;

  if (mode === 'off') {
    trace({ event: 'skipped', reason: 'contractMode off', tool: input.tool_name });
    return;
  }
  if (!ti || typeof ti.prompt !== 'string') {
    trace({ event: 'skipped', reason: 'no prompt field', tool: input.tool_name });
    return;
  }

  const view = c.freshestState(input.session_id || 'unknown');
  const a = view.own || view.quota ? c.assess(view, cfg) : null;

  let preamble = CONTRACT;
  if (a && a.band >= c.BAND.ECONOMY) {
    preamble +=
      '\n[governor] Budget at spawn: ' +
      c.budgetLine(a).replace(/^\[governor\] /, '') +
      '\nWork accordingly: be economical with reads and output.';
  }

  const updatedInput = { ...ti, prompt: ti.prompt + '\n\n' + preamble };
  const extra =
    mode === 'allow'
      ? {
          permissionDecision: 'allow',
          permissionDecisionReason: 'governor: durable-output contract appended to subagent prompt',
          updatedInput,
        }
      : { updatedInput };

  trace({
    event: 'injected',
    mode,
    tool: input.tool_name,
    band: a ? c.BAND_NAME[a.band] : 'no-data',
    promptChars: ti.prompt.length,
  });
  c.hookOutput('PreToolUse', null, extra);
}

try {
  main();
} catch {
  /* never block spawns */
}
process.exit(0);
