# Conversation 캐시 키 분리와 0.2.8 준비

## 조사 범위 / 확인한 것 / 못 확인한 것

- [코드확인] 공개 저장소 `3x-haust/3xhaustpi`의 conversation 입력·provider 옵션·coding run/resume·cache usage 변환과 관련 합성 테스트만 확인했다. 저장소 전체 감사는 아니다.
- [코드확인] 기준 커밋은 `97f0f3f8ee87c0a82076ee71c36aa0fe7b5ca90d`다. 변경 후 파일은 이 문서를 포함한 커밋을 기준으로 한다. 3xhaustpi는 0.2.7에서 0.2.8로 준비하며, 배포 의존성 pi-ai는 0.84.3, 워크스페이스 pi-ai는 0.82.1이다. 둘의 clamp 구현을 확인했다.
- [문서확인] 공개 범위는 완전 공개 소스, 라이선스는 MIT, 이번에 확인한 종류는 코딩 하네스의 임베딩 런타임이다. 저장소 URL은 <https://github.com/3x-haust/3xhaustpi>다.
- [코드확인] 합성 fixture로 옵션 전달과 결과 변환을 검증한다. 실제 provider 호출, 운영 cache hit, 비용 절감, 원격 CI의 다른 OS 실행은 확인하지 않는다. 캐시 키의 안정성만으로 provider 적중을 보장할 수는 없다.

## Conversation API

- [코드확인] `ConversationInput.promptCacheKey?: string`을 내부 계약과 배포 선언에 추가한다. 명시한 키는 `sessionId`보다 우선하며, 생략하면 기존 `sessionId`를 사용한다. 둘 다 없으면 키 옵션을 생략한다. 빈 명시 키는 그대로 전달한다.
- [코드확인] 공개 서브패스 `@earendil-works/pi-ai/api/openai-prompt-cache`의 `clampOpenAIPromptCacheKey`를 재사용한다. `Array.from` 기준 앞 64 Unicode code point를 유지하므로 surrogate pair를 자르지 않는다. fallback 키에도 적용한다.
- [코드확인] `sessionId` 전달과 `finally`의 `cleanupSessionResources(sessionId)`는 그대로다. 안정적인 캐시 키를 정리 대상으로 사용하지 않는다. `cacheRetention: "long"`, WebSocket 선택, 재시도·토큰 제한도 유지한다.

## Coding run/resume 판단

- [코드확인] 이번에는 `CodingTaskInput`과 `ResumeCodingTaskInput`에 `promptCacheKey`를 추가하지 않는다. `runCodingTask`는 사용자 세션 ID와 별개로 `providerCacheSessionId(projectRoot, provider, model, objective, resourceContextDigest)`를 계산한다. 동일한 인자에서 같은 SHA-256 기반 짧은 키가 나오며, 목표나 리소스가 다르면 바뀐다.
- [코드확인] semantic loop는 그 키를 adapter binding으로 넘긴다. adapter는 `-initial`, `-followup`, 필요 시 `-repair`를 붙여 provider의 `sessionId`와 `promptCacheKey`로 사용한다. 이 조합은 호출마다 달라지는 외부 작업 세션 ID를 포함하지 않는다.
- [코드확인] resume은 checkpoint에 저장된 프로젝트·목표·provider·model을 복원하고 같은 계산 경로를 거친다. 따라서 동일한 목표와 리소스의 재개에는 이미 안정적인 affinity가 있다. 변경된 리소스는 별도 키로 분리되거나 기존 재개 검증에서 거부된다.
- [코드확인] 안정적인 작업 키를 받을 수 있다는 가능성만으로 별도 입력을 추가하지 않았다. 현 경로에서 외부 세션 ID 때문에 매번 캐시 키가 바뀌는 문제는 없으며, 외부 키로 기존 프로젝트·목표·리소스·phase 구분을 대체할 근거도 없다.

## Cache usage와 provenance

- [코드확인] pi-ai responses parser는 `input_tokens_details.cached_tokens`가 없거나 0일 때 모두 `cacheRead: 0`으로 만든다. 일반 `Usage`에는 해당 필드가 원문에 있었는지 나타내는 표식이 없다. 초기 usage도 0으로 구성된다.
- [코드확인] conversation은 유한한 양수만 보고하고 0·미보고는 `null`로 유지한다. 이 규칙은 관측된 양수 적중을 확인하는 데 충분하지만, 실제 0 적중과 미보고를 구별하지 못하므로 전체 요청 대비 정확한 적중률의 분모를 만들기에는 부족하다.
- [코드확인] `cacheReadReported`를 정규화된 숫자만 보고 추가해도 원문 provenance를 복원할 수 없다. 양수를 `true`, 0을 `false`로 두면 실제 보고된 0을 미보고로 오분류한다. 이번에는 필드를 추가하지 않는다. 이를 지원하려면 pi-ai parser에서 원문 필드 존재 여부를 보존하는 계약이 먼저 필요하다.
- [코드확인] coding adapter의 별도 `cacheUsageSupport: reported` 계약은 측정값을 그대로 보존하며 semantic loop가 그 지원을 선언한다. 따라서 coding이 내보내는 0도 원문 필드의 존재 증거로 간주할 수 없다. 이번 conversation 변경으로 이 기존 adapter 계약을 확대하거나 0을 새 측정값으로 승격하지 않는다.

