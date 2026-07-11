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
const BIN_DIR = path.join(GOV_HOME, 'bin');
const HISTORY_FILE = path.join(GOV_HOME, 'history.jsonl');
const CONFIG_FILE = path.join(GOV_HOME, 'config.json');
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

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
  // Subagent contract delivery: "allow" | "passive" | "off" (see subagent-budget.js).
  contractMode: 'allow',
  // Ignore state older than this many minutes for quota claims.
  staleMinutes: 10,
  // Burn-rate regression: window and minimum evidence required for a slope.
  burnWindowMinutes: 20,
  burnMinSpanMinutes: 4,
  burnMinSamples: 4,
  // Recency weighting: a sample this many minutes old counts half as much.
  burnHalfLifeMinutes: 8,
  // De-escalation debounce: a lower band must hold this long before the
  // official band drops. Escalation is always immediate.
  deescalateSeconds: 180,
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

function readState(sessionId) {
  return readJson(stateFile(sessionId), null);
}

// Delete per-session state/runtime files older than 14 days (housekeeping,
// invoked opportunistically from the trim path).
function cleanupOldSessions() {
  const cutoff = Date.now() - 14 * 86_400_000;
  for (const dir of [STATE_DIR, RUNTIME_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try {
          if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
  }
}

function appendHistory(sample, cfg, opts) {
  ensureDirs();
  const changed = !opts || opts.changed !== false;
  try {
    // Throttle: the statusline can refresh several times per second, but
    // quota moves slowly and arrives as an integer. Unthrottled appends both
    // churn the disk and shrink the retained window (historyMax trims by
    // line count) below the regression window. Record value CHANGES at most
    // every 10s, plus a 60s heartbeat so flat stretches still register as
    // evidence of zero burn.
    let ageMs = Infinity;
    try {
      ageMs = Date.now() - fs.statSync(HISTORY_FILE).mtimeMs;
    } catch { /* no file yet */ }
    if (!(changed && ageMs > 10_000) && ageMs <= 60_000) return;

    fs.appendFileSync(HISTORY_FILE, JSON.stringify(sample) + '\n');
    // Occasional trim (1-in-20 writes) to bound file growth.
    if (Math.random() < 0.05) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
      const max = (cfg || DEFAULT_CONFIG).historyMax;
      if (lines.length > max) {
        atomicWrite(HISTORY_FILE, lines.slice(-max).join('\n') + '\n');
      }
      cleanupOldSessions();
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
// Burn rate: least-squares slope (%/minute) over a recent window.
// used_percentage arrives as an INTEGER, so pairwise deltas are dominated by
// quantization (a 67→68 tick across 30s reads as 2%/min). Regression over
// many samples recovers the true slope instead. A drop of more than 5 points
// is a window reset; only samples after the last reset count.
// ---------------------------------------------------------------------------

function burnRate(history, key, cfg) {
  const winMin = (cfg && cfg.burnWindowMinutes) || 20;
  const minSpan = (cfg && cfg.burnMinSpanMinutes) || 4;
  const minSamples = (cfg && cfg.burnMinSamples) || 4;
  const cutoff = Date.now() - winMin * 60_000;

  let pts = [];
  for (const s of history) {
    const v = s[key];
    if (typeof v !== 'number' || s.t < cutoff) continue;
    pts.push({ t: s.t, v });
  }
  // Median-of-3 filter: a concurrent idle session can interleave one stale
  // (lower) quota sample into a fresh rising series; unfiltered, that lone
  // dip reads as a "reset" below and truncates the regression. A real reset
  // persists across consecutive samples and survives the median.
  if (pts.length >= 3) {
    pts = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return p;
      const m = [pts[i - 1].v, p.v, pts[i + 1].v].sort((a, b) => a - b)[1];
      return { t: p.t, v: m };
    });
  }
  // Keep only samples after the most recent reset.
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].v < pts[i - 1].v - 5) start = i;
  }
  pts = pts.slice(start);

  if (pts.length < minSamples) return null;
  const spanMin = (pts[pts.length - 1].t - pts[0].t) / 60_000;
  if (spanMin < minSpan) return null;

  // Recency-weighted least squares: burn is rarely constant across the
  // window (subagent bursts, idle gaps), so newer samples count more — a
  // one-formula approximation of piecewise regression that adapts to
  // regime changes without breakpoint detection.
  const halfLife = (cfg && cfg.burnHalfLifeMinutes) || 8;
  const t0 = pts[0].t;
  const tN = pts[pts.length - 1].t;
  const n = pts.length;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 60_000;
    const w = Math.pow(0.5, (tN - p.t) / 60_000 / halfLife);
    sw += w; swx += w * x; swy += w * p.v; swxx += w * x * x; swxy += w * x * p.v;
  }
  const denom = sw * swxx - swx * swx;
  if (denom <= 0) return null;
  const slope = (sw * swxy - swx * swy) / denom;
  if (slope <= 0.01) return null; // flat/unknown

  // Significance gate: integer-quantized samples make short windows noisy.
  // Demand the slope exceed twice its standard error, or report no burn —
  // the pragmatic form of a confidence interval when the only consumer is
  // a threshold-band decision.
  const intercept = (swy - slope * swx) / sw;
  let sse = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 60_000;
    const w = Math.pow(0.5, (tN - p.t) / 60_000 / halfLife);
    const e = p.v - (intercept + slope * x);
    sse += w * e * e;
  }
  const sxxw = swxx - (swx * swx) / sw;
  const dof = n - 2;
  if (dof > 0 && sxxw > 0) {
    const se = Math.sqrt((sse / sw) * (n / dof) / sxxw);
    if (slope < 2 * se) return null;
  }
  return slope; // %/minute
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
    // Escalate only when we'd run dry BEFORE the reset rescues us — and only
    // one tier beyond what the raw level justifies (tiered guards): a burn
    // spike at 72% must never scream CHECKPOINT; at that level there is
    // always runway for an orderly WIND-DOWN instead.
    if (minutesToReset === null || dryIn < minutesToReset) {
      if (dryIn <= dryCfg.checkpoint && pct >= th.windDown) lvl = Math.max(lvl, BAND.CHECKPOINT);
      else if (dryIn <= dryCfg.windDown && pct >= th.economy) lvl = Math.max(lvl, BAND.WIND_DOWN);
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
  const fhBurn = burnRate(hist, 'fh', cfg);
  const sdBurn = burnRate(hist, 'sd', cfg);

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
    const drivers = a.drivers.length ? a.drivers.join(', ') : 'stabilizing';
    line += '\nband: ' + BAND_NAME[a.band] + ' (' + drivers + ') — ' + DIRECTIVES[a.band];
  }
  return line;
}

