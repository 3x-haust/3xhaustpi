# H5: GPT-6 모델 카탈로그와 0.2.7 준비

- 조사 범위: [코드확인] OpenAI/Codex 모델 생성·스냅샷·제품 런타임 해석과 0.2.7 준비.
- 확인한 것: [코드확인] 명시적 외부 갱신, 두 provider 스냅샷, 실제 `createProviderRuntime → resolveModel` 경로, 오프라인 테스트와 로컬 CI 빌드.
- 못 확인한 것: 실제 유료 API·OAuth 요청과 원격 CI의 다른 OS. 네트워크 모델 호출과 배포는 수행하지 않았다. 전체 저장소를 조사한 것은 아니다.

## 갱신과 보강

- [코드확인] PR #15의 `npm --prefix packages/ai run generate-models`를 실행했다. models.dev·NVIDIA NIM·OpenRouter·Vercel AI Gateway 조회가 성공했다. models.dev의 `openai`에는 네 GPT-6 모델이 모두 있었고, `openai-codex`는 생성기의 명시적 목록을 사용한다.
- [코드확인] `openai`의 외부 모델 정보는 유지하고, 빠진 장문 요금 tier를 보강했다. Codex에는 공식 모델 정보를 수동 보강했다. 이후 외부 카탈로그에서 모델이 빠져도 두 provider의 해당 모델을 생성할 수 있다.
- [코드확인] 다른 provider의 갱신 결과는 제외하고 기존 커밋 내용을 유지했다. 합쳐진 최종 스냅샷은 기존 `createModelDataManifest`로 manifest를 다시 생성하고 검증했다. wrapper·aggregator는 내용 변경이 없다.
- [코드확인] 제품의 고정 의존성 `pi-ai@0.84.3`에는 새 Codex 모델이 없으므로, 제품 번들에 저장소의 두 카탈로그에서 GPT-6 항목을 포함했다. 공급자 스트림·인증은 기존 구현을 사용한다. 기본 선택 모델은 바꾸지 않았다.

## 모델 정보

[문서확인] 2026-10-22 공식 모델 페이지에서 확인한 Standard 가격이다. 단위는 USD/1M tokens이며 구독 사용량 청구액과는 다르다.

| ID | 입력 | 캐시 입력 | 출력 | 캐시 쓰기 |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` | 10 | 1 | 50 | 12.5 |
| `gpt-6.1-sol` | 2 | 0.1 | 10 | 2.5 |
| `gpt-6-sol` | 2 | 0.2 | 10 | 2.5 |
| `gpt-6-luna` | 0.1 | 0.01 | 0.5 | 0.125 |

- [문서확인] 네 모델 모두 1,050,000 context, 최대 출력 128,000이며 텍스트·이미지 입력과 reasoning을 지원한다. 입력 272,000 초과 요청 전체에 입력·캐시 요금 2배, 출력 1.5배를 적용한다.
- [문서확인] Astra·6.1 Sol은 low/medium/high/xhigh/max, Sol·Luna는 여기에 none을 지원한다. minimal은 공식 effort로 추가하지 않았다.
- [코드확인] Codex의 UI minimal은 기존 GPT-5.6 관례처럼 low로 매핑한다. off는 Sol·Luna에서 none, Astra·6.1 Sol에서 미지원(null)이다. 확인하지 않은 추가 기능 지원 플래그는 넣지 않았다.
- [문서확인] Codex 가격 문서에는 네 모델의 구독 사용량·크레딧 정보가 있다. 개별 계정의 활성화·한도는 확인하지 않았다.

## 검증

[코드확인] Node 24.11.0, npm 11.6.1의 로컬 결과다. 테스트는 API 키 없는 빈 환경과 임시 HOME에서 실행했다.

| 검사 | exit code | 결과 |
| --- | --- | --- |
| 루트 `npx tsgo --noEmit` | 2 → 0 | 외부 전체 갱신 상태의 타입 오류는 타 provider 변경 제외 후 0 오류 |
| `npm run check` | 1 → 0 | lock 재생성 후 shrinkwrap·install-lock을 재생성하여 통과 |
| pinned-deps / shrinkwrap / install-lock check | 0 / 0 / 0 | 전체 check에 포함 |
| 3xhaustpi vitest `--maxWorkers=4` | 0 | 97파일, 484검사 통과; 실제 모델 해석 8건 포함 |
| AI vitest `--maxWorkers=4 --exclude '**/*e2e*'` | 0 | 92파일·694검사 통과, 자격증명 필요 등 749검사 skip |
| CI Build consumed packages 명령 10개 | 각각 0 | hydrate, AI offline, agent, tui, coding-agent, semantic-contract, core, pi-adapter, pi-session, 3xhaustpi |

- [코드확인] 새 파일은 생성기 보강, 제품 카탈로그 결합, 각 회귀 검사로 역할을 나눴다. 새 코드에 any·동적 import·타입 강제 변환을 추가하지 않았다. 기존 대형 파일에는 import와 호출만 변경했다.
- [코드확인] PR #16처럼 제품 package version·product identity·CHANGELOG를 0.2.7로 준비했다. lock은 npm으로 재생성했고 의존성 버전·integrity 변경 없이 peer/libc 메타데이터 변경이 있어 파생 lock도 재생성했다.
- [코드확인] 기존 npm의 min-release-age 설정 경고, 의존성 deprecation 안내와 Node 실험 기능 경고는 코드 진단 오류와 구분한다.

## 출처 목록

- 공개 소스 / 코딩 하네스: https://github.com/3x-haust/3xhaustpi , 기준 커밋 `c7fde03` (0.2.6 준비), SPDX `MIT`.
- https://github.com/3x-haust/3xhaustpi/pull/15 : 스냅샷·오프라인 빌드 관례, `3xhaust/model-catalog-build.md:19`.
- https://github.com/3x-haust/3xhaustpi/pull/16 : 제품만 버전 변경하는 릴리스 준비 관례.
- https://models.dev/api.json : 외부 OpenAI 모델 입력. `packages/ai/src/providers/data/openai.json:1`, `openai-codex.json:1`, `.manifest.json:1`.
- https://developers.openai.com/api/docs/pricing : Standard와 장문 요금.
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://developers.openai.com/api/docs/models/gpt-6.1-sol
- https://developers.openai.com/api/docs/models/gpt-6-sol
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/codex/pricing (https://learn.chatgpt.com/docs/pricing 로 이동): 구독 모델·크레딧 목록.
- `packages/ai/scripts/openai-gpt6-models.ts:1`: 공식 출처·fallback·장문 요금 보강. `packages/ai/scripts/generate-models.ts:2413`: 생성기 연결.
- `packages/3xhaustpi/src/builtin-models.ts:1`: 배포 번들 카탈로그 결합. `packages/3xhaustpi/src/provider-runtime.ts:210`, `:283`: 실제 런타임·모델 해석.
- `packages/3xhaustpi/test/gpt6-models.test.ts:1`, `packages/ai/test/openai-gpt6-models.test.ts:1`: 모델 해석·외부 metadata 유지·누락 fallback 회귀 검사.
- `.github/workflows/3xhaust-compat.yml:83`: 재현한 CI 빌드 단계.
