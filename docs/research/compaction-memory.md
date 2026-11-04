# 기억·압축 조사 및 개선

## 실제 실행 경로

- **Ondra의 직접 경로:** Ondra `scripts/bundle.mjs`가 `packages/coding-agent/dist/pi`를 `ondra-engine`으로 번들링한다. `src-tauri/src/engine.rs`는 이를 `--no-extensions --mode rpc`로 실행한다. Ondra `src/engine/tasks.ts compactAgent()` → RPC `{type:"compact"}` → coding-agent `src/modes/rpc/rpc-mode.ts` → `AgentSession.compact()`가 수동 압축 경로다. `packages/3xhaustpi` CLI를 경유하지 않는다.
- **별도 3xhaustpi 네이티브 경로:** `packages/3xhaustpi/src/agent-runtime-project.ts`가 coding-agent의 `AgentSessionRuntime`을 만들고, 일반 요청은 `executeAgentTask()` → `session.prompt()`, 수동 압축은 `compactExclusive()` → `session.compact()`로 보낸다. 두 경로가 같은 coding-agent 압축기를 사용한다.
- 실제 수정 대상은 `packages/coding-agent/src/core/compaction/compaction.ts`다. 자동 압축은 `AgentSession.prompt()` 전송 전 검사와 `_handlePostAgentRun()` → `_checkCompaction()` → `_runAutoCompaction()`에서 이 구현을 사용한다. `packages/agent/src/harness/compaction/`에는 별도의 새 harness 구현이 있지만 위 경로의 압축 실행기는 아니다. 이번 변경을 그쪽에 무조건 복제하지 않았다.
- `packages/pi-adapter/src/compaction.ts`는 semantic 경로에서 선언된 프로젝트 증거 텍스트의 앞부분을 해시 표식으로 대체하고 꼬리를 유지하는 별도 기능이다. 대화 기억 요약기가 아니므로 수정하지 않았다.

## 기억의 저장과 재구성

`SessionManager`는 원본 메시지, 도구 호출·결과, 메타데이터, 압축 엔트리를 `id`/`parentId` 트리로 저장한다. 압축은 원본을 삭제하지 않고 `summary`, `firstKeptEntryId`, `tokensBefore`, `details`, `usage`를 가진 엔트리를 추가한다. 현재 브랜치의 최신 압축 요약 + 남겨 둔 최근 메시지 + 압축 뒤의 새 메시지가 모델 문맥이 된다.

coding-agent 자체의 대화 압축 경로에는 별도의 자동 사용자 사실 데이터베이스나 정확한 지시 원문 보관소가 없다. AGENTS.md 등 프로젝트 지침은 리소스 로더가 시스템 프롬프트에 구성하고, 대화 속 지시·결정·미완료 작업은 최근 원문 또는 압축 요약에 의존한다. 원본 세션에 남아 있는 사실도 활성 모델 문맥에서 빠지면 자동으로 회상되지는 않는다.

**Ondra 장기 기억은 별도 계층이다.** Ondra `src/engine/memory.ts`는 `AppState.memory`에 global/space/project 범위의 짧은 사실을 저장한다. 추가 시 600자 제한이며 벡터 검색은 없다. `src/state/store.ts`의 지연 저장과 Rust `state_save()`를 거쳐 앱 데이터 `state.json`에 보관한다. `src/engine/prompts.ts memoriesFor()`가 범위를 필터링하고 `taskSystem()`이 시작 시 시스템 지침으로 주입한다. 진행 중인 작업에 기억 변경이 즉시 다시 주입되는 것은 아니다. captain은 변경 기억을 user 메시지로 전달한다. 이 저장소·주입 정책은 이번 엔진 변경에서 수정하지 않았다. 실제 사용자 기억 데이터는 열지 않았다.

Ondra 작업 세션은 앱 데이터 `sessions/<taskId>` 등에 저장된다. 별도 3xhaustpi의 SQLite `state.sqlite` 및 복구 체크포인트와는 다른 저장소다.

기존 반복 압축은 이전 `firstKeptEntryId`부터 다시 수집하므로 앞선 압축에서 남긴 메시지도 최근 창 밖으로 이동하면 다음 요약에 포함한다. 이것은 유지한다. 도구 파일 경로는 LLM 출력과 별도로 `details.readFiles`/`modifiedFiles`에 누적한다.

## 발견한 위험과 구현

