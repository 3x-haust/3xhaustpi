# 3xhaustPi Native TUI Design System

## 1. Atmosphere & Identity

3xhaustPi should feel like a quiet, precise instrument: native to the terminal,
fast to scan, and calm under heavy agent activity. It is neither a dashboard
made of boxes nor a decorative chatbot.

- Product identity: `3xhaustPi`
- Voice: concise, direct, operational
- Signature: a cool blue-violet accent used sparingly for focus and active work
- Hierarchy: prompt surface first, text luminance second, semantic color last
- Shape language: full-width prompt bands, open prose, and a double-rule composer shell
- Density: transcript-first with progressive disclosure at narrow widths

## 2. Color

### Palette

| Token | ANSI 256 | Role |
| --- | ---: | --- |
| `accent` | 111 | focus, active model, assistant identity |
| `text-primary` | 255 | user content and essential labels |
| `text-secondary` | 250 | metadata that remains readable |
| `text-muted` | 245 | secondary hints and inactive segments |
| `text-ghost` | 239 | separators and lowest-priority structure |
| `prompt-surface` | 238 | full-width submitted user prompt band |
| `success` | 114 | completed state |
| `warning` | 214 | approval and paused state |
| `failure` | 203 | failed state |
| `info` | 117 | informational and pending state |
| `disabled` | 242 | unavailable controls and missing metadata |
| `path` | 150 | file paths and navigable resources |
| `diff-add` | 114 | added diff lines |
| `diff-remove` | 203 | removed diff lines |
| `selection` | reverse video | focused picker row |

### Rules

- Color never carries state alone; every state also has a symbol or word.
- The accent appears in at most one dominant location per row.
- Transcript prose stays primary/secondary neutral for long-read comfort.
- Separators are always lower contrast than the content they organize.
- ANSI resets must survive clipping and wrapping.
- `NO_COLOR` and monochrome terminals retain the same symbols, labels, rails,
  and reverse-video selection; only semantic hues disappear.
- When prompt tint is unavailable, submitted user rows use a leading `>` role
  marker and collapse decorative prompt padding.
- On 16-color terminals, accent/info map to cyan, success/diff-add to green,
  warning to yellow, and failure/diff-remove to red.
- Focus uses reverse video plus a leading marker; active-but-unfocused state
  uses accent text without reverse video.

## 3. Typography

### Scale

The terminal font is user-controlled. Hierarchy uses weight-by-luminance,
symbols, casing, and spacing rather than font-size changes.

| Level | Treatment | Use |
| --- | --- | --- |
| Product | bright label plus subtle accent mark | shell identity |
| Primary | `text-primary` | user and assistant content |
| Secondary | `text-secondary` | model, project, command labels |
| Metadata | `text-muted` | duration, context, provider, hints |
| Structural | `text-ghost` | rails, dividers, continuation marks |

### Font Stack

The active terminal monospace font. All width decisions use terminal cell
width, never JavaScript string length.

### Rules

- Preserve grapheme clusters, CJK double-width cells, emoji, combining marks,
  tabs, and ANSI sequences.
- Avoid all-caps labels except compact machine states.
- Keep labels short enough to remain intact at 56 columns.
- Wrap prose; truncate low-priority metadata; never split command tokens.

## 4. Spacing & Layout

### Base Unit

One terminal cell horizontally and one terminal row vertically.

### Grid

The root uses one vertical shell:

1. **Transcript:** owns all remaining vertical space and scrolls/reflows.
2. **Activity:** fixed, one row.
3. **Composer:** fixed, a top rule, the `>` input row, and a bottom rule;
   autocomplete reserves its own bounded rows.
4. **Context title:** fixed, one quiet row below the composer.
5. **Identity:** fixed, one product/workspace row at the shell bottom.

### Responsive Modes

