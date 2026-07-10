'use strict';
// governor/test/smoke.js — end-to-end smoke test with simulated hook inputs.
// Run: node test/smoke.js
// Uses a throwaway HOME and cwd so it never touches real state.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'governor-test-'));
const FAKE_HOME = path.join(TMP, 'home');
const FAKE_PROJ = path.join(TMP, 'proj');
fs.mkdirSync(FAKE_HOME, { recursive: true });
fs.mkdirSync(FAKE_PROJ, { recursive: true });

let passed = 0;
let failed = 0;

function run(script, stdinObj, extraEnv) {
  return execFileSync('node', [path.join(ROOT, 'scripts', script)], {
    input: JSON.stringify(stdinObj),
    env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, ...(extraEnv || {}) },
    cwd: FAKE_PROJ,
    encoding: 'utf8',
  });
}

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ok  ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

const SID = 'test-session-1';
const nowSec = Math.floor(Date.now() / 1000);

// Deterministic band transitions for hook-level tests: disable the
// de-escalation debounce (tested separately in step 0 below).
const govDir = path.join(FAKE_HOME, '.claude', 'governor');
fs.mkdirSync(govDir, { recursive: true });
fs.writeFileSync(path.join(govDir, 'config.json'), JSON.stringify({ deescalateSeconds: 0 }));

console.log('0. Burn-rate regression & debounce (pure functions)');
// Point the in-process require at the fake HOME too (GOV_HOME is resolved at
// require time), so decide() writes runtime state into the sandbox.
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
const c = require(path.join(ROOT, 'scripts', 'lib', 'common'));
const cfg0 = { burnWindowMinutes: 20, burnMinSpanMinutes: 4, burnMinSamples: 4 };
const T = Date.now();
// A single quantization tick (67→68 across 30s) must NOT yield a slope.
check(
  'quantization spike yields no burn',
  c.burnRate([{ t: T - 30_000, fh: 67 }, { t: T, fh: 68 }], 'fh', cfg0) === null
);
// A steady 1%/min staircase over 10 minutes must read ≈1%/min.
const steady = [];
for (let i = 0; i <= 10; i++) steady.push({ t: T - (10 - i) * 60_000, fh: 60 + i });
const slope = c.burnRate(steady, 'fh', cfg0);
check('steady staircase reads ~1%/min', slope !== null && Math.abs(slope - 1) < 0.05, String(slope));
// Samples before a reset (drop >5) must be discarded.
const withReset = [
  { t: T - 8 * 60_000, fh: 90 }, { t: T - 7 * 60_000, fh: 95 },
  { t: T - 6 * 60_000, fh: 3 }, { t: T - 4 * 60_000, fh: 3 },
  { t: T - 2 * 60_000, fh: 4 }, { t: T, fh: 4 },
];
const postReset = c.burnRate(withReset, 'fh', cfg0);
check('reset discards prior samples', postReset === null || postReset < 0.5, String(postReset));
// Tiered guard: fast burn at 72% must cap at WIND-DOWN, never CHECKPOINT.
const th0 = { economy: 70, windDown: 90, checkpoint: 97 };
const dry0 = { economy: 45, windDown: 15, checkpoint: 5 };
check('dry<5m at 72% caps at WIND-DOWN', c.quotaLevel(72, th0, 8, null, dry0) === c.BAND.WIND_DOWN);
check('dry<5m at 92% may CHECKPOINT', c.quotaLevel(92, th0, 8, null, dry0) === c.BAND.CHECKPOINT);
// Debounce: with deescalateSeconds=300, a raw drop must NOT lower the band.
const dbCfg = { deescalateSeconds: 300, economyInjectEvery: 5 };
const mk = (b) => ({ band: b, fh: { pct: 80 }, sd: { pct: 50 }, drivers: [] });
c.decide('debounce-test', mk(c.BAND.CHECKPOINT), dbCfg);
const d2 = c.decide('debounce-test', mk(c.BAND.ECONOMY), dbCfg);
check('de-escalation is debounced', d2.band === c.BAND.CHECKPOINT, 'got band ' + d2.band);
const d3 = c.decide('debounce-test', mk(c.BAND.CHECKPOINT), dbCfg);
check('escalation is immediate', d3.band === c.BAND.CHECKPOINT);
// A lone stale sample from a concurrent session (72→50→73 shape) must not
// trip reset detection; the median filter should recover the true slope.
const dip = [
  { t: T - 8 * 60_000, fh: 70 }, { t: T - 6 * 60_000, fh: 71 },
  { t: T - 5 * 60_000, fh: 50 },
  { t: T - 3 * 60_000, fh: 72 }, { t: T - 60_000, fh: 73 }, { t: T, fh: 74 },
];
const dipSlope = c.burnRate(dip, 'fh', cfg0);
check('stale dip does not fake a reset', dipSlope !== null && dipSlope > 0.3 && dipSlope < 0.8, String(dipSlope));
// peekBand: read-only debounced view with the fast-drop (reset) bypass.
c.decide('peek-test', mk(c.BAND.CHECKPOINT), dbCfg); // stores band=CHECKPOINT, lastFh=80
check('peek shows debounced band', c.peekBand('peek-test', c.BAND.CRUISE, 80) === c.BAND.CHECKPOINT);
check('peek fast-drop bypass on reset', c.peekBand('peek-test', c.BAND.CRUISE, 20) === c.BAND.CRUISE);

