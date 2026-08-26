# 3xhaustPi

3xhaustPi는 모델이 파일 경로, shell command, 권한, timeout, 실제 tool 이름을
만들지 못하게 분리한 로컬 coding runtime입니다. CLI/TUI와 Desktop app
앱은 같은 `3xhaustpi/runtime` 패키지를 사용합니다.

> 배포 상태: `3xhaustpi@0.1.8`는 npm public registry에 게시됐습니다.
> 2026-08-22 깨끗한 임시 global prefix에서 설치한 뒤 `--help`, `--version`,
> 잘못된 옵션 거부와 72x24 TUI의 idle telemetry, `/help`, `/exit`를 검증했습니다.

## 1. 설치

기본 설치 명령은 다음과 같습니다.

```bash
npm install -g 3xhaustpi
3xhaustpi
```

현재 소스 checkout에서는 같은 package를 tarball로 검증할 수 있습니다.

```bash
npm pack ./packages/3xhaustpi
npm install -g ./3xhaustpi-0.1.9.tgz
3xhaustpi --version
```

Node/Python이 없는 환경은 아래의 플랫폼별 native archive를 사용합니다.
archive에는 실행 runtime, Node, Python, runtime manifest와 대상 플랫폼의 OS
credential-store 모듈이 포함됩니다.

## 2. 계정 추가와 관리

OpenAI Codex OAuth:

```bash
3xhaustpi account add
```

로그인 URL을 기본 브라우저에 열고 grant가 끝나면 credential을 macOS
Keychain, Windows Credential Manager 또는 Linux Secret Service에 저장합니다.
추가한 Codex OAuth 계정은 각각 보존되며 다음 명령으로 목록, 전환, 삭제합니다.

```bash
3xhaustpi account
3xhaustpi account use 2
3xhaustpi account delete 2
```

대화형 TUI에서 `/account`를 열면 화살표로 계정과 동작을 이동하고 Enter로
선택할 수 있습니다. 활성 계정은 `▶`, 저장된 다른 계정은 `○`로 표시되며,
삭제 화면은 Cancel이 기본 선택입니다. `/account add`, `/account use <number>`,
`/account delete <number>` 직접 명령도 유지됩니다.
`~/.3xhaust/auth.json`에는 provider/type/storage metadata만 mode `0600`으로
남습니다. 기존 secret-bearing JSON은 OS store write/readback 검증 후
metadata-only 형식으로 자동 마이그레이션합니다. API-key provider와 사용
가능한 OAuth/subscription provider는 다음 명령으로 확인합니다.

```bash
3xhaustpi models
```

지원 catalog에는 OpenAI, OpenAI Codex, Anthropic, Google, OpenRouter가
포함됩니다. 실제 로그인 방식은 provider가 제공하는 auth transport에
따릅니다.

## 3. 첫 실제 작업

현재 프로젝트에서 대화형 TUI:

```bash
3xhaustpi
```

한 번의 요청을 바로 실행:

```bash
3xhaustpi -p "로그인 오류를 조사하고 수정해"
3xhaustpi --project ./my-project -p "실패하는 테스트를 조사하고 수정해"
```

런타임은 다음 고정 경계를 사용합니다.

```text
사용자 요청
→ 실제 LLM
→ Intent
→ Recipe
→ Capability
→ Policy
→ Executor
→ Observation
→ PatchProposal
→ diff 승인
→ applyPatch
→ getDiagnostics
```

모델 출력에는 actuator authority가 없습니다. `searchText`,
`searchSymbol`, `readRanges`, `applyPatch`, `getDiagnostics`의 실제 입력과
timeout, revision, permission은 host가 결정합니다. provider가 raw tool call을
반환하거나 patch revision이 stale이면 fail-closed로 거부합니다.

## 4. 프로젝트와 session

```bash
3xhaustpi --project ./my-project
3xhaustpi --resume
```

SQLite에는 project/session/request queue/checkpoint/outbox/observation/
approval/patch journal/cache 상태를 저장합니다.

- `/project`와 `/resume`으로 project와 저장된 Pi conversation을 검색하고
  전환합니다.
