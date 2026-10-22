# H3: 모델 카탈로그 빌드 복구

- 조사 범위: `packages/ai` 모델 생성·hydrate·검증, compatibility 빌드, 9월 이후 upstream candidate 실패 단계.
- 확인한 것: [코드확인] 외부 provider 키 변경, Git에서 제외된 JSON 데이터, 외부 카탈로그 변화로 인한 타입 오류 54건, 로컬 빌드·검사 결과.
- 못 확인한 것: 실제 provider의 유료 API 호출, 수정 후 원격 CI의 세 OS 실행. push·PR은 수행하지 않았다. 정기 실행 7건의 실패 단계는 확인했으며 상세 오류 로그는 9월 7일·10월 19일 두 건만 읽었다.

## 원인

- [코드확인] 기존 CI는 hydrate 때마다 models.dev, NVIDIA NIM, OpenRouter, Vercel AI Gateway를 조회했다. JSON은 `.gitignore`에만 지정되어 있고 커밋되지 않았다. 생성 wrapper는 JSON에서 모델 ID와 API 타입을 유도한다. 따라서 외부 모델 삭제·API 추가가 기존 provider 및 테스트의 타입을 바꿨다. wrapper 생성 산출물의 누락이 주원인은 아니다.
- [문서확인] 2026-10-22 직접 받은 `https://models.dev/api.json`에는 `kimi-for-coding` provider가 없다. `kimi-code-plan-cn`과 `kimi-code-plan-global`이 있으며, 각각 `api.kimi.com`과 `api.kimi.ai`를 가리킨다. 응답 SHA-256: `efdb7108a4546cbab7ef034628a1f0ca782e2cfd5d30cbcfa3ad506cee7ec5de`.
- [코드확인] 기존 생성기는 없어진 키만 조회했다. `--data-only`는 기존 wrapper에 필요한 provider를 확인하다 `Cannot hydrate missing providers: kimi-coding`으로 중단했다. compatibility run `39711044987`의 세 OS 로그에서 동일하다.
- [코드확인] 수정 전 루트 `npx tsgo --noEmit`은 exit 2, `error TS` 54건이었다. Kimi 데이터 누락 이외에도 Together/OpenRouter/Copilot 등의 모델 ID 삭제, OpenCode Go의 Google API 추가, Fireworks의 API 추론 변화가 포함되었다.
- [코드확인] 9월 7일~10월 19일 정기 실행 7건은 모두 `Open source-port candidate pull request` 단계에서 실패했다. 9월 7일·10월 19일 로그의 오류는 `Resource not accessible by integration (createPullRequest)`다. 해당 workflow에는 모델 빌드가 없다. 이번 모델 수정과 별개이며 workflow 권한·저장소 설정은 변경하지 않았다.

## 수정 및 스냅샷 출처

- [코드확인] `src/providers/data/*.json`과 `.manifest.json`을 커밋 대상으로 바꿨다. `hydrate-model-data`는 네트워크 없이 스냅샷을 검증한다. 일반 `build`도 `build:offline`을 사용한다. 데이터 누락·스키마·해시 불일치는 기존 검증기로 실패한다.
- [코드확인] 외부 갱신은 `npm --prefix packages/ai run generate-models`로 명시적으로 실행한다. `generate-model-catalog`는 기존처럼 JSON 전용 외부 카탈로그 출력이다. 갱신 시 데이터 diff, 타입 검사, 오프라인 테스트를 검토하고 스냅샷과 manifest를 함께 커밋해야 한다. 기본 빌드는 최신 모델 목록을 보장하지 않는다.
- [코드확인] Kimi 입력은 기존 China endpoint와 일치하는 `kimi-code-plan-cn`으로 변경했다. regional catalog를 섞지 않는다. Groq Qwen3.6의 `none`/`default` effort 매핑도 생성기에 명시해 기존 payload 회귀 검사를 만족시켰다.
- [문서확인] 기본 스냅샷은 공개 npm `@earendil-works/pi-ai@0.82.1`의 `dist/providers/data/`다. upstream gitHead: `b4f293684bba718d59cc1157679bcf6157b3a7f5`, 라이선스 MIT. tarball SHA-512를 registry `dist.integrity`와 대조했다.
- [문서확인] 기존 테스트가 요구하지만 기본 배포본에 없는 다음 5개 모델은 공개 `@earendil-works/pi-ai@0.84.3`에서 가져왔다. gitHead: `bfb004d4418ff05c6f909eaaab856cbe75c1fde0`, 라이선스 MIT. 이 tarball도 integrity를 대조했다. 패키지는 설치·실행하지 않고 JSON만 읽었다.
  - Fireworks: `accounts/fireworks/routers/kimi-k3-fast`
  - Groq: `qwen/qwen3.6-27b`
  - Z.AI: `glm-5.2-highspeed`, `glm-5.3`
  - Cloudflare AI Gateway: `claude-sonnet-4.5`
