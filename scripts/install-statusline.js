'use strict';
// governor/install-statusline.js — one-time setup.
// Points ~/.claude/settings.json's statusLine at the Collector. Refuses to
// clobber an existing statusline unless --force (a backup is written either
// way). Run:  node scripts/install-statusline.js [--force]

const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const collector = path.resolve(__dirname, 'statusline.js');
const command = `node "${collector}"`;

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
if (existing && existing.command !== command && !process.argv.includes('--force')) {
  console.error('A statusline is already configured:');
  console.error('  ' + JSON.stringify(existing));
  console.error('');
  console.error('Governor needs to own the statusline to collect budget data.');
  console.error('Re-run with --force to replace it (a timestamped backup of');
  console.error('settings.json is written first), or chain your old command');
  console.error('manually after the collector.');
  process.exit(1);
}

if (fs.existsSync(settingsFile)) {
  const backup = settingsFile + '.governor-backup-' + Date.now();
  fs.copyFileSync(settingsFile, backup);
  console.log('Backup written: ' + backup);
}

settings.statusLine = { type: 'command', command };
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log('statusLine now points at the governor collector:');
console.log('  ' + command);
console.log('');
console.log('Open a Claude Code session and send one message — quota data');
console.log('appears after the first API response. Then run /governor:status.');
