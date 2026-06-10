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

// ANSI escape codes for terminal colors and formatting
const R      = '\x1B[0m';  // reset all formatting
const BOLD   = '\x1B[1m';  // bold text
const DIM    = '\x1B[2m';  // dim / muted text
const GREEN  = '\x1B[32m'; // green
const CYAN   = '\x1B[36m'; // cyan
const YELLOW = '\x1B[33m'; // yellow
const GRAY   = '\x1B[90m'; // dark gray

const HELP = `
c-trail 🐾 — browse and resume Claude Code sessions across all projects

Usage:
  c-trail                      Interactive picker (fzf if available, else arrow keys)
  c-trail resume <id>          Resume a specific session by ID (skip picker)
  c-trail export <id>          Export a session to Markdown (stdout)
  c-trail export <id> --output <file>  Save exported Markdown to a file
  c-trail --list               Print all sessions and exit
  c-trail --recent <n>         Show only the most recent n sessions
  c-trail --sort <order>       Sort order: active (default), created, project, messages, size
  c-trail --project <name>     Filter by project name (last folder in path)
  c-trail --filter <text>      Filter by directory path or any message
  c-trail --no-fzf             Disable fzf even if it is installed
  c-trail --help               Show this help

Keys (interactive mode):
  ↑ ↓                          Navigate
  Enter                        Resume selected session
  q / Ctrl+C                   Quit

Examples:
  c-trail
  c-trail resume abc123
  c-trail export abc123
  c-trail export abc123 --output session.md
  c-trail --list
  c-trail --filter my-project
  c-trail --filter "auth middleware"

Made by ZhannaM85 · https://github.com/ZhannaM85/c-trail
`;

/**
 * Per-model token pricing in USD per million tokens.
 * Matched by prefix against the model name reported in the JSONL file.
 *
 * @type {Array<{prefix: string, input: number, output: number, cacheWrite: number, cacheRead: number}>}
 */
const MODEL_PRICING = [
  { prefix: 'claude-opus',   input: 15,  output: 75,  cacheWrite: 18.75, cacheRead: 1.5  },
  { prefix: 'claude-haiku',  input: 0.8, output: 4,   cacheWrite: 1,     cacheRead: 0.08 },
  { prefix: 'claude-sonnet', input: 3,   output: 15,  cacheWrite: 3.75,  cacheRead: 0.3  },
];

/** Fallback pricing used when the model name does not match any known prefix. */
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/**
 * Parsed representation of a single Claude Code session.
 *
 * @typedef {Object} Session
 * @property {string}  file             - Absolute path to the .jsonl file on disk
 * @property {string}  sessionId        - UUID that uniquely identifies the session
 * @property {string}  cwd              - Working directory where the session was started
 * @property {string}  timestamp        - ISO 8601 timestamp of the first message
 * @property {Date}    lastActive       - Last time the .jsonl file was modified (file mtime)
 * @property {number}  fileSize         - Size of the .jsonl file in bytes
 * @property {string}  firstMessage     - Text of the very first user message in the session
 * @property {string}  allText          - All user message texts joined and lowercased (used for --filter search)
 * @property {number}  messageCount     - Number of user messages in the session
 * @property {number}  totalTokens      - Total input + output tokens across all assistant turns
 * @property {number}  estimatedCostUSD - Estimated cost in USD based on token usage and model pricing
 */

/**
 * Estimates the USD cost of a session based on token counts and model name.
 * Uses MODEL_PRICING for known model prefixes; falls back to DEFAULT_PRICING otherwise.
 *
 * @param {string} model        - Model name as reported in the JSONL (e.g. "claude-sonnet-4-5")
 * @param {number} input        - Number of input (prompt) tokens
 * @param {number} output       - Number of output (completion) tokens
 * @param {number} cacheCreate  - Number of cache-creation tokens
 * @param {number} cacheRead    - Number of cache-read tokens
 * @returns {number} Estimated cost in USD
 */
function estimateCostUSD(model, input, output, cacheCreate, cacheRead) {
  const p = MODEL_PRICING.find(t => model && model.startsWith(t.prefix)) || DEFAULT_PRICING;
  return (input * p.input + output * p.output + cacheCreate * p.cacheWrite + cacheRead * p.cacheRead) / 1_000_000;
}

/**
 * Formats a raw token count into a compact, human-readable string.
 *
 * @param {number} n - Token count
 * @returns {string} e.g. "0 tok", "12K tok", "1.4M tok"
 */
