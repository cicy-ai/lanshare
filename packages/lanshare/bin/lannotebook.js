#!/usr/bin/env node
// lannotebook — shortcut for `lanshare note ...`
const a = process.argv.slice(2);
const first = a[0];
const NOTE_HELP = `Usage:
  lannotebook [file] [options]     Shared LAN notebook: one full-page textarea autosaved to [file]
                                   (default file: ~/cicy-ai/db/lanshare-note.txt)
  lannotebook status [--json]      Show the background notebook started with --daemon
  lannotebook stop                 Stop the background notebook
  lannotebook ip [--json]          Print LAN (private IPv4) addresses

Options:
  -p, --port <n>        Listen port (default 8081; 0 = random free port)
  -H, --host <addr>     Bind address (default 0.0.0.0 = all interfaces)
  -a, --auth <u:p>      Require HTTP Basic auth (user:password)
  -d, --daemon          Run in the background
      --json            Print startup info as JSON

Examples:
  npx lannotebook
  npx lannotebook -a team:pass -p 9001
  npx lannotebook ~/notes/lan.md --daemon
`;
if (first === '-h' || first === '--help' || first === 'help') { process.stdout.write(NOTE_HELP); process.exit(0); }
if (first === 'stop') process.argv.splice(2, 1, 'stop', 'note');
else if (first !== 'status' && first !== 'ip') process.argv.splice(2, 0, 'note');
await import('./lanshare.js');
