'use strict';
// governor/session-restore.js — SessionStart.
// The other half of durability: when a session starts, resumes, or continues
// past a compaction, inject what survived — the agent-written RESUME.md (or
// the machine-generated RESUME.auto.md) and any preserved subagent outputs.
// Also the plugin's self-maintenance point: it nudges when the collector
// statusline isn't installed, refreshes the stable collector copy after a
// plugin update, and mirrors userConfig options into config.json.

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

// If the collector statusline isn't installed, governor is display-and-hook
// dead even though the plugin loaded fine — say so once per session start.
// If it IS ours: refresh the stable bin copy when its content drifted from
// the plugin source, and repair a dead entry (target script gone, e.g. a
// plugin-cache path after an update moved the cache).
function maintainCollector(parts, source) {
  const settings = c.readJson(c.SETTINGS_FILE, {});
  const cmd = settings.statusLine && settings.statusLine.command;
  const ownership = c.statuslineOwnership(cmd);

  if (ownership === 'ours') {
    const p = c.statuslineCommandPath(cmd);
    const onBin =
      p && path.resolve(p).toLowerCase() === path.resolve(path.join(c.BIN_DIR, 'statusline.js')).toLowerCase();
    // A working legacy direct-path install is left alone; /governor:install
    // migrates it to the stable copy.
    if (onBin && c.collectorBinStale()) {
      try {
        c.installCollectorBin();
      } catch (e) {
        c.traceLog('collector-refresh-failed', { error: String(e && e.message) });
      }
    }
    return;
  }

  if (ownership === 'dead') {
    try {
      const collector = c.installCollectorBin();
      try {
        fs.copyFileSync(c.SETTINGS_FILE, c.SETTINGS_FILE + '.governor-backup-' + Date.now());
      } catch { /* no settings file to back up */ }
      settings.statusLine = { type: 'command', command: `node "${collector}"` };
      c.atomicWrite(c.SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
      c.traceLog('collector-repaired', { from: String(cmd) });
      parts.push(
        '[governor] Repaired the collector statusline: its previous script path no longer ' +
          'existed (a plugin update moved it). It now runs from the stable copy in ' +
          '~/.claude/governor/bin — no action needed.'
      );
    } catch (e) {
      c.traceLog('collector-repair-failed', { error: String(e && e.message) });
    }
    return;
  }

  if (source === 'compact') return; // don't nag mid-session
  parts.push(
    '[governor] Setup incomplete: the plugin is loaded but its collector statusline is not ' +
      'installed, so no budget data is being gathered — band awareness, burn projections, and ' +
      'the quota gauge are all dark. Briefly tell the user to run /governor:install to finish setup.'
  );
}

// userConfig values arrive as CLAUDE_PLUGIN_OPTION_* env vars in plugin
// subprocesses — but the collector runs from settings.json, outside the
// plugin, and never sees them. Mirror them into config.json so the injector
// and the collector compute identical bands. Plugin options win over manual
// edits of the same keys; everything else in config.json is preserved.
function syncPluginOptions() {
  const num = (k) => {
    const v = parseFloat(process.env['CLAUDE_PLUGIN_OPTION_' + k] || '');
    return Number.isFinite(v) && v > 0 && v <= 100 ? v : null;
  };
  const mode = process.env.CLAUDE_PLUGIN_OPTION_contract_mode;
  const eco = num('economy_pct');
  const wd = num('winddown_pct');
  const cp = num('checkpoint_pct');

  const cur = c.readJson(c.CONFIG_FILE, {});
  const next = JSON.parse(JSON.stringify(cur));
  if (mode && ['allow', 'passive', 'off'].includes(mode)) next.contractMode = mode;
  if (eco !== null && wd !== null && cp !== null && eco < wd && wd < cp) {
    next.thresholds = next.thresholds || {};
    for (const k of ['context', 'five_hour']) {
      next.thresholds[k] = { ...(next.thresholds[k] || {}), economy: eco, windDown: wd, checkpoint: cp };
    }
  } else if (
    ['economy_pct', 'winddown_pct', 'checkpoint_pct'].some(
      (k) => process.env['CLAUDE_PLUGIN_OPTION_' + k]
    )
  ) {
    // Values were supplied but are partial, out of range, or misordered
    // (the enable prompt validates per-field bounds, not ordering) — the
    // whole triple is skipped, and that must not be silent.
    c.traceLog('options-thresholds-rejected', { economy: eco, windDown: wd, checkpoint: cp });
  }
  if (JSON.stringify(next) !== JSON.stringify(cur)) {
    c.ensureDirs();
    c.atomicWrite(c.CONFIG_FILE, JSON.stringify(next, null, 2));
  }
}

function main() {
  const input = c.readStdinJson();
  const parts = [];

  try {
    syncPluginOptions();
  } catch { /* best-effort */ }
  try {
    maintainCollector(parts, input.source);
  } catch { /* best-effort */ }

  const dir = path.join(input.cwd || process.cwd(), '.governor');
  if (!fs.existsSync(dir)) {
    if (parts.length) c.hookOutput('SessionStart', parts.join('\n\n'));
    return;
  }

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
