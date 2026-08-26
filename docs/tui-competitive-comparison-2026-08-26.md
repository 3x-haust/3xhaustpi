# 3xhaustPi TUI Competitive Comparison

Date: 2026-08-26

This is the current comparison record for 3xhaustPi against Codex CLI,
Claude Code, Gemini CLI, OpenCode, Pi, Aider, and Cursor CLI. It supersedes the
2026-08-24 feature-presence matrix.

## 1. Result

The current source verifies that 3xhaustPi has:

- durable request admission, FIFO recovery, and generation/lease fencing;
- host-owned mutation review with path, hash, and revision checks;
- restart-durable nested tool/subagent execution state;
- explicit prompt-cache warming and compaction-input serialization controls;
- image-token previews, repeated-paste expansion, and pending-input recall;
- bounded CJK/ANSI-safe terminal rendering with reduced motion.

These are local observations, not universal claims of superiority. Named
competitors remain stronger in live steering, external-editor workflows,
configurable keybindings, scoped permission policy, and dedicated screen-reader
renderers. Full-history transcript search remains a local open gap without a
peer-relative claim.

This audit implemented two user-visible improvements:

1. Empty-composer `Up` during active work recalls the newest queued input for
   editing. The durable row becomes `recalled`, image bindings are restored by
   numeric token identity, and older queued work retains FIFO order.
2. `/status` reads the newest persisted execution graph and presents nested
   agent/tool identity, state, duration, and restart-recovered
   terminal/unfinished state in a bounded scrollable live snapshot.

## 2. Evidence policy

Labels in this file mean:

- **Observed:** exercised in the current build or covered by an executable
  regression.
- **Source-verified:** traced through current source and focused tests.
- **Documented:** stated by a competitor primary source.
- **Different:** both products expose related behavior but with materially
  different semantics.
- **Gap:** the named competitor behavior is not present.
- **Unknown:** public or local evidence is insufficient.

Feature presence is not semantic parity. Durable queueing is not steering,
per-invocation approval is not a persisted permission policy, and
reduced-decoration output is not a dedicated screen-reader renderer.

## 3. Competitor snapshot

| Product | Session model | Input/work model | Controls | Notable documented feature |
| --- | --- | --- | --- | --- |
| Codex CLI [C1-C3] | resume and fork | multiline input, images, in-turn steering, queued follow-up, tools/subagents | slash commands, model/reasoning, sandbox/approval | integrated steering and working-tree review |
| Claude Code [C4-C7] | continue, resume, named sessions | external editor, images, queued-input recall, steering, background tasks | model, permissions, scoped rules | `/btw`, permission scopes, dedicated accessibility mode |
| Gemini CLI [C8-C10] | resume and checkpoints | multiline/file input, tools, MCP, subagents | approval modes and screen-reader setting | broad MCP/tool integration |
| OpenCode [C11-C13] | sessions, undo/redo, export/share, compact | external editor, file references, expandable tools/agents | granular permissions and configurable keys | deep command and transcript controls |
| Pi [C14] | JSONL session tree, resume, tree, fork | external editor, queued-input retrieval, extensible tools | extension-defined controls | minimal extensible session-tree runtime |
| Aider [C15-C16] | save/load and history reconstruction | external editor, multiline, images, vi/Emacs, reverse search | model and settings commands | mature documented terminal editor controls |
| Cursor CLI [C17] | interactive and cloud-agent sessions | terminal/shell-oriented agent work | security and agent-mode controls | editor/cloud-agent integration |
| 3xhaustPi | project resume, generation-fenced new, durable rewind branch | durable FIFO input, newest-input recall, image tokens | model/account/settings overlays and exact per-invocation review | restart-durable operation graph in `/status` |

Commercial binaries and hosted documentation can change independently of this
dated record. Cursor's public documentation exposes less TUI detail than the
open-source products.

## 4. Detailed local comparison

