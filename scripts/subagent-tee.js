'use strict';
// governor/subagent-tee.js — SubagentStop.
// The single most important durability fix: subagents are ephemeral by
// design, and their final message is the only thing that survives — until
// the parent session dies, when even that is gone. This hook tees every
// subagent's final message to a durable file the moment the subagent stops.

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

function main() {
  const input = c.readStdinJson();
  const msg = input.last_assistant_message;
  if (!msg) return;

  const dir = path.join(c.projectDir(input.cwd), 'subagents');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const agentType = String(input.agent_type || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const agentId = String(input.agent_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const file = path.join(dir, `${ts}-${agentType}-${agentId}.md`);

  const body = [
    '---',
    `agent_type: ${input.agent_type || 'unknown'}`,
    `agent_id: ${input.agent_id || 'unknown'}`,
    `session_id: ${input.session_id || 'unknown'}`,
    `finished: ${new Date().toISOString()}`,
    '---',
    '',
    String(msg),
    '',
  ].join('\n');

  fs.writeFileSync(file, body);

  // Also note it in the journal so resume notes can point at it.
  try {
    const jfile = path.join(c.projectDir(input.cwd), 'journal.jsonl');
    fs.appendFileSync(
      jfile,
      JSON.stringify({
        t: Date.now(),
        sid: input.session_id || null,
        tool: 'SubagentStop',
        target: path.relative(input.cwd || process.cwd(), file),
      }) + '\n'
    );
  } catch {
    /* best-effort */
  }
}

try {
  main();
} catch {
  /* never block */
}
process.exit(0);
