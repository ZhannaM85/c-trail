#!/usr/bin/env node
// c-trail — browse and resume Claude Code sessions across all projects

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { spawnSync } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PAGE_SIZE = 8;
const PREVIEW_HEIGHT = 4; // fixed number of preview lines (keeps layout stable)

const R      = '\x1B[0m';
const BOLD   = '\x1B[1m';
const DIM    = '\x1B[2m';
const GREEN  = '\x1B[32m';
const CYAN   = '\x1B[36m';
const YELLOW = '\x1B[33m';
const GRAY   = '\x1B[90m';

const HELP = `
c-trail 🐾 — browse and resume Claude Code sessions across all projects

Usage:
  c-trail                      Interactive picker (arrow keys)
  c-trail --list               Print all sessions and exit
  c-trail --recent <n>         Show only the most recent n sessions
  c-trail --sort <order>       Sort order: active (default), created, project
  c-trail --project <name>     Filter by project name (last folder in path)
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
    info.lastActive = fs.statSync(jsonlPath).mtime;
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
  return sessions.sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
}

function formatDate(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function printAll(sessions, sortBy = 'active') {
  const label = sortBy === 'created' ? 'created' : 'active';
  sessions.forEach((s, i) => {
    const num  = String(i + 1).padStart(String(sessions.length).length);
    const date = formatDate(sortBy === 'created' ? s.timestamp : s.lastActive);
    const cwd  = s.cwd || '?';
    const msg  = (s.firstMessage || '').slice(0, 100);
    const pad  = ''.padStart(String(sessions.length).length + 2);
    console.log(`${GRAY}${num}.${R} ${DIM}${label} ${R}${CYAN}${date}${R}  ${YELLOW}${BOLD}${cwd}${R}`);
    console.log(`${pad}  ${GRAY}"${msg}"${R}`);
    console.log();
  });
}

const previewCache = new Map();

function loadPreview(session) {
  if (previewCache.has(session.sessionId)) return previewCache.get(session.sessionId);
  try {
    const lines = fs.readFileSync(session.file, 'utf8').split('\n');
    const messages = [];
    for (const line of lines.slice(0, 300)) {
      if (!line.trim() || messages.length >= PREVIEW_HEIGHT) break;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && obj.message?.content) {
          const c = obj.message.content;
          const text = (typeof c === 'string' ? c : c[0]?.text || '').replace(/\s+/g, ' ').trim();
          if (text) messages.push({ role: 'user', text });
        } else if (obj.type === 'assistant' && obj.message?.content) {
          const c = obj.message.content;
          const text = (Array.isArray(c) ? c.find(b => b.type === 'text')?.text || '' : c).replace(/\s+/g, ' ').trim();
          if (text) messages.push({ role: 'assistant', text });
        }
      } catch {}
    }
    previewCache.set(session.sessionId, messages);
    return messages;
  } catch {
    return [];
  }
}

// Renders the visible window; returns the number of \n-terminated lines written
// so the next call knows how far to move the cursor back up.
function renderPicker(sessions, selected, offset, prevLines, sortBy = 'active') {
  const visible = Math.min(PAGE_SIZE, sessions.length - offset);

  if (prevLines > 0) {
    process.stdout.write(`\r\x1B[${prevLines}A\x1B[0J`);
  }

  for (let i = offset; i < offset + visible; i++) {
    const s = sessions[i];
    const isSelected = i === selected;
    const date = formatDate(sortBy === 'created' ? s.timestamp : s.lastActive);
    const msg  = (s.firstMessage || '(no message)').slice(0, 70);
    const cwd  = s.cwd || '?';

    if (isSelected) {
      process.stdout.write(`${GREEN}${BOLD} ❯ ${R}${DIM}[${R}${CYAN}${BOLD}${date}${R}${DIM}]${R}  ${YELLOW}${BOLD}${cwd}${R}\n`);
      process.stdout.write(`${GREEN}     "${msg}"${R}\n`);
    } else {
      process.stdout.write(`${DIM}   [${date}]  ${cwd}${R}\n`);
      process.stdout.write(`${GRAY}   "${msg}"${R}\n`);
    }
  }

  // Preview panel — fixed PREVIEW_HEIGHT lines so layout stays stable
  const preview = loadPreview(sessions[selected]);
  process.stdout.write(`\n${DIM}─── Preview ${'─'.repeat(50)}${R}\n`);
  for (let i = 0; i < PREVIEW_HEIGHT; i++) {
    const msg = preview[i];
    if (msg) {
      const prefix = msg.role === 'user' ? `${CYAN} You${R}` : `${GREEN} Claude${R}`;
      process.stdout.write(`${prefix}${DIM}: ${R}${GRAY}${msg.text.slice(0, 76)}${R}\n`);
    } else {
      process.stdout.write('\n');
    }
  }

  const counter = `${CYAN}${selected + 1}${R}${DIM}/${sessions.length}${R}`;
  process.stdout.write(`\n${DIM}↑↓ navigate · enter resume · q quit    ${counter}${R}`);

  // visible*2 session lines + 2 (blank+separator) + PREVIEW_HEIGHT + 1 (blank before hint)
  return visible * 2 + PREVIEW_HEIGHT + 3;
}

async function pickInteractive(sessions, sortBy = 'active') {
  return new Promise((resolve) => {
    let selected = 0;
    let offset   = 0;
    let prevLines = 0;

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    prevLines = renderPicker(sessions, selected, offset, prevLines, sortBy);

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

      prevLines = renderPicker(sessions, selected, offset, prevLines, sortBy);
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

  const listOnly    = args.includes('--list');
  const filterIdx   = args.indexOf('--filter');
  const filterText  = filterIdx !== -1 ? args[filterIdx + 1]?.toLowerCase() : null;
  const projectIdx  = args.indexOf('--project');
  const projectName = projectIdx !== -1 ? args[projectIdx + 1]?.toLowerCase() : null;
  const recentIdx  = args.indexOf('--recent');
  const recentN    = recentIdx !== -1 ? parseInt(args[recentIdx + 1], 10) : null;
  const sortIdx    = args.indexOf('--sort');
  const sortBy     = sortIdx !== -1 ? args[sortIdx + 1] : 'active';

  const SORT_OPTIONS = ['active', 'created', 'project'];
  if (!SORT_OPTIONS.includes(sortBy)) {
    console.error(`${YELLOW}--sort must be one of: ${SORT_OPTIONS.join(', ')}${R}`);
    process.exit(1);
  }

  if (recentN !== null && (isNaN(recentN) || recentN < 1)) {
    console.error(`${YELLOW}--recent requires a positive number, e.g. --recent 10${R}`);
    process.exit(1);
  }

  process.stdout.write(`${DIM}Scanning sessions...${R} `);
  let sessions = getAllSessions();
  const projectCount = new Set(sessions.map(s => s.cwd)).size;
  console.log(`found ${CYAN}${BOLD}${sessions.length}${R} sessions across ${CYAN}${BOLD}${projectCount}${R} projects.\n`);

  if (sortBy === 'created') {
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } else if (sortBy === 'project') {
    sessions.sort((a, b) => (a.cwd || '').localeCompare(b.cwd || ''));
  }
  // 'active' is the default sort from getAllSessions — no re-sort needed

  if (sortBy !== 'active') {
    console.log(`${DIM}Sorted by${R} ${CYAN}${sortBy}${R}.\n`);
  }

  if (recentN !== null) {
    sessions = sessions.slice(0, recentN);
    console.log(`Showing ${CYAN}${BOLD}${sessions.length}${R} most recent sessions.\n`);
  }

  if (projectName) {
    sessions = sessions.filter(s =>
      path.basename(s.cwd || '').toLowerCase() === projectName
    );
    if (sessions.length === 0) { console.log(`${YELLOW}No sessions found for project "${projectName}".${R}`); return; }
    console.log(`Showing ${CYAN}${BOLD}${sessions.length}${R} sessions in project ${YELLOW}"${projectName}"${R}.\n`);
  }

  if (filterText) {
    sessions = sessions.filter(s =>
      s.cwd?.toLowerCase().includes(filterText) ||
      s.firstMessage?.toLowerCase().includes(filterText)
    );
    if (sessions.length === 0) { console.log(`${YELLOW}No sessions matching "${filterText}".${R}`); return; }
    console.log(`Showing ${CYAN}${BOLD}${sessions.length}${R} sessions matching ${YELLOW}"${filterText}"${R}.\n`);
  }

  if (sessions.length === 0) { console.log('No sessions found.'); return; }

  if (listOnly) { printAll(sessions, sortBy); return; }

  const chosen = process.stdin.isTTY
    ? await pickInteractive(sessions, sortBy)
    : (printAll(sessions, sortBy), await pickNumbered(sessions));

  if (!chosen) { console.log('Cancelled.'); return; }

  const projectDir = chosen.cwd && fs.existsSync(chosen.cwd) ? chosen.cwd : process.cwd();
  console.log(`${DIM}Resuming in${R} ${YELLOW}${projectDir}${R} ${DIM}...${R}`);

  spawnSync('claude', ['--resume', chosen.sessionId], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true,
  });
}

main().catch(console.error);
