---
name: governor-policy
description: Budget-pressure protocol for lines beginning with "[governor]". Use whenever a [governor] budget line appears in context, when planning long-running or subagent-heavy work, or when asked about remaining budget/quota/limits — defines what the ECONOMY, WIND-DOWN, and CHECKPOINT bands require and how to checkpoint and resume.
---

# Governor policy

Lines beginning with `[governor]` are instrumentation injected by a local
hook, in the same spirit as the native context-window budget: they report how
much **context window** and **subscription quota** (5-hour and 7-day windows)
remain, including burn rate and time until the quota resets. Treat them as
ground truth about your operating budget, not as user conversation.

The line names a **band**. Each band is a standing order:

## CRUISE
No pressure. Work normally. (Governor stays silent in this band except when
announcing recovery from a higher band.)

## ECONOMY
Budget pressure is building. Keep working, but spend deliberately:
- Read narrowly: targeted Grep and offset/limit reads, never whole-file dumps
  or speculative exploration.
- Be terse in prose output; skip restating things already established.
- Batch independent tool calls into single messages.
- Prefer cheap/fast models for search-type subagents; cap parallel subagents.
- Do not start optional side-quests (refactors, extra polish) — note them for
  later instead.

## WIND-DOWN
The budget will not outlast open-ended work. Priority: **the user gets a
finished unit, not a stump.**
- Finish the current unit of work and deliver it in your reply.
- Start nothing new: no new subtasks, no new subagents.
- Update `.governor/RESUME.md` (create if missing) with: what is done, what is
  in flight, the exact next step (file paths, line numbers), and any decisions
  pending. Keep it under a page.
- If a subagent is still running, let it finish but consume its result into a
  durable file, not just your reply.

## CHECKPOINT
Stop expanding work immediately — but never leave broken syntax or a
half-written file.
1. Complete only the minimal edit needed for the code to be coherent.
2. Write `.governor/RESUME.md` with sections: **Done / In flight / Next step /
   Open decisions**. Concrete file paths and line numbers, not vibes.
3. If the project is a git repo, `git commit` the working state as a
   checkpoint (do not push).
4. Tell the user in one short paragraph: where you stopped, where the resume
   note lives, and when the limit resets (the governor line includes it).
5. End the turn cleanly. Do not keep working past this.

## Resuming after an interruption
On session start you may be shown a `RESUME.md` (agent-written, authoritative)
or `RESUME.auto.md` (machine-generated from the tool journal — a reconstruction,
verify against `git status`/`git diff` before trusting it).
- Read any preserved subagent outputs in `.governor/subagents/` **before**
  re-running research a subagent already did.
- After absorbing a resume note and confirming direction with the user, update
  or delete it so it cannot go stale.

## Subagent contract
When you spawn subagents (Task/Agent tool), require durable outputs: the
subagent writes substantive findings to a file (`.governor/subagents/` or the
project) and its final message is a pointer + summary. A hook also appends
this contract to spawn prompts automatically — do not fight it.

## Interactions
- Native context-window awareness and governor lines can coexist; when they
  disagree about context %, trust the native signal, but quota data exists
  only in governor lines.
- A line marked `(quota data stale)` means the collector hasn't refreshed;
  treat quota numbers as a floor, not a current reading.
