# Leaderboard data

`scripts/leaderboard.mjs` runs every Monday and writes one JSON and one Markdown file per season here, plus [LEADERBOARD.md](../LEADERBOARD.md) at the top of the repository.

Work that happens off GitHub, like helping a newcomer to their first accepted work or answering questions on Discord, goes in `manual.json`. Maintainers add it by pull request so there's a record:

```json
[
  { "season": "2026-Q4", "login": "github-handle", "points": 5, "reason": "Helped a newcomer to their first accepted work", "link": "https://github.com/..." }
]
```

Add `"studio": "design"` (or another studio) if the points should count on that studio's board too.
