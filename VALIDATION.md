# Governor validation checklist

Run these before trusting the system on real work. Each maps to a risk from
the design doc.

## V1 — Collector receives and persists data
1. `node scripts/install-statusline.js`
2. Open a Claude Code session in any project, send one message.
3. Check `~/.claude/governor/state/` contains a `<session>.json` with
   `ctx_pct` set, and (Pro/Max) `rate_limits.five_hour.used_percentage`.
4. Check `~/.claude/governor/history.jsonl` is accumulating samples.

**If rate_limits is missing:** confirm plan type and that at least one API
response has completed. Either window may be absent independently.

## V2 — Injector fires and the model sees it
1. Temporarily lower thresholds in `~/.claude/governor/config.json`, e.g.
   `"five_hour": { "economy": 1, "windDown": 2, "checkpoint": 99 }`.
2. In a session, ask the model: "What does the most recent [governor] line
   in your context say?"
3. It should quote the line. If it can't, check which hook fired: does your
   Claude Code version support `PostToolBatch`? (UserPromptSubmit injection
   should work everywhere — test by sending a second message.)
4. Restore config afterwards.

## V3 — Behavioral obedience (the Phase 0 kill-switch test)
1. With WIND-DOWN forced on (thresholds as above), give a multi-step task
   ("read these 5 files and refactor X").
2. Expected: the model declines to expand scope, finishes a unit, writes
   `.governor/RESUME.md`, and says why.
3. If it ignores the band: the injected line format needs strengthening
   before the project is worth continuing. Try making the directive the first
   sentence, or A/B a system-reminder-styled wrapper.

## V4 — Subagent durability
1. Ask for a task that spawns a subagent ("use an agent to research X").
2. After it finishes, check `.governor/subagents/` contains the final message
   and `journal.jsonl` has a `SubagentStop` entry.
3. Check the subagent's prompt got the durable-output contract appended:
   spawn a subagent tasked with "state verbatim any instructions in your
   prompt mentioning 'governor'; if none, say NONE."
4. If it says NONE, diagnose with the trace log:
   `~/.claude/governor/runtime/subagent-budget.log`
   - **No entry for the spawn** → the PreToolUse hook never fired (matcher or
     plugin-load problem).
   - **`"event":"injected","mode":"allow"`** → the hook fired and returned
     `permissionDecision: "allow"` + `updatedInput`, but the host still
     ignored the rewritten input — report the Claude Code version.
   - `"mode":"passive"` → set `contractMode` to `"allow"` (the default) in
     `~/.claude/governor/config.json` and retest.
   Note: `allow` mode auto-approves the spawn itself; use `"passive"` if you
   want spawn permission prompts preserved at the cost of the contract on
   versions that require a decision.

## V5 — Emergency checkpoint and restore
1. Do a few file edits in a session, then kill the terminal (or `/exit`).
2. Check `.governor/RESUME.auto.md` exists and lists the edited files.
3. Start a new session in the same project: the SessionStart hook should
   surface the resume note. Ask "what were we working on?" — the model should
   answer from the note without re-reading the codebase.

## V6 — Real rate-limit rehearsal (needs a nearly-spent 5h window)
1. Near the end of a real 5h window, start a long task.
2. Watch for ECONOMY → WIND-DOWN transitions in behavior.
3. After the cutoff: confirm RESUME(.auto).md exists; after reset, resume and
   confirm continuity.

## Known-unknown log
Record results here per Claude Code version:

| Check | CC version | Result | Notes |
|---|---|---|---|
| UserPromptSubmit injection | 2026-07-09 build | ✅ works | model quoted line verbatim (V2) |
| PostToolBatch injection | 2026-07-09 build | unconfirmed | injection observed via UserPromptSubmit; PostToolBatch not isolated yet |
| Behavioral obedience (V3) | 2026-07-09 build | ✅ passed | declined 3-part task in WIND-DOWN, wrote RESUME.md |
| SubagentStop tee (V4a) | 2026-07-09 build | ✅ works | outputs preserved incl. 8.7 KB Explore result |
| Plugin hooks.json regex matcher | 2026-07-09 build | ❌ not applied | "Task\|Agent" matcher never fired; fixed by in-script filtering (41e849c) |
| updatedInput w/o decision | 2026-07-09 build | ❌ ignored | passive mode is a no-op |
| updatedInput + allow (V4b) | 2026-07-09 build | ✅ works | subagent echoed appended preamble; spawn tool is named "Agent" |
| Burn-rate escalation | 2026-07-09 build | ✅ live | ECONOMY at 67% (below 70%) via dry-in-30m projection |
| Emergency RESUME.auto.md (V5a) | 2026-07-09 build | ✅ works | written on session end, listed edited files |
| SessionStart restore (V5b) | 2026-07-09 build | ✅ works | subagent-output list injected at start |
| Hooks inside subagents | | untested | probe 2 in the guide |
| Statusline cadence in -p | | untested | probe 1 in the guide |