| Dimension | Current 3xhaustPi behavior | Comparison | Exact local evidence |
| --- | --- | --- | --- |
| Resume | project-scoped selection and hydration | Source-verified | `packages/3xhaustpi/test/tui-session-command.test.ts` |
| New conversation | generation-fenced `/new`; hidden `/clear` alias | Source-verified | `packages/3xhaustpi/src/tui-live-session-commands.ts` |
| Branch conversation | `/rewind` persists a branch and preserves the original | Source-verified | `packages/3xhaustpi/test/tui-rewind-command.test.ts` |
| Input while working | Enter creates a durable next task; empty `Up` recalls the newest queued task | Different; Claude and Pi also expose queued-input retrieval [C4][C14] | `packages/3xhaustpi/test/tui-operation-state.test.ts` |
| Live steering | not implemented or advertised | Gap vs Codex, Claude Code, and Pi [C1][C4][C14] | `DESIGN.md` binding contract |
| Tool/subagent graph | nested identities and terminal state persist in SQLite and reopen in `/status` | Observed; competitor durability was not benchmarked | `packages/3xhaustpi/test/tui-status-execution.test.ts` |
| Transcript navigation | detached follow-tail, row/page movement, full-history overlay | Source-verified | `packages/3xhaustpi/test/tui-scroll.test.ts`, `packages/3xhaustpi/test/tui-history-overlay.test.ts` |
| Transcript search | absent from full-history overlay | Source-verified; no peer comparison | `packages/3xhaustpi/src/tui-history-overlay.ts` |
| Command discovery | slash autocomplete, `/help`, pending-recall key hint | Source-verified | `packages/3xhaustpi/test/tui-command-catalog.test.ts`, `packages/3xhaustpi/test/tui.test.ts` |
| Project goal | `/goal` set/show/done/clear persists project intent and surfaces active intent in footer/status | Observed; no peer comparison | `packages/3xhaustpi/test/tui-goal-command.test.ts` |
| External editor | absent | Gap vs Claude, OpenCode, Pi, Aider [C4][C11][C14][C15] | `packages/3xhaustpi/src/tui-composer.ts` |
| Configurable keys | fixed documented bindings | Gap vs Codex, OpenCode, Pi, Aider [C3][C13-C15] | `packages/3xhaustpi/src/tui-composer.ts`, `packages/3xhaustpi/src/tui-layout-frame.ts` |
| Images | resized clipboard payload, `[imageN]`, preview, keyboard enlargement | Source-verified; no universal comparative rank | `packages/3xhaustpi/test/tui-composer-image-interaction.test.ts`, `packages/3xhaustpi/test/tui-composer-image-layout.test.ts`, `packages/3xhaustpi/test/tui-image-preview.test.ts` |
| Repeated text paste | first paste compacts; immediate duplicate expands without duplication | Source-verified | `packages/tui/test/editor.test.ts` |
| Account selection | persisted exclusions, explicit selection, deterministic sticky assignment | Different; no TUI priority/cooldown/availability router | `packages/3xhaustpi/src/account-selection.ts` |
| Per-invocation approval | exact target, hash prefixes backed by full host checks, complete accepted preview or fail-closed block | Different from persisted permission policy | `packages/3xhaustpi/src/tui-approval.ts`, `packages/3xhaustpi/test/agent-approved-tools.test.ts` |
| Persisted permission policy | absent by design | Gap vs Claude/OpenCode [C5][C12] | `DESIGN.md` approval contract |
| Compaction input serializer | strips private reasoning and digests large tool bodies before provider summarization | Source-verified; actual summary quality Unknown | `packages/coding-agent/benchmark/compaction-benchmark.ts`, `packages/coding-agent/test/compaction-benchmark-score.test.ts`, `packages/coding-agent/test/compaction-serialization.test.ts` |
| Prompt-cache warming | project opt-in, bounded wake, savings/status, scope cancellation | Observed; no peer performance comparison | `packages/3xhaustpi/test/cache-warm-controller.test.ts`, `packages/3xhaustpi/test/tui-status-overlay.test.ts` |
| Response telemetry | TPS, provider cache ratio, duration, context, cache-warm savings | Observed; no peer accuracy benchmark | `packages/3xhaustpi/src/tui-activity-state.ts`, `packages/3xhaustpi/test/tui-status-turn-reset.test.ts` |
| Tool-call telemetry | durable per-node duration is visible in `/status` | Observed | `packages/3xhaustpi/test/execution-graph.test.ts`, `packages/3xhaustpi/test/tui-status-execution.test.ts` |
| Side question | `/btw` is bounded, no-tools, and parent-safe | Documented similarity with Claude `/btw`; implementation limits differ [C4] | `packages/3xhaustpi/test/tui-btw-command.test.ts` |
| Working-tree review | bounded Git evidence with post-review staleness detection | Different from Codex integrated review [C1] | `packages/3xhaustpi/test/working-tree-review.test.ts`, `packages/3xhaustpi/test/tui-review-command.test.ts` |
| Worker cleanup | per-operation worker is reaped after settlement | Source-verified; historical RSS figures excluded without a checked receipt | `packages/3xhaustpi/test/tui-runtime-client.test.ts`, `packages/3xhaustpi/test/tui-runtime-worker-protocol.test.ts` |
| Responsive/CJK | bounded layouts and CJK/ANSI cell tests | Observed; no competitor-relative benchmark | `packages/3xhaustpi/test/tui.test.ts`, `packages/3xhaustpi/test/tui-execution-view.test.ts`, `artifacts/tui-competitive-qa-2026-08-26.md` |
| Accessibility | no-color, reduced motion, keyboard operation, reduced-decoration output | Gap vs dedicated Claude/Gemini screen-reader renderers [C7][C10] | `packages/3xhaustpi/src/tui-live-state.ts` |

