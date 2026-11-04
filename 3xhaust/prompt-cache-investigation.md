# 프롬프트 캐시 조사와 경계 보완

## 결론과 증거 범위

- 사용자 제공 관측은 전체 히트율 74%, 세션 첫 요청 약 1만 토큰 uncached, 간헐적인 입력 전체 미스다. 운영 요청 원문이나 서버 로그는 열람하지 않았다. 이 비율을 재측정하거나 특정 운영 미스의 원인을 확정하지 않는다.
- 로컬에서 확인한 수정 대상은 **Anthropic 대화 캐시의 단일 이동 경계**다. 큰 병렬 도구 묶음 뒤 직전 경계가 서버의 제한된 블록 탐색 범위 밖으로 밀릴 수 있었다. 직전 사용자 경계를 명시적으로 남기고, OAuth 시스템 경계를 통합하여 총 네 개 이내로 유지했다. 이는 Anthropic 경로의 개선이며 **Codex 미스의 해결 증거가 아니다**.
- 코딩 에이전트 기본 시스템 프롬프트에는 요청마다 달라지는 날짜·시간·세션 ID를 삽입하지 않는다. 동일 리소스와 도구 순서에서는 날짜 변경, 프롬프트 재구성, compaction 전후에도 시스템/도구 JSON 바이트가 동일함을 faux provider로 확인했다.
- Codex의 세션 기반 키는 라우팅 친화도를 분산시킬 수 있지만, **세션 간 캐시 공유가 원천 불가능하다는 증거는 아니다**. 같은 키도 히트 보장이 아니다. 실패했던 공통 키 실험을 기본값으로 다시 적용하지 않았다.
- 실제 API 호출, 인증 파일 접근, 실제 키 사용은 없었다. 서버 적중률·지연·비용 절감은 미측정이다. 캐시 통계/usage 계약 및 메모리 정리 코드는 변경하지 않았다.

## 1. 접두부 안정성

| 구간 | 확인한 코드 동작 | 미스와의 관계 |
| --- | --- | --- |
| 기본 시스템 | `packages/coding-agent/src/core/system-prompt.ts`는 지침, 문서 설치 경로, append prompt, 프로젝트 파일, skill 목록, cwd를 결합한다. 매 요청 시계는 없다. | 같은 리소스면 안정적이다. 다른 cwd/워크트리/설치 경로는 실제 문자열을 바꾼다. |
| 도구 | `AgentSession.setActiveToolsByName()` 및 `_rebuildSystemPrompt()`는 등록된 도구를 선택 순서대로 보존한다. provider 변환도 그 배열 순서를 따른다. | 무작위 재정렬은 발견하지 않았다. 호출자가 순서/설명/schema/활성 집합을 바꾸면 도구와 관련 지침이 바뀐다. 의미 있는 선택 순서를 임의로 정렬하지 않았다. |
| 리소스 | 로더는 읽어 둔 프로젝트 지침, skill 설명/경로 및 append prompt를 반환하며 일반 prompt마다 디스크에서 다시 읽지 않는다. 기본 시스템도 매 요청 재생성하지 않고 도구 변경/reload 때 재구성한다. | 파일 편집은 다음 로드에서 반영된다. 스킬은 발견 순서를 유지하며 파일 탐색을 명시 정렬하지 않으므로 재시작/reload 사이 변동 후보지만 실제 변동은 미관측이다. |
| 확장 | `before_agent_start`는 매 일반 prompt에서 기본 시스템부터 다시 체인하며 이전 덮어쓰기를 누적하지 않는다. 반환 시스템은 해당 실행의 도구 루프/재시도 동안 유지된다. context / provider payload 훅은 매 호출의 과거 메시지와 최종 요청을 바꿀 수 있다. | 날짜·현재 상태·시각을 훅에서 시스템 앞에 넣으면 코어가 안정적이어도 미스가 가능하다. 확장 로드는 순차적이어서 단순 비동기 완료 순서로 도구가 뒤섞이는 구조는 아니다. Ondra 훅의 실제 출력은 이번 저장소 조사만으로 검증하지 못했다. |
| 시간 | 내부 메시지 timestamp는 Anthropic/Codex 변환에서 프롬프트 내용으로 직렬화하지 않는다. | timestamp 증가 자체는 원인이 아니다. 본문에 삽입한 시간은 별개다. |
| compaction | 요약+유지 메시지로 대화 앞부분을 재구성한다. 기본 시스템과 도구는 유지된다. 요약 생성 요청 자체는 별도 시스템과 `cacheRetention: "none"`을 사용한다. | 대화 캐시는 요약 시작점부터 달라지는 것이 정상이다. 안정적인 시스템/도구까지 반드시 미스가 나야 하는 것은 아니다. |
| 지연 로딩 도구 | `packages/ai/src/utils/deferred-tools.ts`는 이력의 `addedToolNames`와 도구 사용 순서로 접두부/지연 도구를 구분한다. | compaction으로 로딩 표식이 사라지면 도구가 초기 목록으로 승격될 수 있다. 이 경우 정적 접두부도 바뀐다. 기능 유지에 필요한 동작이므로 표식을 지우거나 도구를 숨기지 않았다. |
| rewind/fork | fork는 선택 경로의 메시지를 보존하고 새 세션 ID/런타임을 만든다. 기본 서비스 경로는 리소스를 다시 로드하며 시스템 문자열/현재 활성 도구 집합 자체는 세션 로그에 저장되지 않는다. | 과거 메시지가 동일해도 기본 Codex 라우팅 키와 연결 상태는 새로워진다. 리소스가 편집되었다면 시스템도 달라질 수 있다. 이후 분기 본문은 의도적으로 달라진다. |

