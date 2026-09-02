# Auxiliary chat release evidence

Captured 2026-09-03 from the production `runTui` surface in a 120x36 PTY. ANSI streams were replayed through
`@xterm/headless` 5.5.0; the resulting terminal buffers were rendered to the paired PNG and text files.
The tested source, including every product and regression change, is commit
`27c066266d618200125ad213dc9795a0c4d9aba0`.

- `model-picker.*`: `/model` with one enabled OpenAI API-key account; only `openai/*` models render.
- `response.*`: submitting `안녕` produces `RESPONSE_OK_안녕` and `TPS 320.0 tok/s`.
- `side-chat.*`: `/side remember SIDE_842`, then `follow up`, advances isolated history from 0 to 1. Reopening
  `/side` after process restart shows both turns. `MAIN_SECRET_731` is absent from this transcript.
- `btw.*`: while main displays `Working (LIVE_MAIN_WORK_731…)`, `/btw what is running?`, then `and now?`,
  reports `phase=running`, the live work label, `main=true`, and BTW history 0 to 1.
- `promote.*`: Ctrl+R, then Enter, produces both safe promoted turns. Repeating Side promotion produces the
  duplicate receipt. BTW promotion is admitted while main is still working; `MAIN_FINISHED_731` precedes
  `MAIN_ACCEPTED_BTW`, proving FIFO drain without interruption.
- `promotion-state.json`: durable promotion rows and source-uniqueness receipt.
- `red-green.txt`: exact focused test commands and their before/after assertions.
- `verification.txt`: repository check, full isolated tests, builds, and xterm evidence verifier results.

## Sentinel definitions

- `MAIN_SECRET_731`: main-only transcript marker. The Side driver set `isolated=true` only when the serialized Side
  request contained no copy of it.
- `SIDE_842`: Side-only memory marker used to prove persistence and follow-up history.
- `LIVE_MAIN_WORK_731`: active main work label captured in each fresh BTW observation.
- `main=true`: emitted only when BTW observed both `MAIN_SECRET_731` and `LIVE_MAIN_WORK_731`.
- `history=0|1`: number of completed auxiliary question/answer pairs supplied before the current turn.
- `MAIN_ACCEPTED_SIDE|BTW`: deterministic main executor receipts after durable promotion admission.

## Reproduction

1. Use Node 24.11 on macOS arm64 and a 120x36 PTY with `TERM=xterm-256color`.
2. Point `X3HAUSTPI_CREDENTIAL_BACKEND=file`, `X3HAUSTPI_AUTH_PATH`, and `X3HAUSTPI_STATE_PATH` at an isolated
   directory. Put one active `{ "type": "api_key" }` credential under provider `openai`; configure no other provider.
3. Start the production `runTui` entry with deterministic task and auxiliary adapters that emit the sentinels defined
   above. Record the PTY with `script -qF`.
4. Perform the exact commands and key sequences listed above. Restart against the same SQLite path before reopening
   Side Chat. Hold main work on an external event, promote BTW, then release that event.
5. Replay each ANSI recording into `new Terminal({ cols: 120, rows: 36, scrollback: 2000 })` from
   `@xterm/headless` 5.5.0, export the active buffer to text, and render the same rows to PNG.
6. Run `shasum -a 256` on the files listed in the manifest below and compare the results.

## SHA-256

```text
64b6dba51a6b67e0aba5f5d12372079f5e4d3f79adc4b771697e18b12462df13  model-picker.png
4dfa4fb8632e304496e5a3399270c83392a6263fa6dd6d923400f599522db617  response.png
5171e22897f614f3f4282234aa6e2289500e2f60a4815d99fcdf375049d17233  side-chat.png
22156162c3d7d4cb4ff9399868f4e8ce717892d245339ee90c32dabf58adae0e  btw.png
743dc2af7c891eeadb4d71be45e2ec0cc20c672b3c9116447aabfa6b56726363  promote.png
393481922cf65647681151693886f2253b1c3ccfce613b42f5b9e0745d3d7f14  model-picker.txt
b09c8cf4e219543dd2d905b123bad909c087f574ad390e2d4a4117f0bb18955c  response.txt
dedfdf1b2b13ead716ae5d2d6068c85eb877e700babf21d958db16dace4d85cf  side-chat.txt
37d38d21a4c5a9e0fb25ea26ded844fa4861d48364ae553f4a3808da4e096aae  btw.txt
aa08d37d234e651b6a9b502951bd777010640753ba6db5c1458f1f24e71ad0bc  promote.txt
be826a582df6acbcd01c10cf68757d170e9771399cde86deaf87c9c7c92a0549  promotion-state.json
0b262954d621a6f394dd22cdd41853939aa72919321a1ac1812350972a16c214  red-green.txt
616cd84e40786645fb60af3f17280310fafdde234b8c82905f6fe2be68941e1a  verification.txt
```
