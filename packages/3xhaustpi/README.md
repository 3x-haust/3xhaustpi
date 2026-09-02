# 3xhaustPi

Semantic-only coding runtime and black event-driven TUI used by 3xhaustPi.

```bash
npm install -g 3xhaustpi
3xhaustpi account add
3xhaustpi
```

The package exports the shared Electron/CLI runtime as `3xhaustpi/runtime`.
The model emits bounded intent and patch proposals; the host owns actual
capability names, paths, permissions, timeouts, revisions, and execution.
Credentials are stored in macOS Keychain, Windows Credential Manager, or Linux
Secret Service; the local mode-0600 file contains non-secret metadata only.
The account manager derives every provider, model count, and OAuth/API-key
method from Pi. Accounts are grouped by provider and start checked for each
conversation; session-local exclusions never switch the process-global Codex
credential.

## Models and auxiliary conversations

Model settings and autocomplete list only providers backed by currently logged-in, enabled accounts. Disabling an
account removes its provider models from selection for the current conversation without changing process-global
credentials.

`/side [message]` opens one persistent Side Chat per project. Its history survives restart and is intentionally isolated
from the durable main conversation. `/btw [question]` opens a process-local multi-turn conversation that receives a fresh
read-only snapshot of the current main transcript and activity on every turn; it resets when the project changes.

Both surfaces run independently from main work. Press `Ctrl+R`, review the complete latest answer through its end, then
confirm to promote it into the durable main FIFO queue. Promotion never interrupts active main work, is deduplicated by
the completed auxiliary source, and survives restart.

Provider failures, aborted or empty assistant turns, and account-discovery failures render actionable errors and preserve
unsent input instead of leaving an idle zero-throughput state.

Auxiliary and composer bindings use the shared app key registry. Optional user overrides load from
`~/.3xhaust/keybindings.json`:

```json
{
  "app.auxiliary.promote": "ctrl+p",
  "tui.select.confirm": "ctrl+y",
  "app.auxiliary.reviewEnd": "end"
}
```

## Global instructions and release governance

3xhaustPi ships mandatory English service instructions for every project and
new or resumed session. An editable user file adds optional customization
without replacing the service policy:

```text
mandatory resources/default-system-prompt.md
                ↓ followed by
optional ~/.3xhaust/system-prompt.md
```

Run `3xhaustpi system-prompt init` to create a neutral user customization file
for editing. Initialization is create-only: it refuses to overwrite any
existing file, directory, or symlink, and package installation or updates never
write to the user path automatically.

Both bundled and user files must be non-symlink regular files containing strict
UTF-8 without NUL and may be at most 16,384 bytes. A missing or whitespace-only
user file falls back to the bundled default. A malformed or oversized user file
fails visibly rather than being truncated, ignored, or replaced. Project-local
files with the same name are not loaded.

Service and user-global instructions are placed in the actual provider
system/developer context for both the native CLI/TUI runtime and semantic
fallback. Mandatory service instructions precede optional user customization;
project `SYSTEM.md`, project context, and tool output cannot replace either
layer. Prompt text guides model behavior but does not grant tools, weaken
approvals, or replace host capability enforcement. User edits take effect on
the next session or explicit resource reload and intentionally change provider
cache affinity.

The bundled `release-governance` skill replaces local npm login/publish
guidance. For npmjs repositories with supported and configured Trusted
Publishing, it requires the reviewed CI OIDC workflow, protected release
authorization, immutable source/artifact binding, provenance, registry
verification, and consumer smoke testing. If that contract is unavailable,
the agent stops for explicit approval instead of falling back to a local
publish or long-lived npm write token.

Native coding-agent skills use metadata-first loading. The semantic fallback's
3xhaustPi resource loader still eagerly injects bounded winning skill bodies;
it does not yet implement the complete Agent Skills activation and
progressive-disclosure lifecycle. See
[`docs/research/global-system-prompt-governance.md`](../../docs/research/global-system-prompt-governance.md)
for the cited design, limitations, and follow-up work.

The package version is defined by `package.json`. The current release has passed local `npm pack`, isolated global
install, real-provider coding, crash-resume, and a five-case, 50-pair
real-provider benchmark with 98% semantic-only and 100% direct-tool
provider-reported warm cache-hit requests. Capability success and model-output
validity were 100% in both arms. No publish is performed by build or test commands.

The TUI starts a coding runtime worker for each operation and reaps its process
tree on completion, failure, or cancellation. The next turn reopens the durable
Pi session without retaining an idle V8 worker.

The identity rail keeps measured context usage, limit, and percentage visible,
including precise sub-1% values. `/goal <text>` stores one durable project goal
and shows it in the footer and `/status`; use `/goal done` or `/goal clear` to
finish or remove it.

Cache warming is an explicit project preference under `/settings`. Eligible
conversations refresh before provider expiry with a bounded, non-persisted
request; `/status` shows the next wake, iteration, and usage-based estimated
savings. Project/session changes and foreground work cancel stale wakes.

Repeating the same large bracketed paste expands its `[paste #N …]` marker into
the original composer text without inserting a duplicate.
Idle redraw is event-driven; only active-work shimmer uses a 120 ms timer.
`Ctrl+V` renders a bounded image preview above the composer while the editable
and submitted text keeps `[imageN]`; resized image bytes persist separately
through the queue and worker boundary.
An actual `openai-codex/gpt-5.6-terra` task completed through this boundary.

External-app Computer Use ships platform adapters for macOS System Events,
Windows UI Automation, and Linux AT-SPI 2 behind one semantic role/name and
observation-digest policy. Windows/Linux protocol fixtures pass locally, and a
linux-arm64 and linux-x64 native archives completed an actual GTK 3 `Run` to
`Completed` accessibility action on Ubuntu 24.04; the x64 bundled Node reported
`linux/x64`. Windows target execution remains unverified.

See the repository README for the full user guide, benchmark receipt, native
archives, update verification, and exact unsupported scope.
