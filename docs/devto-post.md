# I built a global session browser for Claude Code

**Tags:** `ai` `javascript` `opensource` `productivity`

---

If you use Claude Code regularly, you've probably run into this: you start a
conversation in one project, then a week later you want to pick it up — but
`claude --resume` only shows sessions for the directory you're currently in.

Switch projects, lose your history. At least, that's how it feels.

## The sessions are all there

Turns out Claude Code stores every session centrally in `~/.claude/projects/`
— one subdirectory per project, each containing `.jsonl` files. Nothing is
lost. It's just not exposed anywhere useful.

So I built c-trail 🐾 — a CLI tool that reads that directory and gives you a
global view of every session, across every project, from anywhere.

## What it does

```bash
npm install -g c-trail
c-trail
```

An interactive arrow-key picker opens (or fzf if you have it installed),
showing all your sessions sorted by last activity. Navigate with ↑↓, press
Enter to resume. That's it.

There's also:

- **Session preview** — see the first few messages before resuming
- **Full-text search** — `c-trail --filter "auth middleware"` searches across all message text
- **Stats** — message count, token usage, and estimated cost per session
- **Filters** — `--project`, `--recent`, `--since`, `--sort`
- **Export** — `c-trail export <id> --output session.md` dumps a full transcript to Markdown
- **Direct resume** — `c-trail resume <id>` skips the picker entirely

## Zero dependencies

The arrow-key picker is built with Node's built-in `readline` module and ANSI
escape codes — no npm dependencies required. fzf integration is optional and
automatic if fzf is on your PATH.

## Try it

```bash
npm install -g c-trail
```

GitHub: [github.com/ZhannaM85/c-trail](https://github.com/ZhannaM85/c-trail)

Feedback and contributions welcome — there are open issues if you want to jump in.
