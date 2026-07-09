'use strict';
// governor/precompact-archive.js — PreCompact.
// Compaction is lossy by design. Before it happens, archive a full copy of
// the transcript so nothing summarized away is ever unrecoverable.

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

function main() {
  const input = c.readStdinJson();
  const src = input.transcript_path;
  if (!src || !fs.existsSync(src)) return;

  c.ensureDirs();
  const cfg = c.loadConfig();
  const sid = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(src, path.join(c.ARCHIVE_DIR, `${sid}-${ts}.jsonl`));

  // Retention: keep the newest N archives.
  const files = fs
    .readdirSync(c.ARCHIVE_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: fs.statSync(path.join(c.ARCHIVE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of files.slice(cfg.archiveMax)) {
    try {
      fs.unlinkSync(path.join(c.ARCHIVE_DIR, f));
    } catch {
      /* best-effort */
    }
  }
}

try {
  main();
} catch {
  /* never block compaction */
}
process.exit(0);
