'use strict';
// governor/lib/common.js — shared plumbing for all hooks.
// Zero dependencies. Every consumer must never crash Claude Code:
// wrap entry points in try/catch and exit 0 no matter what.

const fs = require('fs');
const os = require('os');
const path = require('path');

const GOV_HOME = path.join(os.homedir(), '.claude', 'governor');
const STATE_DIR = path.join(GOV_HOME, 'state');
const RUNTIME_DIR = path.join(GOV_HOME, 'runtime');
const ARCHIVE_DIR = path.join(GOV_HOME, 'archives');
const HISTORY_FILE = path.join(GOV_HOME, 'history.jsonl');
const CONFIG_FILE = path.join(GOV_HOME, 'config.json');

const BAND = { CRUISE: 0, ECONOMY: 1, WIND_DOWN: 2, CHECKPOINT: 3 };
const BAND_NAME = ['CRUISE', 'ECONOMY', 'WIND-DOWN', 'CHECKPOINT'];

const DEFAULT_CONFIG = {
  // Percent-used thresholds per metric for ECONOMY / WIND-DOWN / CHECKPOINT.
  thresholds: {
    context: { economy: 70, windDown: 90, checkpoint: 97 },
    five_hour: { economy: 70, windDown: 90, checkpoint: 97 },
    seven_day: { economy: 95, windDown: 98, checkpoint: 99 },
  },
  // Burn-rate escalation (quota only): projected minutes until 100%.
  dryMinutes: { windDown: 15, economy: 45, checkpoint: 5 },
  // Inject every Nth batch while in ECONOMY (WIND-DOWN+ injects every batch).
  economyInjectEvery: 5,
  // Ignore state older than this many minutes for quota claims.
  staleMinutes: 10,
  // EWMA smoothing factor for burn rate.
  ewmaAlpha: 0.35,
  // Max history samples retained.
  historyMax: 1000,
  // Max transcript archives retained.
  archiveMax: 10,
};

function ensureDirs() {
  for (const d of [GOV_HOME, STATE_DIR, RUNTIME_DIR, ARCHIVE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readStdinJson() {
  try {
    const raw = readStdinSync();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const user = readJson(CONFIG_FILE, {});
  // Shallow-merge per section so a partial user config keeps other defaults.
  const cfg = { ...DEFAULT_CONFIG, ...user };
  cfg.thresholds = { ...DEFAULT_CONFIG.thresholds, ...(user.thresholds || {}) };
  for (const k of Object.keys(DEFAULT_CONFIG.thresholds)) {
    cfg.thresholds[k] = { ...DEFAULT_CONFIG.thresholds[k], ...((user.thresholds || {})[k] || {}) };
  }
  cfg.dryMinutes = { ...DEFAULT_CONFIG.dryMinutes, ...(user.dryMinutes || {}) };
  return cfg;
}

// ---------------------------------------------------------------------------
// State: written by the statusline collector, read by every other hook.
// Per-session file so parallel sessions don't clobber each other; quota is
// account-level so readers merge "freshest quota wins" across all sessions.
// ---------------------------------------------------------------------------

function stateFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(STATE_DIR, safe + '.json');
}

function writeState(sessionId, snapshot) {
  ensureDirs();
  atomicWrite(stateFile(sessionId), JSON.stringify(snapshot));
}

function appendHistory(sample, cfg) {
  ensureDirs();
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(sample) + '\n');
    // Occasional trim (1-in-20 writes) to bound file growth.
    if (Math.random() < 0.05) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
      const max = (cfg || DEFAULT_CONFIG).historyMax;
      if (lines.length > max) {
        atomicWrite(HISTORY_FILE, lines.slice(-max).join('\n') + '\n');
      }
    }
  } catch {
    /* history is best-effort */
  }
}

function readHistory(maxAgeMinutes) {
  try {
    const cutoff = Date.now() - maxAgeMinutes * 60_000;
    return fs
      .readFileSync(HISTORY_FILE, 'utf8')
      .trim()
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((s) => s && s.t >= cutoff)
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

// Freshest view: context % strictly from this session; quota from whichever
// session file reported it most recently (quota is shared account-wide).
function freshestState(sessionId) {
  const own = readJson(stateFile(sessionId), null);
  let quota = null;
  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const s = readJson(path.join(STATE_DIR, f), null);
      if (!s || !s.rate_limits) continue;
      if (!quota || s.t > quota.t) quota = s;
    }
  } catch {
    /* no state dir yet */
  }
  return {
    own,
    quota,
    ctxPct: own && typeof own.ctx_pct === 'number' ? own.ctx_pct : null,
    fiveHour: quota && quota.rate_limits ? quota.rate_limits.five_hour || null : null,
    sevenDay: quota && quota.rate_limits ? quota.rate_limits.seven_day || null : null,
    quotaAgeMs: quota ? Date.now() - quota.t : null,
  };
}