// ---------------------------------------------------------------------------
// Band debounce + speak cadence (per session).
// Escalation is immediate (safety). De-escalation requires the lower band to
// hold for deescalateSeconds — quantized quota data makes instantaneous band
// math noisy, and CHECKPOINT→ECONOMY→WIND-DOWN whiplash both confuses the
// model and burns injection tokens. A quota drop >10 points (window reset)
// bypasses the debounce so recovery is instant when it's real.
// ---------------------------------------------------------------------------

function runtimeFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(RUNTIME_DIR, safe + '.json');
}

// Returns { band, speak }. Mutates per-session runtime state — only the
// injector should call this; display code uses peekBand().
function decide(sessionId, assessed, cfg) {
  ensureDirs();
  const file = runtimeFile(sessionId);
  const rt = readJson(file, {});
  const prevBand = typeof rt.band === 'number' ? rt.band : (typeof rt.lastBand === 'number' ? rt.lastBand : BAND.CRUISE);
  const raw = assessed.band;
  const now = Date.now();
  const deMs = (cfg.deescalateSeconds ?? 180) * 1000;

  const fhPct = assessed.fh.pct;
  const fastDrop =
    typeof fhPct === 'number' && typeof rt.lastFh === 'number' && fhPct < rt.lastFh - 10;

  let band = prevBand;
  if (raw >= prevBand || fastDrop || deMs === 0) {
    band = raw;
    rt.candidate = null;
  } else if (rt.candidate === raw && now - (rt.candidateSince || 0) >= deMs) {
    band = raw;
    rt.candidate = null;
  } else if (rt.candidate !== raw) {
    rt.candidate = raw;
    rt.candidateSince = now;
  }

  rt.count = (rt.count || 0) + 1;
  let speak = false;
  if (band !== prevBand) {
    // Announce every (stable) band change, including recovery to CRUISE —
    // but stay quiet if we were never above CRUISE in the first place.
    speak = band > BAND.CRUISE || prevBand > BAND.CRUISE;
    rt.count = 0;
  } else if (band >= BAND.WIND_DOWN) {
    speak = true;
  } else if (band === BAND.ECONOMY) {
    speak = rt.count % cfg.economyInjectEvery === 0;
  }

  rt.band = band;
  if (typeof fhPct === 'number') rt.lastFh = fhPct;
  delete rt.lastBand; // migrate away from the old field
  try {
    atomicWrite(file, JSON.stringify(rt));
  } catch {
    /* best-effort */
  }
  return { band, speak };
}

