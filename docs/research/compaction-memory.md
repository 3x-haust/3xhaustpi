# 기억·압축 조사 및 개선

## 실제 실행 경로

- 네이티브 엔진은 `packages/3xhaustpi/src/agent-runtime-project.ts`에서 coding-agent의 `AgentSessionRuntime`을 만들고, 일반 요청은 `executeAgentTask()` → `session.prompt()`, 수동 압축은 `compactExclusive()` → `session.compact()`로 보낸다.
- 실제 수정 대상은 `packages/coding-agent/src/core/compaction/compaction.ts`다. `packages/agent/src/harness/compaction/`에는 별도의 새 harness 구현이 있지만 이 네이티브 경로의 압축 실행기는 아니다. 이번 변경을 그쪽에 무조건 복제하지 않았다.
- `packages/pi-adapter/src/compaction.ts`는 semantic 경로에서 선언된 프로젝트 증거 텍스트의 앞부분을 해시 표식으로 대체하고 꼬리를 유지하는 별도 기능이다. 대화 기억 요약기가 아니므로 수정하지 않았다.

## 기억의 저장과 재구성

`SessionManager`는 원본 메시지, 도구 호출·결과, 메타데이터, 압축 엔트리를 `id`/`parentId` 트리로 저장한다. 압축은 원본을 삭제하지 않고 `summary`, `firstKeptEntryId`, `tokensBefore`, `details`, `usage`를 가진 엔트리를 추가한다. 현재 브랜치의 최신 압축 요약 + 남겨 둔 최근 메시지 + 압축 뒤의 새 메시지가 모델 문맥이 된다.

별도의 자동 사용자 사실 데이터베이스나 정확한 지시 원문 보관소가 이 경로에 있는 것은 아니다. AGENTS.md 등 프로젝트 지침은 리소스 로더가 시스템 프롬프트에 구성하고, 대화 속 지시·결정·미완료 작업은 최근 원문 또는 압축 요약에 의존한다. 원본 세션에 남아 있는 사실도 활성 모델 문맥에서 빠지면 자동으로 회상되지는 않는다.

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

fork/rewind 저장 형식 및 브랜치 선택 로직은 바꾸지 않는다. 현재 경로의 이전 요약만 사용하므로 전역 mutable 메모리에서 다른 브랜치의 미래 결정을 가져오는 새 경로도 만들지 않았다.

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