- `/new`는 새 conversation generation을 시작합니다.
- TUI 입력은 실행 전에 SQLite queue에 먼저 저장됩니다.
- 실행 중 follow-up은 FIFO로 처리되고, TUI process가 종료되어도 다음 실행에서
  대기 요청을 복원합니다.
- request fingerprint와 ID로 중복 실행을 차단합니다.
- line-range context는 다음 요청에 bounded context로 붙습니다.
- process crash 뒤 execution recovery는 해당 project의 durable checkpoint를
  자동으로 안전하게 claim하거나 명시적인 repair 상태를 표시합니다.
- 상태 조회나 화면 refresh는 실행 상태를 변경하지 않습니다. interrupted
  recovery는 resume 경계에서만 명시적으로 수행합니다.
- provider가 요청을 받았는지 불명확하면 `indeterminate`로 남기고 자동
  재전송하지 않습니다.
- stale revision과 patch conflict는 적용 전에 차단합니다.

Desktop app은 같은 runtime의 `runCodingTask`와 `resumeCodingTask`를
utility process/MessagePort로 호출합니다. 별도 coding runtime을 두지
않습니다.

## 5. 모델과 계정

```bash
3xhaustpi models
```

Desktop app의 Connections 화면은 같은 provider의 여러 account를
priority, measured usage, availability, sticky lease, cooldown으로 선택합니다.
HTTP 429/quota/5xx/auth 실패를 분류하고 `Retry-After`가 있으면 반영합니다.
cooldown 중인 account는 다음 task에서 제외되고 만료 뒤 다시 후보가 됩니다.

CLI의 OS credential store와 Electron의 account secret store는 renderer 또는
model prompt에 credential을 노출하지 않습니다. Electron OAuth는 main
process가 짧은 수명의 Node credential broker를 실행해 CLI와 같은 OS
credential store를 읽습니다. broker 출력은 Zod로 검증된 뒤 내부
MessagePort로 utility runtime에만 전달되며 renderer, prompt, application
SQLite에는 기록하지 않습니다.

## 6. diff 승인과 안전 정책

- read capability는 bounded project root와 revision 안에서만 실행됩니다.
- patch는 proposal과 diff를 먼저 만들고 승인 뒤 적용합니다.
- approval ID, patch ID, revision generation은 host가 발급합니다.
- diagnostics command는 recipe가 고정하며 모델이 shell을 생성하지 않습니다.
- extension은 harness, policy, schema, executor를 교체할 수 없습니다.
- raw MCP schema/tool name은 모델에 노출하지 않습니다.

TUI는 black/charcoal 기반의 event-driven ANSI UI입니다. polling loop와
idle redraw는 없고, 작업 중 grayscale shimmer만 120 ms animation timer를
사용합니다. coding runtime worker는 작업마다 필요할 때 올라오고 완료·실패·
취소 때 process tree 전체를 정리합니다. durable Pi session은 다음 turn에서
다시 열리므로 idle 상태에 V8 worker를 남기지 않습니다.
하단 identity rail은 측정된 context token/limit/percent를 항상 표시합니다.
1% 미만은 두 자리 정밀도를 유지하며, `/compact`가 too-small no-op이면 같은
context budget을 결과에 포함합니다. `/goal <text>`는 project-scoped intent를
저장하고 footer와 `/status`에 표시합니다. `/goal done`은 완료,
`/goal clear`는 제거입니다.
`/settings`의 Cache warming은 project별 opt-in입니다. 활성화하면 eligible
conversation의 prompt cache를 provider TTL 전에 최대 16 output token의
비변경 요청으로 갱신하고, `/status`에 iteration, 다음 wake 시각, provider
usage 기반 예상 절감액을 표시합니다. project/session 전환과 foreground 작업은
예약 또는 진행 중인 wake를 즉시 취소합니다.
`Ctrl+V`로 이미지를 붙이면 composer의 각 `[imageN]` token 바로 위에
metadata-free bounded thumbnail이 보이고, 입력·chat transcript에는
`[image1]` placeholder가 그대로 남습니다.
긴 텍스트는 첫 `Cmd+V`에서 `[paste #N …]`으로 축약되고 같은 내용을 바로
한 번 더 `Cmd+V`하면 중복 삽입 없이 원문이 composer에 펼쳐집니다.
resized image payload는 텍스트와 분리해 durable queue와 native agent
runtime으로 전달합니다.

