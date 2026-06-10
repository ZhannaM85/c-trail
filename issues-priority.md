# Issues & Priority

## High Priority

### Interactive arrow-key picker
Replace the numbered list with an arrow-key TUI so users can navigate sessions without typing a number.
Candidate: `@inquirer/prompts` (single small dependency).

### Session preview before resuming
Show the first few messages of a conversation before committing to resume — so users can confirm it's the right session.

### Full-text search
`--filter` currently only matches the project directory path and the very first user message.
It should search across all messages in a session.

### `--project` flag
Filter sessions by project name (last segment of the path) rather than the full path.
Example: `c-trail --project my-app`

---

## Medium Priority

### Session stats in list view
Show message count and last-active timestamp per session.
Token count and cost are available in the `.jsonl` files and could be surfaced too.

### Direct resume by session ID
`c-trail resume <session-id>` — skip the picker and jump straight to a known session.

### `--recent <n>` flag
Show only the last N sessions instead of all of them.
Example: `c-trail --recent 20`

### Colors
Highlight dates, paths, and message previews with distinct colors to make scanning easier.

---

## Low Priority

### fzf integration
If `fzf` is available on the system, pipe output through it for fuzzy search and preview as an alternative to the built-in picker.

### Cross-platform verification
Explicit testing on macOS and Linux (expected to work — same `~/.claude/projects/` path — but not yet verified).

### Session export
`c-trail export <session-id>` — dump a session to readable Markdown for sharing or archiving.