## 5. Benchmark scope and receipts

### In-process agent-loop tool-call microbenchmark

```bash
npm run benchmark:tools --workspace=@earendil-works/pi-agent-core -- \
  --check --batch-size 64 --warmups 5 --repetitions 30
```

This synthetic benchmark covers TypeBox argument validation, in-process
agent-loop callback dispatch, lifecycle event emission, and returned
in-memory tool-result ordering. It does **not** cover SQLite, the durable TUI
queue, worker IPC, approvals, provider latency, real tools, or downstream I/O.

Two identical-command runs during this audit both passed:

- execution success: 100%;
- contract success: 100%;
- orphaned calls: 0.

Throughput and sub-millisecond latency varied materially between runs and
machines, so they are not preserved here as a durable product comparison. The
command emits per-run p50/p95/p99 and calls/second values.

### Compaction-input serializer microbenchmark

```bash
npm run benchmark:compaction --workspace=@earendil-works/pi-coding-agent -- \
  --check --warmups 5 --repetitions 30
```

Scope:

- one synthetic tool-heavy case;
- six exact substring sentinels;
- character-count divided by four as the token estimate;
- `serializeConversation()` only, before provider summarization.

Both audit runs passed the serializer gates. The case retained all six
sentinels, leaked none of its forbidden strings, and reduced the character/4
estimate by 84.63%. These numbers do not measure provider-produced summary
quality, real tokenizer counts, or post-compaction task success.

### Selected real-provider receipt

The selected receipt is the 2026-07-31 50-pair
`openai-codex/gpt-5.6-terra` acceptance run:

- path: `artifacts/real-llm/paired-1785484534806.json`;
- SHA-256:
  `10c3e7ad49de0329565a5c75e5f8276e763b9bef1b74b570483ecfccbd6fdab1`.