Compaction serializer는 private reasoning과 대형 edit/write body를 digest로
줄이면서 exact path, command, tool call ID, error head/tail을 보존합니다.
로컬 속도·품질 gate는 provider 호출 없이 실행됩니다.

```bash
npm run benchmark:compaction --workspace=@earendil-works/pi-coding-agent -- --check
```

외부 앱 Computer Use도 `/settings`의 Integrations에서 실행할 수 있습니다.

앱과 accessibility role/name을 먼저 관찰하고, semantic click은 `y/n`
검토를 통과해야 실행됩니다. TUI 명령에는 좌표 입력이 없습니다.

## 7. Skill, MCP, Memory, Computer Use

```bash
3xhaustpi extension list
```

Desktop app은 다음 경계를 제공합니다.

- Skill: bounded instruction context만 추가
- MCP: host가 stdio initialize/list/invoke를 수행하고 read-only tool만 opaque
  capability로 변환
- Memory: global/project scope 분리
- Computer Use: embedded browser와 macOS 외부 앱 모두 accessibility
  element를 우선 사용
- 좌표 click: semantic target이 없고 main host가 현재 observation과 좌표에
  대해 발급한 approval digest까지 일치할 때만 fallback

Computer Use accessibility observation은 digest로 고정됩니다. stale digest,
ambiguous role/name, 미승인 좌표 fallback은 거부됩니다.

macOS 외부 앱은 3xhaustPi의 `desktop-runtime`이 System Events 접근성 트리를
bounded observation으로 읽고, Electron의 Desktop surface가 같은 host를
사용합니다. 실제 격리 Calculator 프로세스에서 26개 element 관찰,
accessibility `AXPress`, action 뒤 digest 변경, renderer가 만든 가짜 좌표
approval 차단을 검증했습니다. 증거는
`../3xhaustdesktop/artifacts/native-desktop-computer-use.json`과
`../3xhaustdesktop/artifacts/g044-native-desktop-computer-use.png`입니다.
Pi TUI의 앱 목록→관찰→검토→semantic action 흐름은
`../3xhaustdesktop/artifacts/g045-tui-computer-use.png`로 검증했습니다.

Windows는 UI Automation PowerShell host, Linux는 AT-SPI 2 Python host를 같은
`desktop-runtime` 경계에 연결했습니다. 두 adapter 모두 앱 목록, bounded
role/name observation, click/type/key/scroll과 승인된 좌표 fallback protocol을
구현하며 stale·ambiguous·미승인 좌표 정책은 플랫폼 helper 실행 전에 공통
host가 검사합니다. win32/linux fixture protocol 4/4와 PowerShell parser,
Python syntax는 통과했습니다. linux-arm64와 linux-x64 native archive는
Ubuntu 24.04의 Xvfb/D-Bus/GTK 3/AT-SPI 2 세션에서 실제 `Run` button을
accessibility로 눌러 `Completed` 상태와 digest 변경까지 검증했습니다.
x64 bundled Node도 `linux/x64`를 직접 보고했습니다. Windows 실제 desktop
action은 아직 미검증입니다. 증거는
`../3xhaustdesktop/artifacts/cross-platform-computer-use.json`과
`../3xhaustdesktop/artifacts/native-linux-atspi-computer-use.json`,
`../3xhaustdesktop/artifacts/native-linux-x64-atspi-computer-use.json`입니다.

## 8. 실제 benchmark

현재 coding-agent TUI 기능·UX·성능 비교와 구현 격차는
[`docs/tui-competitive-comparison-2026-08-26.md`](docs/tui-competitive-comparison-2026-08-26.md)에
근거·한계·우선순위와 함께 기록합니다.

실제 provider paired benchmark:

```bash
3xhaustpi benchmark --real --repetitions 50 --project /path/to/project
```

