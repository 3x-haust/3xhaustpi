# T10: conversation cache routing and usage evidence

## Confirmed defect

The published dependency and workspace sources differ. `packages/3xhaustpi/package.json:54` pins pi-ai 0.84.3; `packages/3xhaustpi/build.mjs:32-33` leaves pi-ai external. Inspect the installed dependency under `packages/3xhaustpi/node_modules`, not the root workspace link.

In pi-ai 0.84.3, `dist/api/simple-options.js:10-34` does not forward `promptCacheKey`. `dist/api/openai-codex-responses.js:169-171` derives the body cache key from `sessionId`. Its `buildRequestBody` puts that value in `prompt_cache_key` at line 399. Thus a stable Metamong key digest did not establish a stable wire key. Each fresh resource session changed the actual cache routing key.

The HTTP regression `test/conversation-wire.test.ts` exercises the installed dependency with synthetic OAuth metadata and an offline fetch boundary. Before the payload fix, all three cases failed: the wire key was the resource session instead of the supplied stable key. Afterward all three pass, including raw zero, positive and absent cached-token reports. Resource sessions remain independent.

This proves a cache-affinity defect, not that every historical null was a cache miss. The old normalization irreversibly discarded that distinction.

## Request prefix and response usage

`src/coding-runtime-provider.ts:57-67` sends the caller system instructions followed by the user prompt. Timestamp is internal message metadata; the provider wire fixture verifies the supplied instructions and no previous response ID. Conversation has no tools or injected cwd, clock or random prompt prefix.

The pinned adapter uses `store: false` (`dist/api/openai-codex-responses.js:393`) and does not send the public API retention field. `cacheRetention: long` enables the key but does not prove a particular server TTL. The former `websocket` transport did not enable the `websocket-cached` continuation branch. The new conversation path uses SSE, sends full input, and observes raw terminal usage through a transparent fetch stream before normalization.

`dist/api/openai-responses-shared.js:440-451` maps absent cached counts to zero. The conversation adapter now reports:

| Raw evidence | cacheRead | cacheReadReported |
| --- | --- | --- |
| Explicit numeric zero | 0 | true |
| Positive count | count | true |
| Missing, null or invalid count, normalized zero | null | false |

Positive normalized counts from other provider paths still prove reporting. No normalized zero is promoted without raw evidence. Raw response bodies, credentials and headers are never logged. `cacheWrite` retains its prior conservative behavior.

## Measurement and limits

Metamong's `scripts/measure-runtime-prefix.mjs` uses its real wiki bootstrap loader, secretary-loop prompt builder, skill loader and inline bridge builder, with synthetic request IDs and personal vault policy/START/index read locally. It emits counts only. The production server prompt and policy database were not read.

On 2026-10-23: system 13,209 UTF-16 units, user prompt common prefix 35,359, combined common prefix 48,568, nine wiki assets, START/index present, stable key identical. Before/after is 48,568 / 48,568 because this patch changes routing and usage, not prompt text. This is a local reconstruction, not an exact token count or retained production request.

The Mac's personal credential check passed and the requested model resolved locally. Actual Codex requests were rejected as model unsupported; no successful provider pair or measured cache hit is claimed. Alternate local models were also rejected. Fixing cache affinity is verified at the HTTP wire boundary; live cache behavior remains unverified.

## Release preparation

Package version, product identity and package lock are prepared for 0.2.9 following the package-specific #16-#18 convention. Changelog additions stay under Unreleased. No tag, npm publish, push or deployment is performed. Metamong's existing 0.2.8 artifact pin remains unchanged until a real source archive and npm artifact can be verified.

## Validation

- `npm ci --ignore-scripts`: exit 0. `npx tsgo --noEmit`: exit 0. `npm run check`: exit 0. Package build and local npm pack: exit 0. Diff whitespace check: exit 0.
- Conversation wire/cache/metadata/key focused tests: 30 passed, exit 0. The existing conversation transport assertion was updated to SSE; its four tests passed independently, exit 0. These are offline HTTP fixtures, not live cache-hit evidence.
- Root `./test.sh`: exit 1. The 3xhaustPi workspace initially had the old transport assertion plus two TUI timeouts. After updating the assertion, its test passes; isolated `CI=true` image-preview tests pass (8 tests). The source-worker startup test still times out at its existing five-second deadline (16 other tests pass); it remains unresolved.
- The broader coding-agent workspace also reported 44 suite-load failures with temporary-file ENOENT errors, an external-editor capture ENOENT and a detached-child output assertion failure. These paths were not modified, and a clean-baseline comparison was not run; no claim that they predate this task is made.
- All changed source and test files are below 250 physical lines. Changes are limited to conversation transport/routing/usage reporting, the associated contracts/tests and 0.2.9 preparation.