function formatTokens(n) {
  if (!n) return '0 tok';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K tok`;
  return `${n} tok`;
}

/**
 * Builds a compact stats string for a session.
 *
 * @param {Session} s     - The session to summarise
 * @param {boolean} [full=true] - When false, returns only the message count (used in unselected picker rows)
 * @returns {string} e.g. "12 msgs · 45K tok · ~$0.14"
 */
function sessionStats(s, full = true) {
  const msgs = `${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}`;
  if (!full) return msgs;
  const toks = s.totalTokens ? formatTokens(s.totalTokens) : null;
  const cost = s.estimatedCostUSD >= 0.0001
    ? `~$${s.estimatedCostUSD < 0.01 ? s.estimatedCostUSD.toFixed(4) : s.estimatedCostUSD.toFixed(2)}`
    : null;
  return [msgs, toks, cost].filter(Boolean).join(' · ');
}

/**
 * Reads and parses a single .jsonl session file.
 *
 * Iterates every line, extracting:
 * - Session metadata: sessionId, cwd, first timestamp
 * - User messages: firstMessage, allText (for full-text search), messageCount
 * - Token usage from assistant turns: totalTokens, estimatedCostUSD
 * - File stats: lastActive (mtime), fileSize
 *
 * Returns null if the file is empty, unreadable, or contains no sessionId.
 *
 * @param {string} jsonlPath - Absolute path to the .jsonl file
 * @returns {Session|null}
 */
function parseSession(jsonlPath) {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
    const info = { file: jsonlPath };
    const messageTexts = [];
    let totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0;
    let sessionModel = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!info.sessionId && obj.sessionId) info.sessionId = obj.sessionId;
        if (!info.cwd && obj.cwd) info.cwd = obj.cwd;
        if (!info.timestamp && obj.timestamp) info.timestamp = obj.timestamp;
        if (obj.type === 'user' && obj.message?.content) {
          const c = obj.message.content;
          const text = (typeof c === 'string' ? c : c[0]?.text || '').replace(/\s+/g, ' ').trim();
          if (!info.firstMessage && text) info.firstMessage = text;
          if (text) messageTexts.push(text);
        }
        if (obj.type === 'assistant' && obj.message?.usage) {
          const u = obj.message.usage;
          totalInput       += u.input_tokens                 || 0;
          totalOutput      += u.output_tokens                || 0;
          totalCacheCreate += u.cache_creation_input_tokens  || 0;
          totalCacheRead   += u.cache_read_input_tokens      || 0;
          if (!sessionModel && obj.message.model) sessionModel = obj.message.model;
        }
      } catch {}
    }
    info.allText = messageTexts.join('\n').toLowerCase();
    const stat = fs.statSync(jsonlPath);
    info.lastActive = stat.mtime;
    info.fileSize = stat.size;
    info.messageCount = messageTexts.length;
    info.totalTokens = totalInput + totalOutput;
    info.estimatedCostUSD = estimateCostUSD(sessionModel, totalInput, totalOutput, totalCacheCreate, totalCacheRead);
    return info.sessionId ? info : null;
  } catch {
    return null;
  }
}

/**
 * Scans ~/.claude/projects/ and returns all sessions sorted by last active time (newest first).
 *
 * Each subdirectory of PROJECTS_DIR represents one project, named after its encoded path.
 * Every .jsonl file inside is one session. Files that fail to parse are silently skipped.
 *
 * @returns {Session[]} All discovered sessions, newest first
 */
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

/**
 * Formats a Date or ISO string into a human-readable "DD Mon YYYY HH:MM" string.
 *
 * @param {Date|string} iso
 * @returns {string} e.g. "10 Jun 2026 22:54"
 */
function formatDate(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Prints all sessions to stdout in a numbered, color-coded list.
 * Used by --list mode and displayed before the numbered picker in non-TTY environments.
 *
 * @param {Session[]} sessions
 * @param {string}    [sortBy='active'] - Controls which date to display per row:
 *                                        'created' shows session start time; anything else shows last active
 */
function printAll(sessions, sortBy = 'active') {
  const label = sortBy === 'created' ? 'created' : 'active';
  sessions.forEach((s, i) => {
    const num   = String(i + 1).padStart(String(sessions.length).length);
    const date  = formatDate(sortBy === 'created' ? s.timestamp : s.lastActive);
    const cwd   = s.cwd || '?';
    const msg   = (s.firstMessage || '').slice(0, 100);
    const pad   = ''.padStart(String(sessions.length).length + 2);
    const stats = sessionStats(s);
    console.log(`${GRAY}${num}.${R} ${DIM}${label} ${R}${CYAN}${date}${R}  ${YELLOW}${BOLD}${cwd}${R}`);
    console.log(`${pad}  ${GRAY}"${msg}"${R}  ${DIM}[${stats}]${R}`);
    console.log();
  });
}

/**
 * In-memory cache of preview messages keyed by sessionId.
 * Prevents re-reading the same .jsonl file as the user navigates the picker.
 * @type {Map<string, Array<{role: 'user'|'assistant', text: string}>>}
 */
const previewCache = new Map();

/**
 * Loads the first PREVIEW_HEIGHT messages (user and assistant turns) from a session file.
 * Results are cached in previewCache after the first read.
 *
 * @param {Session} session
 * @returns {Array<{role: 'user'|'assistant', text: string}>}
 */
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

/**
 * Extracts plain text from a Claude message content field.
 *
 * The content field can be either:
 * - A plain string (older API format)
 * - An array of content blocks, e.g. `[{ type: 'text', text: '...' }, { type: 'tool_use', ... }]`
 *
 * Only `text`-typed blocks are included; tool calls, images, etc. are ignored.
 *
 * @param {string|Array<{type: string, text?: string}>} content
 * @returns {string} The concatenated plain text
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n');
}

/**
 * Converts a full session to a Markdown document string.
 *
 * The output starts with a metadata header (session ID, project path, dates, stats)
 * followed by each message rendered as a `## You` / `## Claude` section.
 * Suitable for archiving, sharing, or feeding into other tools.
 *
 * @param {Session} session
 * @returns {string} Markdown-formatted session transcript
 */
function exportToMarkdown(session) {
  const lines = fs.readFileSync(session.file, 'utf8').split('\n');
  const messages = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.message?.content) {
        const text = extractText(obj.message.content).trim();
        if (text) messages.push({ role: 'You', text });
      } else if (obj.type === 'assistant' && obj.message?.content) {
        const text = extractText(obj.message.content).trim();
        if (text) messages.push({ role: 'Claude', text });
      }
    } catch {}
  }

  const out = [];
  out.push('# Session Export');
  out.push('');
  out.push(`**Session ID:** \`${session.sessionId}\``);
  out.push(`**Project:** \`${session.cwd || 'unknown'}\``);
  out.push(`**Started:** ${formatDate(session.timestamp)}`);
  out.push(`**Last active:** ${formatDate(session.lastActive)}`);
  out.push(`**Stats:** ${sessionStats(session)}`);
  out.push('');
  out.push('---');
  out.push('');

  for (const msg of messages) {
    out.push(`## ${msg.role}`);
    out.push('');
    out.push(msg.text);
    out.push('');
    out.push('---');
    out.push('');
  }

  return out.join('\n');
}

