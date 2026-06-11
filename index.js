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
  c-trail resume <n>           Resume session by number from --list (skip picker)
  c-trail rename <n> "title"   Rename session by number from --list
  c-trail export <n>           Export a session to Markdown (stdout)
  c-trail export <n> --output <file>  Save exported Markdown to a file
  c-trail delete <n>           Delete a session file (asks for confirmation)
  c-trail stats                Print aggregate usage summary across all sessions
  c-trail stats --top <n>      Show top n projects in the breakdown (default: 10)
  c-trail --list               Print all sessions with numbers and exit
  c-trail --recent <n>         Show only the most recent n sessions
  c-trail --sort <order>       Sort order: active (default), created, project, messages, size
  c-trail --project <name>     Filter by project name (last folder in path)
  c-trail --filter <text>      Filter by directory path or any message
  c-trail --since <date>       Show only sessions active on or after YYYY-MM-DD
  c-trail --before <date>      Show only sessions active on or before YYYY-MM-DD
  c-trail --no-fzf             Disable fzf even if it is installed
  c-trail --help               Show this help

Keys (interactive mode):
  ↑ ↓                          Navigate
  Enter                        Resume selected session
  /                            Enter search mode (filter sessions)
  r                            Rename selected session
  Backspace                    Remove last search/rename character
  Escape                       Clear search / cancel rename / exit mode
  q / Ctrl+C                   Quit

Examples:
  c-trail
  c-trail --list
  c-trail resume 3
  c-trail rename 3 "My session title"
  c-trail export 3
  c-trail export 3 --output session.md
  c-trail delete 3
  c-trail stats
  c-trail stats --top 5
  c-trail --filter my-project
  c-trail --filter "auth middleware"
  c-trail --since 2026-06-01
  c-trail --before 2026-05-01
  c-trail --since 2026-05-01 --before 2026-06-01

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
        if (obj.type === 'custom-title' && obj.customTitle) info.customTitle = obj.customTitle;
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
    info.lastMessage = messageTexts.length > 0 ? messageTexts[messageTexts.length - 1] : '';
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
    const pad   = ''.padStart(String(sessions.length).length + 2);
    const stats = sessionStats(s);
    console.log(`${GRAY}${num}.${R} ${DIM}${label} ${R}${CYAN}${date}${R}  ${YELLOW}${BOLD}${cwd}${R}`);
    if (s.customTitle) {
      console.log(`${pad}  ${CYAN}${s.customTitle}${R}  ${DIM}[${stats}]${R}`);
    } else {
      const first = (s.firstMessage || '').slice(0, 100);
      const last  = s.lastMessage && s.lastMessage !== s.firstMessage ? s.lastMessage.slice(0, 100) : null;
      console.log(`${pad}  ${DIM}first:${R} ${GRAY}"${first}"${R}  ${DIM}[${stats}]${R}`);
      if (last) console.log(`${pad}  ${DIM}last: ${R} ${GRAY}"${last}"${R}`);
    }
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
 * Writes a custom-title entry to the session's JSONL file and updates the in-memory object.
 * This is the same format Claude Code uses for /rename, so the name shows everywhere.
 *
 * @param {Session} session
 * @param {string}  newTitle
 */