- [코드확인] 위 입력을 합친 뒤 이 저장소 생성기의 metadata 처리·직렬화·검증 경로로 다시 생성했다. Fireworks 추가 모델은 현재 생성기의 Anthropic endpoint·compat를 적용했다. Copilot effort override 및 Z.AI `max_tokens` 등도 현재 생성기 설정을 적용했다. wrapper 및 aggregator의 내용 변경은 없었다.

| npm 버전 | tarball SHA-512 (Base64) |
| --- | --- |
| 0.82.1 | `3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==` |
| 0.84.3 | `M0YUV8vNO3y2WwWSyY8ijKJV5W4gkSUixuvk+Z00ZBjsyMfsdXfITsHEwP1UIf09YRWXT6oGn0GlCamt+P32XQ==` |

## 검証

[코드확인] 로컬 Node 24.11.0에서 실행했다. CI의 Node 22.19.0·다른 OS는 원격 재검증하지 않았다.

| 검사 | exit code | 결과 |
| --- | --- | --- |
| `npm ci --ignore-scripts` | 0 | lockfile 변경 없음 |
| compatibility의 Build consumed packages 명령 10개 | 0 | hydrate → AI offline → agent → tui → coding-agent → semantic-contract → core → pi-adapter → pi-session → 3xhaustpi |
| 루트 `npx tsgo --noEmit` | 2 → 0 | 타입 오류 54 → 0 |
| `npm run check` | 0 | Biome 수정 없음, 잠금·타입·browser smoke 통과 |
| 3xhaustpi vitest 전체 | 1 → 0 | 첫 실행 worker 시작 5초 timeout 1건. `--maxWorkers=4` 재실행: 96파일·476검사 통과 |
| AI vitest, `--maxWorkers=4 --exclude '**/*e2e*'` | 1 → 0 | 초기 스냅샷 metadata 4건 수정 후 91파일·692검사 통과, 자격증명 필요 검사 749건 skip |
| 새 hydrate·regional JSON 생성 회귀 검사 | 0 | 2건 통과. 네트워크 차단 hydrate 및 서로 다른 지역 fixture 검증 |

[코드확인] vitest는 빈 환경과 임시 HOME에서 실행하고 API 키를 전달하지 않았다. npm의 기존 `min-release-age` 설정 경고와 Node SQLite 실험 기능 경고는 발생했다. 검사 실패를 숨기거나 테스트를 삭제하지 않았다.

## 출처 목록

- 공개 소스 / 코딩 하네스: https://github.com/3x-haust/3xhaustpi , 기준 커밋 `edd47b0ecad2fd4ddff702526bc6a93faf3d59ec`, MIT.
- `packages/ai/package.json:52-60`: 모델 생성·hydrate·빌드 명령.
- `packages/ai/scripts/generate-models.ts:1813-1859`: Kimi 변환. `:2034-2048`: offline hydrate와 외부 갱신 분기.
- `packages/ai/scripts/model-data.ts:186-272`: schema, structure hash, 파일 hash, model 검증.
- `packages/ai/src/model-catalog.ts:1-28`: JSON 기반 타입 유도.
- `packages/ai/src/providers/data/.manifest.json:1`: 최종 스냅샷 파일 해시.
- `.github/workflows/3xhaust-compat.yml:83-95`: 로컬 재현한 빌드 단계.
- `.github/workflows/3xhaust-upstream-sync.yml:86-98`: 별도 실패의 PR 생성 단계.
- https://github.com/3x-haust/3xhaustpi/actions/runs/39711044987 : compatibility 실패 로그.
- https://github.com/3x-haust/3xhaustpi/actions/runs/34128055083 , https://github.com/3x-haust/3xhaustpi/actions/runs/39271867675 : 상세 확인한 정기 실행 로그.
- https://models.dev/api.json : 현재 provider 키·endpoint·Groq reasoning_options 직접 조회.
- https://registry.npmjs.org/@earendil-works/pi-ai/0.82.1 , https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.82.1.tgz : 기본 스냅샷.
- https://registry.npmjs.org/@earendil-works/pi-ai/0.84.3 , https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.84.3.tgz : 명시한 추가 모델.
