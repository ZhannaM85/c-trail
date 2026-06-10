# c-trail 🐾

> Browse and resume your Claude Code session history across all projects — from anywhere.

Claude Code's built-in `--resume` only shows sessions for the directory you're currently in. `c-trail` gives you a global view: every session, every project, in one list.

---

## How it works

Claude Code stores all session data centrally in `~/.claude/projects/` — one subdirectory per project, each containing `.jsonl` session files. `c-trail` reads that directory directly, so it's instant and requires no filesystem scanning.

---

## Installation

```bash
npm install -g c-trail
```

Requires Node.js 14+ and Claude Code CLI. Works on macOS, Linux, and Windows — all platforms where Claude Code stores sessions at `~/.claude/projects/`.

---

## Usage

```bash
c-trail                          # Interactive picker (arrow keys) — choose a session to resume
c-trail --list                   # Print all sessions and exit
c-trail --recent 10              # Show only the 10 most recent sessions
c-trail --filter my-project      # Filter by directory path or first message
c-trail --filter "auth bug"
c-trail --sort active            # Sort by last activity (default)
c-trail --sort created           # Sort by when the session was started
c-trail --sort project           # Sort alphabetically by project path
c-trail --help
```

Flags can be combined freely:

```bash
c-trail --recent 20 --filter my-app --sort created
```

### Interactive picker

Navigate with ↑↓, press Enter to resume, q to quit. Sessions are sorted by last activity by default so your most recent conversations are always at the top.

### Example output

```
Scanning sessions... found 112 across 8 projects.

 ❯ [10 Jun 2026 22:54]  /Users/you/projects/my-app
     "Can you help me refactor the auth middleware?"

   [10 Jun 2026 11:08]  /Users/you/projects/website
     "The deployment is failing, here's the error..."

↑↓ navigate · enter resume · q quit    1/112
```

`c-trail` resumes the session in its original project directory automatically.

---

## License

MIT
