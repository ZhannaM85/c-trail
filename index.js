#!/usr/bin/env node
// c-trail — browse and resume Claude Code sessions across all projects
// Usage: c-trail [--list] [--filter <text>] [--help]

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { spawnSync } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const HELP = `
c-trail — browse and resume Claude Code sessions across all projects

Usage:
  c-trail                      Interactive picker — choose a session to resume
  c-trail --list               List all sessions without resuming
  c-trail --filter <text>      Filter sessions by directory path or first message
  c-trail --help               Show this help

Examples:
  c-trail
  c-trail --list
  c-trail --filter my-project
  c-trail --filter "auth middleware"
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

function printSession(i, s, total) {
  const num = String(i + 1).padStart(String(total).length);
  const date = formatDate(s.timestamp);
  const cwd = s.cwd || '?';
  const msg = (s.firstMessage || '(no message)').slice(0, 100);
  console.log(`${num}. [${date}]  ${cwd}`);
  console.log(`${''.padStart(String(total).length + 2)}  "${msg}"`);
}

async function pick(sessions) {
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

  const listOnly = args.includes('--list');
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
    console.log(`Filtered to ${sessions.length} matching "${filterText}".\n`);
  }

  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  sessions.forEach((s, i) => {
    printSession(i, s, sessions.length);
    console.log();
  });

  if (listOnly) return;

  const chosen = await pick(sessions);
  if (!chosen) { console.log('Cancelled.'); return; }

  const projectDir = chosen.cwd && fs.existsSync(chosen.cwd) ? chosen.cwd : process.cwd();
  console.log(`\nResuming in ${projectDir} ...`);

  spawnSync('claude', ['--resume', chosen.sessionId], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true,
  });
}

main().catch(console.error);
