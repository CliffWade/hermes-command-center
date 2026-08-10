# Changelog

All notable changes to Hermes Command Center.

## [1.0.0] - 2026-08-10

### Added

- **10 tabs** — Overview, Activity, Usage, Tools, Cron, Plugins, Models, Skills, Memory, System
- **Overview** — live health score (100 minus honest penalties) with hover breakdown, running backends, tokens (24h), cache efficiency, real errors, memory, gateway status, recent-error viewer with copy buttons, active processes
- **Activity** — full-text session search (FTS5 with snippets), activity heatmap (24-hour grid + 7-day strip, pastel rainbow scale), recent sessions grouped by source, background tasks (delegations + deliveries)
- **Usage** — live OpenRouter balance (total/used/remaining), per-provider token and cost breakdown, FAL.ai image generation tracking, any provider Hermes bills appears automatically
- **Tools** — ranked tool usage from message records with per-tool color identity
- **Cron** — every scheduled job as a card (schedule, model, next run), execution history with real job names and durations
- **Plugins** — backend + desktop plugin cards with versions, API status, sizes
- **Models** — token burn by model, daily 15-day trend, tokens by task, top sessions
- **Skills** — ranked skill usage with medals and state badges
- **Memory** — per-file fill (MEMORY.md / USER.md), fact store, health guidance
- **System** — storage breakdown, active config (provider/model/skin/cwd), environment, update checker (release-date comparison, no false positives)

### Fixed

- Update checker compared semver against date-version tags and always reported an update — now compares release-date forms and only flags genuinely newer releases
- Health score counted routine WARNINGs (check_fn gating, PAID-lane notices) as errors — now counts only real ERROR/CRITICAL lines; memory headroom checks per-file limits
- FAL.ai balance has no public API — usage shown from local image-studio history instead of faking a balance
- Route collision with the built-in Command Center — plugin lives at `/hermes-center`

### Changed

- Renamed to **Hermes Command Center** (route stays `/hermes-center` to avoid the built-in collision)
- Card-grid layout on every tab — no stretched full-width rows
- Readability pass: all small data text bumped to readable contrast, theme-safe colors on pastel heatmap cells
- MIT licensed