2026-07-31 `openai-codex/gpt-5.6-terra`, 동일 fixture/evidence/validator,
교차 실행 순서에서 얻은 최신 acceptance 결과입니다. `searchText` 3개와
`searchSymbol` 2개로 구성된 5-case coding corpus를 각각 예열한 뒤 동일한
요청을 반복 측정했습니다. 예열 표본도 artifact에 별도로 보존합니다.

| Metric | Semantic-only 3xhaustPi | Direct-tool |
| --- | ---: | ---: |
| Paired successes | 50/50 | 50/50 |
| Warm cache-hit requests | 98% | 100% |
| Cached-token ratio | 80.76% | 82.97% |
| Output validity | 100% | 100% |
| Tool/capability success | 100% | 100% |
| Tool latency p50 / p95 | 0.0055 / 0.0177 ms | 0.0048 / 0.0144 ms |
| End-to-end p50 / p95 | 3,184.7 / 5,949.5 ms | 1,591.3 / 2,937.7 ms |
| Successful throughput | 16.54/min | 31.56/min |
| Repair / timeout / orphan | 0 / 0 / 0 | 0 / 0 / 0 |
| Maximum input tokens | 4,663 | 4,327 |

Semantic-only 방식은 model과 actuator authority를 분리하지만 이 표본에서는
direct-tool보다 model-side end-to-end latency와 throughput이 느렸습니다.
이를 숨기지 않습니다.

증거:
`artifacts/real-llm/paired-1785484534806.json`
(SHA-256 `10c3e7ad49de0329565a5c75e5f8276e763b9bef1b74b570483ecfccbd6fdab1`)

Desktop app Performance 화면도 이 corpus metadata와 실제 acceptance를
직접 읽습니다. GUI 검증 캡처는
`../3xhaustdesktop/artifacts/g035-real-benchmark-gui.png`입니다.

local read executor는 동일 400 samples에서 TypeScript/Python 1/4/8 모두
tool success 100%, capability cache 99%, output mismatch 0이었습니다. provider를
호출하지 않으므로 이 측정의 provider cache는 `unmeasured`입니다.

최신 단독 idle 측정:

- Electron 5-run median: ready 666.7 ms, idle CPU median-of-means/max
  0.0345%/0.0803%, whole working set mean/max 346.6/350.3 MiB, renderer mean
  90.2 MiB
- 기존 GUI measured baseline 대비 ready 60.78%, whole working set 20.31% 감소
- TUI 5-run median: CPU mean/max 0%/0%, RSS mean/max 58.41/58.45 MiB
- runtime-worker 분리 전 TUI 5-run median 94.55/94.55 MiB 대비 평균 RSS
  38.23% 감소

2026-08-26 per-operation worker reap 변경은 동일 Node 24, esbuild 설정,
`80x24` PTY event gate와 invalid-model no-provider workload로 기존/candidate
bundle을 각각 5회 비교했습니다.

- idle parent RSS median: 216.80 MiB -> 129.86 MiB, 40.10% 감소
- child-appearance aggregate RSS median: 272.06 MiB -> 188.59 MiB, 30.68% 감소
- post-result aggregate RSS median: 460.30 MiB -> 135.61 MiB, 70.54% 감소
- candidate는 5회 모두 result 뒤 child RSS 0 KiB
- before/candidate bundle SHA-256:
  `5fbe793929a49ef464ab4491c0d4df2d7f276647669ec88b15f64ef3a7fec795` /
  `75a380655b8406cdbc8ffc145a440f469be775c809a7847860a83adcb4abd6fd`

aggregate RSS는 parent/child의 합으로 shared physical page를 중복 계산할 수
있으며, provider-backed 정상 workload의 peak가 아니라 deterministic
invalid-model lifecycle 측정입니다.