/**
 * Renders the interactive picker to stdout using ANSI escape codes.
 *
 * Draws a scrollable window of PAGE_SIZE sessions, a fixed-height preview panel
 * for the highlighted session, and a navigation hint line.
 *
 * On subsequent calls it erases the previous render by moving the cursor up
 * `prevLines` rows and clearing to end-of-screen, then redraws in place.
 * This avoids flickering without using a full terminal library.
 *
 * @param {Session[]} sessions  - Full filtered/sorted session list
 * @param {number}    selected  - Index of the currently highlighted session (0-based)
 * @param {number}    offset    - Index of the first visible session in the scroll window
 * @param {number}    prevLines - Number of lines written by the previous render (0 on first call)
 * @param {string}    [sortBy='active'] - Which date to show: 'created' = session start, else = last active
 * @returns {number} The number of lines written, to be passed as prevLines on the next call
 */
function renderPicker(sessions, selected, offset, prevLines, sortBy = 'active') {
  const visible = Math.min(PAGE_SIZE, sessions.length - offset);

  if (prevLines > 0) {
    // Move cursor back to the top of what we drew, then clear to end of screen
    process.stdout.write(`\r\x1B[${prevLines}A\x1B[0J`);
  }

  for (let i = offset; i < offset + visible; i++) {
    const s = sessions[i];
    const isSelected = i === selected;
    const date = formatDate(sortBy === 'created' ? s.timestamp : s.lastActive);
    const msg  = (s.firstMessage || '(no message)').slice(0, 70);
    const cwd  = s.cwd || '?';

    if (isSelected) {
      const stats = sessionStats(s);
      process.stdout.write(`${GREEN}${BOLD} ❯ ${R}${DIM}[${R}${CYAN}${BOLD}${date}${R}${DIM}]${R}  ${YELLOW}${BOLD}${cwd}${R}\n`);
      process.stdout.write(`${GREEN}     "${msg}"  ${R}${DIM}[${stats}]${R}\n`);
    } else {
      const stats = sessionStats(s, false);
      process.stdout.write(`${DIM}   [${date}]  ${cwd}${R}\n`);
      process.stdout.write(`${GRAY}   "${msg}"  [${stats}]${R}\n`);
    }
  }

  // Preview panel — fixed PREVIEW_HEIGHT lines so total height stays constant while navigating
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

  // visible*2 session rows + blank line + separator + PREVIEW_HEIGHT + blank line before hint = +3
  return visible * 2 + PREVIEW_HEIGHT + 3;
}