| Mode | Width | Policy |
| --- | ---: | --- |
| `degraded` | `< 40` or `< 10 rows` | bounded title, transcript, activity, and composer |
| `minimal` | `40–55` | one-row prompt bands, unlabeled answer, activity |
| `compact` | `56–79` | tinted prompt bands, answer flow, activity |
| `full` | `80–119` | wider answer measure and response metrics |
| `wide` | `>= 120` | three-row prompt bands and complete response metrics |

Height is also a first-class constraint:

- Optional response metadata collapses before transcript, activity, or composer.
- Autocomplete rows are subtracted from transcript budget.
- Physical terminal width and height are hard limits; no synthetic minimum may
  emit outside them.
- Transcript may fall to one row only when essential fixed chrome consumes the
  rest.
- Supported physical floor is `20x8`. Below it, emit at most the physical rows
  and columns with an adaptively shortened `3xhaustPi` terminal-size warning,
  `/exit`, and no picker.
- Validation matrix: `20x8`, `32x10`, `40x12`, `56x22`, `72x24`, `80x24`,
  and `120x32`.

### Rules

- The transcript is the sole vertical scroll owner.
- Context title, composer, and active state remain visible during interaction.
- Empty space is intentional breathing room, not filled with permanent panels.
- A focused picker is bounded to at most 40% of terminal height.

### Shared Layout Contract

One pure layout function owns static and live rendering. Given physical columns,
rows, editor rows, and overlay rows, it returns:

- density mode
- visible rail set
- exact chrome row count
- transcript row budget
- segment variants selected for each rail
- degraded-state decision

No renderer may invent a separate width floor, height floor, footer candidate,
or transcript budget.

### Responsive Surface Table

| Surface | Wide/full | Compact | Minimal/degraded |
| --- | --- | --- | --- |
| title | product, project, model | product and project | product |
| user prompt | empty tint row, content, empty tint row, neutral separator row | empty tint row, content, empty tint row, neutral separator row | content row only |
| thought | duration and work summary | duration | hide before answer |
| answer | readable capped measure | terminal measure | terminal measure |
| metrics | throughput, cache, duration | throughput, cache, duration when they fit | duration |
| activity | state, target, interrupt key | state and target | state |
| composer | top rule plus `>` input | same | same |

## 5. Components

### Identity Rail

- One product label only: no duplicated `3xhaustPi` project name.
- Owns only product and workspace identity.
- Anchors the final shell row below the context title and composer.
- Full/compact: `(😺 3xhaustPi Native) project`
- Minimal: `3xhaustPi`
- Model and run state never repeat here.

### Transcript Feed

- Semantic roles: `prompt`, `work`, `answer`, `system`.
- Submitted prompts are full-width `prompt-surface` bands. The surface, not a
  speaker name, identifies the user role. `You`, `User`, `3xhaust`, and generic
  assistant labels never render.
- Wide and compact prompt bands use symmetric empty tinted rows above and below
  the prompt, followed by one neutral terminal-background separator. Minimal
  and degraded modes may collapse these rows before content.
- Wide and compact assistant output uses one terminal-background row above and
  below bright answer prose. Minimal output may collapse the leading row.
- Prompt bottom padding remains tinted and is followed by one neutral separator
  before pending work or an answer.
- Every repeated prompt preserves its tinted top padding; the preceding
  assistant relinquishes its neutral trailing margin instead.
- Prompt, durable work, answer, and response telemetry bodies use the same
  one-row semantic boundary. Work rows never touch answer prose, and telemetry
  never touches the final answer body.
- Leading and trailing newlines in persisted message text are normalized before
  card margins are added, so message payload whitespace cannot double a boundary.
- Runtime telemetry stays in the idle activity row and never enters the
  conversation transcript.
- Answer prose owns the widest readable measure. Repeated labels, side rails,
  and chat bubbles are forbidden.
- System messages are quieter than conversation and have no repeated `system`
  label. A compact notice marker may introduce durable notices, but startup,
  restored-queue counts, resumable-session state, and transient progress belong
  to activity/status rather than the chat transcript.
