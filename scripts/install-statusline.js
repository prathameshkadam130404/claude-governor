'use strict';
// governor/install-statusline.js — one-time setup.
// Copies the Collector (statusline.js + lib/common.js) to the stable
// ~/.claude/governor/bin/ and points ~/.claude/settings.json's statusLine at
// that copy. The stable copy matters: marketplace-installed plugins live in
// a cache directory whose path changes on update, so pointing settings at
// the plugin itself would break the statusline on every upgrade. The
// SessionStart hook refreshes the copy when the plugin version changes.
//
// Refuses to clobber a non-governor statusline unless --force (a timestamped
// backup of settings.json is written either way). Run:
//   node scripts/install-statusline.js [--force]

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

const settingsFile = c.SETTINGS_FILE;

let settings = {};
if (fs.existsSync(settingsFile)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (e) {
    console.error(`Could not parse ${settingsFile}: ${e.message}`);
    console.error('Fix the JSON first; nothing was changed.');
    process.exit(1);
  }
}

const existing = settings.statusLine;
// 'ours' (live governor collector) and 'dead' (governor's own entry whose
// target moved) may be replaced freely; 'foreign' needs explicit consent.
const ownership = existing ? c.statuslineOwnership(existing.command) : 'none';
if (ownership === 'foreign' && !process.argv.includes('--force')) {
  console.error('A statusline is already configured:');
  console.error('  ' + JSON.stringify(existing));
  console.error('');
  console.error('Governor needs to own the statusline to collect budget data.');
  console.error('Re-run with --force to replace it (a timestamped backup of');
  console.error('settings.json is written first), or chain your old command');
  console.error('manually after the collector.');
  process.exit(1);
}

let collector;
try {
  collector = c.installCollectorBin();
} catch (e) {
  console.error(`Could not copy the collector to ${c.BIN_DIR}: ${e.message}`);
  console.error('Check permissions (or antivirus locks) on that directory');
  console.error('and re-run. settings.json was not changed.');
  process.exit(1);
}
const command = `node "${collector}"`;

if (fs.existsSync(settingsFile)) {
  const backup = settingsFile + '.governor-backup-' + Date.now();
  fs.copyFileSync(settingsFile, backup);
  console.log('Backup written: ' + backup);
}

settings.statusLine = { type: 'command', command };
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log('Collector copied to: ' + collector);
console.log('statusLine now points at the governor collector:');
console.log('  ' + command);
console.log('');
console.log('Open a Claude Code session and send one message — quota data');
console.log('appears after the first API response. Then run /governor:status.');
