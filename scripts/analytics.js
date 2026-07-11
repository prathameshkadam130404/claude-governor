'use strict';
// governor/analytics.js — usage analytics from governor's own local data.
// Used by /governor:analytics; also fine to run by hand:
//   node scripts/analytics.js [session_id]
//
// Reports only what the collector actually records: per-session state
// snapshots (14-day retention), quota history samples, and the current
// project's journal/subagent artifacts. The statusline feed carries no
// token counts, so there is deliberately no "token efficiency" metric —
// cost_usd and quota percentages are the honest units available.

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

function safeReadDir(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

function main() {
  const sessionId = process.argv[2] || process.env.CLAUDE_SESSION_ID || 'unknown';
  const cfg = c.loadConfig();

  console.log('governor analytics (local collector data only)');
  console.log('');

  // ---- sessions: one state snapshot per session, kept 14 days ----
  const sessions = [];
  for (const f of safeReadDir(c.STATE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = c.readJson(path.join(c.STATE_DIR, f), null);
    if (s && typeof s.t === 'number') sessions.push(s);
  }
  sessions.sort((a, b) => a.t - b.t);
  if (sessions.length) {
    const days = Math.max(1, Math.round((Date.now() - sessions[0].t) / 86_400_000));
    const costs = sessions.map((s) => s.cost_usd).filter((v) => typeof v === 'number');
    const models = [...new Set(sessions.map((s) => s.model).filter(Boolean))];
    console.log('sessions      : ' + sessions.length + ' tracked over ~' + days + 'd');
    if (costs.length) {
      const sum = costs.reduce((a, b) => a + b, 0);
      console.log(
        '  cost        : total $' + sum.toFixed(2) +
          ', avg $' + (sum / costs.length).toFixed(2) +
          ', max $' + Math.max(...costs).toFixed(2)
      );
    }
    if (models.length) console.log('  models      : ' + models.join(', '));
  } else {
    console.log('sessions      : none recorded yet');
  }

  // ---- quota history: burn behavior and observed resets ----
  const hist = c.readHistory(14 * 24 * 60);
  if (hist.length >= 2) {
    const spanH = (hist[hist.length - 1].t - hist[0].t) / 3_600_000;
    let resets = 0, peakFh = 0, peakSd = 0, prev = null;
    for (const s of hist) {
      if (typeof s.fh === 'number') {
        if (prev !== null && s.fh < prev - 5) resets++;
        prev = s.fh;
        if (s.fh > peakFh) peakFh = s.fh;
      }
      if (typeof s.sd === 'number' && s.sd > peakSd) peakSd = s.sd;
    }
    console.log('quota history : ' + hist.length + ' samples over ' + spanH.toFixed(1) + 'h');
    console.log('  peaks       : 5h ' + peakFh + '%, 7d ' + peakSd + '%');
    console.log('  5h resets   : ' + resets + ' observed in the retained window');
    const burn = c.burnRate(hist, 'fh', cfg);
    if (burn) {
      const view = c.freshestState(sessionId);
      const pct = view.fiveHour ? view.fiveHour.used_percentage : null;
      let s = '  current burn: ' + burn.toFixed(2) + '%/min';
      if (typeof pct === 'number') s += ' → dry ~' + c.fmtMins(Math.round((100 - pct) / burn));
      console.log(s);
    } else {
      console.log('  current burn: none detected (flat or not enough evidence)');
    }
  }

  // ---- current 7d position ----
  const view = c.freshestState(sessionId);
  if (view.sevenDay && typeof view.sevenDay.used_percentage === 'number') {
    console.log(
      'weekly usage  : ' + Math.round(view.sevenDay.used_percentage) + '% of the 7d window' +
        (view.sevenDay.resets_at
          ? ', resets in ' + c.fmtMins(Math.max(0, Math.round((view.sevenDay.resets_at * 1000 - Date.now()) / 60_000)))
          : '')
    );
  }

  // ---- current project: journal + preserved subagent work ----
  const dir = path.join(process.cwd(), '.governor');
  const jfile = path.join(dir, 'journal.jsonl');
  if (fs.existsSync(jfile)) {
    const entries = fs
      .readFileSync(jfile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const byTool = {};
    const files = {};
    for (const e of entries) {
      if (e.tool) byTool[e.tool] = (byTool[e.tool] || 0) + 1;
      if (['Edit', 'Write', 'NotebookEdit'].includes(e.tool) && e.target) {
        files[e.target] = (files[e.target] || 0) + 1;
      }
    }
    const top = (m, n) =>
      Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + ' (' + v + ')');
    console.log('this project  : ' + entries.length + ' journaled tool calls');
    if (Object.keys(byTool).length) console.log('  top tools   : ' + top(byTool, 5).join(', '));
    if (Object.keys(files).length) console.log('  hot files   : ' + top(files, 5).join(', '));
  }
  const subDir = path.join(dir, 'subagents');
  const subs = safeReadDir(subDir).filter((f) => f.endsWith('.md'));
  if (subs.length) {
    const bytes = subs.reduce((a, f) => {
      try {
        return a + fs.statSync(path.join(subDir, f)).size;
      } catch {
        return a;
      }
    }, 0);
    console.log('  subagents   : ' + subs.length + ' preserved output(s), ' + (bytes / 1024).toFixed(1) + ' KB rescued');
  }

  console.log('');
  console.log('(no token counts exist in the statusline feed; cost/percentage are the honest units)');
}

try {
  main();
} catch (e) {
  console.log('governor analytics: ' + (e && e.message));
}
process.exit(0);
