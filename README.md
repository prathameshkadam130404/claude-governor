# ⛽ Governor

**A budget-aware agent loop for Claude Code.** Makes the agent — and its
subagents — continuously aware of both the context window *and* the
subscription quota clock (5-hour / 7-day windows), so it economizes under
pressure, finishes the answer in hand, checkpoints durably, and resumes
cleanly instead of dying mid-task and losing work.

Zero dependencies. Everything stays local. No telemetry.

## Why

Two limits interrupt long agentic work:

| | Context window | Usage quota (5h / 7d) |
|---|---|---|
| Model aware? | ✅ native (Sonnet 4.5+) | ❌ **never shown to the model** |
| Failure | lossy auto-compaction | hard mid-task cutoff |

Subagent work compounds the damage: only a subagent's final message survives,
and if the session dies before that message is acted on, it's gone too.

Governor closes the loop with five components:

1. **Collector** — a statusline shim that persists the budget JSON Claude Code
   already provides (`context_window.*`, `rate_limits.five_hour/seven_day`)
   to `~/.claude/governor/`.
2. **Injector** — `UserPromptSubmit` + `PostToolBatch` hooks inject one compact
   `[governor]` budget line (with burn rate and projected exhaustion vs. reset
   time) that the **model actually sees**, with hysteresis so it only speaks
   when it matters.
3. **Policy skill** — defines what the CRUISE → ECONOMY → WIND-DOWN →
   CHECKPOINT bands require of the model.
4. **Durability layer** — journal of every tool call; every subagent's final
   message teed to `.governor/subagents/`; transcript archived before
   compaction; machine-generated `RESUME.auto.md` when a session dies on a
   rate limit without warning.
5. **Resume layer** — on session start/resume, injects the checkpoint and
   preserved subagent outputs back into context.

## Install

Requires Node.js (Claude Code itself runs on Node, so you have it) and a
Pro/Max subscription for quota data (API-key users get context-only mode).

**1. Install the plugin** (from a local clone):

```
claude --plugin-dir <path-to>/governor
```

or add it to your marketplace/plugins config once published:
`/plugin install github:<you>/governor`

**2. Install the statusline collector** (one-time; backs up settings.json):

```
node <path-to>/governor/scripts/install-statusline.js
```

If you already have a statusline you care about, the installer refuses to
replace it without `--force`. To keep yours, chain it: make your script run
first, then pipe the same stdin to `scripts/statusline.js` — or just adopt
Governor's statusline, which shows band, context %, and both quota windows.

**3. Verify.** Open a session, send one message (quota appears after the first
API response), then run `/governor:status`.

## What you'll see

Statusline: `⛽ CRUISE · ctx 12% · 5h 34% ↺2h11m · 7d 61% ↺3d · Sonnet 5`

When pressure builds, the model starts seeing lines like:

```
[governor] ctx 62% | 5h 87% (resets 14:32, 41m) burn 1.9%/m → dry ~7m
band: WIND-DOWN (5h-quota) — finish the current unit and deliver it...
```

Injection cadence: silent in CRUISE · every 5th batch in ECONOMY · every batch
in WIND-DOWN/CHECKPOINT · always on band change.

## Configuration

Optional `~/.claude/governor/config.json` (defaults shown):

```json
{
  "thresholds": {
    "context":   { "economy": 70, "windDown": 90, "checkpoint": 97 },
    "five_hour": { "economy": 70, "windDown": 90, "checkpoint": 97 },
    "seven_day": { "economy": 95, "windDown": 98, "checkpoint": 99 }
  },
  "dryMinutes": { "economy": 45, "windDown": 15, "checkpoint": 5 },
  "economyInjectEvery": 5,
  "staleMinutes": 10,
  "archiveMax": 10
}
```

`dryMinutes` drives burn-rate escalation: if projected minutes-to-100% falls
below these (and the reset won't arrive first), the band escalates regardless
of the raw percentage.

## Files it writes

| Path | What |
|---|---|
| `~/.claude/governor/state/<session>.json` | latest budget snapshot per session |
| `~/.claude/governor/history.jsonl` | samples for burn-rate math (auto-trimmed) |
| `~/.claude/governor/archives/` | pre-compaction transcript copies (last 10) |
| `<project>/.governor/journal.jsonl` | tool-call ledger (rotates at 2 MB) |
| `<project>/.governor/subagents/*.md` | every subagent's final message, preserved |
| `<project>/.governor/RESUME.md` | agent-written checkpoint (authoritative) |
| `<project>/.governor/RESUME.auto.md` | machine-generated checkpoint (reconstruction) |

Add `.governor/` to your project's `.gitignore` if you don't want checkpoints
committed — though committing `RESUME.md` is a feature, not a bug.

## Honest limitations (v0.1)

- **Headless (`claude -p`) mode**: the statusline may not refresh, starving
  the collector. Planned fallback: transcript-JSONL parsing for context %, and
  an opt-in OAuth usage poller for quota.
- **`PostToolBatch` and `updatedInput`-without-decision** are newer hook
  surfaces; on older Claude Code versions Governor degrades gracefully
  (UserPromptSubmit still injects; the subagent contract simply doesn't get
  appended). Validate on your version — see VALIDATION.md.
- **Which hooks fire inside subagent contexts** is under-documented upstream;
  the subagent tee works from the parent side regardless.
- The model *should* obey band directives (the same mechanism native context
  awareness uses, plus a skill), but obedience under pressure is exactly what
  Phase 0 testing is for. If it ignores WIND-DOWN, tighten thresholds so the
  machine checkpoint (which needs no model cooperation) catches more.
- Quota fields exist only for Pro/Max subscribers, only after the first API
  response, and either window may be independently absent. All scripts handle
  absence by degrading, never by failing.

## Uninstall

Remove the plugin, restore the settings.json backup the installer created
(or delete the `statusLine` key), and delete `~/.claude/governor/` and any
project `.governor/` directories.
