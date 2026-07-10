---
description: Finish governor setup — install the collector statusline into ~/.claude/settings.json (backup written first)
allowed-tools: Bash
---

Run the collector installer:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-statusline.js"
```

- On success, relay the output and tell the user: budget data appears after
  the next message (quota fields need one API response, Pro/Max plans only);
  verify with `/governor:status`.
- If it refuses because a different statusline is already configured, show
  the user the existing command and ask whether to replace it (their
  settings.json is backed up first either way). Only if they agree, re-run
  with `--force`.
- Do not edit settings.json by hand; the installer handles backup, the
  stable collector copy in `~/.claude/governor/bin/`, and the settings write.