- Completed work rows show state, capability, duration, and summary without an
  assistant header or execution-tree rail.
- Raw output emitted into the transcript is bounded and exposes omitted-line
  counts. Interactive expansion is not part of this redesign.
- Newest content remains visible; persisted order stays deterministic.

#### Response Flow

3xhaustPi's transcript grammar is:

```text
[full-width tinted user prompt]

✓ capability · duration · summary

Bright assistant answer with no speaker label.

TPS 15.8 tok/s. Cache hit 99.6%, 4.5s
```

- Prompt tint is the only large-area surface in the transcript.
- Runtime telemetry stays out of the conversation transcript.
- Durable work results may appear before the answer; transient progress stays in
  the activity row.

#### Row Templates

| Event | Durable transcript form |
| --- | --- |
| user message | full-width tinted prompt band, no speaker label |
| model completed | no transcript row; telemetry updates the idle activity row |
| assistant streaming | bright unlabeled partial prose updated in place |
| assistant complete | bright unlabeled prose |
| tool pending/running | muted work row with explicit verb and state |
| tool success | muted `✓ capability · duration · summary` |
| tool failure | failure `× capability · duration · summary` |
| tool cancelled | muted `– cancelled` |
| tool truncated | result row plus `… N lines omitted` |
| agent queued/active | emphasized work summary without a role rail |
| agent blocked/failed | warning/failure summary |
| approval | review row naming the originating patch/tool and accepted keys |
| system notice | low-contrast `· message`, only for durable user-relevant notices |
| error | `error │ message` with failure symbol |

Work rows show state, capability, key argument, duration, and summary. Attached
output is capped at 100 lines and ends with an omitted-line count.

#### Scroll Contract

- Follow-tail is the default.
- With an empty composer and no picker, `PageUp`/`PageDown` move by one
  transcript viewport and `Alt+Up`/`Alt+Down` move one transcript row.
- `Alt+End` returns to latest output.
- When output arrives while detached, preserve scroll position and show
  `↓ N new` in the activity row.
- Submitting a new user message returns to follow-tail.
- Copy/selection remains terminal-native and never forces follow-tail.
- Picker input always wins. A non-empty or multiline composer always wins over
  transcript navigation. No global transcript key consumes an editor key while
  the editor has content.

### Activity Row

- Lives immediately above the composer.
- Owns current ephemeral execution state; no other rail repeats it.
- Ready before the first response: blank; command discovery stays behind `/help`.
- Ready after a response: measured `TPS`, cache-hit ratio, and duration.
- Running: `• Working (<detail> · esc to interrupt)`, never spinner-only. A
  grayscale shimmer sweeps only this activity text while work is active.
- Review: approval action and key choices.
- Pending input: visible only while a human entry awaits delivery; internal
  checkpoint/request queue state never appears here.
- Detached scroll: new-output count and return-to-latest key.

#### Concurrent Activity Arbitration

The single row resolves simultaneous state in this order:

1. approval/review request
2. foreground failure or cancellation event
3. current foreground capability
4. active agents/tools aggregate
5. pending user input
6. latest response telemetry, otherwise blank

Within one priority, show the latest foreground target. A completion immediately
selects the next active sibling; it never leaves a stale target.

### Composer

- Always visually focused with a leading `>`.
- Empty state is an unlabeled hardware cursor, matching a native shell prompt.
- `/` opens command discovery; command and model tokens remain intact.
- Matching full-width rules above and below the input create a stable
  double-rule shell. There is no decorative side rail.
- It grows to a bounded multiline height, then owns internal scroll.
- Up/Down navigate wrapped composer rows before prompt history.
- External editor integration handles long input.
- Draft survives picker dismissal, interruption, session-picker cancellation,
  and recoverable errors.

### Command / Model Picker

- Uses the existing `showOverlay()` compositor with a bounded overlay contract;
  it does not consume transcript rows.
