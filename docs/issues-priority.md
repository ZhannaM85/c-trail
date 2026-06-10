# Issues Priority List

Issues grouped by implementation tier. Work top-to-bottom within each tier.

---

## Tier 1 — Core UX

| # | Issue | Notes |
|---|-------|-------|
| ~~[#1](https://github.com/ZhannaM85/c-trail/issues/1)~~ | ~~feat: interactive arrow-key picker~~ | ~~Zero dependencies, uses Node built-in readline raw mode~~ |
| ~~[#8](https://github.com/ZhannaM85/c-trail/issues/8)~~ | ~~feat: colors in list output and picker~~ | ~~Cyan dates, yellow paths, gray messages~~ |
| ~~[#2](https://github.com/ZhannaM85/c-trail/issues/2)~~ | ~~feat: session preview before resuming~~ | ~~Shows up to 4 messages below the picker; cached~~ |
| ~~[#7](https://github.com/ZhannaM85/c-trail/issues/7)~~ | ~~feat: `--recent <n>` flag~~ | ~~Limit sessions shown; combines with other flags~~ |
| ~~[#4](https://github.com/ZhannaM85/c-trail/issues/4)~~ | ~~feat: `--project` flag~~ | ~~Filter by last path segment, e.g. `c-trail --project my-app`~~ |

---

## Tier 2 — Search & navigation

| # | Issue | Notes |
|---|-------|-------|
| ~~[#3](https://github.com/ZhannaM85/c-trail/issues/3)~~ | ~~feat: full-text search across all messages~~ | ~~`--filter` currently only matches directory and first message~~ |
| ~~[#6](https://github.com/ZhannaM85/c-trail/issues/6)~~ | ~~feat: direct resume by session ID~~ | ~~`c-trail resume <id>` — skip the picker entirely~~ |

---

## Tier 3 — Stats & insights

| # | Issue | Notes |
|---|-------|-------|
| ~~[#5](https://github.com/ZhannaM85/c-trail/issues/5)~~ | ~~feat: session stats in list view~~ | ~~Message count, cost, token count from `.jsonl` files~~ |

---

## Tier 4 — Export & integrations

| # | Issue | Notes |
|---|-------|-------|
| ~~[#11](https://github.com/ZhannaM85/c-trail/issues/11)~~ | ~~feat: session export to Markdown~~ | ~~`c-trail export <session-id>` — dump session for sharing or archiving~~ |
| ~~[#9](https://github.com/ZhannaM85/c-trail/issues/9)~~ | ~~feat: fzf integration (optional)~~ | ~~Pipe through fzf if available; optional enhancement~~ |

---

## Tier 5 — Platform verification

| # | Issue | Notes |
|---|-------|-------|
| ~~[#10](https://github.com/ZhannaM85/c-trail/issues/10)~~ | ~~chore: cross-platform verification (macOS, Linux)~~ | ~~Expected to work — same `~/.claude/projects/` path — needs confirmation~~ |

---

## Tier 6 — Power user features

| # | Issue | Notes |
|---|-------|-------|
| [#20](https://github.com/ZhannaM85/c-trail/issues/20) | feat: `c-trail stats` — aggregate usage summary | Total sessions, tokens, cost; breakdown by project |
| [#19](https://github.com/ZhannaM85/c-trail/issues/19) | feat: `--since` / `--before` date-range filters | ISO date flags, combinable with existing filters |
| [#21](https://github.com/ZhannaM85/c-trail/issues/21) | feat: inline search in arrow-key picker | Type `/` to filter in real time; Esc to clear |
| [#18](https://github.com/ZhannaM85/c-trail/issues/18) | feat: `c-trail delete <id>` — remove a session file | Prints session details, requires y/yes confirmation |
