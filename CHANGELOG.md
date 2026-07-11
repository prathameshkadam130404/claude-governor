# Changelog

## 0.2.0 — 2026-07-10

Install & self-maintenance:
- Marketplace-first install; `/governor:install` finishes setup from inside
  Claude Code (collector copied to stable `~/.claude/governor/bin/`,
  settings backup first, foreign statuslines never replaced without consent)
- SessionStart self-checks: setup nudge when the collector is missing,
  content-drift refresh of the bin copy, automatic repair of a dead
  statusline entry after a plugin-cache move
- `⚠ hooks off?` statusline marker when pressure is ECONOMY+ but the
  injector hasn't run — catches sessions running without the plugin's hooks
- `userConfig` enable-time prompts for band thresholds and contract mode,
  mirrored into `config.json`; maintenance failures logged to
  `runtime/governor.log`

Prediction & display:
- Burn rate: recency-weighted least squares (`burnHalfLifeMinutes`) with a
  2× standard-error significance gate — adapts to regime changes, ignores
  quantization noise
- Statusline: 8-slot 5h gauge and a red `⏳ dry~Xm` expected cutoff, shown
  only when the projection beats the reset

New:
- `/governor:analytics` — session costs, burn behavior, observed resets,
  weekly usage, per-project tool/subagent footprint (local data only)
- `.governor/` self-ignores via a nested `.gitignore`

## 0.1.0 — 2026-07-09

Initial release: statusline collector (context + 5h/7d quota from the
documented statusline feed), per-turn and mid-turn budget injection
(UserPromptSubmit + PostToolBatch) with CRUISE/ECONOMY/WIND-DOWN/CHECKPOINT
bands, burn-rate projection with tiered escalation guards and de-escalation
debounce, subagent budget contracts (PreToolUse rewrite), subagent output
preservation (SubagentStop tee), tool journal, emergency `RESUME.auto.md`
on rate-limit death, SessionStart restore, pre-compaction transcript
archive. Live-validated V1–V5 on 2026-07-09.