- Searchable, keyboard-first, active selection obvious.
- Keeps transcript, context title, and composer stable.
- Model changes are visibly session-scoped.
- Captures focus while open; `Escape` restores composer focus.
- Maximum width is `min(76, terminal - 4)` and maximum height is 40% of terminal
  rows. At degraded dimensions it falls back to compact in-flow results.

### Response Metrics

- Metrics occupy the idle activity row instead of the conversation transcript.
- TPS and duration use the sum of assistant `message_start` → `message_end`
  intervals. Tool execution and idle queue time are excluded.
- Cache hit uses provider-reported input semantics:
  `cacheRead / (uncachedInput + cacheRead)`. Newly appended suffix tokens are
  therefore counted as uncached input instead of being hidden by a session
  high-water mark. Cold turns omit the cache field instead of displaying a
  meaningless `0.0%`.
- Full/wide: throughput, cache-hit ratio, and duration when measured.
- Compact: throughput, cache-hit ratio, and duration remain together when the
  complete line fits; lower-priority segments collapse only on overflow.
- Minimal/degraded: duration only.
- Missing measurements disappear; the UI never invents telemetry.

### State Ownership Matrix

| Runtime state | Transcript | Activity | Composer | Status | Accepted keys / transition |
| --- | --- | --- | --- | --- | --- |
| ready | none | latest response telemetry or blank | enabled | none | text submits; `/` opens picker |
| waiting for model | none | `• Working` | pending input enabled | none | `Esc` interrupts; empty-composer `Ctrl+C` interrupts |
| assistant streaming | unlabeled answer row | `• Working` | pending input enabled | metrics appear when idle | `Esc` preserves pending input and completed output |
| tool running | muted work row | verb + capability | pending input enabled | none | pending input waits for safe delivery |
| agent active | named state row | owner + action | pending input enabled when parent-owned | none | navigate owner or wait |
| approval requested | actor/action plus scrollable preview | explicit subject + labeled scope choices | disabled | warning health | approval surface; `Esc` safe reject |
| pending input | no duplicate transcript row | pending delivery count while pending | enabled | none | recall/edit/remove |
| cancelled | durable canceled/incomplete row | canceled until deliberate action | restored pending input | none | retry, edit, or new input |
| failed | durable cause/incomplete row | retry reason/attempt or fatal state | enabled when safe | none | retry, inspect, or new input |
| recoverable checkpoint | no pause fiction | recovery notice only when action is required | enabled for commands | none | automatic recovery or explicit repair |
| provider unavailable | system/error row | explicit provider issue | enabled for commands | none | `/model`, `/accounts` |
| context warning/critical | no duplicate prose | warning in activity only at critical | enabled | none | `/new`, `/clear` |
| no models/no matches | picker empty state | unchanged | picker owns input | none | edit query or `Esc` |
| transcript detached | durable feed unchanged | `↓ N new · Alt+End latest` | enabled | none | transcript keys only when composer empty |

An event has one primary surface. Durable conversation facts go to the
transcript; measured response telemetry and ephemeral work go to activity.

The transcript remains compact. `/agents [n]` exposes a durable read-only
execution projection for the latest or selected operation, with real
tool/subagent identities, hierarchy, state, measured duration, and failure
summary. It never invents nodes from prose or animation state.

## 6. Motion & Interaction

### Timing

Terminal rendering remains event-driven except for one state-signaling motion:
active work advances one `text-primary` glyph every 120 ms across otherwise
`disabled` gray text. The highlight skips whitespace, so exactly one visible
white glyph is present in every frame. It never changes glyphs, width, or row
ownership. Timer-only redraws retain the current capability/detail text until
an exact completion or state transition clears it.

### Rules

- Differential redraws must not scroll fixed chrome.
- Running work uses a subtle grayscale text shimmer only alongside the explicit
  `Working` state. It stops immediately when no foreground work remains.