// ---------------------------------------------------------------------------
// Burn rate: EWMA of quota %/minute from history samples. A drop of more than
// 5 points is treated as a window reset and clears the average.
// ---------------------------------------------------------------------------

function burnRate(history, key, alpha) {
  let ewma = null;
  let prev = null;
  for (const s of history) {
    const v = s[key];
    if (typeof v !== 'number') continue;
    if (prev) {
      const dtMin = (s.t - prev.t) / 60_000;
      const dPct = v - prev.v;
      if (dPct < -5) {
        ewma = null; // window reset
      } else if (dtMin >= 0.05 && dtMin <= 15 && dPct >= 0) {
        const rate = dPct / dtMin;
        ewma = ewma === null ? rate : alpha * rate + (1 - alpha) * ewma;
      }
    }
    prev = { t: s.t, v };
  }
  return ewma; // %/minute, or null if unknown
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

function levelFromPct(pct, th) {
  if (typeof pct !== 'number') return BAND.CRUISE;
  if (pct >= th.checkpoint) return BAND.CHECKPOINT;
  if (pct >= th.windDown) return BAND.WIND_DOWN;
  if (pct >= th.economy) return BAND.ECONOMY;
  return BAND.CRUISE;
}

function quotaLevel(pct, th, burnPerMin, minutesToReset, dryCfg) {
  let lvl = levelFromPct(pct, th);
  if (typeof pct === 'number' && burnPerMin && burnPerMin > 0) {
    const dryIn = (100 - pct) / burnPerMin;
    // Escalate only when we'd run dry BEFORE the reset rescues us.
    if (minutesToReset === null || dryIn < minutesToReset) {
      if (dryIn <= dryCfg.checkpoint) lvl = Math.max(lvl, BAND.CHECKPOINT);
      else if (dryIn <= dryCfg.windDown) lvl = Math.max(lvl, BAND.WIND_DOWN);
      else if (dryIn <= dryCfg.economy) lvl = Math.max(lvl, BAND.ECONOMY);
    }
  }
  return lvl;
}

function minutesToReset(resetsAtEpochSec) {
  if (!resetsAtEpochSec) return null;
  return Math.max(0, Math.round((resetsAtEpochSec * 1000 - Date.now()) / 60_000));
}

// Returns { band, drivers: [..], parts: {...} } for the freshest state.
function assess(view, cfg) {
  const hist = readHistory(45);
  const fhBurn = burnRate(hist, 'fh', cfg.ewmaAlpha);
  const sdBurn = burnRate(hist, 'sd', cfg.ewmaAlpha);

  const stale =
    view.quotaAgeMs !== null && view.quotaAgeMs > cfg.staleMinutes * 60_000;

  const fhPct = view.fiveHour ? view.fiveHour.used_percentage : null;
  const sdPct = view.sevenDay ? view.sevenDay.used_percentage : null;
  const fhReset = view.fiveHour ? minutesToReset(view.fiveHour.resets_at) : null;
  const sdReset = view.sevenDay ? minutesToReset(view.sevenDay.resets_at) : null;

  const ctxLvl = levelFromPct(view.ctxPct, cfg.thresholds.context);
  const fhLvl = stale
    ? BAND.CRUISE
    : quotaLevel(fhPct, cfg.thresholds.five_hour, fhBurn, fhReset, cfg.dryMinutes);
  const sdLvl = stale
    ? BAND.CRUISE
    : quotaLevel(sdPct, cfg.thresholds.seven_day, sdBurn, sdReset, cfg.dryMinutes);

  const band = Math.max(ctxLvl, fhLvl, sdLvl);
  const drivers = [];
  if (ctxLvl === band && band > 0) drivers.push('context');
  if (fhLvl === band && band > 0) drivers.push('5h-quota');
  if (sdLvl === band && band > 0) drivers.push('7d-quota');

  return {
    band,
    drivers,
    stale,
    ctxPct: view.ctxPct,
    fh: { pct: fhPct, reset: fhReset, burn: fhBurn, resetsAt: view.fiveHour ? view.fiveHour.resets_at : null },
    sd: { pct: sdPct, reset: sdReset, burn: sdBurn, resetsAt: view.sevenDay ? view.sevenDay.resets_at : null },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtClock(epochSec) {
  if (!epochSec) return '?';
  const d = new Date(epochSec * 1000);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function fmtMins(m) {
  if (m === null || m === undefined) return '?';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h' + (m % 60 ? (m % 60) + 'm' : '');
  return Math.round(h / 24) + 'd';
}

const DIRECTIVES = {
  [BAND.ECONOMY]:
    'economize — targeted reads only (no whole-file dumps), terse output, batch tool calls, prefer cheap subagents for search.',
  [BAND.WIND_DOWN]:
    'finish the current unit and deliver it to the user; start NOTHING new (no new subtasks or subagents); update .governor/RESUME.md with state + exact next step.',
  [BAND.CHECKPOINT]:
    'checkpoint NOW: write .governor/RESUME.md (done / in-flight / next / open decisions), git commit if in a repo, tell the user when the limit resets, then end the turn cleanly.',
};

// One compact line (+directive) the model sees. Keep it under ~50 tokens.
function budgetLine(a) {
  const bits = [];
  if (typeof a.ctxPct === 'number') bits.push('ctx ' + Math.round(a.ctxPct) + '%');
  if (typeof a.fh.pct === 'number') {
    let s = '5h ' + Math.round(a.fh.pct) + '%';
    if (a.fh.resetsAt) s += ' (resets ' + fmtClock(a.fh.resetsAt) + ', ' + fmtMins(a.fh.reset) + ')';
    if (a.fh.burn && a.fh.burn > 0.05) {
      const dry = Math.round((100 - a.fh.pct) / a.fh.burn);
      s += ' burn ' + a.fh.burn.toFixed(1) + '%/m';
      if (dry < 120) s += ' → dry ~' + fmtMins(dry);
    }
    bits.push(s);
  }
  if (typeof a.sd.pct === 'number' && a.sd.pct >= 50) {
    bits.push('7d ' + Math.round(a.sd.pct) + '%' + (a.sd.resetsAt ? ' (' + fmtMins(a.sd.reset) + ')' : ''));
  }
  if (a.stale) bits.push('(quota data stale)');

  let line = '[governor] ' + (bits.length ? bits.join(' | ') : 'no budget data yet');
  if (a.band > 0) {
    line +=
      '\nband: ' + BAND_NAME[a.band] + ' (' + a.drivers.join(', ') + ') — ' + DIRECTIVES[a.band];
  }
  return line;
}

// ---------------------------------------------------------------------------
// Hysteresis (per session): decide whether the injector should speak.
// ---------------------------------------------------------------------------

function runtimeFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(RUNTIME_DIR, safe + '.json');
}

function shouldInject(sessionId, band, cfg) {
  ensureDirs();
  const file = runtimeFile(sessionId);
  const rt = readJson(file, { lastBand: -1, count: 0 });
  rt.count += 1;
  let speak = false;
  if (band !== rt.lastBand) {
    // Announce every band change, including recovery to CRUISE (but stay
    // quiet if we were never above CRUISE in the first place).
    speak = band > BAND.CRUISE || rt.lastBand > BAND.CRUISE;
    rt.count = 0;
  } else if (band >= BAND.WIND_DOWN) {
    speak = true;
  } else if (band === BAND.ECONOMY) {
    speak = rt.count % cfg.economyInjectEvery === 0;
  }
  rt.lastBand = band;
  try {
    atomicWrite(file, JSON.stringify(rt));
  } catch {
    /* best-effort */
  }
  return speak;
}

// ---------------------------------------------------------------------------
// Project-local durability dir
// ---------------------------------------------------------------------------

function projectDir(cwd) {
  const d = path.join(cwd || process.cwd(), '.governor');
  fs.mkdirSync(path.join(d, 'subagents'), { recursive: true });
  return d;
}

function hookOutput(eventName, additionalContext, extra) {
  const out = {
    hookSpecificOutput: {
      hookEventName: eventName,
      ...(additionalContext ? { additionalContext } : {}),
      ...(extra || {}),
    },
  };
  process.stdout.write(JSON.stringify(out));
}

module.exports = {
  BAND,
  BAND_NAME,
  GOV_HOME,
  STATE_DIR,
  ARCHIVE_DIR,
  CONFIG_FILE,
  ensureDirs,
  readStdinJson,
  atomicWrite,
  readJson,
  loadConfig,
  writeState,
  appendHistory,
  readHistory,
  freshestState,
  burnRate,
  assess,
  budgetLine,
  fmtClock,
  fmtMins,
  shouldInject,
  projectDir,
  hookOutput,
};
