'use strict';
// governor/status-report.js — human/agent-readable dump of current budget
// state. Used by the /governor:status command; also fine to run by hand:
//   node scripts/status-report.js [session_id]

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

const sessionId = process.argv[2] || process.env.CLAUDE_SESSION_ID || 'unknown';
const cfg = c.loadConfig();
const view = c.freshestState(sessionId);

if (!view.own && !view.quota) {
  console.log('governor: no collector data yet.');
  console.log('- Is the statusline installed? (node scripts/install-statusline.js)');
  console.log('- Quota fields appear only after the first API response, Pro/Max plans only.');
  process.exit(0);
}

const a = c.assess(view, cfg);
const band = c.peekBand(sessionId, a.band, a.fh.pct);

console.log('governor status');
console.log('  band        : ' + c.BAND_NAME[band] + (a.drivers.length ? ' (driver: ' + a.drivers.join(', ') + ')' : '') + (band !== a.band ? ' [debounced; raw ' + c.BAND_NAME[a.band] + ']' : ''));
console.log('  context     : ' + (a.ctxPct === null ? 'n/a (no state for this session)' : Math.round(a.ctxPct) + '%'));
if (a.fh.pct !== null) {
  let s = '  5h quota    : ' + Math.round(a.fh.pct) + '%';
  if (a.fh.resetsAt) s += ', resets ' + c.fmtClock(a.fh.resetsAt) + ' (' + c.fmtMins(a.fh.reset) + ')';
  if (a.fh.burn) s += ', burn ' + a.fh.burn.toFixed(2) + '%/min';
  console.log(s);
} else {
  console.log('  5h quota    : n/a (Pro/Max only; appears after first API response)');
}
if (a.sd.pct !== null) {
  console.log('  7d quota    : ' + Math.round(a.sd.pct) + '%' + (a.sd.resetsAt ? ', resets in ' + c.fmtMins(a.sd.reset) : ''));
}
if (a.stale) console.log('  WARNING     : quota data is stale (> ' + cfg.staleMinutes + ' min old)');
if (view.quota && view.quota.model) console.log('  last model  : ' + view.quota.model);

const govDir = path.join(process.cwd(), '.governor');
if (fs.existsSync(govDir)) {
  const resume = ['RESUME.md', 'RESUME.auto.md'].filter((f) => fs.existsSync(path.join(govDir, f)));
  const subs = fs.existsSync(path.join(govDir, 'subagents'))
    ? fs.readdirSync(path.join(govDir, 'subagents')).filter((f) => f.endsWith('.md')).length
    : 0;
  console.log('  durability  : ' + (resume.length ? resume.join(', ') : 'no checkpoint') + '; ' + subs + ' preserved subagent output(s)');
}