| 위험 | 변경 |
| --- | --- |
| 분할된 턴만 새로 요약할 때 이전 요약이 `No prior history.`로 대체됨 | 새로 요약할 history가 없으면 이전 요약 본문을 그대로 재사용; 불필요한 재요약 호출도 없음 |
| 이전 요약의 모든 완료 항목을 계속 누적하라는 지시와 임의 삭제 허용이 혼재 | 활성 사용자 지시·금지, 결정과 근거, 미완료·차단 사항, 정확한 도구·세션 식별자 우선; 침묵은 해결로 취급하지 않으며 명시적 대체·해결만 반영 |
| 파일 목록을 LLM에 다시 보내고 새 목록을 또 붙임 | 엔진이 만든 정확한 후행 footer만 제거하고 누적 details에서 다시 생성; 확장 소유 요약은 건드리지 않음 |
| history와 prefix가 각각 reserve의 80%, 50%를 사용할 수 있음 | history 최대 4096, prefix 최대 2048; 분할 시 reserve의 각각 50%, 30% 이하로 배분; 모델 출력·문맥 한도도 적용 |
| 도구별 결과 축약만 있고 요약 요청 전체 입력 예산은 없음 | 시스템·지시·이전 요약·출력·framing을 포함한 보수적 UTF-8 byte 상한; 긴 대화는 시간순 배치, 도구 호출/결과는 같은 배치 |
| 길이 제한·빈 응답·중단된 결과가 정상 요약처럼 저장될 수 있음 | 실패로 처리해 원본 문맥 유지; 중간 배치 요약도 최종 성공 전에는 저장하지 않음; 자동 압축의 취소 이벤트도 정규화 |
| 사용자 지정 압축 초점이 분할 prefix 요청에 전달되지 않음 | history와 prefix 및 후속 배치 모두 동일 초점 전달 |

기본 출력 상한은 단일 history 13,107 → 4,096 토큰, 분할 합계 21,299 → 6,144 토큰이다. 이는 생성 허용량의 감소이지 실측 청구 토큰이나 실제 모델 회상률 향상을 뜻하지 않는다. 단일 요청에 들어가는 입력은 일부러 보수적으로 계산하므로 배치가 늘면 이전 요약·지시 재입력 비용이 추가될 수 있다. 추론 토큰도 출력 예산을 소모할 수 있다.

## 접두 문맥과 동시 작업 경계

Ondra의 `PI_CACHE_RETENTION=long`, 메인의 변경분만 전송하는 방식, rewind의 fork 사용을 전제로 했다. 캐시 옵션, provider 라우팅, cache affinity, 메인 session ID, `get_session_stats` 구현은 바꾸지 않았다. `agent-session.ts` 변경은 자동 압축 catch의 취소 분류에만 한정한다.

압축 성공은 기존 대화 앞부분을 새 요약으로 바꾸므로, 그 경계 뒤의 이전 캐시 접두는 재사용할 수 없다. 시스템/도구 접두의 재사용은 provider별로 가능하다. 압축 이후에는 저장된 요약과 최근 원문을 그대로 사용하고 평상시 매 턴 기억 블록을 재작성하지 않는다. 따라서 다음 압축 전까지 변경분을 덧붙이는 prefix 안정성은 유지된다. 성공적인 압축은 짧아진 새 prefix의 재사용 출발점이며, 배치 요약의 임시 중간 결과를 메인 프롬프트에 주입하지 않는다.

Ondra rewind는 `tasks.ts forkAt()` → RPC fork → `AgentSessionRuntime.fork()` → `SessionManager.createBranchedSession()`으로 선택한 user 메시지 직전까지 새 세션에 복사한다. 원본과 그 이후 압축 요약을 현재 경로에 억지로 포함하지 않으며, 파일 변경 자체를 되돌리지는 않는다. fork/rewind 저장 형식 및 브랜치 선택 로직은 바꾸지 않았다. 현재 경로의 이전 요약만 사용하므로 전역 mutable 메모리에서 다른 브랜치의 미래 결정을 가져오는 새 경로도 만들지 않았다.

fork는 session ID가 바뀌며 리소스를 다시 읽을 수 있어 캐시 적중을 보장하지 않는다. Codex WebSocket delta도 기존 입력+응답의 정확한 접두 및 입력 외 요청 본문 일치가 필요하므로, 압축·system·도구 변경 시 전체 요청 fallback이 정상이다. 위 prefix 회귀 테스트는 같은 세션에서 압축 이후의 정상적인 두 요청을 검증하며 모든 provider의 캐시 적중을 검증하는 것은 아니다. 3xhaustpi의 `installProviderCacheRouting()` wrapper는 Ondra 직접 RPC 경로에는 적용되지 않는다.

## 앱 반영 조건

이 작업은 엔진 **소스와 테스트** 변경이며 실행 중인 Ondra 번들을 교체하지 않았다. Ondra `scripts/bundle.mjs`는 `dist/pi`가 이미 존재하면 엔진 재빌드를 생략한다. 따라서 머지 후 수정된 coding-agent 바이너리를 다시 생성하고 그 산출물로 앱을 번들링해야 반영된다. 별도 worktree 산출물을 선택할 때는 `ONDRA_ENGINE_DIST`를 사용한다. 실제 바이너리의 소스 커밋 일치와 앱 재번들링·실행 검증은 이번 작업에서 수행하지 않았다.

