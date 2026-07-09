'use strict';
// governor/injector.js — the Injector.
// Registered on UserPromptSubmit and PostToolBatch. Reads the freshest state
// written by the Collector, computes the pressure band, and (with hysteresis)
// injects one compact budget line the model actually sees, in the same slot
// where native context-awareness updates land.

const c = require('./lib/common');

function main() {
  const input = c.readStdinJson();
  const cfg = c.loadConfig();
  const sessionId = input.session_id || 'unknown';
  const eventName = input.hook_event_name || 'PostToolBatch';

  const view = c.freshestState(sessionId);
  // No collector data at all → stay silent (statusline not installed yet,
  // or headless mode; see README fallbacks).
  if (!view.own && !view.quota) return;

  const a = c.assess(view, cfg);
  const { band, speak } = c.decide(sessionId, a, cfg);
  if (!speak) return;

  a.band = band; // debounced band is the official one the model sees
  let line = c.budgetLine(a);
  if (band === c.BAND.CRUISE) {
    line = '[governor] budget pressure cleared — normal operation.';
  }
  c.hookOutput(eventName, line);
}

try {
  main();
} catch {
  /* never block the loop */
}
process.exit(0);