function statuslineInput(ctxPct, fhPct, sdPct) {
  return {
    session_id: SID,
    model: { display_name: 'Sonnet 5' },
    cwd: FAKE_PROJ,
    context_window: {
      used_percentage: ctxPct,
      remaining_percentage: 100 - ctxPct,
      context_window_size: 200000,
    },
    cost: { total_cost_usd: 0.42 },
    rate_limits: {
      five_hour: { used_percentage: fhPct, resets_at: nowSec + 41 * 60 },
      seven_day: { used_percentage: sdPct, resets_at: nowSec + 3 * 86400 },
    },
  };
}

console.log('1. Collector (statusline.js)');
const out1 = run('statusline.js', statuslineInput(12, 34, 61));
check('renders a statusline', out1.includes('CRUISE') && out1.includes('ctx 12%'), out1);
const stateFile = path.join(FAKE_HOME, '.claude', 'governor', 'state', SID.replace(/-/g, '-') + '.json');
const stateDir = path.join(FAKE_HOME, '.claude', 'governor', 'state');
check('writes state file', fs.existsSync(stateDir) && fs.readdirSync(stateDir).length === 1);
const histFile = path.join(FAKE_HOME, '.claude', 'governor', 'history.jsonl');
check('appends history', fs.existsSync(histFile));

console.log('2. Injector — CRUISE stays silent');
const out2 = run('injector.js', { session_id: SID, hook_event_name: 'PostToolBatch', cwd: FAKE_PROJ });
check('no injection in cruise', out2.trim() === '', out2);

console.log('3. Injector — WIND-DOWN speaks with directive');
run('statusline.js', statuslineInput(62, 91, 61)); // 5h crosses windDown
const out3 = run('injector.js', { session_id: SID, hook_event_name: 'PostToolBatch', cwd: FAKE_PROJ });
check('injects on band change', out3.includes('additionalContext'), out3);
check('names WIND-DOWN band', out3.includes('WIND-DOWN'), out3);
check('carries directive', out3.includes('finish the current unit'), out3);
check('mentions reset clock', /resets \d\d:\d\d/.test(out3), out3);

console.log('4. Injector — repeats every batch in WIND-DOWN');
const out4 = run('injector.js', { session_id: SID, hook_event_name: 'PostToolBatch', cwd: FAKE_PROJ });
check('re-injects in wind-down', out4.includes('WIND-DOWN'), out4);