- `NO_COLOR`, `TERM=dumb`, or `REDUCE_MOTION=1` renders the same complete
  `Working` text statically with no timer.
- Completed, failed, and approval states update immediately on exact events.
- `Ctrl+C` clears a non-empty composer. With an empty composer it aborts active
  work, reaps the runtime worker, and exits in one keypress with code 0.
- `/exit` performs the same deterministic shutdown.
- `Escape` closes a picker or rejects the currently focused transient surface;
  it never silently exits.
- Composer owns default focus. Pickers temporarily capture focus and restore it
  on dismissal. Transcript navigation is global and does not become a fake
  focusable control.
- Streaming and partial output remain readable after cancellation.
- Cancellation and failure have no timed acknowledgement. Their durable row is
  appended synchronously, then activity transitions to `ready` in the same
  completion/failure event after active handles clear.

### Response Width Rules

- Wide/full: prompt bands span the terminal; answer prose remains capped to a
  readable measure; complete response metrics may share one row.
- Compact: prompt tint remains full width; complete response metrics remain
  together when they fit and collapse only before wrapping.
- Minimal: prompt band keeps content only; answer remains unlabeled.
- Degraded: prompt tint may flatten to one row but roles remain distinguishable.
- Continuation prose aligns to the answer gutter without a role label.
- Capability names remain atomic and middle-ellipsize before wrapping.
- Work summaries wrap only in full/wide modes and remain CJK/ANSI cell-safe.

## 7. Depth & Surface

### Strategy

Depth comes from luminance and containment, not nested boxes:

- primary shell: terminal background
- submitted prompts: one full-width slate surface
- assistant flow: luminance hierarchy on the terminal background
- active picker: bounded higher-contrast surface
- approval/error: semantic accent plus explicit text
- separators: one-cell ghost rules

No gradients, shadows, rounded-card imitation, or decorative emoji clusters.
The single cat glyph in the product identity is the fixed brand mark, not a
general-purpose icon or decorative cluster.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Every rendered line fits its physical terminal width.
- Every live root layout fits terminal height at tested sizes.
- CJK, emoji, combining characters, ANSI, and unbroken strings remain safe.
- State is conveyed by text/symbol as well as color.
- Essential controls remain visible at 56x22, 72x24, and 120x32.
- Narrow mode preserves model/activity access through commands even when
  persistent metadata is hidden.
- Command tokens and key hints never wrap mid-token.
- Keyboard-only use is complete; no mouse-only action exists.
- Visual QA uses true PTY screen state, not flattened differential logs.
- Final QA covers both spawn-at-size and live resize at `19x7`, `20x8`,
  `40x10`, `56x12`, `80x24`, and `120x36`.
- Approval actions, composer, activity, and at least one transcript row are
  reserved before identity, cwd, provider/model detail, or metrics.
- Every logical activity, rule, and approval-action row is cell-clipped before
  layout and occupies exactly one physical row.
- CJK grapheme width is not treated as IME proof. Candidate `Esc`/`Enter` is
  consumed by composition before application shortcuts; bracketed and per-byte
  paste preserve UTF-8.
- Every advertised command, keybinding, and picker action has a reachable
  implementation.

### Binding Interaction Contract

This contract supersedes older examples in this document where session
recovery, internal queue state, or approval keys conflict with it.

- Pi `SessionManager` is the user-conversation source of truth. Session list,
  resume, new, transcript hydration, and later fork/branch read the same source.
- A project-scoped `AgentSessionRuntime` owns active switching so persisted
  model/provider/thinking, cwd-bound resources/extensions, usage, and lifecycle
  hooks restore coherently. Pointer-only one-shot reopen is called continuation,
  not switching.
- SQLite checkpoint/outbox state remains a separate execution-recovery ledger.
  Recovery cannot change the selected conversation.
- `/resume` without an ID/name opens a project-scoped searchable session picker.
  Direct lookup failure reports the selector and reopens that picker.
