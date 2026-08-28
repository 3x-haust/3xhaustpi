# Changelog

## [Unreleased]

## [0.2.1] - 2026-08-28

### Added

- Added an English bundled global system prompt with enterprise architecture, fast risk-based CI, dedicated branch/worktree isolation, and post-merge branch/worktree cleanup policy.
- Added `3xhaustpi system-prompt init` to copy the bundled default into the user data directory for editing.

### Changed

- Missing or whitespace-only user prompts now fall back to the bundled default, while a valid `~/.3xhaust/system-prompt.md` remains the highest-priority global policy.

### Fixed

- Prevented initialization and package updates from overwriting any existing user global prompt.

## [0.2.0] - 2026-08-28

### Breaking Changes

- Removed local `npm login` and `npm publish` CLI commands; releases now require the reviewed Trusted Publishing workflow.

### Added

- Added one bounded `~/.3xhaust/system-prompt.md` across native and semantic sessions, with strict file validation, provider-slot isolation, cache identity, and stale semantic-resume protection.
- Added a cited global-prompt and release-governance design report.

### Changed

- Replaced local npm login/publish guidance with a bounded `release-governance` built-in for protected PR/CI flows and npmjs Trusted Publishing.
- Changed native project `SYSTEM.md` handling only when a global prompt exists so the native base and user-global policy cannot be replaced.

### Fixed

- Fixed external npm installs failing to load because project search imported an unpublished coding-agent package subpath.
- Fixed manual release recovery to verify the requested tag/source/version and safely replace assets on reruns.
- Fixed project snapshots and semantic searches to prefer coding-agent's managed ripgrep binary with a bounded Node fallback.
- Fixed approved file writes on Windows hosts where directory `fsync` reports `EPERM`.
- Fixed existing-file patch replacement and rollback on Windows without overwriting concurrent changes.
- Fixed project diagnostics on Windows by invoking npm through the command interpreter.

## [0.1.10] - 2026-08-26

### Added

- Added durable project-scoped goals with `/goal`, footer, and `/status` integration.
- Added `/btw` for temporary no-tools side questions that do not mutate the active conversation.
- Added `/compact [focus]`, `/review [focus]`, and `/rewind` for conversation compaction, bounded working-tree review, and durable conversation branching.
- Added `/status`, `/settings`, and `/skills` overlays for honest session telemetry, model and integration settings, and installed skill inspection.
- Added provider account management through the CLI and `/account`, including OAuth and API-key login, per-conversation selection, Codex account switching, and confirmed deletion.
- Added durable image pasting with `[imageN]` bindings, bounded composer and transcript previews, mouse and `Ctrl+O` enlargement, and queued/resumed delivery.
- Added project-scoped prompt-cache warming with provider-aware scheduling, foreground/navigation cancellation, and usage-based savings in `/status`.
- Added Up-arrow recall of the newest pending request during active work, including attached images while preserving older FIFO requests.

### Changed

- Replaced `auth login` and `accounts` with the unified `account` command family.
- Consolidated discoverable slash commands around task-level workflows while retaining legacy and internal routes as hidden compatibility aliases.
- Changed `/clear` into a hidden compatibility alias for `/new`; screen redraw remains bound to `Ctrl+L`.
- Changed runtime workers to start per operation and exit after settlement, reopening durable sessions instead of retaining an idle worker.
- Changed context telemetry to show truthful measured usage, selected-model limits, and precise percentages across responsive TUI rails.
- Changed compaction feedback to distinguish estimates from measured context and to report measured context on too-small no-ops.
- Changed prompt and answer spacing to preserve tinted prompt padding and one neutral separator row.
- Changed execution summaries to report separate active and completed nodes and moved durable execution inspection under `/status`.
- Moved computer access, MCP servers, hooks, and related integration controls under `/settings`.

### Fixed

- Fixed context usage remaining visible after starting a new conversation or switching model, provider, project, or conversation scope.
- Fixed repeated large pastes so the second paste expands the compact marker without inserting a duplicate.
- Fixed recalled image drafts so reordered attachment tokens preserve their payloads and new attachments receive the next unused number.
- Fixed approval, overlay, image-viewer, and active-work key ownership so unrelated overlays cannot capture approval actions or interrupts.
- Fixed dynamic work, graph, account, goal, and skill rendering to remove terminal controls and newlines and remain cell-width safe for CJK and narrow terminals.