function renameSession(session, newTitle) {
  const entry = JSON.stringify({ type: 'custom-title', customTitle: newTitle, sessionId: session.sessionId });
  fs.appendFileSync(session.file, '\n' + entry, 'utf8');
  session.customTitle = newTitle;
  previewCache.delete(session.sessionId);
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
 * @param {Session[]} sessions        - Filtered/sorted session list to display
 * @param {number}    selected        - Index of the currently highlighted session (0-based)
 * @param {number}    offset          - Index of the first visible session in the scroll window
 * @param {number}    prevLines       - Number of lines written by the previous render (0 on first call)
 * @param {string}    [sortBy='active']     - Which date to show: 'created' = session start, else = last active
 * @param {boolean}   [searchMode=false]    - Whether the search input prompt is active
 * @param {string}    [searchQuery='']      - Current inline search query
 * @returns {number} The number of lines written, to be passed as prevLines on the next call
 */
function renderPicker(sessions, selected, offset, prevLines, sortBy = 'active', searchMode = false, searchQuery = '', renameMode = false, renameBuffer = '') {
  if (prevLines > 0) {
    // Move cursor back to the top of what we drew, then clear to end of screen
    process.stdout.write(`\r\x1B[${prevLines}A\x1B[0J`);
  }

  const visible = Math.min(PAGE_SIZE, sessions.length - offset);

  if (sessions.length === 0) {
    process.stdout.write(`${DIM}  (no sessions match "${searchQuery}")${R}\n`);
  } else {
    for (let i = offset; i < offset + visible; i++) {
      const s = sessions[i];
      const isSelected = i === selected;
      const date  = formatDate(sortBy === 'created' ? s.timestamp : s.lastActive);
      const cwd   = s.cwd || '?';

      if (isSelected) {
        const stats   = sessionStats(s);
        const msgLine = s.customTitle
          ? s.customTitle.slice(0, 76)
          : (() => { const f = (s.firstMessage || '(no message)').slice(0, 38); const l = s.lastMessage && s.lastMessage !== s.firstMessage ? s.lastMessage.slice(0, 38) : null; return l ? `"${f}"  ${DIM}→${R}${GREEN}  "${l}"` : `"${f}"`; })();
        process.stdout.write(`${GREEN}${BOLD} ❯ ${R}${DIM}[${R}${CYAN}${BOLD}${date}${R}${DIM}]${R}  ${YELLOW}${BOLD}${cwd}${R}\n`);
        process.stdout.write(`${GREEN}     ${msgLine}  ${R}${DIM}[${stats}]${R}\n`);
      } else {
        const stats   = sessionStats(s, false);
        const msgLine = s.customTitle
          ? s.customTitle.slice(0, 76)
          : (() => { const f = (s.firstMessage || '(no message)').slice(0, 38); const l = s.lastMessage && s.lastMessage !== s.firstMessage ? s.lastMessage.slice(0, 38) : null; return l ? `"${f}"  →  "${l}"` : `"${f}"`; })();
        process.stdout.write(`${DIM}   [${date}]  ${cwd}${R}\n`);
        process.stdout.write(`${GRAY}   ${msgLine}  [${stats}]${R}\n`);
      }
    }
  }

  // Preview panel — fixed PREVIEW_HEIGHT lines so total height stays constant while navigating
  const preview = sessions.length > 0 ? loadPreview(sessions[selected]) : [];
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

  const counter = sessions.length > 0
    ? `${CYAN}${selected + 1}${R}${DIM}/${sessions.length}${R}`
    : `${DIM}0/0${R}`;

  if (renameMode) {
    process.stdout.write(`\n${CYAN}rename:${R} ${renameBuffer}${DIM}█${R}  ${DIM}esc cancel · enter confirm${R}  ${counter}`);
  } else if (searchMode) {
    process.stdout.write(`\n${CYAN}/${R}${searchQuery}${DIM}█${R}  ${DIM}esc clear · ↑↓ navigate · enter confirm${R}  ${counter}`);
  } else {
    process.stdout.write(`\n${DIM}↑↓ navigate · enter resume · / search · r rename · q quit    ${counter}${R}`);
  }

  if (sessions.length === 0) {
    // 1 (no-results) + 2 (blank+separator) + PREVIEW_HEIGHT + 1 (blank+status)
    return PREVIEW_HEIGHT + 4;
  }
  // visible*2 session rows + blank+separator + PREVIEW_HEIGHT + blank+status
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
    let searchMode = false;
    let searchQuery = '';
    let renameMode = false;
    let renameBuffer = '';
    let filtered = sessions;

    function applyFilter() {
      if (!searchQuery) return sessions;
      const q = searchQuery.toLowerCase();
      return sessions.filter(s =>
        s.cwd?.toLowerCase().includes(q) ||
        s.firstMessage?.toLowerCase().includes(q) ||
        s.allText?.includes(q)
      );
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);

    const cleanup = (result) => {
      process.stdin.setRawMode(false);
      process.stdin.removeAllListeners('keypress');
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    };

    process.stdin.on('keypress', (ch, key) => {
      if (!key) return;

      if (key.ctrl && key.name === 'c') {
        cleanup(null);
        return;
      }

      if (renameMode) {
        if (key.name === 'escape') {
          renameMode = false;
          renameBuffer = '';
          prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
          return;
        }

        if (key.name === 'return') {
          if (renameBuffer.trim() && filtered.length > 0) {
            renameSession(filtered[selected], renameBuffer.trim());
          }
          renameMode = false;
          renameBuffer = '';
          prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
          return;
        }

        if (key.name === 'backspace') {
          renameBuffer = renameBuffer.slice(0, -1);
          prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
          return;
        }

        if (ch && !key.ctrl && !key.meta && ch.length === 1) {
          renameBuffer += ch;
          prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
        }
        return;
      }

      if (searchMode) {
        if (key.name === 'escape') {
          searchQuery = '';
          searchMode = false;
          selected = 0;
          offset = 0;
          filtered = applyFilter();
          prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
          return;
        }

        if (key.name === 'return') {
          searchMode = false;
          prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
          return;
        }

        if (key.name === 'backspace') {
          searchQuery = searchQuery.slice(0, -1);
          selected = 0;
          offset = 0;
          filtered = applyFilter();
          prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
          return;
        }

        if (key.name === 'up') {
          if (selected > 0) {
            selected--;
            if (selected < offset) offset = selected;
            prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
          }
          return;
        }

        if (key.name === 'down') {
          if (filtered.length > 0 && selected < filtered.length - 1) {
            selected++;
            if (selected >= offset + PAGE_SIZE) offset = selected - PAGE_SIZE + 1;
            prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
          }
          return;
        }

        if (ch && !key.ctrl && !key.meta && ch.length === 1) {
          searchQuery += ch;
          selected = 0;
          offset = 0;
          filtered = applyFilter();
          prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
        }
        return;
      }

      // Normal navigation mode
      if (key.name === 'q') {
        cleanup(null);
        return;
      }

      if (key.name === 'return') {
        if (filtered.length > 0) cleanup(filtered[selected]);
        return;
      }

      if (ch === '/') {
        searchMode = true;
        prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
        return;
      }

      if (ch === 'r' && filtered.length > 0) {
        renameMode = true;
        renameBuffer = filtered[selected].customTitle || '';
        prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
        return;
      }

      if (key.name === 'up' && selected > 0) {
        selected--;
        if (selected < offset) offset = selected;
      } else if (key.name === 'down' && selected < filtered.length - 1) {
        selected++;
        if (selected >= offset + PAGE_SIZE) offset = selected - PAGE_SIZE + 1;
      } else {
        return;
      }

      prevLines = renderPicker(filtered, selected, offset, prevLines, sortBy, searchMode, searchQuery, renameMode, renameBuffer);
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
      '--preview', `"${process.execPath}" "${scriptPath}" {1} "${dataPath}"`,
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
 * Prints an aggregate usage summary across all sessions, with a per-project breakdown.
 *
 * @param {Session[]} sessions - All sessions to aggregate
 * @param {number}    [topN=10] - How many projects to show in the breakdown
 */
function printStats(sessions, topN = 10) {
  const totalSessions = sessions.length;
  const totalProjects = new Set(sessions.map(s => s.cwd)).size;
  const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0);
  const totalTokens   = sessions.reduce((sum, s) => sum + s.totalTokens, 0);
  const totalCost     = sessions.reduce((sum, s) => sum + s.estimatedCostUSD, 0);

  const costStr = totalCost >= 0.0001
    ? `$${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}`
    : '$0.00';

  console.log(`${BOLD}Overall${R}\n`);
  console.log(`  ${DIM}Sessions${R}   ${CYAN}${BOLD}${totalSessions}${R}`);
  console.log(`  ${DIM}Projects${R}   ${CYAN}${BOLD}${totalProjects}${R}`);
  console.log(`  ${DIM}Messages${R}   ${CYAN}${BOLD}${totalMessages}${R}`);
  console.log(`  ${DIM}Tokens${R}     ${CYAN}${BOLD}${formatTokens(totalTokens)}${R}`);
  console.log(`  ${DIM}Est. cost${R}  ${CYAN}${BOLD}${costStr}${R}`);
  console.log();

  const byProject = {};
  for (const s of sessions) {
    const key = s.cwd || '(unknown)';
    if (!byProject[key]) byProject[key] = { sessions: 0, messages: 0, tokens: 0, cost: 0 };
    byProject[key].sessions++;
    byProject[key].messages += s.messageCount;
    byProject[key].tokens   += s.totalTokens;
    byProject[key].cost     += s.estimatedCostUSD;
  }

  const top = Object.entries(byProject)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, topN);

  console.log(`${BOLD}Top ${top.length} project${top.length !== 1 ? 's' : ''} by token usage${R}\n`);
  for (const [cwd, stats] of top) {
    const pCost = stats.cost >= 0.0001
      ? `~$${stats.cost < 0.01 ? stats.cost.toFixed(4) : stats.cost.toFixed(2)}`
      : '$0.00';
    console.log(`  ${YELLOW}${BOLD}${cwd}${R}`);
    console.log(
      `    ${DIM}${stats.sessions} session${stats.sessions !== 1 ? 's' : ''} · ` +
      `${stats.messages} msg${stats.messages !== 1 ? 's' : ''} · ` +
      `${formatTokens(stats.tokens)} · ${pCost}${R}`
    );
    console.log();
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
      console.error(`${YELLOW}Usage: c-trail resume <number>${R}`);
      process.exit(1);
    }
    process.stdout.write(`${DIM}Scanning sessions...${R} `);
    const sessions = getAllSessions();
    const projectCount = new Set(sessions.map(s => s.cwd)).size;
    console.log(`found ${CYAN}${BOLD}${sessions.length}${R} sessions across ${CYAN}${BOLD}${projectCount}${R} projects.\n`);
    const _n = parseInt(targetId, 10);
    const chosen = (!isNaN(_n) && _n >= 1 && _n <= sessions.length)
      ? sessions[_n - 1]
      : sessions.find(s => s.sessionId === targetId);
    if (!chosen) {
      console.error(`${YELLOW}No session found for "${targetId}". Use --list to see session numbers.${R}`);
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
      console.error(`${YELLOW}Usage: c-trail export <number> [--output <file>]${R}`);
      process.exit(1);
    }
    const outputIdx  = args.indexOf('--output');
    const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : null;

    process.stdout.write(`${DIM}Scanning sessions...${R} `);
    const sessions = getAllSessions();
    const projectCount = new Set(sessions.map(s => s.cwd)).size;
    console.log(`found ${CYAN}${BOLD}${sessions.length}${R} sessions across ${CYAN}${BOLD}${projectCount}${R} projects.\n`);

    const _n = parseInt(targetId, 10);
    const chosen = (!isNaN(_n) && _n >= 1 && _n <= sessions.length)
      ? sessions[_n - 1]
      : sessions.find(s => s.sessionId === targetId);
    if (!chosen) {
      console.error(`${YELLOW}No session found for "${targetId}". Use --list to see session numbers.${R}`);
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

  // c-trail rename <n|id> "title" — give a session a human-readable name
  if (args[0] === 'rename') {
    if (args.length < 3) {
      console.error(`${YELLOW}Usage: c-trail rename <number|session-id> "New title"${R}`);
      process.exit(1);
    }
    const identifier = args[1];
    const newTitle   = args.slice(2).join(' ');

    process.stdout.write(`${DIM}Scanning sessions...${R} `);
    const sessions = getAllSessions();
    const projectCount = new Set(sessions.map(s => s.cwd)).size;
    console.log(`found ${CYAN}${BOLD}${sessions.length}${R} sessions across ${CYAN}${BOLD}${projectCount}${R} projects.\n`);

    const n = parseInt(identifier, 10);
    const chosen = (!isNaN(n) && n >= 1 && n <= sessions.length)
      ? sessions[n - 1]
      : sessions.find(s => s.sessionId === identifier);

    if (!chosen) {
      console.error(`${YELLOW}No session found for "${identifier}". Use --list to see session numbers.${R}`);
      process.exit(1);
    }

    const oldTitle = chosen.customTitle || '(none)';
    renameSession(chosen, newTitle);

    console.log(`${GREEN}Renamed:${R}`);
    console.log(`  ${DIM}From:${R} ${GRAY}${oldTitle}${R}`);
    console.log(`  ${DIM}To:${R}   ${CYAN}${newTitle}${R}`);
    return;
  }

  // c-trail delete <id> — remove a session's .jsonl file after confirmation
  if (args[0] === 'delete') {
    const targetId = args[1];
    if (!targetId) {
      console.error(`${YELLOW}Usage: c-trail delete <number>${R}`);
      process.exit(1);
    }
    process.stdout.write(`${DIM}Scanning sessions...${R} `);
    const sessions = getAllSessions();
    const projectCount = new Set(sessions.map(s => s.cwd)).size;
    console.log(`found ${CYAN}${BOLD}${sessions.length}${R} sessions across ${CYAN}${BOLD}${projectCount}${R} projects.\n`);

    const _n = parseInt(targetId, 10);
    const chosen = (!isNaN(_n) && _n >= 1 && _n <= sessions.length)
      ? sessions[_n - 1]
      : sessions.find(s => s.sessionId === targetId);
    if (!chosen) {
      console.error(`${YELLOW}No session found for "${targetId}". Use --list to see session numbers.${R}`);
      process.exit(1);
    }

    console.log(`${BOLD}Session to delete:${R}`);
    console.log(`  ${DIM}Project${R}    ${YELLOW}${BOLD}${chosen.cwd || '?'}${R}`);
    console.log(`  ${DIM}Date${R}       ${CYAN}${formatDate(chosen.lastActive)}${R}`);
    console.log(`  ${DIM}First msg${R}  ${GRAY}"${(chosen.firstMessage || '(none)').slice(0, 100)}"${R}`);
    console.log(`  ${DIM}File${R}       ${GRAY}${chosen.file}${R}`);
    console.log();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${YELLOW}Delete this session? [y/N]:${R} `, answer => {
      rl.close();
      if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
        fs.unlinkSync(chosen.file);
        console.log(`\n${GREEN}Deleted${R} ${GRAY}${chosen.file}${R}`);
      } else {
        console.log(`${DIM}Aborted.${R}`);
      }
    });
    return;
  }

  // c-trail stats [--top N] — aggregate usage summary across all sessions
  if (args[0] === 'stats') {
    const topIdx = args.indexOf('--top');
    const topN   = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : 10;
    if (topIdx !== -1 && (isNaN(topN) || topN < 1)) {
      console.error(`${YELLOW}--top requires a positive number, e.g. --top 5${R}`);
      process.exit(1);
    }
    process.stdout.write(`${DIM}Scanning sessions...${R} `);
    const sessions = getAllSessions();
    console.log(`found ${CYAN}${BOLD}${sessions.length}${R} sessions.\n`);
    if (sessions.length === 0) { console.log('No sessions found.'); return; }
    printStats(sessions, topN);
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
  const sinceIdx   = args.indexOf('--since');
  const sinceStr   = sinceIdx !== -1 ? args[sinceIdx + 1] : null;
  const beforeIdx  = args.indexOf('--before');
  const beforeStr  = beforeIdx !== -1 ? args[beforeIdx + 1] : null;

  const SORT_OPTIONS = ['active', 'created', 'project', 'messages', 'size'];
  if (!SORT_OPTIONS.includes(sortBy)) {
    console.error(`${YELLOW}--sort must be one of: ${SORT_OPTIONS.join(', ')}${R}`);
    process.exit(1);
  }

  if (recentN !== null && (isNaN(recentN) || recentN < 1)) {
    console.error(`${YELLOW}--recent requires a positive number, e.g. --recent 10${R}`);
    process.exit(1);
  }

  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (sinceStr && !ISO_DATE_RE.test(sinceStr)) {
    console.error(`${YELLOW}--since requires an ISO date (YYYY-MM-DD), e.g. --since 2026-06-01${R}`);
    process.exit(1);
  }
  if (beforeStr && !ISO_DATE_RE.test(beforeStr)) {
    console.error(`${YELLOW}--before requires an ISO date (YYYY-MM-DD), e.g. --before 2026-06-01${R}`);
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

  if (sinceStr) {
    const since = new Date(sinceStr + 'T00:00:00');
    sessions = sessions.filter(s => new Date(s.lastActive) >= since);
    if (sessions.length === 0) { console.log(`${YELLOW}No sessions found on or after ${sinceStr}.${R}`); return; }
    console.log(`Showing ${CYAN}${BOLD}${sessions.length}${R} sessions since ${YELLOW}${sinceStr}${R}.\n`);
  }

  if (beforeStr) {
    const before = new Date(beforeStr + 'T00:00:00');
    before.setDate(before.getDate() + 1); // include the full before date
    sessions = sessions.filter(s => new Date(s.lastActive) < before);
    if (sessions.length === 0) { console.log(`${YELLOW}No sessions found on or before ${beforeStr}.${R}`); return; }
    console.log(`Showing ${CYAN}${BOLD}${sessions.length}${R} sessions before ${YELLOW}${beforeStr}${R}.\n`);
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
