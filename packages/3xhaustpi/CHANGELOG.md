# Changelog

## [Unreleased]

## [0.2.11] - 2026-10-27

### Added

- Added GPT-6.1 Terra to the OpenAI and Codex catalogs with 1.05M context, official reasoning levels, and standard/long-context pricing.
- Added optional conversation `reasoningEffort` with model-aware validation and provider-reported `responseModel`/`reasoningEffort` observations when available.

### Fixed

- Forward explicit conversation reasoning effort through the installed pi-ai adapter to the provider request while preserving stable cache routing and omitted-effort behavior.
- Resolve case-mapped efforts such as Google `LOW` and reject efforts an installed adapter silently replaces or ignores before transport.
- Accept conversation `none` only when the model declares an off level or the request body proves thinking is disabled. Gemini 2.5 Pro, Gemini 3 lowest-level substitutes, Responses models without a declared off level, and Mistral are rejected instead of dispatched with thinking still on.

## [0.2.10] - 2026-10-23

### Fixed

- Send the stable conversation cache key as the Codex `session-id` header. A production probe showed that the same `prompt_cache_key` with a changing per-call session header never hit the cache (0 of 5,614 tokens), while a matching header read 5,376 cached tokens on the second call.

## [0.2.9] - 2026-10-23

### Fixed

- Apply conversation cache affinity at the final Codex payload boundary: the pinned pi-ai 0.84.3 drops `promptCacheKey` and otherwise sends the changing resource session ID as `prompt_cache_key`.
- Preserve explicit zero Codex `cached_tokens` separately from unavailable cache usage. Conversation results include `usage.cacheReadReported`; normalized zero alone remains unknown. Codex conversations use SSE to observe raw usage before pi-ai normalization, retaining stable prompt-cache affinity and per-call resource cleanup. Prepared package/product identity 0.2.9; publishing remains a separate operation.

## [0.2.8] - 2026-10-22

### Added

- Added optional `ConversationInput.promptCacheKey` for stable cache affinity independent of per-call session resource IDs. Omitted keys fall back to `sessionId`; keys use pi-ai's 64-code-point clamp and retain long cache retention.

## [0.2.7] - 2026-10-22

### Added

- Added GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, and GPT-6 Luna for OpenAI and ChatGPT Codex accounts, with 1.05M context, reasoning levels, and long-context pricing.

### Fixed

- Bundled the reviewed GPT-6 model snapshot so installed clients can resolve the new models independently of the pinned pi-ai catalog.

## [0.2.6] - 2026-10-22

### Added

- Added optional conversation usage, pi-ai calculated costs, stop reason, response ID, and response provider/model metadata for downstream embedders. Unknown values remain null; cache counts are reported only when positive because pi-ai normalizes unreported cache counts to zero.

### Changed

- Upgraded the published coding-agent runtime dependency to 1.3.0 and updated vulnerable dependencies and production locks.
- Made model catalog hydration and builds use a validated committed snapshot, with external catalog updates remaining explicit.

### Fixed

- Kept compaction success feedback visible after reloading the transcript with coding-agent 1.3.0.

## [0.2.5] - 2026-09-04

### Fixed

- Closed OpenAI Codex WebSocket resources with their owning agent session so completed prompts exit promptly without sacrificing prompt-cache affinity.
- Accepted an empty OAuth method selection when browser login is explicitly labeled as the default.

## [0.2.4] - 2026-09-02

### Added

- Added one persistent project-scoped Side Chat with isolated history, plus process-local multi-turn BTW that observes a fresh read-only snapshot of active main work.
- Added reviewed `Ctrl+R` promotion from Side Chat and BTW into the durable FIFO main queue, with source-level deduplication and restart-safe persistence.
- Added user-remappable auxiliary controls through `~/.3xhaust/keybindings.json`.

### Changed

- Model settings, autocomplete, and hidden provider selection now expose only models backed by currently enabled logged-in accounts.
- Removed product branding from the normal TUI footer while preserving the tiny-terminal exit affordance.

### Fixed

- Provider error, aborted, empty, missing, and credential-discovery outcomes now produce an assistant response or actionable visible TUI error instead of settling silently.
- Fenced Side Chat completion and termination by active leases, reset BTW history across projects, sanitized auxiliary errors, and canceled pending auxiliary input during close or shutdown.

## [0.2.3] - 2026-08-31

### Added

- Added a service-wide English CI quota policy that optimizes total billed runner minutes while preserving correctness, security, provenance, and required platform coverage.

### Changed

- Bundled service instructions are now mandatory for every native session, with `~/.3xhaust/system-prompt.md` applied afterward as optional user customization.
- `3xhaustpi system-prompt init` now creates a neutral user customization file instead of duplicating the mandatory bundled service prompt.

### Fixed

- Prevented an existing user-global prompt from replacing service-wide harness instructions.

## [0.2.2] - 2026-08-28

### Changed

- Upgraded published Pi AI and coding-agent runtime dependencies from 0.82.1 to 0.84.3 while retaining the compatible TUI contract.

### Fixed

- Removed high-severity `undici` and `brace-expansion` advisories from clean consumer installations.

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
