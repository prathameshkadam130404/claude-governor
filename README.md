# ⛽ Governor

**A budget-aware agent loop for Claude Code.** Makes the agent — and its
subagents — continuously aware of both the context window *and* the
subscription quota clock (5-hour / 7-day windows), so it economizes under
pressure, finishes the answer in hand, checkpoints durably, and resumes
cleanly instead of dying mid-task and losing work.

Zero dependencies. Everything stays local. No telemetry. MIT.

## The problem

Two limits interrupt long agentic work:

| | Context window | Usage quota (5h / 7d) |
|---|---|---|
| Model aware? | ✅ native (Sonnet 4.5+) | ❌ **never shown to the model** |
| Failure | lossy auto-compaction | hard mid-task cutoff |

The quota clock is invisible to the model: it will happily spawn three
parallel subagents four minutes before your 5-hour window slams shut, and
everything they learned dies with the session. Resume flags restore the
*conversation*, not the discarded work. Dozens of tools display quota gauges
— **to the human**. Feature requests to expose usage data to automation
([#11008](https://github.com/anthropics/claude-code/issues/11008) and friends)
remain open.

Governor closes the loop: the gauge goes in front of the **model**, every
turn, with a policy attached — and everything important is journaled to disk
continuously so even an unannounced cutoff costs one turn, not a session.

## What the model sees

```
[governor] ctx 62% | 5h 87% (resets 14:32, 41m) burn 1.9%/m → dry ~7m
band: WIND-DOWN (5h-quota) — finish the current unit and deliver it to the
user; start NOTHING new; update .governor/RESUME.md with state + next step.
```

Injected at turn start and after every tool batch **mid-turn**, with
hysteresis: silent in CRUISE, every 5th batch in ECONOMY, every batch in
WIND-DOWN/CHECKPOINT, always on band change. The band comes from whichever is
most severe: context %, 5h projection, or 7d projection — where projections
race the burn rate (EWMA %/min) against the reset clock, so 67%-and-hemorrhaging
escalates while 87%-and-coasting doesn't.

## Live validation transcript (real session, real quota)

The band directives measurably change behavior. Given a deliberately
expandable 3-part refactor task while in WIND-DOWN, the model replied:

> The governor just moved to WIND-DOWN (5h quota burning 0.8%/min, projected
> to run dry well before the 22:30 reset). Per the policy, I shouldn't start
> this multi-part task now; instead I'll record it in `.governor/RESUME.md`
> so it can be picked up cleanly after the reset. […]
>
> I'm holding off on this task — the policy is explicit: start nothing new,
> so you get finished units rather than a stump of a half-refactored codebase.
> What I did instead: scoped the work (11 scripts), wrote the resume note
> with the order (start with lib/common.js since everything else depends on
> it), and two open decisions for you. The 5h quota resets at 22:30.

Earlier in the same validation run, the burn-rate projection pushed the model
into ECONOMY at **67% used — below the 70% threshold** — because the slope
said dry-in-30-minutes. Full results: [VALIDATION.md](VALIDATION.md).

## Architecture

Five components, one plugin:

| # | Component | Mechanism |
|---|---|---|
| 1 | **Collector** | Statusline shim persists the budget JSON Claude Code already emits (`context_window.*`, `rate_limits.five_hour/seven_day`) — no scraping, no undocumented APIs |
| 2 | **Injector** | `UserPromptSubmit` + `PostToolBatch` hooks inject the `[governor]` line with band, burn rate, and projected exhaustion vs. reset |
| 3 | **Policy skill** | CRUISE → ECONOMY → WIND-DOWN → CHECKPOINT: what each band requires |
| 4 | **Durability layer** | Journal of every tool call; every subagent's final message teed to `.governor/subagents/` at `SubagentStop`; transcript archived before compaction; machine-generated `RESUME.auto.md` on rate-limit death — needs zero model cooperation |
| 5 | **Resume layer** | `SessionStart` injects the checkpoint + preserved subagent outputs into the next session |

Subagents are covered twice: their spawn prompts are rewritten (`PreToolUse`
+ `updatedInput`) to carry the current budget and a durable-output contract,
and their final messages are preserved to disk regardless.

## Install

Requires Node.js (Claude Code runs on Node, so you have it). Quota data needs
a Pro/Max subscription; API-key users get context-only mode.

```bash
git clone https://github.com/prathameshkadam130404/claude-governor
node claude-governor/scripts/install-statusline.js   # one-time; backs up settings.json
claude --plugin-dir ./claude-governor                # or install via /plugin
```

Marketplace route: `/plugin marketplace add prathameshkadam130404/claude-governor` then
`/plugin install governor`.

Verify: send one message in a session (quota appears after the first API
response), then run `/governor:status`.

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
  "contractMode": "allow",
  "deescalateSeconds": 180,
  "burnWindowMinutes": 20,
  "burnMinSpanMinutes": 4,
  "burnMinSamples": 4,
  "staleMinutes": 10,
  "archiveMax": 10
}
```

- `dryMinutes` — burn-rate escalation: if projected minutes-to-100% falls
  below these (and the reset won't arrive first), the band escalates beyond
  what the raw percentage says — **by at most one tier**: projection can push
  into CHECKPOINT only when usage is already past the wind-down threshold,
  and into WIND-DOWN only past the economy threshold. A transient burn spike
  at 72% can never scream CHECKPOINT.
- `deescalateSeconds` — bands escalate instantly but drop only after the
  lower band holds this long (a real window reset bypasses the debounce).
  Quota percentages arrive as integers; without smoothing and debounce the
  band flaps. Burn rate itself is a least-squares slope over
  `burnWindowMinutes` of samples (requiring `burnMinSamples` spanning
  `burnMinSpanMinutes`), not a jumpy sample-to-sample delta.
- `contractMode` — how the durable-output contract reaches subagent prompts.
  `"allow"` (default) returns `permissionDecision: "allow"` with the rewritten
  input — required on builds that ignore `updatedInput` without a decision;
  it auto-approves the spawn itself (spawns are typically auto-allowed
  anyway). `"passive"` preserves normal permission flow but may be ignored;
  `"off"` disables. Invocations are traced to
  `~/.claude/governor/runtime/subagent-budget.log`.

## Files it writes

| Path | What |
|---|---|
| `~/.claude/governor/state/` | latest budget snapshot per session |
| `~/.claude/governor/history.jsonl` | burn-rate samples (auto-trimmed) |
| `~/.claude/governor/archives/` | pre-compaction transcript copies |
| `<project>/.governor/journal.jsonl` | tool-call ledger (rotates at 2 MB) |
| `<project>/.governor/subagents/*.md` | every subagent's final message |
| `<project>/.governor/RESUME.md` | agent-written checkpoint (authoritative) |
| `<project>/.governor/RESUME.auto.md` | machine-generated checkpoint |

Add `.governor/` to your project's `.gitignore` — or commit `RESUME.md`
deliberately as a team checkpoint.

## How it differs from prior art

- [claude-quotas](https://github.com/FruityMaxine/claude-quotas) — pull-based:
  gives the model a `check_quota` MCP tool it must remember to call. Governor
  is push-based (injected unasked, per turn, like native context awareness),
  adds burn-rate forecasting, context-window handling, and subagent coverage.
- [Usage monitors / statuslines](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)
  — display gauges to the human; the model never sees them.
- Auto-resume scripts — blindly re-send "continue" after reset; nothing was
  checkpointed, so there's little to continue *from*. Governor makes the
  checkpoint exist.

## Honest limitations

- **Single uninterrupted text generation** (a reply with zero tool calls) has
  no hook point mid-stream — no system, including Anthropic's native context
  awareness, can inject there. Economically negligible against a 5h quota.
- **Headless (`claude -p`)**: statusline refresh cadence unverified; the
  collector may starve. Interactive sessions unaffected. Fallback planned.
- **Quota fields** exist only for Pro/Max, only after the first API response,
  and either window may be independently absent — everything degrades
  gracefully to context-only mode.
- **Hook surface varies by Claude Code version.** This repo's
  [VALIDATION.md](VALIDATION.md) documents what was verified on which build,
  including two undocumented platform quirks discovered along the way (plugin
  regex matchers not applying; `updatedInput` requiring an `allow` decision).
- Anthropic may ship native quota awareness someday
  ([#11008](https://github.com/anthropics/claude-code/issues/11008)). Good.
  The durability layer — subagent tee, journal, emergency checkpoint — stays
  valuable regardless.

## Development

```bash
node test/smoke.js   # 36 assertions, simulated hook inputs, throwaway HOME
```

Everything is plain Node, one script per hook, `scripts/lib/common.js` for
shared state/band/formatting logic.

## Uninstall

Remove the plugin, restore the settings.json backup the installer created
(or delete the `statusLine` key), delete `~/.claude/governor/` and any
project `.governor/` directories.
