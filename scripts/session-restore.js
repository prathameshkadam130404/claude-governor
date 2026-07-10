'use strict';
// governor/session-restore.js — SessionStart.
// The other half of durability: when a session starts, resumes, or continues
// past a compaction, inject what survived — the agent-written RESUME.md (or
// the machine-generated RESUME.auto.md) and any preserved subagent outputs.
// Also the plugin's self-maintenance point: it nudges when the collector
// statusline isn't installed, refreshes the stable collector copy after a
// plugin update, and mirrors userConfig options into config.json.

const fs = require('fs');
const os = require('os');
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
// If it IS ours and the plugin was updated, refresh the stable bin copy.
function maintainCollector(parts, source) {
  const settings = c.readJson(path.join(os.homedir(), '.claude', 'settings.json'), {});
  const cmd = settings.statusLine && settings.statusLine.command;
  if (c.isGovernorStatusline(cmd)) {
    try {
      const ver = fs.readFileSync(path.join(c.BIN_DIR, 'VERSION'), 'utf8').trim();
      if (ver !== c.pluginVersion()) c.installCollectorBin();
    } catch {
      // No bin copy: a pre-0.2 direct-path install. It works; leave it.
      // /governor:install migrates it to the stable copy.
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