/**
 * Shows the interactive arrow-key picker and resolves with the chosen session (or null if cancelled).
 * Requires stdin to be a real TTY so that setRawMode is available.
 *
 * @param {Session[]} sessions
 * @param {string}    [sortBy='active']
 * @returns {Promise<Session|null>} The chosen session, or null if the user pressed q/Ctrl+C
 */
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

/**
 * Fallback picker used when stdout is not a TTY (e.g. when output is piped).
 * Prints the numbered session list and prompts the user to type a number.
 *
 * @param {Session[]} sessions
 * @returns {Promise<Session|null>} The chosen session, or null if input is invalid or 'q'
 */
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

/**
 * Checks whether the `fzf` fuzzy finder is installed and available on PATH.
 * @returns {boolean}
 */
function fzfAvailable() {
  try {
    return spawnSync('fzf', ['--version'], { stdio: 'pipe' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Builds a plain-text preview string for a session, used by the fzf --preview panel.
 * Shows session metadata (ID, project, active date, stats) followed by the first few messages.
 *
 * @param {Session} session
 * @returns {string} Multi-line text shown in the fzf preview window
 */
function buildFzfPreview(session) {
  const out = [];
  out.push(`Session: ${session.sessionId}`);
  out.push(`Project: ${session.cwd || '?'}`);
  out.push(`Active:  ${formatDate(session.lastActive)}`);
  out.push(`Stats:   ${sessionStats(session)}`);
  out.push('');
  for (const m of loadPreview(session)) {
    const label = m.role === 'user' ? 'You' : 'Claude';
    out.push(`${label}: ${m.text.slice(0, 120)}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Runs the fzf fuzzy finder as an interactive picker.
 *
 * Sessions are piped to fzf as `sessionId<TAB>display-line` pairs so fzf shows
 * only the display text while the hidden first column carries the ID needed for lookup.
 * Preview data is written to a temp JSON file and read by a small helper script that
 * fzf invokes for each highlighted entry.
 *
 * Temp files are cleaned up in a finally block regardless of whether the user selects
 * a session or cancels.
 *
 * @param {Session[]} sessions
 * @param {string}    [sortBy='active'] - Controls which date appears in each fzf row
 * @returns {Session|null} The chosen session, or null if the user cancelled
 */
function pickWithFzf(sessions, sortBy = 'active') {
  const pid        = process.pid;
  const scriptPath = path.join(os.tmpdir(), `c-trail-fzf-script-${pid}.js`);
  const dataPath   = path.join(os.tmpdir(), `c-trail-fzf-data-${pid}.json`);

  const previewData = {};
  for (const s of sessions) previewData[s.sessionId] = buildFzfPreview(s);

  // Tiny helper script so the preview command avoids inline quoting pitfalls
  fs.writeFileSync(scriptPath,
    `var d=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));` +
    `process.stdout.write(d[process.argv[1]]||'(no preview)');`
  );
  fs.writeFileSync(dataPath, JSON.stringify(previewData));

  const lines = sessions.map(s => {
    const date  = formatDate(sortBy === 'created' ? s.timestamp : s.lastActive);
    const msg   = (s.firstMessage || '(no message)').slice(0, 60);
    const cwd   = s.cwd || '?';
    // Format: sessionId<TAB>display-line  (fzf shows only field 2 via --with-nth)
    return `${s.sessionId}\t${date}  ${cwd}  "${msg}"  [${sessionStats(s, false)}]`;
  }).join('\n');

  try {
    const result = spawnSync('fzf', [
      '--delimiter', '\t',
      '--with-nth', '2',
      '--no-sort',
      '--ansi',
      '--height', '60%',
      '--layout', 'reverse',
      '--border',
      '--prompt', 'c-trail> ',
      '--preview', `node "${scriptPath}" {1} "${dataPath}"`,
      '--preview-window', 'right:40%:wrap',
    ], { input: lines, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });

    if (result.status !== 0 || !result.stdout.trim()) return null;
    const id = result.stdout.trim().split('\t')[0];
    return sessions.find(s => s.sessionId === id) || null;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
    try { fs.unlinkSync(dataPath); } catch {}
  }
}

/**
 * CLI entry point. Parses process.argv, applies filters and sorting,
 * then dispatches to the appropriate command or picker.
 *
 * Subcommands:
 *   resume <id>  — skip the picker and resume a known session directly
 *   export <id>  — write a Markdown transcript to stdout or a file
 *
 * Flags (all optional, combinable):
 *   --list, --recent N, --sort <order>, --project <name>, --filter <text>, --no-fzf, --help
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  // c-trail resume <id> — jump straight to a known session without showing the picker
  if (args[0] === 'resume') {
    const targetId = args[1];
    if (!targetId) {
      console.error(`${YELLOW}Usage: c-trail resume <session-id>${R}`);
      process.exit(1);
    }
    process.stdout.write(`${DIM}Scanning sessions...${R} `);
    const sessions = getAllSessions();
    const projectCount = new Set(sessions.map(s => s.cwd)).size;
    console.log(`found ${CYAN}${BOLD}${sessions.length}${R} sessions across ${CYAN}${BOLD}${projectCount}${R} projects.\n`);
    const chosen = sessions.find(s => s.sessionId === targetId);
    if (!chosen) {
      console.error(`${YELLOW}No session found with ID "${targetId}".${R}`);
      process.exit(1);
    }
    const projectDir = chosen.cwd && fs.existsSync(chosen.cwd) ? chosen.cwd : process.cwd();
    console.log(`${DIM}Resuming in${R} ${YELLOW}${projectDir}${R} ${DIM}...${R}`);
    spawnSync('claude', ['--resume', chosen.sessionId], {
      cwd: projectDir,
      stdio: 'inherit',
      shell: true,
    });
    return;
  }

  // c-trail export <id> [--output <file>] — dump a session as Markdown
  if (args[0] === 'export') {
    const targetId = args[1];
    if (!targetId) {
      console.error(`${YELLOW}Usage: c-trail export <session-id> [--output <file>]${R}`);
      process.exit(1);
    }
    const outputIdx  = args.indexOf('--output');
    const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : null;

    process.stdout.write(`${DIM}Scanning sessions...${R} `);
    const sessions = getAllSessions();
    const projectCount = new Set(sessions.map(s => s.cwd)).size;
    console.log(`found ${CYAN}${BOLD}${sessions.length}${R} sessions across ${CYAN}${BOLD}${projectCount}${R} projects.\n`);

    const chosen = sessions.find(s => s.sessionId === targetId);
    if (!chosen) {
      console.error(`${YELLOW}No session found with ID "${targetId}".${R}`);
      process.exit(1);
    }

    const markdown = exportToMarkdown(chosen);

    if (outputFile) {
      fs.writeFileSync(outputFile, markdown, 'utf8');
      console.log(`${GREEN}Exported to${R} ${YELLOW}${outputFile}${R}`);
    } else {
      process.stdout.write(markdown + '\n');
    }
    return;
  }

  const listOnly    = args.includes('--list');
  const noFzf       = args.includes('--no-fzf');
  const filterIdx   = args.indexOf('--filter');
  const filterText  = filterIdx !== -1 ? args[filterIdx + 1]?.toLowerCase() : null;
  const projectIdx  = args.indexOf('--project');
  const projectName = projectIdx !== -1 ? args[projectIdx + 1]?.toLowerCase() : null;
  const recentIdx  = args.indexOf('--recent');
  const recentN    = recentIdx !== -1 ? parseInt(args[recentIdx + 1], 10) : null;
  const sortIdx    = args.indexOf('--sort');
  const sortBy     = sortIdx !== -1 ? args[sortIdx + 1] : 'active';

  const SORT_OPTIONS = ['active', 'created', 'project', 'messages', 'size'];
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
  } else if (sortBy === 'messages') {
    sessions.sort((a, b) => b.messageCount - a.messageCount);
  } else if (sortBy === 'size') {
    sessions.sort((a, b) => b.fileSize - a.fileSize);
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
      s.allText?.includes(filterText)
    );
    if (sessions.length === 0) { console.log(`${YELLOW}No sessions matching "${filterText}".${R}`); return; }
    console.log(`Showing ${CYAN}${BOLD}${sessions.length}${R} sessions matching ${YELLOW}"${filterText}"${R}.\n`);
  }

  if (sessions.length === 0) { console.log('No sessions found.'); return; }

  if (listOnly) { printAll(sessions, sortBy); return; }

  let chosen;
  if (!process.stdin.isTTY) {
    printAll(sessions, sortBy);
    chosen = await pickNumbered(sessions);
  } else if (!noFzf && fzfAvailable()) {
    chosen = pickWithFzf(sessions, sortBy);
  } else {
    chosen = await pickInteractive(sessions, sortBy);
  }

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