console.log('5. Injector — recovery announces CRUISE once, then silence');
run('statusline.js', statuslineInput(20, 30, 61));
const out5a = run('injector.js', { session_id: SID, hook_event_name: 'PostToolBatch', cwd: FAKE_PROJ });
check('announces recovery', out5a.includes('pressure cleared'), out5a);
const out5b = run('injector.js', { session_id: SID, hook_event_name: 'PostToolBatch', cwd: FAKE_PROJ });
check('silent again in cruise', out5b.trim() === '', out5b);

console.log('6. Journal (journal.js)');
run('journal.js', {
  session_id: SID,
  cwd: FAKE_PROJ,
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: 'src/app.ts' },
  tool_output: 'ok',
});
const jfile = path.join(FAKE_PROJ, '.governor', 'journal.jsonl');
check('journal entry written', fs.existsSync(jfile) && fs.readFileSync(jfile, 'utf8').includes('src/app.ts'));

console.log('7. Subagent tee (subagent-tee.js)');
run('subagent-tee.js', {
  session_id: SID,
  cwd: FAKE_PROJ,
  hook_event_name: 'SubagentStop',
  agent_type: 'Explore',
  agent_id: 'abc123',
  last_assistant_message: 'FINDINGS: the flux capacitor is in src/flux.ts:42',
});
const subDir = path.join(FAKE_PROJ, '.governor', 'subagents');
const subFiles = fs.existsSync(subDir) ? fs.readdirSync(subDir) : [];
check('subagent output preserved', subFiles.length === 1, JSON.stringify(subFiles));
check(
  'content intact',
  subFiles.length === 1 && fs.readFileSync(path.join(subDir, subFiles[0]), 'utf8').includes('flux capacitor')
);

console.log('8. Subagent budget contract (subagent-budget.js)');
run('statusline.js', statuslineInput(62, 91, 61)); // pressure back on
const out8 = run('subagent-budget.js', {
  session_id: SID,
  cwd: FAKE_PROJ,
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  tool_input: { prompt: 'Research the flux capacitor', subagent_type: 'Explore' },
});
check('returns updatedInput', out8.includes('updatedInput'), out8);
check('default mode carries allow decision', out8.includes('"permissionDecision":"allow"'), out8);
check('appends contract', out8.includes('Durable-output contract'), out8);
check('appends budget under pressure', out8.includes('Budget at spawn'), out8);
check('original prompt preserved', out8.includes('Research the flux capacitor'), out8);

console.log('8b. Contract passive/off modes');
const cfgFile = path.join(FAKE_HOME, '.claude', 'governor', 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ contractMode: 'passive' }));
const out8b = run('subagent-budget.js', {
  session_id: SID,
  cwd: FAKE_PROJ,
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  tool_input: { prompt: 'Research the flux capacitor' },
});
check('passive mode omits decision', out8b.includes('updatedInput') && !out8b.includes('permissionDecision'), out8b);
fs.writeFileSync(cfgFile, JSON.stringify({ contractMode: 'off' }));
const out8c = run('subagent-budget.js', {
  session_id: SID,
  cwd: FAKE_PROJ,
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  tool_input: { prompt: 'Research the flux capacitor' },
});
check('off mode is a no-op', out8c.trim() === '', out8c);
fs.rmSync(cfgFile);
const traceLog = path.join(FAKE_HOME, '.claude', 'governor', 'runtime', 'subagent-budget.log');
check('trace log written', fs.existsSync(traceLog) && fs.readFileSync(traceLog, 'utf8').includes('"event":"injected"'));

