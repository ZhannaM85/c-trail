#!/usr/bin/env node
// c-trail — browse and resume Claude Code sessions across all projects

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { spawnSync } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PAGE_SIZE = 8;

const R    = '\x1B[0m';
const BOLD = '\x1B[1m';
const DIM  = '\x1B[2m';
const GREEN = '\x1B[32m';
const CYAN  = '\x1B[36m';

const HELP = `
c-trail 🐾 — browse and resume Claude Code sessions across all projects

Usage:
  c-trail                      Interactive picker (arrow keys)
  c-trail --list               Print all sessions and exit
  c-trail --filter <text>      Filter by directory path or first message
  c-trail --help               Show this help

Keys (interactive mode):
  ↑ ↓                          Navigate
  Enter                        Resume selected session
  q / Ctrl+C                   Quit

Examples:
  c-trail
  c-trail --list
  c-trail --filter my-project
  c-trail --filter "auth middleware"

Made by ZhannaM85 · https://github.com/ZhannaM85/c-trail
`;

function parseSession(jsonlPath) {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
    const info = { file: jsonlPath };
    for (const line of lines.slice(0, 40)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!info.sessionId && obj.sessionId) info.sessionId = obj.sessionId;
        if (!info.cwd && obj.cwd) info.cwd = obj.cwd;
        if (!info.timestamp && obj.timestamp) info.timestamp = obj.timestamp;
        if (!info.firstMessage && obj.type === 'user' && obj.message?.content) {
          const c = obj.message.content;
          info.firstMessage = (typeof c === 'string' ? c : c[0]?.text || '').replace(/\s+/g, ' ').trim();
        }
        if (info.sessionId && info.cwd && info.firstMessage) break;
      } catch {}
    }
    return info.sessionId ? info : null;
  } catch {
    return null;
  }
}

function getAllSessions() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error('No Claude projects directory found at', PROJECTS_DIR);
    process.exit(1);
  }
  const sessions = [];
  for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, entry.name);
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const session = parseSession(path.join(dir, file));
        if (session) sessions.push(session);
      }
    } catch {}
  }
  return sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function formatDate(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function printAll(sessions) {
  sessions.forEach((s, i) => {
    const num = String(i + 1).padStart(String(sessions.length).length);
    console.log(`${num}. [${formatDate(s.timestamp)}]  ${s.cwd || '?'}`);
    console.log(`${''.padStart(String(sessions.length).length + 2)}  "${(s.firstMessage || '').slice(0, 100)}"`);
    console.log();
  });
}

// Renders the visible window; returns the number of \n-terminated lines written
// so the next call knows how far to move the cursor back up.
function renderPicker(sessions, selected, offset, prevLines) {
  const visible = Math.min(PAGE_SIZE, sessions.length - offset);

  if (prevLines > 0) {
    process.stdout.write(`\r\x1B[${prevLines}A\x1B[0J`);
  }

  for (let i = offset; i < offset + visible; i++) {
    const s = sessions[i];
    const isSelected = i === selected;
    const date = formatDate(s.timestamp);
    const msg  = (s.firstMessage || '(no message)').slice(0, 70);
    const cwd  = s.cwd || '?';

    if (isSelected) {
      process.stdout.write(`${GREEN}${BOLD} ❯ [${date}]  ${cwd}${R}\n`);
      process.stdout.write(`${GREEN}     "${msg}"${R}\n`);
    } else {
      process.stdout.write(`${DIM}   [${date}]  ${cwd}${R}\n`);
      process.stdout.write(`${DIM}   "${msg}"${R}\n`);
    }
  }

  const counter = `${CYAN}${selected + 1}${R}${DIM}/${sessions.length}${R}`;
  process.stdout.write(`\n${DIM}↑↓ navigate · enter resume · q quit    ${counter}${R}`);

  // visible*2 session lines + 1 blank line before hint, all ended with \n
  return visible * 2 + 1;
}

async function pickInteractive(sessions) {
  return new Promise((resolve) => {
    let selected = 0;
    let offset   = 0;
    let prevLines = 0;

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    prevLines = renderPicker(sessions, selected, offset, prevLines);

    const cleanup = (result) => {
      process.stdin.setRawMode(false);
      process.stdin.removeAllListeners('keypress');
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    };

    process.stdin.on('keypress', (_, key) => {
      if (!key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'q') {
        cleanup(null);
        return;
      }

      if (key.name === 'return') {
        cleanup(sessions[selected]);
        return;
      }

      if (key.name === 'up' && selected > 0) {
        selected--;
        if (selected < offset) offset = selected;
      } else if (key.name === 'down' && selected < sessions.length - 1) {
        selected++;
        if (selected >= offset + PAGE_SIZE) offset = selected - PAGE_SIZE + 1;
      } else {
        return;
      }

      prevLines = renderPicker(sessions, selected, offset, prevLines);
    });
  });
}

// Fallback when stdout is not a TTY (piped output)
async function pickNumbered(sessions) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\nEnter number to resume (or q to quit): ', answer => {
      rl.close();
      const n = parseInt(answer, 10);
      resolve(!isNaN(n) && n >= 1 && n <= sessions.length ? sessions[n - 1] : null);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const listOnly  = args.includes('--list');
  const filterIdx = args.indexOf('--filter');
  const filterText = filterIdx !== -1 ? args[filterIdx + 1]?.toLowerCase() : null;

  process.stdout.write('Scanning sessions... ');
  let sessions = getAllSessions();
  console.log(`found ${sessions.length} across ${new Set(sessions.map(s => s.cwd)).size} projects.\n`);

  if (filterText) {
    sessions = sessions.filter(s =>
      s.cwd?.toLowerCase().includes(filterText) ||
      s.firstMessage?.toLowerCase().includes(filterText)
    );
    if (sessions.length === 0) { console.log(`No sessions matching "${filterText}".`); return; }
    console.log(`Showing ${sessions.length} matching "${filterText}".\n`);
  }

  if (sessions.length === 0) { console.log('No sessions found.'); return; }

  if (listOnly) { printAll(sessions); return; }

  const chosen = process.stdin.isTTY
    ? await pickInteractive(sessions)
    : (printAll(sessions), await pickNumbered(sessions));

  if (!chosen) { console.log('Cancelled.'); return; }

  const projectDir = chosen.cwd && fs.existsSync(chosen.cwd) ? chosen.cwd : process.cwd();
  console.log(`Resuming in ${projectDir} ...`);

  spawnSync('claude', ['--resume', chosen.sessionId], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true,
  });
}

main().catch(console.error);
