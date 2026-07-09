'use strict';
// governor/session-restore.js — SessionStart.
// The other half of durability: when a session starts, resumes, or continues
// past a compaction, inject what survived — the agent-written RESUME.md (or
// the machine-generated RESUME.auto.md) and any preserved subagent outputs.

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

const MAX_AGE_DAYS = 7;
const MAX_CHARS = 6000;

function fresh(file) {
  try {
    const st = fs.statSync(file);
    return Date.now() - st.mtimeMs < MAX_AGE_DAYS * 86_400_000 ? st : null;
  } catch {
    return null;
  }
}

function main() {
  const input = c.readStdinJson();
  const dir = path.join(input.cwd || process.cwd(), '.governor');
  if (!fs.existsSync(dir)) return;

  const parts = [];

  const manual = path.join(dir, 'RESUME.md');
  const auto = path.join(dir, 'RESUME.auto.md');
  let resumeFile = null;
  if (fresh(manual)) resumeFile = manual;
  else if (fresh(auto)) resumeFile = auto;

  if (resumeFile) {
    const txt = fs.readFileSync(resumeFile, 'utf8').slice(0, MAX_CHARS);
    parts.push(
      `[governor] A checkpoint from an interrupted session exists (${path.basename(resumeFile)}):\n\n` +
        txt +
        `\n\n[governor] After absorbing this and confirming direction with the user, update or delete ${path.basename(resumeFile)} so it does not go stale.`
    );
  }

  const subDir = path.join(dir, 'subagents');
  if (fs.existsSync(subDir)) {
    const outs = fs
      .readdirSync(subDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, m: fs.statSync(path.join(subDir, f)).mtimeMs }))
      .filter((x) => Date.now() - x.m < MAX_AGE_DAYS * 86_400_000)
      .sort((a, b) => b.m - a.m)
      .slice(0, 10);
    if (outs.length && !resumeFile) {
      parts.push(
        '[governor] Preserved subagent outputs exist from earlier work — read before redoing research:\n' +
          outs.map((x) => `- .governor/subagents/${x.f}`).join('\n')
      );
    }
  }

  if (parts.length) c.hookOutput('SessionStart', parts.join('\n\n'));
}

try {
  main();
} catch {
  /* never block startup */
}
process.exit(0);