console.log('9. Emergency checkpoint (emergency.js)');
run('emergency.js', {
  session_id: SID,
  cwd: FAKE_PROJ,
  hook_event_name: 'StopFailure',
  error_type: 'rate_limit',
  error_message: 'Rate limited',
});
const autoResume = path.join(FAKE_PROJ, '.governor', 'RESUME.auto.md');
check('RESUME.auto.md written', fs.existsSync(autoResume));
const resumeTxt = fs.existsSync(autoResume) ? fs.readFileSync(autoResume, 'utf8') : '';
check('lists modified files', resumeTxt.includes('src/app.ts'), resumeTxt.slice(0, 200));
check('lists subagent outputs', resumeTxt.includes('subagents'), '');
check('mentions reset time', /resets at \d\d:\d\d/.test(resumeTxt), '');

console.log('10. Session restore (session-restore.js)');
const out10 = run('session-restore.js', {
  session_id: 'new-session-2',
  cwd: FAKE_PROJ,
  hook_event_name: 'SessionStart',
  source: 'resume',
});
check('injects resume note', out10.includes('additionalContext') && out10.includes('RESUME.auto.md'), out10.slice(0, 200));
check('nudges when collector not installed', out10.includes('governor:install'), out10.slice(0, 200));

console.log('11. Ignored StopFailure types');
fs.rmSync(autoResume);
run('emergency.js', {
  session_id: SID,
  cwd: FAKE_PROJ,
  hook_event_name: 'StopFailure',
  error_type: 'authentication_failed',
});
check('auth failure does not checkpoint', !fs.existsSync(autoResume));

console.log('12. Malformed input never crashes');
for (const s of [
  'statusline.js',
  'injector.js',
  'journal.js',
  'subagent-tee.js',
  'subagent-budget.js',
  'emergency.js',
  'session-restore.js',
  'precompact-archive.js',
]) {
  let ok = true;
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', s)], {
      input: 'this is not json{{{',
      env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME },
      cwd: FAKE_PROJ,
      encoding: 'utf8',
    });
  } catch {
    ok = false;
  }
  check(s + ' survives garbage stdin', ok);
}

console.log('13. Collector installer (install-statusline.js)');
const settingsFile = path.join(FAKE_HOME, '.claude', 'settings.json');
const binDir = path.join(FAKE_HOME, '.claude', 'governor', 'bin');
run('install-statusline.js', {});
const settings13 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
check(
  'settings points at stable bin copy',
  settings13.statusLine && settings13.statusLine.command.includes(path.join('governor', 'bin', 'statusline.js')),
  JSON.stringify(settings13.statusLine)
);
check(
  'bin copy complete',
  fs.existsSync(path.join(binDir, 'statusline.js')) && fs.existsSync(path.join(binDir, 'lib', 'common.js'))
);
const pluginVer = JSON.parse(
  fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
).version;
check('VERSION matches plugin manifest', fs.readFileSync(path.join(binDir, 'VERSION'), 'utf8').trim() === pluginVer);
let reinstallOk = true;
try {
  run('install-statusline.js', {});
} catch {
  reinstallOk = false;
}
check('reinstall over own statusline needs no --force', reinstallOk);
// A foreign statusline must be refused without --force and left untouched.
fs.writeFileSync(
  settingsFile,
  JSON.stringify({ statusLine: { type: 'command', command: 'my-custom-bar.sh' } })
);
let refused = false;
try {
  run('install-statusline.js', {});
} catch {
  refused = true;
}
check('refuses foreign statusline without --force', refused);
check(
  'foreign statusline untouched after refusal',
  JSON.parse(fs.readFileSync(settingsFile, 'utf8')).statusLine.command === 'my-custom-bar.sh'
);
execFileSync('node', [path.join(ROOT, 'scripts', 'install-statusline.js'), '--force'], {
  env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME },
  cwd: FAKE_PROJ,
  encoding: 'utf8',
});
check(
  '--force replaces foreign statusline',
  JSON.parse(fs.readFileSync(settingsFile, 'utf8')).statusLine.command.includes('statusline.js')
);