## 검증

신규 `packages/coding-agent/test/suite/compaction-memory.test.ts`는 suite harness와 faux provider만 사용한다.

- 이전 요약이 있고 새 history가 없는 split 경로에서 기존 지시·결정·미완료 작업 본문을 byte 단위 그대로 보존.
- 3회 반복 압축에서 이전 요약 전달, 이전에 남긴 원문 재수집, 파일 경로 누적 및 footer 중복 방지.
- 한국어 장문 80개를 여러 요청으로 처리하며 입력/출력 예산과 모든 메시지의 정확히 한 번 전달 확인.
- 긴 도구 기록에서 호출·명령과 결과를 같은 배치로 유지.
- 압축 뒤 메인에 변경분만 보내는 두 요청의 시스템·체크포인트·기존 메시지 접두가 그대로 유지되는지 확인.
- 기본 출력 상한, 작은 reserve, 작은 모델 출력 한도 확인.
- 빈 응답·길이 중단·취소 및 뒤쪽 배치 실패 시 원본 문맥과 세션 엔트리 불변.
- 단일 초대형 지시는 조용히 자르지 않고 provider 호출 전 실패.

관련 coding-agent suite 및 압축·직렬화·분기·대기열·화면 회귀: 60개 파일, 259개 테스트 통과, 실제 API 요약 테스트 2개 제외. `npm run check`의 lint·의존성·타입·browser smoke 검사 통과. 최초 실패는 복제된 워크트리의 기존 dist 누락과 외부 `PI_PACKAGE_DIR` 때문이었고, 원본의 빌드 산출물을 읽기 전용으로 복제하고 테스트에서 그 환경 변수를 해제한 뒤 통과했다. 빌드·배포·실제 API 요청은 실행하지 않았다. npm 자체는 현재 로컬 설정의 미지원 키 경고를 출력하지만 코드 lint·타입 검사 경고는 없다.

재현 명령(저장된 실제 인증으로 e2e가 켜지지 않도록 해당 환경 변수를 해제):

```sh
cd packages/coding-agent
env -u ANTHROPIC_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u PI_PACKAGE_DIR \
  node ../../node_modules/vitest/dist/cli.js --run test/suite \
  test/compaction.test.ts test/compaction-serialization.test.ts \
  test/compaction-summary-reasoning.test.ts test/compaction-extensions-example.test.ts \
  test/compaction-benchmark-score.test.ts test/agent-session-auto-compaction-queue.test.ts \
  test/branch-summary-extensions.test.ts test/interactive-mode-compaction.test.ts
cd ../..
npm run check
```

## 남은 한계

- 생성형 요약의 의미적 충실도는 프롬프트만으로 보장할 수 없다. faux 테스트는 입력 전달·저장·예산·실패 보존의 결정적 회귀를 검사하며 실제 모델의 회상 품질 평가는 아니다.
- 단일 메시지/도구 교환 또는 기존 체크포인트 자체가 예산을 넘으면 안전하게 실패한다. 자동 절단으로 진행하는 대신 더 큰 문맥의 모델이나 입력 축소가 필요하다.
- 도구 출력 중간 부분, 큰 edit/write 인자 원문은 기존 serializer가 생략한다. 명령·파일·호출 ID·오류 상태와 양 끝은 남지만 모든 중간 증거를 보존하지는 않는다.
- 누적 파일 목록은 정확성을 위해 임의로 버리지 않는다. 아주 많은 파일을 다룬 세션에서는 메타데이터 자체가 커질 수 있다.
- 별도 harness/semantic 압축, 브랜치 요약의 예산 정책, 모델별 tokenizer 기반 예산, 장기 검색 기억은 별도 후속 범위다.
- Ondra 기억 중복 판정의 space 구분 누락 및 captain이 압축 뒤 누락된 기억을 다시 보내는지 여부는 별도 앱 계층 검토 항목이다. 이번 엔진 압축 수정으로 해결했다고 보지 않는다.
- 읽기 확인한 Ondra `captain.ts tidy()`는 문맥 사용률이 60%를 넘으면 `compact`가 아니라 `new_session`을 요청한다. 이후 최근 대화의 짧은 recap과 기억을 다시 전송하므로, 그 세션 교체에서 생기는 상세 대화 손실은 이번 compaction 개선만으로 해결되지 않는다. 메인의 rollover 정책을 바꾸려면 별도 Ondra 변경이 필요하다.
- `docs/session-format.md`의 retainedTail 체크포인트 설명은 현재 coding-agent의 firstKeptEntryId 구현과 다르다. 위 설명과 테스트는 실제 src의 경계 방식에 맞췄다.