| Metric | Semantic-only arm | Direct-tool arm |
| --- | ---: | ---: |
| Paired successes | 50/50 | 50/50 |
| Tool/capability success | 100% | 100% |
| Warm cache-hit requests | 98% | 100% |
| End-to-end p50 | 3,184.7 ms | 1,591.3 ms |
| End-to-end p95 | 5,949.5 ms | 2,937.7 ms |
| Successful throughput | 16.54/min | 31.56/min |
| Repair / timeout / orphan | 0 / 0 / 0 | 0 / 0 / 0 |

The semantic arm enforces a narrower authority boundary but was materially
slower in this receipt. Security outcomes were not benchmarked. Newer artifacts
exist; this receipt is selected for its documented 50-pair acceptance setup,
not described as the latest run.

### Worker lifecycle measurements

Historical RSS figures remain in the repository README, but this audit did not
find a checked-in raw receipt and reproducible benchmark script for them.
Therefore they are excluded from comparative conclusions here.

## 6. Improvement ranking

| Priority | Improvement | State |
| ---: | --- | --- |
| 1 | Recall newest pending input with image identity and FIFO preservation | Implemented |
| 2 | Durable nested execution graph in discoverable `/status` | Implemented |
| 3 | Search inside full history | Open |
| 4 | External editor handoff | Open |
| 5 | Deliberate retry/restore after failed work | Open |
| 6 | Dedicated session picker surface | Open |
| 7 | Configurable keybindings | Open |
| 8 | Scoped permission policy runtime | Open; requires policy design |
| 9 | True live steering | Open; requires protocol work |

## 7. Current verification contract

This comparison remains current only when:

- every local row names exact source/tests;
- competitor claims map to a primary source below;
- local benchmark commands pass their limited `--check` gates;
- UI changes pass fresh real-PTY visual QA;
- actual-provider, synthetic microbenchmark, and source-only evidence remain
  explicitly distinct;
- historical matrices remain marked superseded.

The fresh real-PTY interaction and visual evidence for this change is recorded
in `artifacts/tui-competitive-qa-2026-08-26.md`.

## 8. Primary sources

- **C1** Codex CLI: <https://developers.openai.com/codex/cli/>
- **C2** Codex features: <https://developers.openai.com/codex/cli/features/>
- **C3** Codex slash commands:
  <https://developers.openai.com/codex/cli/slash-commands/>
- **C4** Claude Code interactive mode:
  <https://code.claude.com/docs/en/interactive-mode>
- **C5** Claude Code permissions:
  <https://code.claude.com/docs/en/permissions>
- **C6** Claude Code subagents:
  <https://code.claude.com/docs/en/sub-agents>
- **C7** Claude Code accessibility:
  <https://code.claude.com/docs/en/accessibility>
- **C8** Gemini CLI commands:
  <https://geminicli.com/docs/reference/commands>
- **C9** Gemini CLI checkpointing:
  <https://geminicli.com/docs/cli/checkpointing/>
- **C10** Gemini CLI settings (`ui.accessibility.screenReader`):
  <https://geminicli.com/docs/cli/settings/>
- **C11** OpenCode TUI: <https://opencode.ai/docs/tui/>
- **C12** OpenCode permissions: <https://opencode.ai/docs/permissions/>
- **C13** OpenCode keybindings: <https://opencode.ai/docs/keybinds/>
- **C14** Pi coding-agent pinned source:
  <https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/README.md>
- **C15** Aider commands: <https://aider.chat/docs/usage/commands.html>
- **C16** Aider prompt caching: <https://aider.chat/docs/usage/caching.html>
- **C17** Cursor CLI: <https://cursor.com/docs/cli/overview>

Pinned revisions used where they resolved during the research pass:

- Codex `25a6e316c81fb7600d1d75f3e63ffe26be10b7c8`
- Claude Code `005c5dade90c2c59c88d819d8723e7b579addb5e`
- Gemini CLI `64b5b79a6dd89ea96e65cb761c23aae6c0b33ce4`
- OpenCode `fd9bd448a2e68990e7aed3495e5590cecb934bfb`
- Pi `8fa7eebd235355522c8104166b4f1f959b4e2f10`