console.log('14. SessionStart self-maintenance');
const out14 = run('session-restore.js', {
  session_id: 'new-session-3',
  cwd: FAKE_PROJ,
  hook_event_name: 'SessionStart',
  source: 'startup',
});
check('no install nudge once collector installed', !out14.includes('governor:install'), out14.slice(0, 200));
// Plugin update self-heal: stale VERSION in the bin copy gets refreshed.
fs.writeFileSync(path.join(binDir, 'VERSION'), '0.0.0-stale');
run('session-restore.js', { session_id: 'new-session-3', cwd: FAKE_PROJ, hook_event_name: 'SessionStart', source: 'startup' });
check('stale bin copy refreshed on session start', fs.readFileSync(path.join(binDir, 'VERSION'), 'utf8').trim() === pluginVer);
// userConfig env options are mirrored into config.json for the collector.
run(
  'session-restore.js',
  { session_id: 'new-session-3', cwd: FAKE_PROJ, hook_event_name: 'SessionStart', source: 'startup' },
  {
    CLAUDE_PLUGIN_OPTION_contract_mode: 'passive',
    CLAUDE_PLUGIN_OPTION_economy_pct: '60',
    CLAUDE_PLUGIN_OPTION_winddown_pct: '85',
    CLAUDE_PLUGIN_OPTION_checkpoint_pct: '95',
  }
);
const cfg14 = JSON.parse(fs.readFileSync(path.join(govDir, 'config.json'), 'utf8'));
check('contract_mode option mirrored', cfg14.contractMode === 'passive', JSON.stringify(cfg14));
check(
  'threshold options mirrored to context+5h',
  cfg14.thresholds &&
    cfg14.thresholds.context.economy === 60 &&
    cfg14.thresholds.five_hour.windDown === 85 &&
    cfg14.thresholds.five_hour.checkpoint === 95,
  JSON.stringify(cfg14.thresholds)
);
// Inverted thresholds must be rejected, not written.
run(
  'session-restore.js',
  { session_id: 'new-session-3', cwd: FAKE_PROJ, hook_event_name: 'SessionStart', source: 'startup' },
  {
    CLAUDE_PLUGIN_OPTION_economy_pct: '90',
    CLAUDE_PLUGIN_OPTION_winddown_pct: '70',
    CLAUDE_PLUGIN_OPTION_checkpoint_pct: '95',
  }
);
const cfg14b = JSON.parse(fs.readFileSync(path.join(govDir, 'config.json'), 'utf8'));
check('inverted thresholds rejected', cfg14b.thresholds.context.economy === 60, JSON.stringify(cfg14b.thresholds));
fs.rmSync(path.join(govDir, 'config.json'));

console.log('15. Hooks-off marker (statusline.js)');
const SID3 = 'hooks-off-3';
run('statusline.js', { ...statuslineInput(30, 91, 61), session_id: SID3 });
// Backdate the session's first-seen time past the 5-minute grace window;
// with no runtime file for this session the marker must appear.
const sf3 = path.join(FAKE_HOME, '.claude', 'governor', 'state', SID3 + '.json');
const snap3 = JSON.parse(fs.readFileSync(sf3, 'utf8'));
snap3.t0 = Date.now() - 6 * 60_000;
fs.writeFileSync(sf3, JSON.stringify(snap3));
const out15a = run('statusline.js', { ...statuslineInput(30, 91, 61), session_id: SID3 });
check('marker shown when injector never ran', out15a.includes('hooks off?'), out15a);
// Once the injector runs (runtime file fresh), the marker must clear.
run('injector.js', { session_id: SID3, hook_event_name: 'PostToolBatch', cwd: FAKE_PROJ });
const out15b = run('statusline.js', { ...statuslineInput(30, 91, 61), session_id: SID3 });
check('marker clears once injector is live', !out15b.includes('hooks off?'), out15b);

console.log('');
console.log(`${passed} passed, ${failed} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