메인에서 새 메시지만 엔진에 전달해도 엔진은 저장된 이력 전체를 provider context로 재구성한다. 이는 정상이다. 엔진 입력이 증분이라는 사실만으로 provider 전송도 증분이거나 서버 캐시가 적중했다고 판단할 수 없다.

### 별도 네이티브 런타임 경로

`packages/3xhaustpi/src/agent-runtime-provider.ts`에는 이미 프로젝트/provider/model/계정/시스템 digest 기반 affinity와 `promptCacheKey` 전달이 있다. Codex에서는 자원 `sessionId`를 실제 세션 ID로 분리한다. 반면 일반 coding-agent/RPC 경로가 이 래퍼를 자동으로 설치하는 것은 아니다. Ondra가 실제 사용하는 진입점·버전에서 어느 경로가 실행되는지 구분해야 한다.

이 래퍼는 Codex transport를 `"websocket"`으로 지정한다. 현재 provider 구현에서 이 값은 연결만 재사용하고 전체 이력을 전송한다. 기본 `"auto"` 및 `"websocket-cached"`만 연결 내 continuation을 시도한다. 기존 선택은 바꾸지 않았다. 전송량 감소와 토큰 캐시 적중률은 별도 문제이며, 공통 키로 자원 세션까지 합치면 독립 이력 간 잘못된 연결 공유 위험이 있다.

## 2. Anthropic 경계 수정

기존 배치:

- 마지막 초기 도구에 한 개(호환성 설정으로 생략 가능).
- API key는 시스템 한 개, OAuth는 identity와 시스템에 각각 한 개.
- 마지막 메시지가 user일 때만 마지막 블록에 한 개.

문제:

1. 대화 표시는 최신 user 하나뿐이어서 새 요청에 많은 `tool_use`/`tool_result` 블록이 추가되면 직전 요청의 캐시 경계가 자동 탐색 범위 밖으로 밀릴 수 있다. Anthropic의 명시적 breakpoint 탐색은 무제한 전체 이력 검색이 아니다(문서상 최대 20개 블록).
2. 마지막 메시지가 assistant인 continuation에서는 대화 표시가 빠졌다.
3. OAuth+도구+시스템은 이미 네 개를 사용하므로 단순히 표시를 추가하면 한도를 넘는다.
4. string user는 최신일 때만 배열로 바뀌었다. 캐시 표식 외에도 같은 과거 메시지의 JSON 표현이 턴마다 바뀌었다. 서버는 토큰 접두부를 비교하므로 이것만으로 실제 미스를 단정하지는 않는다.

