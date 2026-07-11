---
description: Usage analytics from governor's local data — session costs, burn behavior, resets, weekly usage, per-project tool and subagent stats
allowed-tools: Bash
---

Run this command and relay its output to the user, formatted readably:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/analytics.js" "${CLAUDE_SESSION_ID}"
```

Add at most two sentences of interpretation (e.g. an unusually high burn or
an approaching 7d ceiling). Everything reported comes from governor's own
local files; if a section is missing, the collector simply hasn't recorded
that data yet — say so rather than speculating.