## 로컬 검증

- [코드확인] `npm install --package-lock-only --ignore-scripts`: exit 0. lock diff는 3xhaustpi 버전 한 줄뿐이며 의존성 버전·integrity는 변경하지 않았다.
- [코드확인] `npm ci --ignore-scripts`: exit 0. npm이 기존 `min-release-age` 설정 경고, deprecated 의존성 경고, high 취약점 7건을 보고했다. 의존성 보안 수리는 이번 변경에 포함하지 않았다.
- [코드확인] `npm run check:pinned-deps`, `npm run check:shrinkwrap`, `npm run check:install-lock:coding-agent`, `npx tsgo --noEmit`, `npm run check`: 각각 exit 0. lint·타입 오류는 없으며 npm 설정 경고는 남아 있다.
- [코드확인] 신규 cache key 테스트·기존 conversation·metadata·선언 테스트: 4개 파일, 26개 테스트 통과, exit 0.
- [코드확인] 패키지 전체 기본 병렬 vitest: exit 1, 496개 통과·1개 실패. 기존 `tui-runtime-client.test.ts`의 `terminates worker descendants when cancellation recycles the worker`에서 `grandchild-terminated` 대기 타임아웃이 발생했다. 해당 파일 단독 재실행은 17개 통과, exit 0. 관련 구현·테스트·타임아웃은 변경하지 않았다.
- [코드확인] 패키지 전체 `node ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism --silent=passed-only` 재실행: exit 0, 98개 파일·497개 테스트 모두 통과. 테스트 생략 없이 파일 병렬 실행만 끈 결과다. 병렬 실행의 타이밍 의존성은 남아 있다.
- [코드확인] CI의 Build consumed packages 명령: 아래 10개 모두 exit 0. 원격 CI 결과가 아닌 로컬 macOS 실행이다.

| 명령 | Exit code |
| --- | --- |
| `npm --prefix packages/ai run hydrate-model-data` | 0 |
| `npm --prefix packages/ai run build:offline` | 0 |
| `npm --prefix packages/agent run build` | 0 |
| `npm --prefix packages/tui run build` | 0 |
| `npm --prefix packages/coding-agent run build` | 0 |
| `npm --prefix packages/semantic-contract run build` | 0 |
| `npm --prefix packages/core run build` | 0 |
| `npm --prefix packages/pi-adapter run build` | 0 |
| `npm --prefix packages/pi-session run build` | 0 |
| `npm --prefix packages/3xhaustpi run build` | 0 |

- [코드확인] `node 3xhaust/verify-embedding.mjs`: exit 0.

## 출처 목록

- [코드확인] <https://github.com/3x-haust/3xhaustpi>, 기준 커밋 `97f0f3f8ee87c0a82076ee71c36aa0fe7b5ca90d`: `packages/3xhaustpi/src/coding-runtime.ts:52-112,231-240`, `coding-runtime-resume.ts:6-44`, `coding-runtime-semantic.ts:75-85`; `packages/pi-adapter/src/adapter.ts:123-130,150-160,201-205`, `metrics.ts:4-11,13-39`.
- [코드확인] 같은 기준 커밋: `packages/ai/src/api/openai-prompt-cache.ts:1-8`, `openai-codex-responses.ts:255-286`, `openai-responses-shared.ts:541-556`, `packages/ai/src/types.ts:374-394`. 배포 의존성 pi-ai 0.84.3의 `dist/api/openai-prompt-cache.js:1-10` 및 `dist/api/openai-responses-shared.js:437-452`도 직접 확인했다.
- [코드확인] 이 문서를 포함한 변경 커밋: `packages/3xhaustpi/src/coding-runtime-provider.ts:1-5,43-80,94-100,116-118,134-136,180-189`, `coding-runtime-contracts.ts:125-137`, `runtime-api.d.ts:162-174`; `packages/3xhaustpi/test/conversation-cache-key.test.ts`, `conversation-metadata.test.ts:78-120`, `runtime-api-contract.test.ts`.
- [문서확인] <https://github.com/3x-haust/3xhaustpi/pull/16>, <https://github.com/3x-haust/3xhaustpi/pull/17>: 패키지 버전·CHANGELOG·product identity·lock을 함께 갱신하는 릴리스 준비 관례를 확인했다.
- [문서확인] 같은 저장소 기준 커밋의 `LICENSE:1-21` 및 `packages/3xhaustpi/package.json:52,60-63`: MIT 라이선스와 공개 저장소 주소.
