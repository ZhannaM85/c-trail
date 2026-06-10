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

Requires Node.js 14+ and Claude Code CLI.

---

## Usage

```bash
c-trail                        # Interactive picker — choose a session to resume
c-trail --list                 # List all sessions without resuming
c-trail --filter my-project    # Filter by directory path or first message
c-trail --filter "auth bug"
c-trail --help
```

### Example output

```
Scanning sessions... found 112 across 8 projects.

  1. [10 Jun 2026 22:54]  /Users/you/projects/my-app
     "Can you help me refactor the auth middleware?"

  2. [10 Jun 2026 11:08]  /Users/you/projects/website
     "The deployment is failing, here's the error..."

Enter number to resume (or q to quit):
```

Pick a number — `c-trail` resumes that session in its original project directory automatically.

---

## License

MIT