- `/new` may allocate lazily, but the next accepted write must use a different
  conversation identity and the old transcript is no longer presented as
  current.
- Native conversation IDs and legacy checkpoint/run IDs are different typed
  namespaces. Only native conversation events can mutate the active-session
  pointer.
- A pending human input is in exactly one recoverable state: draft, queued,
  attached, completed, or canceled-and-restored.
- Every queued request binds immutable canonical project, conversation
  generation/session, provider, and model at admission. Reclaim never rebuilds
  routing from mutable UI state.
- Active conversation publication is generation CAS fenced by the request's
  live lease. Stale completion and stale `/new` cannot overwrite a newer head.
- Until true live steering exists, Enter during work honestly queues the next
  task. Steering and follow-up modifiers are introduced only when both delivery
  paths exist and are labeled.
- Pending entries remain represented by their submitted transcript turn and an
  active-work count, execute FIFO, and survive interruption. There is no
  separate queue-management screen.
  Idle chrome never exposes internal checkpoint, paused, outbox, or request
  queue vocabulary.
- Session new/switch rejects while work or bound pending requests exist unless
  the transition atomically settles or rebinds them.
- Dispatch order is IME composition, blocking approval/dialog, picker,
  composer, active-turn control, transcript navigation, then global exit.
- A focus-acquiring click never approves, submits, selects, or dismisses.
- Approval shows the exact operation, target, identity hashes, reviewable
  preview, and fixed action row. Native approval is deliberately per-invocation
  `y/n`; session/scoped policy is not advertised until a policy runtime exists.
- Approval `Esc` is safe reject/dismiss. `Ctrl+C` cannot terminate the TUI while
  approval owns focus. Oversized content scrolls instead of being rejected only
  for exceeding viewport height.
- The transcript is the sole base scroll owner. A full-history viewer is a
  separate focused overlay with page, top/bottom, close, and follow-tail
  controls.
- Subagents expose name, measured running/completed/failed state, and durable
  parent/child relation. Input ownership and delegated approval are added only
  with a corresponding runtime protocol.
- Transient errors show cause, attempt/countdown where applicable, preserve
  completed partial output, and remain visible until deliberate action.
- A linear transcript-friendly mode removes animation and decorative borders
  while preserving every state and action label. Keyboard help is discoverable.

### Critical Screen Specifications

1. **Idle:** transcript, optional measured metrics, and focused `>` composer.
   Internal resumability and storage queues are not workflow chrome.
2. **Streaming:** partial unlabeled assistant prose, explicit working state, and
   composer available for the documented pending-input contract.
3. **Parallel work:** named owner/state rows with parent/child relation and no
   repeated full-card boxes.
4. **Approval:** exact action/diff, reviewable preview, fixed labeled action
   row, and approval disabled whenever the complete review does not fit.
5. **Failure:** durable cause/incomplete marker and actionable retry/inspect
   state; completed partial output remains.
6. **Detached transcript:** content position is stable; `↓ N new` is visible.
7. **Command/model picker:** bounded overlay, active row in reverse video,
   shell remains visible.
8. **Compact/minimal:** prompt tint and unlabeled answer remain; optional
   metrics disappear before content.
9. **Degraded:** bounded context title, prompt surface, composer, and exit path.
10. **Session picker:** searchable root sessions with metadata, selector errors
    that reopen the picker, and transcript hydration on selection.
11. **Pending input:** submitted turns and pending count remain visible and are
    preserved through interruption without exposing storage queue vocabulary.
12. **Subagent:** measured state and hierarchy are explicit.

### Accepted Debt

- Terminal themes vary. The ANSI-256 palette assumes a dark or neutral terminal
  and requires final light, dark, and custom-theme contrast checks.
- Cloud/background orchestration commands remain absent unless the corresponding
  runtime capability exists; the UI never advertises a placeholder action.
