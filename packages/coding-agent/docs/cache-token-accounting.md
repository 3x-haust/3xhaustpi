# Cache token accounting

## Request usage

The final assistant message's `usage` is the authoritative record for a conversational model request. Streaming partial messages are previews, not additional billable requests. The agent loop emits one `message_end` from the terminal stream result; `AgentSession` applies extension replacements, persists that message, then notifies subscribers. Reading session statistics or entries from a completion subscriber therefore includes the completed request.

The normalized token buckets are disjoint:

- `input`: prompt tokens not reported as cache reads or cache writes.
- `cacheRead`: prompt tokens read from the provider cache.
- `cacheWrite`: prompt tokens written to the provider cache, when reported. Do not infer writes from uncached tokens on providers that do not report them.
- `output`: generated tokens, including reasoning tokens when the provider includes them.
- `totalTokens`: `input + cacheRead + cacheWrite + output`.

Optional `cacheWrite1h` and `reasoning` are subsets of `cacheWrite` and `output`, respectively, not additional buckets to add to totals.

Anthropic reports uncached `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` separately. OpenAI Responses and Codex include cached tokens in `input_tokens`; normalization subtracts the reported read/write buckets from that input total. For explicit OpenAI cache writes, `input_tokens_details.cache_write_tokens` supplies the write bucket. Providers that omit cache details report zero, not an estimated cache hit or write.

Read the final persisted usage, not a sum of `message_update`, `message_end`, `turn_end`, and `agent_end`: these events describe the same response. Failed or aborted conversational requests contribute any usage the provider actually reported. If the provider terminates without reporting usage, exact consumption cannot be reconstructed locally.

## Session statistics

RPC `get_session_stats` delegates directly to `AgentSession.getSessionStats()`. Its token and cost totals visit each stored entry once and include:

- Assistant messages, including failed/aborted requests with reported usage.
- Optional tool-result usage for **additional nested model work**, not a copy of the calling assistant's usage.
- Optional compaction and branch-summary generation usage.
- `custom` entries with `customType: "pi.summarization_usage"` for failed/aborted summary attempts and successful responses discarded because the overall summary operation failed or was cancelled.

Built-in summarization observes each actual response before retry handling. Failed attempts are persisted immediately. Successful attempts remain attributed to the normal compaction/branch-summary entry when that entry is committed; `details.usageRequests` preserves their individual usage snapshots and request metadata, while the entry's aggregate `usage` is counted once. Otherwise they are saved as standalone usage records, including late completion of a parallel split-turn sibling. An aborted retry sleep is not another request and does not add a duplicate usage record. Standalone records are invisible to model context and contain the source, provider/model, completion reason, optional response ID, and usage snapshot. Usage-bearing records flush even when there has not yet been a conversational assistant response.

Custom summary extensions remain responsible for reporting their own usage. Providers that never report usage cannot be accounted for exactly.

Totals include all entries in the session file, including pre-compaction history and abandoned tree branches. They are not the current context size. Compaction does not erase historical consumption, and rebuilding context does not add another copy of kept messages to totals. Immediately after compaction the separate `contextUsage` can be unknown until a fresh assistant response.

Reload reconstructs these totals from stored entries; there is no live-only usage accumulator. A new empty session starts at zero. Fork/clone totals include copied history, so adding statistics from a parent and its fork double-counts shared history:

- `/tree`: same file; abandoned branches remain in totals.
- `/fork` and `/clone`: a new file containing the selected branch path; other branches are not copied.
- `SessionManager.forkFrom`: copies the source file's entire tree; all copied entries contribute.

These totals describe recorded consumption in the session history, not incremental charges incurred since a fork was created. Forking first settles an active conversational response in its source session. In-memory forks use an independent manager so late summary responses cannot be attributed to the child.

## Interpreting cache observations

For one request, the token-weighted cache hit rate is:

```
cacheRead / (input + cacheRead + cacheWrite)
```

Uncached prompt work is `input + cacheWrite`, not `input + output`. A session-wide rate uses the sums of those buckets, not an average of request percentages. The footer's `CH` value uses the latest recorded conversational assistant request, while `/session` uses cumulative totals. An embedding such as Ondra can choose either; inspect request usage and `get_session_stats` before interpreting a displayed 74%. A 74% aggregate rate can coexist with an initial 10,000-token cold request and a later complete miss. It does not mean that every request hit at 74%.

A zero read count alone cannot establish why a request missed. Expiration, routing, changed prompt prefixes, and compaction are cache-behavior questions; accounting must preserve the reported zero rather than fabricate a hit. This change does not modify cache keys, request payload caching controls, retention, compaction prompts, or memory policy.

## Offline coverage

`test/suite/agent-session-cache-usage.test.ts` uses only the faux provider and covers per-request cold/hit/miss usage, completion-time statistics, streaming deduplication, extension overrides, failed/retried/aborted conversational requests, nested tools, compaction, tree navigation, forks, and JSONL reload. `test/suite/agent-session-summary-usage.test.ts` covers failed/retried/cancelled summaries, discarded and late parallel responses, and standalone usage persistence. Provider normalization fixtures in `packages/ai/test/provider-cache-usage.test.ts` use local mock responses without credentials or network calls.
