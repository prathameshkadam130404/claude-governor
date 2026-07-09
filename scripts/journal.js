'use strict';
// governor/journal.js — PostToolUse.
// Appends a one-line record of every tool call to <project>/.governor/journal.jsonl.
// Cheap, append-only. This is the raw material for machine-generated resume
// notes when a session dies without warning.

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

const MAX_BYTES = 2 * 1024 * 1024; // rotate at 2 MB

function summarizeTarget(toolName, ti) {
  if (!ti || typeof ti !== 'object') return null;
  const t =
    ti.file_path ||
    ti.path ||
    ti.command ||
    ti.pattern ||
    ti.url ||
    ti.description ||
    ti.prompt ||
    null;
  return t ? String(t).slice(0, 200) : null;
}

function main() {
  const input = c.readStdinJson();
  if (!input.tool_name) return;

  const dir = c.projectDir(input.cwd);
  const file = path.join(dir, 'journal.jsonl');

  try {
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > MAX_BYTES) {
      fs.renameSync(file, path.join(dir, 'journal.1.jsonl')); // keep one generation
    }
  } catch {
    /* rotation is best-effort */
  }

  const rec = {
    t: Date.now(),
    sid: input.session_id || null,
    tool: input.tool_name,
    target: summarizeTarget(input.tool_name, input.tool_input),
  };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

try {
  main();
} catch {
  /* never block */
}
process.exit(0);
