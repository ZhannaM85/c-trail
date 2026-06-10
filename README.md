# c-trail 🐾

[![npm version](https://img.shields.io/npm/v/c-trail.svg)](https://www.npmjs.com/package/c-trail)
[![license](https://img.shields.io/npm/l/c-trail.svg)](LICENSE)

> Browse and resume your Claude Code session history across all projects — from anywhere.

Claude Code's built-in `--resume` only shows sessions for the directory you're currently in. `c-trail` gives you a global view: every session, every project, in one list.

![demo](https://github.com/user-attachments/assets/64240f85-c9c9-470c-a73a-625f215d2b73)

---

## How it works

Claude Code stores all session data centrally in `~/.claude/projects/` — one subdirectory per project, each containing `.jsonl` session files. `c-trail` reads that directory directly, so it's instant and requires no filesystem scanning.

---

## Installation

```bash
npm install -g c-trail
```

Requires Node.js 14+ and Claude Code CLI. Works on macOS, Linux, and Windows.

---

## Usage

```bash
c-trail                          # Interactive picker — choose a session to resume
c-trail resume <id>              # Resume a specific session by ID (skip the picker)
c-trail export <id>              # Export a session to Markdown (stdout)
c-trail export <id> --output session.md  # Save exported Markdown to a file

c-trail --list                   # Print all sessions and exit
c-trail --recent 10              # Show only the 10 most recent sessions
c-trail --filter my-project      # Filter by directory path or any message text
c-trail --filter "auth bug"
c-trail --project my-app         # Filter by project name (last folder in path)

c-trail --sort active            # Sort by last activity (default)
c-trail --sort created           # Sort by when the session was started
c-trail --sort project           # Sort alphabetically by project path
c-trail --sort messages          # Sort by number of messages (longest first)
c-trail --sort size              # Sort by file size (largest first)

c-trail --no-fzf                 # Use arrow-key picker even if fzf is installed
c-trail --help
```

Flags can be combined freely:

```bash
c-trail --recent 20 --filter my-app --sort created
```

### Interactive picker

If [fzf](https://github.com/junegunn/fzf) is installed, `c-trail` uses it automatically for fuzzy search with a live preview panel. Otherwise it falls back to a built-in arrow-key picker (zero dependencies).

Navigate with ↑↓, press Enter to resume, q to quit. Sessions are sorted by last activity by default so your most recent conversations are always at the top.

### Session stats

Each session shows message count, total token usage, and an estimated cost:

```
 ❯ [11 Jun 2026 10:42]  /Users/you/projects/my-app
     "Can you help me refactor the auth middleware?"  [24 msgs · 120K tok · ~$0.48]
```

### Export to Markdown

```bash
c-trail export abc123 --output session.md
```

Produces a full transcript with metadata header — useful for sharing, archiving, or piping into other tools.

### Example output

```
Scanning sessions... found 112 sessions across 8 projects.

 ❯ [11 Jun 2026 10:42]  /Users/you/projects/my-app
     "Can you help me refactor the auth middleware?"  [24 msgs · 120K tok · ~$0.48]

   [10 Jun 2026 11:08]  /Users/you/projects/website
     "The deployment is failing, here's the error..."  [8 msgs]

↑↓ navigate · enter resume · q quit    1/112
```

`c-trail` resumes the session in its original project directory automatically.

---

## License

MIT · Made by [ZhannaM85](https://github.com/ZhannaM85)
