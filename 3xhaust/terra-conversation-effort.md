# X11: Terra와 conversation effort, 0.2.11 준비

## 사양과 생성

2026-10-27 [공식 모델 페이지](https://developers.openai.com/api/docs/models/gpt-6.1-terra)와 [가격 문서](https://developers.openai.com/api/docs/pricing)를 확인했다.

- `gpt-6.1-terra`: 입력 $1, 캐시 입력 $0.05, 출력 $5 / 1M tokens. 30분 캐시 쓰기 $1.25.
- Context 1,050,000, 최대 출력 128,000, 텍스트·이미지 입력.
- 공식 effort: `none`, `low`, `medium`(기본값), `high`, `xhigh`, `max`. `minimal`은 공식 값이 아니다.
- 입력 272,000 초과 시 요청 전체에 입력·캐시 요금 2배, 출력 1.5배. 즉 입력 $2, 캐시 입력 $0.10, 출력 $7.50, 30분 캐시 쓰기 $2.50.
- 이 가격은 Standard API 모델 요율이며 구독 계정 청구 영수증이 아니다.

`packages/ai/scripts/openai-gpt6-models.ts`의 생성 규칙에 추가했다. `generate-models.ts --strict --json-only --json-output <temporary-directory>`가 외부 카탈로그 조회에 성공했고, 출력의 Terra만 두 provider 스냅샷에 반영했다. 다른 모델의 의미상 변경은 없다. `createModelDataManifest`로 manifest를 재생성하고 `validateGeneratedModelData`로 검증했다.

기존 제품 번들의 GPT-6 카탈로그 결합을 통해 `resolveModel(runtime, "openai-codex", "gpt-6.1-terra")`와 OpenAI 해석이 가능하다. Codex UI의 `minimal → low` 매핑은 유지하되, conversation의 명시적 raw effort `minimal`은 Terra에서 거부한다.

## 전달과 관측

- `ConversationInput.reasoningEffort` → `runConversation`의 모델별 지원 값 검사 → `completeSimple`의 `reasoning` → pi-ai Codex `reasoningEffort` → 요청 `reasoning.effort`.
- 설치된 pi-ai 0.84.3의 `SimpleStreamOptions.reasoning`에는 `none`이 없다. 지원 모델인지 검사한 뒤 기존 `onPayload`에서 `reasoning.effort = "none"`을 지정한다. 나머지 단계는 실제 pi-ai 요청 생성 경로를 사용한다.
- 생략하면 기존 provider 기본 동작을 유지한다. 지원하지 않는 값은 전송 전에 `RangeError`로 거부하며 자동 보정하지 않는다.
- cache key와 provider session header는 기존 계산을 유지한다. 같은 effort를 반복하거나 effort를 변경해도 키에 effort가 들어가지 않는다. 이는 캐시 라우팅 유지의 증거이며, 서버의 실제 캐시 적중을 보장하지 않는다.
- OpenAI Responses/Codex SSE의 terminal response에서 `model`과 `reasoning.effort`를 관측한다. 명시된 경우에만 `responseModel`·`reasoningEffort`를 결과에 포함하며, 기존 `model`도 관측값을 우선한다. 없는 값은 요청값으로 추정하지 않는다.
- 내부 타입과 배포용 `runtime-api.d.ts`를 함께 갱신했다. HTTP fake는 설치된 실제 adapter를 거쳐 정확한 body, 오류, 생략, 캐시 라우팅, 응답 관측을 검사한다.

## 검증

Node 24.11.0 / macOS arm64에서 실행했다. 두 vitest 실행은 자격증명 없는 빈 환경과 임시 사용자 디렉터리에서 `--run --maxWorkers=4 --exclude '**/*e2e*'`로 수행했다.

| 검사 | exit code | 결과 |
| --- | --- | --- |
| `npm ci --ignore-scripts` | 0 | lifecycle 실행 없이 설치 |
| 모델 생성 / manifest 검증 | 0 / 0 | 두 provider에 Terra만 추가 |
| `npm install --package-lock-only --ignore-scripts` | 0 | 제품 버전만 변경 |
| shrinkwrap / install-lock 재생성 | 0 / 0 | 결과는 기존 파일과 동일 |
| pinned-deps / shrinkwrap / install-lock check | 0 / 0 / 0 | `npm run check`에서 각각 통과 |
| `npx tsgo --noEmit` | 0 | 타입 검사 통과 |
| `npm run check` | 0 | Biome, import, lock, 타입, browser smoke 통과 |
| 3xhaustpi vitest | 0 | 101파일, 529검사 통과 |
| AI vitest (오프라인) | 0 | 92파일·694검사 통과, 22파일·749검사 skip |
| CI hydrate-model-data | 0 | 커밋 스냅샷 검증 |
| CI AI build:offline | 0 | 오프라인 빌드 |
| CI agent / tui / coding-agent build | 0 / 0 / 0 | 각각 통과 |
| CI semantic-contract / core build | 0 / 0 | 각각 통과 |
| CI pi-adapter / pi-session / 3xhaustpi build | 0 / 0 / 0 | 각각 통과 |
| `node 3xhaust/verify-embedding.mjs` | 0 | embedding smoke 통과 |
| 배포 CLI `--version` | 0 | `0.2.11` |
| 개인 Codex conversation 실호출 | 0 | 1회, Terra low, `ok` |
| `npm audit --json` | 1 | 기존 의존성 취약점 6건(중간 1, 높음 5) |

실호출은 빌드된 `runtime` export를 사용했다. 전송 직전 body의 모델 `gpt-6.1-terra`, effort `low`, stable cache key와 session header 일치를 확인했다. 응답 역시 모델 `gpt-6.1-terra`, effort `low`를 보고했고, 입력 20 / 출력 5 tokens, 본문 `ok`였다. 인증 내용·계정 정보는 기록하지 않았다.

초기 회귀 실행은 선행 semantic-contract 빌드 누락으로 exit 1이었다. 빌드와 모델 반영 후에는 기존 구현에서 15검사 중 13실패로 누락·미검증을 재현했고, 구현 후 통과했다. 추가 OpenAI·관측 검사까지 포함한 최종 suite 결과는 위 표와 같다.

보조 skill의 no-excuse 검사기는 TypeScript 7의 `typescript/unstable/*`를 요구하여 현재 저장소의 TypeScript 5.9.3에서 exit 2였다. 필수 Biome/tsgo 검사는 통과했고 변경 코드의 any, 동적 import, 강제 타입 변환은 직접 점검했다. npm 설정·deprecation·Node 실험 기능 안내는 코드 진단과 구분했다.

## 릴리스 범위와 한계

PR #20의 제품 단독 버전 관례대로 package version, product identity, CHANGELOG, root lock을 0.2.11로 준비했다. publish·tag·push·PR은 수행하지 않았다.

원격 CI, Windows/Linux, API-key 실호출, 다른 effort의 실호출, 장문 실제 청구·캐시 적중은 미검증이다. audit의 node-forge·undici·zod 계열 기존 취약점은 이 작업에서 수정하지 않았다. 의존성 버전·integrity 변경은 없다.
