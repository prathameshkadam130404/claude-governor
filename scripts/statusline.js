'use strict';
// governor/statusline.js — the Collector.
// Claude Code invokes this on every status refresh, piping session JSON on
// stdin (context_window, rate_limits, cost, model, session id). We persist a
// snapshot for the hook scripts, append a history sample for burn-rate math,
// then render a human statusline. Must ALWAYS exit 0 and print something.

const c = require('./lib/common');

function main() {
  const input = c.readStdinJson();
  const cfg = c.loadConfig();
  const now = Date.now();

  const sessionId = input.session_id || 'unknown';
  const cw = input.context_window || {};
  const rl = input.rate_limits || null;

  const snapshot = {
    t: now,
    session_id: sessionId,
    model: (input.model && (input.model.display_name || input.model.id)) || null,
    ctx_pct: typeof cw.used_percentage === 'number' ? cw.used_percentage : null,
    ctx_size: cw.context_window_size || null,
    cost_usd: input.cost ? input.cost.total_cost_usd : null,
    rate_limits: rl
      ? {
          five_hour: rl.five_hour
            ? { used_percentage: rl.five_hour.used_percentage, resets_at: rl.five_hour.resets_at }
            : null,
          seven_day: rl.seven_day
            ? { used_percentage: rl.seven_day.used_percentage, resets_at: rl.seven_day.resets_at }
            : null,
        }
      : null,
  };

  // Change detection BEFORE overwriting the snapshot: history only needs
  // samples when the quota values actually moved (plus a heartbeat, handled
  // inside appendHistory).
  const prev = c.readState(sessionId);
  // First-seen time survives snapshot overwrites; the hooks-off probe below
  // needs to know the session isn't brand new before it accuses anyone.
  snapshot.t0 = (prev && prev.t0) || now;
  const prevRl = prev && prev.rate_limits ? prev.rate_limits : null;
  const newFh = rl && rl.five_hour ? rl.five_hour.used_percentage : null;
  const newSd = rl && rl.seven_day ? rl.seven_day.used_percentage : null;
  const changed =
    !prevRl ||
    newFh !== (prevRl.five_hour ? prevRl.five_hour.used_percentage : null) ||
    newSd !== (prevRl.seven_day ? prevRl.seven_day.used_percentage : null);

  c.writeState(sessionId, snapshot);
  c.appendHistory(
    { t: now, sid: sessionId, ctx: snapshot.ctx_pct, fh: newFh, sd: newSd },
    cfg,
    { changed }
  );

  // ---- render ----
  const view = c.freshestState(sessionId);
  const a = c.assess(view, cfg);
  // Show the same debounced band the model sees, not the raw noisy one.
  const band = c.peekBand(sessionId, a.band, a.fh.pct);

  const RESET = '\x1b[0m';
  const DIM = '\x1b[2m';
  const bandColor = ['\x1b[32m', '\x1b[33m', '\x1b[38;5;208m', '\x1b[31m'][band];

  const parts = [];
  parts.push(bandColor + '⛽ ' + c.BAND_NAME[band] + RESET);
  if (typeof a.ctxPct === 'number') parts.push('ctx ' + Math.round(a.ctxPct) + '%');
  if (typeof a.fh.pct === 'number') {
    parts.push('5h ' + Math.round(a.fh.pct) + '%' + DIM + ' ↺' + c.fmtMins(a.fh.reset) + RESET);
  }
  if (typeof a.sd.pct === 'number') {
    parts.push('7d ' + Math.round(a.sd.pct) + '%' + DIM + ' ↺' + c.fmtMins(a.sd.reset) + RESET);
  }
  if (snapshot.model) parts.push(DIM + snapshot.model + RESET);

  // Liveness cross-check: under pressure the injector writes runtime state
  // on every prompt and tool batch. A session that's several minutes old
  // with no recent injector activity means the plugin hooks aren't loaded
  // (statusline installs globally; hooks only exist where the plugin is
  // actually enabled) — the gauge looks healthy but the model is blind.
  if (
    band >= c.BAND.ECONOMY &&
    now - snapshot.t0 > 5 * 60_000 &&
    !c.runtimeFresh(sessionId, 10 * 60_000)
  ) {
    parts.push('\x1b[31m⚠ hooks off?\x1b[0m');
  }

  process.stdout.write(parts.join('  ·  '));
}

try {
  main();
} catch (e) {
  // Never break the status bar.
  process.stdout.write('⛽ governor (no data)');
}
process.exit(0);