수정:

- OAuth identity는 그대로 전송하고 **전체 시스템 끝**에만 표시한다. identity도 이 접두부 안에 포함된다.
- 최신 캐시 가능한 대화 블록과 그 앞 user 경계를 표시한다. 큰 병렬 도구 배치 뒤에도 직전 명시 경계가 남는다.
- assistant text/tool-use continuation을 지원하고 thinking/redacted-thinking에는 표시하지 않는다.
- string user를 항상 text-block 배열로 표현하여, 표식 외의 과거 메시지 표현을 일정하게 유지한다.
- 최대 `도구 1 + 시스템 1 + 대화 2 = 4`. 호환성의 도구 표시 제외, long/short/none 선택은 유지한다.

이는 모든 대화 블록을 캐시하거나 자동 탐색 제한 자체를 없애는 수정은 아니다. 모델별 최소 길이, 같은 접두부, 계정/조직 격리, TTL과 서버 가용성 조건은 여전히 적용된다. 추가 경계가 캐시 쓰기 위치와 비용 분포를 바꿀 수 있으므로 실제 비용은 provider usage로 별도 확인해야 한다.

## 3. Codex 요청과 한계

`packages/ai/src/api/openai-codex-responses.ts`와 `simple-options.ts` 확인 결과:

- `prompt_cache_key = clamp(promptCacheKey ?? sessionId)`. 명시 키는 이미 `streamSimple`까지 전달된다. 앞 64 Unicode code point로 제한한다. 긴 임의 문자열의 뒷부분만 다르면 잘릴 수 있으므로 digest 등 짧은 키가 적절하다.
- transport 연결/continuation 자원은 `sessionId`로 소유한다. 명시 `promptCacheKey`와 분리되어 있다.
- `store: false`, `instructions`, 전체 `input`, 도구, `tool_choice`, `parallel_tool_calls`, reasoning/verbosity/include, 출력 제한 등이 요청을 구성한다.
- `PI_CACHE_RETENTION=long`은 Anthropic에서 지원 시 `ttl: "1h"`가 된다. **ChatGPT Codex endpoint에는 `prompt_cache_retention: "24h"`를 보내지 않는다.** 저장소의 기존 회귀 테스트와 기록은 이 endpoint가 공개 API retention 필드를 거부한다고 명시한다. 이번에는 서버에 재확인하지 않았다.
- 따라서 Codex에서 long을 전달한다고 1시간/24시간 TTL이 확보되지는 않는다. `none`은 키/세션 기반 재사용을 끄지만, 지원하는 공개 OpenAI API의 explicit cache mode처럼 서버 자체의 모든 캐시 read/write를 차단한다는 계약도 없다.
- cached WebSocket continuation은 요청의 input 외 필드가 같고, 복원 이력이 이전 요청+응답의 정확한 prefix여야 한다. 설정 변경, compaction, fork, 연결 만료·재연결, SSE 전환이면 전체 요청으로 돌아갈 수 있다. 이 검사는 잘못된 과거 상태를 재사용하지 않기 위한 안전장치다.
- `store: false`는 응답 영구 저장 정책이고 prompt cache 비활성화와 같은 뜻이 아니다. `previous_response_id`는 연결 내 이력 재사용이고 prompt cache key와 같은 뜻이 아니다.
- `onPayload`는 WebSocket delta 변환 **이전의 전체 요청**을 관찰한다. 이 훅만으로 실제 frame이 전체였는지 증분이었는지를 단정할 수 없다.

### 첫 요청 0 및 간헐적 전체 미스 해석