Electron actual-provider E2E는 OAuth account route, MCP/Skill/Memory context,
patch proposal/approval, utility process `SIGKILL`, resume, diagnostics와 FIFO
follow-up을 한 흐름에서 검증했습니다. 최신 실행은 provider call 3회, tool
call 3/3 성공, tool duration 368.6 ms였습니다. 집계 증거는
`../3xhaustdesktop/artifacts/performance-comparison.json`, TUI kill/restart 캡처는
`../3xhaustdesktop/artifacts/g042-tui-durable-queue.png`, project/conversation 전환 캡처는
`../3xhaustdesktop/artifacts/g043-tui-project-chat-navigation.png`입니다. TUI worker를
통한 실제 `openai-codex/gpt-5.6-terra` 조사 작업 transcript는
`../3xhaustdesktop/artifacts/tui-worker-real-llm.txt`에 보존했습니다.

## 9. update

```bash
3xhaustpi update
```

update는 npm registry package metadata와 ECDSA signature, tarball integrity를
검증한 뒤 global install을 교체합니다. 새 executable의 version이 metadata와
다르면 사전에 pack한 현재 install을 재설치하고 복원 version을 확인합니다.
rollback까지 실패하면 두 오류를 함께 보고합니다.

## 10. 플랫폼별 다운로드

GitHub Release asset 이름:

```text
3xhaustpi-darwin-arm64.tar.gz
3xhaustpi-darwin-x64.tar.gz
3xhaustpi-linux-arm64.tar.gz
3xhaustpi-linux-x64.tar.gz
3xhaustpi-windows-arm64.zip
3xhaustpi-windows-x64.zip
SHA256SUMS
```

다운로드 후 archive 옆의 `.sha256` 파일로 checksum을 먼저 확인합니다.
`artifacts/native-0.1.9-parity-final`에는 현재 0.1.9 소스로 만든 6개 target archive와
각 checksum이 있습니다. 모든 archive의 checksum과 embedded
`runtime-manifest.json` product/version/target을 확인했고, `cli.js`,
`cli-tui.js`, `cli-full.js`, `runtime.js`, `tui-runtime-worker.js`가 frozen
local `dist`와 byte-identical한지 검증했습니다. 이 빌드는 bundled Node
22.23.1과 Python 3.13.14를 포함합니다. target별 실제 OS 실행 검증은
별도로 필요합니다.

`artifacts/native`, `artifacts/native-0.1.8`, `artifacts/native-0.1.8-final`,
`artifacts/deployment-audit.json`은 기존 0.1.0 검증과 중간 0.1.8 build의
증거이므로 덮어쓰지 않고
보존합니다. 0.1.0 darwin-arm64 증거는 빈 temp directory에서 bundled
Node/Python, macOS Keychain, 기존 OAuth, 실제 provider 작업, 15개 GUI
application Computer Use를 검증한 기록입니다.

같은 darwin-arm64 archive의 실제 Pi TUI에서 `/settings`의 Computer
integration을 열어 현재 실행 중인 15개 GUI application을 accessibility
host로 조회했습니다. 증거는
`../3xhaustdesktop/artifacts/native-tui-computer-use.txt`입니다.

## 11. troubleshooting

상태 점검:

```bash
3xhaustpi doctor
```

자주 확인할 항목:

- `provider credential unavailable`: `3xhaustpi account add [provider]` 실행
- `No durable checkpoint`: 재개 가능한 crashed/paused session이 없음
- `Project revision changed`: 최신 revision에서 proposal을 다시 생성
- `cooldown`: `Retry-After` 또는 bounded cooldown 동안 다른 account를 사용
- `native archive unavailable`: npm/source install에서는 정상이며 native
  bundle에서만 manifest가 있음
- `Python accelerator unavailable`: TypeScript executor로 fallback

## 12. 정확한 미지원·미검증 범위

- windows-arm64, windows-x64 native archive의 실제 대상 머신 smoke
- Windows UI Automation 외부 앱 Computer Use의 실제 대상 desktop action
  smoke
- provider가 cache usage를 보고하지 않는 경우의 cache hit: 추정하지 않고
  `unmeasured`
- 모든 provider의 subscription OAuth: provider transport가 실제 제공하는
  방식만 지원

## 개발 검증

```bash
npm test --workspace=3xhaustpi
npx tsgo --noEmit
npm run build --workspace=3xhaustpi
```

Desktop app:

```bash
cd ../3xhaustdesktop
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:e2e:perf
npm run test:tui:visual
```

## License

MIT
