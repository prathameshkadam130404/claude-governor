---
description: Show current governor budget state (context, 5h/7d quota, band, burn rate, durability artifacts)
allowed-tools: Bash
---

Run this command and relay its output to the user, formatted readably. Add a
one-line interpretation of what the current band means for ongoing work (per
the governor-policy skill). Do not editorialize beyond that.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/status-report.js" "${CLAUDE_SESSION_ID}"
```