- 서버에 재사용 가능한 동일 접두부가 아직 없으면 첫 요청의 정적 1만 토큰도 처리해야 한다. 사용자가 관측한 첫 요청 0만으로 클라이언트 버그나 서버 캐시 불능을 입증할 수 없다.
- 공통 키는 동일 내용에 대한 라우팅 힌트일 뿐 캐시 항목 생성/영속화/다른 세션 히트를 강제하는 명령이 아니다. 다른 접두부를 같게 만들지도 않는다.
- 같은 계정/모델/접두부/키의 후속 요청에서도 서버 라우팅, 부하 분산, 퇴거, 보존 시간, 요청 동시성, endpoint별 정책으로 미스가 가능하다. 이번에 운영 원인으로 입증한 것은 아니다.
- 공개 OpenAI API의 일반적인 최소 1024 토큰·128 토큰 단위 적중 및 extended-retention 설명을 ChatGPT Codex의 모든 모델에 그대로 보장하면 안 된다. 정확한 자격·보존 시간은 endpoint/model별 계약으로 확인해야 한다.
- usage에 cached-token 필드가 없어서 정규화된 0이 된 경우와 서버가 실제 0을 보고한 경우도 구분해야 한다. 이 provenance 개선은 별도 작업 범위이며 여기서 통계 필드를 바꾸지 않았다.

## 4. 검증

테스트는 provider 네트워크 호출 없이 순수 payload fixture와 faux provider만 사용했다.

- `packages/ai/test/anthropic-prompt-cache.test.ts`: OAuth 포함 네 개 제한, 24개 병렬 도구 호출/결과 후 이전 경계 유지, assistant/thinking/image/tool-result, none 및 빈 이력.
- `packages/coding-agent/test/suite/agent-session-prompt-cache.test.ts`: 동일 선택 순서, 날짜 변경과 시스템 재구성, compaction 후 시스템/도구 바이트 동일 및 대화 prefix 교체.
- `packages/ai/test/faux-provider.test.ts`: 기존 가상 제공자 회귀. AI 두 파일 32개 테스트 통과.
- coding-agent의 새 테스트와 기존 compaction/runtime/system-prompt 네 파일 37개 테스트 통과(fork 회귀 포함).
- 전체 `npm run check`: lint, 의존성 고정/lock 검증, 타입 검사 및 브라우저 스모크 통과. 최초에는 워크트리에 없는 semantic-contract 선언 산출물 때문에 실패하여 원본의 해당 `dist`를 copy-on-write 복제한 뒤 재실행했다. 소스/설정/의존성을 낮추거나 바꾸지 않았다. npm 자체의 기존 알 수 없는 설정 경고는 출력되었지만 lint/타입 검사 오류·경고는 없었다.

`node_modules`도 요청대로 원본에서 `cp -cR`로 복제했다. 원본 폴더는 수정하지 않았다. 빌드/전체 e2e/API 실험은 실행하지 않았다. 테스트의 캐시 통계는 실서버 증거로 사용하지 않는다.

## 5. 후속 운영 확인 절차

이 문서는 API 호출을 승인하거나 자동 실행하지 않는다. 별도 승인된 측정 시:

1. 같은 endpoint/model/account와 고정된 system/tools/초기 이력으로 연속 요청을 비교한다. 첫 cold 요청과 후속 요청을 분리한다.
2. onPayload 최종 변경까지 반영한 시스템·도구·대화의 **섹션별 해시/바이트 수 및 첫 차이 위치만** 기록한다. prompt 원문·도구 결과·키·헤더·개인 경로는 로그에 남기지 않는다. 캐시 표식 변화와 실제 본문 변화를 분리한다.
3. 일반 후속, 도구 묶음, compaction, fork, reload, 연결 교체를 구분한다. 안정적인 시스템/도구까지 미스인지, 달라진 대화 부분만 미스인지 본다.
4. raw usage의 cached 필드 존재 여부와 값, 요청 간격, transport/continuation 상태를 함께 확인한다. 같은 키 실험도 동일 접두부 증거와 함께 평가한다.
5. 접두부가 달라졌다면 최초 변경 구간을 고친다. 접두부가 같아도 미스면 서버 조건을 조사한다. 별도 warm 요청으로 비용만 앞당긴 것을 적중률 개선으로 계산하지 않는다.

참고 계약: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). 외부 문서 최신성/현재 Codex 동작은 이번 오프라인 작업에서 재검증하지 않았다.