// True if the injector has touched this session's runtime state within
// maxAgeMs. Display surfaces use this as a liveness probe: the injector
// writes runtime on every prompt/tool batch, so a stale/missing file while
// the session is active means the plugin hooks aren't loaded at all (e.g.
// launched with --plugin-dir once, then resumed without it).
function runtimeFresh(sessionId, maxAgeMs) {
  try {
    return Date.now() - fs.statSync(runtimeFile(sessionId)).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

// Read-only view of the debounced band for display surfaces (statusline).
// Falls back to the raw band when no fresh runtime state exists. Applies the
// same fast-drop bypass as decide() so a genuine window reset is visible
// immediately, not only after the injector's next run.
function peekBand(sessionId, rawBand, fhPct) {
  try {
    const file = runtimeFile(sessionId);
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > 15 * 60_000) return rawBand;
    const rt = readJson(file, {});
    if (typeof fhPct === 'number' && typeof rt.lastFh === 'number' && fhPct < rt.lastFh - 10) {
      return rawBand;
    }
    return typeof rt.band === 'number' ? Math.max(rt.band, rawBand) : rawBand;
  } catch {
    return rawBand;
  }
}

// ---------------------------------------------------------------------------
// Project-local durability dir
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Collector bin install: marketplace-installed plugins live in a cache whose
// path changes on update, so settings.json's statusLine must never point into
// the plugin. Instead the collector is copied to the stable BIN_DIR and the
// SessionStart hook refreshes the copy whenever the plugin version changes.
// ---------------------------------------------------------------------------

const COLLECTOR_FILES = ['statusline.js', path.join('lib', 'common.js')];

// Copy statusline.js + this file to BIN_DIR; returns the stable collector path.
function installCollectorBin() {
  const scriptsDir = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(BIN_DIR, 'lib'), { recursive: true });
  for (const rel of COLLECTOR_FILES) {
    fs.copyFileSync(path.join(scriptsDir, rel), path.join(BIN_DIR, rel));
  }
  return path.join(BIN_DIR, 'statusline.js');
}

// True when the bin copy's content differs from this plugin's source — the
// refresh gate. Content comparison (not a version stamp) so a code change
// shipped or dev-edited without a plugin.json bump still propagates.
function collectorBinStale() {
  const scriptsDir = path.resolve(__dirname, '..');
  for (const rel of COLLECTOR_FILES) {
    try {
      if (
        fs.readFileSync(path.join(scriptsDir, rel), 'utf8') !==
        fs.readFileSync(path.join(BIN_DIR, rel), 'utf8')
      ) {
        return true;
      }
    } catch {
      return true; // bin copy missing or unreadable
    }
  }
  return false;
}

// Extract the statusline script path from a settings.json statusLine command.
function statuslineCommandPath(command) {
  const cmd = String(command || '');
  const m = cmd.match(/"([^"]*statusline\.js)"/) || cmd.match(/(\S*statusline\.js)/);
  return m ? m[1] : null;
}

// Classify the configured statusLine command relative to governor:
//   'none'    — no statusline configured
//   'ours'    — a live governor collector (stable bin copy, or a legacy
//               direct-path install identified by the file's own header —
//               never by path substrings, so a user's unrelated
//               statusline.js under a 'governor' directory stays foreign)
//   'dead'    — governor's entry, but the target script no longer exists
//               (e.g. a plugin-cache path after an update moved the cache)
//   'foreign' — someone else's statusline; never touch without --force
function statuslineOwnership(command) {
  if (!command) return 'none';
  const p = statuslineCommandPath(command);
  if (!p) return 'foreign';
  const norm = (x) => path.resolve(x).toLowerCase();
  const isBin = norm(p) === norm(path.join(BIN_DIR, 'statusline.js'));
  if (fs.existsSync(p)) {
    if (isBin) return 'ours';
    try {
      const head = fs.readFileSync(p, 'utf8').slice(0, 300);
      if (head.includes('governor/statusline.js')) return 'ours';
    } catch {
      /* unreadable → foreign */
    }
    return 'foreign';
  }
  // Target missing: claim it only if it's our bin path or carries the old
  // governor path signature; otherwise it's someone else's broken bar.
  return isBin || /governor/i.test(String(command)) ? 'dead' : 'foreign';
}

// Best-effort diagnostics sink for hook-side maintenance events (refresh and
// repair failures must not be silent, but must never block a hook either).
function traceLog(event, extra) {
  try {
    ensureDirs();
    fs.appendFileSync(
      path.join(RUNTIME_DIR, 'governor.log'),
      JSON.stringify({ t: Date.now(), event, ...(extra || {}) }) + '\n'
    );
  } catch {
    /* best-effort */
  }
}

function projectDir(cwd) {
  const d = path.join(cwd || process.cwd(), '.governor');
  fs.mkdirSync(path.join(d, 'subagents'), { recursive: true });
  // Self-ignoring: a nested .gitignore keeps governor artifacts out of the
  // user's repo without ever touching their own .gitignore. Committing
  // RESUME.md deliberately still works via `git add -f`.
  const gi = path.join(d, '.gitignore');
  try {
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  } catch {
    /* best-effort */
  }
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
  readState,
  appendHistory,
  readHistory,
  freshestState,
  burnRate,
  quotaLevel,
  assess,
  budgetLine,
  fmtClock,
  fmtMins,
  decide,
  peekBand,
  runtimeFresh,
  installCollectorBin,
  collectorBinStale,
  statuslineCommandPath,
  statuslineOwnership,
  traceLog,
  BIN_DIR,
  SETTINGS_FILE,
  projectDir,
  hookOutput,
};
