# v0.5.109-enhanced.8 (2026-10-24)

- DeepSeek Web: os nomes dos modelos agora dizem o modo do chat web que cada ID usa. `pro` vira "Expert (web)" e os demais viram "V4.1 Flash (web default)". Os IDs legados (`deepseek-chat`, `reasoner`, `R1`, `V3.2`, `Search`) aparecem como aliases. Os IDs não mudaram, porque os combos usam esses nomes.
- DeepSeek Web: o thinking é tratado como o liga/desliga que o web tem. O seletor oferece `none`/`thinking`, ou só `thinking` nos IDs `think`/`reasoner`/`R1`. `reasoning_effort: "none"` e `thinking: {type: "disabled"}` agora desligam o thinking (antes ligavam).

# v0.5.109-enhanced.7 (2026-10-24)

- DeepSeek Web: o pacote instalado não incluía o `deepseek-pow-hash.js`, que o worker do proof-of-work importa. Toda chamada falhava com `Cannot find module` (502) e o provider ficava indisponível. O arquivo agora entra no build via `outputFileTracingIncludes`. O mesmo bug existe no upstream.

# v0.5.109-enhanced.6 (2026-10-24)

- Loader lazy: pacotes CommonJS (`playwright-core`) importados do diretório `runtime` só expunham os exports em `default`, então `const { chromium } = ...` vinha `undefined` e o login via navegador falhava com `reading 'launchPersistentContext'`. Os exports agora ficam acessíveis por nome. O mesmo bug existe no upstream.

# v0.5.109-enhanced.5 (2026-10-24)

- Pacote instalado: o carregamento lazy de `playwright-core`/`wreq-js` quebrava com `Cannot read properties of undefined (reading 'resolve')`, porque o webpack reescrevia `createRequire(...).resolve` para `(void 0).resolve`. Corrigido, e isso destrava o login via navegador e os demais providers que dependem do loader. O mesmo bug existe no upstream.

# v0.5.109-enhanced.4 (2026-10-24)

- Web login (deepseek-web): o placeholder anônimo `{"value":null,"__version":"0"}` do `userToken` não conta mais como login. Antes a captura fechava a janela em segundos, antes de você logar, e a verificação de identidade rejeitava o token. O mesmo bug existe no upstream.

# v0.5.109-enhanced.3 (2026-10-23)

- Qoder: a página do provider, a busca do combo e o `/v1/models` visível passam a anunciar o catálogo ao vivo da conta. Modelo que o Qoder não lista mais sai. Modelo novo entra. Se o fetch falha, o registry estático continua. Conta com `enabledModels` curado não tem a lista trocada.

# v0.5.109-enhanced.2 (2026-10-23)

- Qoder: promoções do catálogo vivo (`is_free` ou `price_factor` 0) saem como `tier=free` no `/v1/models` e no picker de import. Escopo visible só enriquece o tier e não troca a lista anunciada. `price_factor` nulo ou vazio não conta como free.
- Qoder: nomes estáticos de `kmodel`, `dfmodel` e `mmodel` alinhados ao catálogo, e `contextWindow` da tabela de capabilities alinhado ao `max_input_tokens` publicado.
- Qoder: falha de catálogo (HTTP, timeout interno ou rede) e falha de troca de PAT ficam suprimidas por 60s. Abort do caller não suprime. PATs distintos e regiões não compartilham a janela, e o token cru não é guardado. `forceRefresh` continua furando o cache.

# v0.5.109-enhanced.1 (2026-10-23 — upstream v0.5.109 sync)

- Sync com upstream v0.5.109 (v0.5.104 → v0.5.109); adaptações do fork preservadas.
- Combo: Smart Router/System One e failover de stream vazio (peek SSE) do upstream integrados ao continue-policy, soft-miss, trilha `[tried …]` e registro de tentativas do fork; 4xx request-scoped devolve o status/corpo do primeiro membro que rejeitou o pedido (com a trilha quando >1 membro).
- `checkFallbackError`: 400/406/413/422 agora também marcam `requestScoped: true` (sem cooldown, sem rotação de conta — semântica RH2 inalterada).
- Command Code: mantido o parser de cota do fork (mensal × compradas × grátis, orgId); adotados os aliases curtos de plano (`go`, `go-v1`…) do upstream. O probe de conexão via `/alpha/whoami` do upstream foi descartado em favor do probe de geração do fork (duplicata silenciosa no `switch`).
- Registry: upstream ocupa p139 (sensenova) e p140–p151 (*-web); `orcarouter` do fork movido para p152.

# v0.5.109 (2026-10-23)

## Features
- **Combos**: add Smart Router (System One) evaluation with adaptive session stickiness (Smart Switch, Strict Lock, Per-Turn) to retain prompt cache; introduce SmartPolicyModal and System One router picker in dashboard (#4975)
- **Combos**: add search box for combo list with case-insensitive filtering by name and model IDs, filtered count, clear action, and selective bulk actions (#9b4ea9e)
- **Image & MITM**: support reference image inputs (base64 and data URIs) for Gemini and Antigravity image generation; ensure MITM directory is auto-created on startup (#4981)
- **Web Providers**: add web provider executors (`deepseek-web`, `gemini-web`, `muse-web`, `chatgpt-web`, `uc-web`, `veoaifree-web`), shared browser pool (`browserPool`), TLS impersonation via `wreq-js` for `grok-web`, lazy runtime installer for Playwright/wreq-js, and browser session cookie capture (#38a0c44)
- **Providers**: add SenseNova provider support (`sensenova-6.8-flash-lite`, U1.5 image models) with image configuration options and connection validation (#5079)
- **Ollama**: support System One decision models (`clef`, `clef-flash`) with host path normalization (#4731)
- **RTK**: support user-authored custom system prompt injected across OpenAI, Responses, Claude, Gemini, and Kiro request shapes (#8a84204)
- **STT**: add Codex OAuth transcription provider (`cx/transcribe`), reusing existing Codex OAuth chat connections with 24 kHz PCM16 WAV conversion and bounded private temp files (#5074)

## Fixes
- **Combos**: advance past request-scoped 4xx rejections (validation, unsupported parameter, context overflow) instead of terminating combo (#5057)
- **Combos**: fall through to next member when streaming response returns HTTP 200 but produces zero content frames (#ca7b540)
- **Combos**: try next model when provider returns HTTP 400 for insufficient credits or balance too low (#4713)
- **Antigravity**: dynamically resolve unadorned models to tiered variants from client `reasoning_effort` (#82aeb90)
- **Antigravity**: update User-Agent to `hub/2.24.0` resolving HTTP 404 on Gemini 4 Argon; add `gemini-4-argon-medium` and `gemini-4-argon-low` tiers, including them in quota tracking (#4816)
- **OpenCode**: send `reasoning_effort` instead of `thinking` object for `glm-5.3-flash-free` to prevent upstream 400 rejection (#32c5f30)
- **OpenCode Free**: honor `low|high|max` reasoning efforts for `oc/deepseek-v4.1-flash-free` instead of collapsing `low` to `high` (#313559f)
- **OpenCode Free**: full reasoning support for `oc/mimo-v2.6-flash-free` across plain OpenAI `reasoning_effort` enum and SSE aggregation / translators (#b833128)
- **Transports**: allow transports to declare thinking format; nest `reasoning:{effort,summary}` for OpenCode Go and Muse on `/responses` routes (#3014)
- **Streaming**: synthesize missing `id` on streamed tool-call fragments so strict OpenAI clients do not abort (#4992)
- **Streaming**: restore original caller tool names on OpenAI passthrough path when renamed by OpenCode fingerprinting (#4986, #4994)
- **DB**: strip NUL bytes from bound strings across all SQLite drivers to prevent write errors or truncation on raw binary values (#5055, #4917)
- **Usage**: support `/api/balance` for Ollama Cloud quota tracking (session 5h, weekly 7d resets, allowance/credits) (#5026)
- **CommandCode**: resolve short plan IDs (`go`, `individual-go-v1`) with 10-credit cap, colored percentages, and dedicated `/alpha/whoami` connection probe (#4a76b8d)
- **CodeBuddy**: back off and advance combo on international connection errors (HTTP 400 "request illegal" / "conversation id missing") (#5024)
- **Codex**: skip ChatGPT Free accounts for image generation and use Go-compatible `gpt-5.6-terra` main model (#b08f12d)
- **Qoder**: treat 10605 queue capacity signals as transient rather than billing blocks; add static model config for Sonus/Cantus; restore `PROVIDER_CAPABILITIES` table (#2720cd2)
- **Capabilities**: advertise 500k context window for Grok 4.7 matching upstream limit (#b065531)
- **GitHub**: refresh Copilot fallback model catalog with current models and set default fallback to `gpt-5-mini` (#dbdbb64)
- **OpenAI**: strip and rename `max_tokens` to `max_completion_tokens` to prevent 400 rejections on modern models (#7c42d8f)
- **Kiro**: normalize Anthropic model IDs and snapshot dates to Kiro-accepted upstream aliases; fix MiniMax casing to `minimax-m2.5` (#3ce2b82)
- **Headroom**: compress native Gemini, Antigravity, and Responses tool output text (#4070)
- **Headroom**: support native CommandCode requests stored under `params.messages` (#4552)
- **Security**: bump `undici` to 7.30.1 and bind Headroom port to `127.0.0.1` in docker-compose.yml (#08ef047)
- **Docker**: pin `node:22.23.4-alpine` and `.nvmrc` to address October 2026 security CVEs (CVE-2026-111497) (#32a064e)
- **Dependencies**: upgrade Monaco editor to 0.57.0 (DOMPurify 3.4.15) and pin CDN loader copy (#5883110)
- **Dashboard**: clarify API Key Created modal guidance that keys can be viewed or copied later from the list (#a3ca2f9)
- **Media Providers**: keep connection card for OAuth providers with API-key media lanes (#00dd3df)
- **Search**: reset regex state between model matches in search filters (#5853a88)
- **Pi Settings**: declare `existingProvider` before use in POST handler to prevent ReferenceError 500 (#342ecb0)
- **Tests**: triage master test suite (GLM-5.2 effort, gpt-6.1-sol codex capabilities, image SSRF mocks, refresh known-fails) (#b6a9ca4)
# v0.5.104-enhanced.2 (2026-10-16)

## Fixes
- **Relay Proxy Pools (Cloudflare Access — KI-1)**: `proxyAwareFetch()` now injects `CF-Access-Client-Id` and `CF-Access-Client-Secret` over `https:` for trusted Cloudflare relay hosts (defaulting to `.scursel.workers.dev` or `CF_ACCESS_RELAY_HOSTS`, with trailing-dot normalization and exclusion of `.vercel.app`, `.deno.dev`, `.netlify.app` and unrelated `*.workers.dev` tenants), uses `redirect: "manual"` to prevent cross-origin redirect credential leaks, and throws an explicit error if the relay response redirects to `/cdn-cgi/access/login`.
- **Relay Health Check (`/api/proxy-pools/[id]/test`)**: `testVercelRelay()` now sends Cloudflare Access headers, sets `redirect: "manual"`, requires `HTTP 200` with `application/json`, and validates the parsed JSON object payload so blocked or empty responses are never falsely marked `active`.
- **Cloudflare Relay Worker (`cloudflare-deploy`)**: strip `cf-access-*` headers and `CF_Authorization` cookie in the Worker before forwarding requests to upstream targets (and redeployed all 6 production relay Workers).

# v0.5.104-enhanced.1 (2026-10-15 — upstream v0.5.104 sync)

Merged upstream `v0.5.104` (40 commits since v0.5.99); the upstream release notes follow below.

## Fork fix carried in this release
- **Command Code**: the credential health check no longer marks working connections as `error` with "Your Command Code CLI is out of date". It had no `commandcode` case and fell through to the generic probe, which omitted the registry `x-command-code-version` / `x-cli-environment` headers, so upstream answered 403 `upgrade_required`. The check now sends the real request envelope with those headers (through the connection proxy, bounded timeout, stream always cancelled) and classifies the first stream event with the executor's own inspector. `upgrade_required` and quota (402/432) are reported as warnings, not invalid credentials. Upstream v0.5.104 has no equivalent change.
- **Health probes**: the generic probe now forwards registry `transport.headers`, except `content-type`/`content-length`/`host` and anything credential-shaped (`auth|token|key|cookie|secret`), so a registry header can never replace the user's credential.
- `x-command-code-version` stays `0.25.7` on purpose: newer values make upstream remap models (e.g. `deepseek-v4-flash` to `v4.1-flash`) and change the stream shape.

## Overlap decisions (fork vs upstream)
- **Combo fallback**: upstream's "HTTP 200 with zero usable content" fallback (#4750) is adopted as one more *soft miss* inside the fork's continue-policy flow (kept as the fallback response, recorded as a failed attempt), so it can never surface as an error body carrying HTTP 200.
- **Codex**: upstream's removal of `gpt-5.5` adopted; the fork's `gpt-6` / `gpt-6.1-sol` / `gpt-6-luna` entries are kept.
- **OpenCode**: upstream's new free-tier fingerprint and its test expectations adopted wholesale.
- **Capabilities**: fork's Claude pattern block kept (dash spellings, Claude 3.x guards, Haiku 4.5 limits, Fable adaptive-only) and extended with upstream's `pdf: true` and `haiku-5*` / `haiku-4*` / `opus-4*` / `sonnet-4*` patterns.
- **`/v1/models`**: fork's visible-scope filter kept; upstream's per-provider disabled-model check and no-auth free providers merged in (verified they do not bypass the scope).
- **Node deletion**: upstream's custom-model pruning is applied inside the fork's atomic `deleteProviderNodeInTx`, so every delete path gets it.
- **Model picker**: upstream's regex/negation search and Select/Deselect All adopted; the fork's stored-catalog resolution and memo dependencies kept. Select/Deselect All buttons render only when the caller supplies a batch handler.
- **Registry index**: upstream's new `nous` took `p138`; the fork-only `orcarouter` moved to `p139`.

# v0.5.104 (2026-10-15)

## Features
- **Gemini**: add Gemini 4 Argon (`gemini`/`vertex`, plus a `high` tier on Antigravity) — non-dismissible gemini-level thinking, 1M context, Vertex defaults to `global` location
- **Usage**: Cursor IDE quota via DashboardService (spend + request buckets) (#4689)
- **Cursor**: resolve Auto (Server Picks) to the account's default agent model (#4692)
- **Quota**: anchored auto-ping schedule at fixed local times with timezone/DST support and schedule modal (#4848); unify mode selection into a 3-way toggle, default timezone to local, bring schedule config to the quota page
- **Providers**: add Nous Research OAuth + free-tier provider
- **UI**: model picker regex/negation search, Select/Deselect All, provider filtering, and per-provider wildcards

## Fixes
- **Streaming**: fill a missing `id` on streamed tool-call fragments so strict OpenAI-compatible clients stop aborting the turn with "Expected 'id' to be a string" (#4992)
- **OpenCode**: restore the caller's tool name on the openai→openai passthrough path, so a fingerprint-renamed tool (`read` → `read_client`) no longer reaches the client as a tool it never declared (#4986, #4994)
- **Nous**: add missing attribution tags to API-key requests through compatible Chat Completions connections, preserving caller tags and identities (#4745)
- **Cursor**: recover long sessions from empty AgentService turns (#4690); hold strictProxy on the AgentService h2 path (#4696)
- **OpenCode**: encode inverted timestamp in translated session IDs so non-OpenCode clients pass Zen free-tier checks (#4780); inject `reasoning_content` placeholder for Zen multi-turn chats (#4805); move free tier to `/inference/v1` with the v2 client fingerprint (#4842)
- **OpenCode Zen**: use attested free-tier identity for `-free` models on keyed lane (#4784)
- **OpenCode Go**: route `claude-haiku-5-5` to `/messages` with adaptive thinking (#4727); drop `response_format` for the deepseek family (relay rejects with a bare 400)
- **Capabilities**: add missing OpenCode Free reasoning entries (space-bunny & co) so `reasoning_effort` stops being silently stripped; advertise PDF input for current Claude models (#4761)
- **Combos**: fallback when a model returns HTTP 200 with zero usable content (#4750)
- **Qoder**: surface add-on (free-credit promo) quota in the quota tracker (#4758)
- **Translator**: return Claude messages for forced SSE JSON responses (#4789)
- **Vertex**: honor API-key project/location for Gemini 4 Argon (#4821)
- **GitHub**: route Copilot embeddings to `api.githubcopilot.com` (#4793)
- **Codex**: drop retired gpt-5.5 from registry, image, and auto-ping; CLI preset default to `gpt-6.1-sol`
- **Gemini**: drop sampling params and order functionResponse-last for Gemini 4 (#4802)
- **Models**: expose no-auth free providers in `/v1/models`; prune custom models on node deletion
- **Usage**: token fallback for `input_tokens` rows in 24h/today stats; stable key masking
- **Dashboard**: unclip proxy dropdown and tooltips via body portal

# v0.5.99-enhanced.1 (2026-10-08 — upstream v0.5.99 sync)

Merged upstream `v0.5.99` (28 commits). Upstream additions integrated:
- **Bedrock**: AWS Bedrock and Bedrock-xAI with AWS SSO profile support via `@aws-sdk/credential-providers`.
- **MiniMax Code**: MiniMax Code credits provider via OAuth.
- **Key Access Control**: Per-API-key access restrictions on combos and models integrated with `/v1/models` visible-scope filtering.
- **Antigravity**: Claude Sonnet 5.5 and Opus 5.5 with reasoning variants and quota routing; MITM default updated to Gemini 3.8 Flash.
- **Gemini Fixes**: Uniquify duplicate tool call IDs, sanitize `$ref` in function responses, handle MCP `properties` parameter.
- **Codex / Image Usage**: Exact image token usage persistence from SSE events.
- **Capabilities**: GLM-5.2/5.3 context window updated to 1M; GLM-5.3 thinkingCanDisable: false.

## Kept from the fork on purpose
- **Dynamic Antigravity Quota Parser**: Keeps `parseAntigravityQuotaModels` discovering models dynamically from Google's Cloud Code `agentModelSorts` and `deprecatedModelIds` rather than upstream's static array.
- **Claude Minimum Budget Floor**: Keeps `CLAUDE_MIN_BUDGET_TOKENS` (1024) floor in `claude-budget` and skips `"auto"` on OpenAI/Step/Responses formats.
- **Visible-scope /v1/models**: Clients default to combos and dashboard-visible models only (`?scope=all` adds full catalog), combined with upstream's key-access filter.
- **Resilience**: Per-account chat semaphore and circuit breakers with HALF_OPEN probe handling, soft-error combo guard, finish-close stream usage recording.
- **Quota & DB**: Local sliding-window meter for Alibaba Token Plan (`alitp-intl`), schema version 3, and readable provider errors with Portuguese i18n.
- **Registry index**: Renumbered fork-only `orcarouter` to `p138` (upstream uses `p134..p137` for minimax-code and bedrock).

# v0.5.99 (2026-10-08)

## Features
- **Antigravity**: refresh model catalog with Gemini 3.8 Flash (High/Medium/Low), Gemini 3.6 Flash, and Gemini 3.1 Pro High; remove deprecated 3.5/3-flash models; update MITM default to `gemini-3.8-flash-medium`
- **Antigravity**: add Claude Sonnet 5.5 and Opus 5.5 support with reasoning effort variants, pricing, and family quota routing
- **Bedrock**: add Amazon Bedrock (`bedrock` and `bedrock-xai`) provider with static keys, AWS SSO profiles, native SigV4 signer, and shared EventStream decoder (#4157)
- **Hermes**: per-profile configuration across API, Dashboard card, and CLI menu with bulk apply, scoped reset, and auxiliary roles (#4660)
- **Hermes**: audio transcription via 9router — an "Audio STT" toggle in the card points the profile's `stt.openai.base_url` at `/v1/audio/transcriptions` with an STT-kind model picker (#4763)
- **API Keys**: per-API-key access control — restrict keys to allowed combos and models via interactive modal
- **ElevenLabs**: add Scribe speech-to-text support (#4537)
- **Proxy Pools**: add Netlify serverless relay proxy pool with digest-deploy API and dashboard management modal
- **Providers**: add MiniMax Code (`mcode`) credits provider
- **System One**: support Cloudflare AI `clef-flash` endpoint
- **Codebuddy CN**: sync catalog with 2026-09-30 server config
- **Dashboard**: open 9Remote sidebar item directly to website

## Fixes
- Avoid Headroom compression warnings caused by large unchanged tool schemas (#4809).
- **Dashboard**: fix mobile layouts for API Keys card (alignment, code wrap), header breadcrumbs (overflow collision), model chips (full width, break-all), and Claude CLI settings
- **Gemini**: do not treat properties map as schema node when tool parameter is named `properties` (#4620); rename `$ref` keys in `functionResponse` payloads
- **Translator**: uniquify duplicate `tool_call_ids` for Gemini (#4532)
- **Capabilities**: mark GLM-5.3 as unable to disable thinking (#4656); correct GLM-5.2/5.3 context window to 1M (#4544)
- **Combos**: show compatible node models in picker without an active connection (#4659)
- **CLI**: take `connect` models from server; add `show`, `--save`, Pi and Oh My Pi; store full model IDs in TUI combos
- **Kimi**: route Responses clients to Kimi Code `/responses` endpoint
- **Cursor**: forward reasoning effort to AgentService Run; reject empty turns without successful stop
- **Codex**: preserve explicit tool strict flags; track exact image token usage
- **Ollama**: report `prompt_eval_cached_count` as cached tokens in usage tracking
- **Muse**: route Responses-only models to declared transport and nest reasoning effort
- **TTS**: accept server model and voice in self-hosted example

# v0.5.95-enhanced.1 (2026-10-01 — upstream v0.5.95 sync)

Merged upstream `v0.5.95` (45 commits). Where the fork had built the same thing, the official version was adopted: the model-registry slots for tokenharbor/dahl/atria/agnes/bai (renumbered p125–p133 alongside the new tinyfish/v1m/muse entries), the tool dedup signature (`dedupeTools(tools, { clientTool, model })`, now covering same-name DeepSeek models), the catalog overlay on canonical capability entries (routed through the fork's `refine()`), the zed/cline live-catalog providers in the model selector, the credential re-read before a usage refresh plus its invalid_grant throw (replacing the fork's silent fallback), the `xhigh` thinking clamp keyed off `supportedLevels` (the fork's `minimal → low` mapping stays), the capability tables for Sonnet 5.5/Opus 5.5/GPT-5.4+/devin-cli, and the ghost-model removal in the codex registry (gpt-5.4/mini/spark; the fork's opt-in `-900k` ids stay).

## Kept from the fork on purpose
- **API keys never reach the usage JSON** — `publicApiKeyBuckets()` replaces the full key with a one-way hash before `/api/usage/*` returns the buckets.
- **`anthropic-beta` gating** — `forwardableClientBeta` keeps `context-1m-*` scoped to opus/sonnet models.
- **Combo `contextWindow`/`maxOutput` stay the minimum across members** in `aggregateComboCapabilities`; `/v1/models` publishes them from that aggregate through `makeComboMemberResolver` (which also resolves custom connection prefixes and model aliases). Upstream's static-seat `comboSeatLimits`/`comboSeatCapabilities` were therefore not ported — only their `ALIAS_TO_ID` transport-alias mapping, absorbed into the resolver.
- **`applyJsonSchemaFallback` stays pure** — upstream still mutates `sys.content`, which accumulated the schema prompt on every retry (F27/RM9).
- **Per-account circuit breakers, capacity gates, `skipUpstreamRetry` and the stream-readiness budget** in `handleSingleModelChat` — the fork flow replaces upstream's simpler per-account call; upstream's `providerOverrides` setting was merged into it.
- **Combo soft-error guard** (`COMBO_SOFT_ERROR_GUARD`), stream usage on finish-close (`finalizeOnClientClose`), `/v1/models` visible-scope filtering (`?scope=all`), model meta/detect/add-to-combo, readable provider errors and the mobile/icon layout — all unchanged.

## Merge fixes
- Registry index: adopted upstream slots for tokenharbor (p125), dahl (p126), atria (p127), agnes (p129), bai (p130), tinyfish (p131), v1m (p132) and muse (p133); fork-only orcarouter moved to p136 (p134/p135 stay vacant as the upstream-side buffer).
- `accountFallback.checkFallbackError` keeps the fork's auth-status and literal-404 pre-checks and gains upstream's per-provider rule filter (`provider` parameter threaded through `auth.js`).
- `open-sse/utils/stream.js`: upstream's deferred-`response.completed` watchdog now drives the fork's `finalizeStream()`; both state machines coexist (`finishForwarded` + `completionFlushTimer`).
- `ModelSelectModal`: upstream's standalone `fetchCombos` was dropped — the fork's concurrent `fetchModalData` already fetches `/api/combos`.
- Codex registry: upstream removed the ghost gpt-5.4/mini/spark models (#4202); the fork's opt-in `-900k` ids (and `CODEX_900K_CAPS`) are preserved.

## Baselines
- `tests/__baseline__/providers-baseline.json`: muse entry added (upstream); the fork's orcarouter entry is preserved.

# v0.5.95 (2026-10-01)

## Features
- **Hermes**: sync the auxiliary role picker with Hermes 0.21.5 (`hermes_cli/config_defaults.py`) — add TTS Audio Tags, Triage Specifier, Kanban Decomposer, Profile Describer, Review and Goal Judge; drop Web Extract, which stopped calling an LLM
- **CLI**: Hermes profile selection in the settings menu — per-profile status header, Quick Setup and Reset scoped to the picked profile, plus "Apply to All Profiles"
- **Dashboard**: per-profile Hermes config — profile selector with status dots and run command, Apply/Reset scoped to the selected profile, per-profile Manual Config paths, and an "Apply to All Profiles" action
- **Hermes**: profile-aware settings API — target a profile with `?profile=`/body, list them via `GET /api/cli-tools/hermes-profiles`, and apply endpoint + API key to every profile in one call (`applyToAll`)
- **Providers**: add Meta Muse provider with OAuth login and model catalog; add v1m System One provider
- **GLM**: add Z.ai OAuth login to GLM Coding (dual-auth)
- **Codex**: add GPT-6.1 Sol; expose 1M context variants for GPT-6 and GPT-5.6; add gpt-daybreak/reserve models and route bare `gpt-5.x`/`gpt-6.x` slugs to codex
- **Claude**: add Claude Sonnet 5.5 (plus `claude-opus-5.5` models in the Kiro registry)
- **CLI**: add `connect` command for remote 9Router servers
- **Providers**: per-provider custom header overrides from the registry
- **Agnes**: seed the 2.5/3.0 model ids in the registry
- **Usage**: sync `?provider=` URL param with provider filter for bookmarkable deep links (#4395)
- **Dashboard**: drop NEW badges in sidebar, mark 9Remote as HOT

## Fixes
- **Hermes**: stop breaking the config write when an earlier save left the `model: ""` sentinel behind (duplicate-key handling in `config.yaml`)
- **Claude**: preserve intentional prefill from non-messages[] source formats; keep a trailing user turn so cleanup never yields assistant prefill
- **Claude**: cache a tool loop's final tool results with the 4th breakpoint
- **Claude**: resolve Sonnet 5.x to adaptive thinking so no forged thinking placeholders are sent; inject unsigned thinking placeholders for opencode-go DeepSeek `/messages` (#4436)
- **Thinking**: add `xhigh` to claude-adaptive thinking levels
- **Claude**: keep a user turn whose only block is `container_upload`
- **Capabilities**: publish real GPT-6/GPT-5.4+ context windows and combo token limits
- **Responses**: wait for real usage before emitting `response.completed`, bounded by a 3s watchdog
- **Codex**: stop refresh-token reuse that logs accounts out on auto-ping; preserve hosted web search on GPT-6 Sol/Luna; remove ghost models
- **Grok CLI**: send Grok CLI 1.0.44 so proxy stops returning HTTP 426
- **Proxy**: auto-fallback to insecure TLS on self-signed cert errors; hold strictProxy when no proxy resolves
- **Translator**: strip `errorMessage` and other non-standard schema keywords from Gemini tool schemas; dedupe same-name tools for DeepSeek models (#3333)
- **Codebuddy**: parse the 6004 rate limit error and extract `resetsAtMs`; forward `recurring` for codebuddy-intl quota packs (#4422)
- **CLI Tools**: replace `sk_9router` placeholder with first active dashboard API key
- **Dashboard**: exclude hidden providers from usage stats provider list
- **Capabilities**: add deepseek-v4-1-flash vision alias; add zed to live catalog providers
# v0.5.91-enhanced.7 (2026-09-28)

## Combos skip a member whose "success" is an error notice
- Some free providers answer HTTP 200 with their error message as the reply (aihubmix: "Sorry, to prevent abuse of free resources, accounts that have not been recharged…"). The combo took that as a success, showed the notice to the user and never tried the next member. Chat combos now recognise these notices and move on to the next member.
- Only phrasings specific to provider notices count (recharge, insufficient balance/credit, quota exceeded, prevent abuse, invalid API key, 余额不足…), and only in a short reply or at the very start of a longer one. A reply that merely talks about rate limits is left alone.
- Streams: the router holds back at most the first 60 characters (or 8 s) while it checks, and not at all once the model starts reasoning or calling tools. What the user receives is unchanged.
- A skipped member counts as a failed attempt in the combo stats. If every member answers with a notice, the last one is returned, as before.
- Turn it off without a restart with `COMBO_SOFT_ERROR_GUARD=off`.

# v0.5.91-enhanced.6 (2026-09-28)

## Combo success % and usage now count agent traffic
- Agents such as Hermes close a streamed `/v1/chat/completions` answer as soon as it reaches its end (`finish_reason`), before the provider's final usage chunk and `[DONE]`. Those answers were recorded nowhere: no row in Usage, no `DONE` line in the log, request details stuck on "Streaming in progress", and no success counted for the combo, so the combo % stayed empty. A stream closed after its end now counts as a completed request with its tokens (from the provider, or estimated when it sent none). A stream the client closes before the end still counts as aborted.
- Same fix `/v1/responses` already had for Codex, now for chat completions (passthrough and translated streams).

# v0.5.91-enhanced.5 (2026-09-28)

## `/v1/models` lists only combos and the models each provider shows
- `GET /v1/models` (and `/v1/models/{kind}`, `/v1/models/free`) now return the combos plus, per provider, the models its dashboard page lists: the built-in list minus disabled models, custom/imported models and aliases. Before, every id from each account's synced catalogue and each compatible node's own `/models` was advertised too — about 3,700 entries on a real install, almost none usable.
- `?scope=all` keeps the previous full routable catalogue for tooling (combo pruning, reconcilers). Looking up one model (`/v1/models/{provider}/{model}`) still searches the full catalogue. Routing is unchanged: any routable id keeps working even when not listed.

# v0.5.91-enhanced.4 (2026-09-26)

## Dashboard fits phone screens
- Header: smaller icon buttons and spacing on phones so the page title is no longer cut to a few letters; the provider search no longer pushes the menu off screen.
- Pages and cards use tighter padding on phones, giving content more width.
- Provider page: model ids wrap instead of showing "open…", and the model actions move to their own line; the connection checkbox lines up with its row.
- Actions that only appeared on mouse hover (test, remove, add to combo, detect, row actions) are always visible on touch screens.
- Endpoint: the API key text no longer overlaps its toggle and buttons; the local URL gets more room.
- Quota: each quota shows name, reset time and hide button on one line and the bar with the full used/total on the next, instead of "0…" / "US$…".
- Translator, Skills, PXPIPE and Chat: no more content running past the right edge (file names, copy buttons, period tabs, History/Clear bar).

## Polish for the model import, context/reasoning and add-to-combo UI
- Model rows: context, reasoning, combo and "disabled" chips share one shape and size; the context chip tooltip gives the exact token count and its source; the model name is readable (no tiny italics); cards have regular widths (two per line on wide screens).
- The **+** (add to combo) stays faintly visible with a mouse instead of leaving an empty gap; its popover has a title, shows how many models each combo has and marks combos that already include the model.
- **Detect** uses a clearer icon and opens its result inside the screen with a title.
- **Icons across the whole dashboard render at their intended size.** Both the `material-symbols` package CSS and our own globals pinned every icon at 24px outside any CSS layer, so Tailwind size and visibility classes on icons (`text-sm`, `text-[18px]`, `hidden sm:inline`, …) were ignored. The icon font is now declared in `globals.css` and the icon rule sits in `@layer base`. Side effects fixed with it: stray "→" arrows above CLI tool fields no longer show on phones; sidebar items keep their height; the smallest touch targets (API key actions, connection priority arrows, quota hide, combo reorder, CLI "clear" buttons) get a larger icon on touch screens.
- Import dialog: Portuguese texts, "Variable price" instead of `$-1000000`, labelled context filter ("Context ≥ 128k"), context and reasoning chips per model, and on phones the id pattern fields fold behind "Id filters" so the list keeps its room.
- Daily auto-import card (Settings): Portuguese texts, provider names instead of generated ids, readable error reasons, imported/failed counts as chips.
- Provider list: the error reason stays on one line (full text on hover) instead of a three-line red block.
- Translations keep the spaces around translated words ("1 Conectado", not "1Conectado").

# v0.5.91-enhanced.3 (2026-09-26)

## Model context, reasoning and add-to-combo on the provider page
- Each model shows its context window **on that provider** (e.g. `262k`) and whether it reasons, with where the value came from: reported by the provider, detected by test, model catalog, or estimated from the name (`~`).
- The import picker and the daily auto-import save the context window and reasoning the provider's `/models` list reports (OpenRouter-style `context_length` / `supported_parameters`).
- A **Detect** button per model reads the context window from the provider list and makes one small real request asking for reasoning; an outage stays unknown instead of "no reasoning".
- Measured values override the name-based estimates in `/api/models` (and so in combo capability views).
- A **+** at each model adds it to an existing combo (models already in a combo are marked) or to a new one.

# v0.5.91-enhanced.2 (2026-09-26)

## Readable provider errors in the dashboard
- Provider errors show the reason in plain words — "Out of credits", "Invalid or expired credentials", "Too many requests", "Model not found", "Provider unavailable", "Subscription or activation required", ... (17 standard reasons, translated) — with a one-line hint, instead of a bare code or the provider's raw JSON/HTML. The original error is one click away.
- Applied to the providers list, account cards, model tests, the import picker, combo member stats, proxy pools and request details.
- `describeProviderError()` (`src/shared/utils/errorReason.js`) reads stored errors (`[402]: {...}`, `HTTP 401`, HTML error pages, network failures, bare status codes); checked against the 672 errors stored on a live instance (670 classified).
- Dashboard only: the `/v1` API responses are unchanged.

# v0.5.91-enhanced.1 (2026-09-26 — upstream v0.5.91 sync)

Merged upstream `v0.5.91` (38 commits). Where the fork had built the same thing, the official version was adopted: the `bai` and `dahl` registry entries (upstream's are richer: aliases, GLM-5.3 Flash on dahl), the Zed live-models test isolation (the fork's global `DATA_DIR` guard stays as a second layer), Claude CLI 2.1.280 and GPT-6 Sol/Luna (already identical).

## Kept from the fork on purpose
- **API keys never reach the usage JSON.** Upstream keys the live `byApiKey` stats by the full API key to stop team keys (shared prefix) colliding. The buckets stay keyed that way internally, but `getUsageStats` now replaces the key with a one-way hash before `/api/usage/*` returns it (the daily-rollup path had the same exposure).
- **`anthropic-beta` forwarding:** the client's flags are merged as upstream now does, except `context-1m-*`, which stays gated to opus/sonnet (`forwardableClientBeta`) because a combo member may reject it.
- **Combo `maxOutput` stays the minimum across members** (upstream reports the maximum); upstream's server-side `resolveCaps` override is merged into the fork's aggregate.

## Merge fixes
- `opencode-go`: both sides added a `modelsFetcher`; upstream's (`type: "opencode-go"`) wins and that type is now syncable per account, which the fork's silently-overridden entry used to provide.
- Registry index renumbered (`p131`–`p136`) so fork and upstream providers do not share import slots; duplicate `bai`/`dahl` model-list configs removed.
- STT: fork usage recording and token refresh kept alongside upstream's Gemini Live transport; `chat.js` keeps the fork's 503 on account exhaustion and now also returns the last upstream's rate-limit headers.

# v0.5.91 (2026-09-26)

## Features
- **Web Search & Fetch**: add TinyFish Search and Fetch with one API-key connection, normalized results, and official provider icon
- **Providers**: add Token Harbor provider and four OpenAI-compatible aggregator providers (dahl, atria, agnes, bai)
- **Claude**: forward `x-claude-code-session-id` on OAuth requests; merge client `anthropic-beta` flags and forward rate-limit headers; return thinking text to OpenAI-format clients
- **Codex**: add GPT-6 Sol and Luna support
- **CLI Tools**: support multiple model profiles for Codex CLI
- **Hermes**: multi-role model config (delegation + auxiliary slots)
- **OpenCode Go**: complete the Go catalog (40 models) with auto-fetch + family endpoint regex
- **Usage**: show and redeem free limit resets for cc accounts
- **Cline**: expose the `cline-free/*` tier and price it at zero
- **Combos**: display vision adapter models in an ordered table view

## Fixes
- **Claude**: decloak tool names when `toolNameMap` misses (#4342); update spoofed cli version to 2.1.280 to support Opus 5.5
- **Providers API**: make POST `/api/providers` O(1) and refuse silent key overwrite (#4350)
- **Capabilities**: stop caching the catalog source per module copy (#4351)
- **OAuth**: stop Zed paste-token crash and add IDE auto-import (#4359)
- **Dashboard**: resolve combo limits with the server's capabilities (#4360); lazy-load charts and `marked`, preload in background on idle
- **Responses**: carry the streamed output items in `response.completed` (#4307)
- **STT**: dispatch live-API-only Gemini models over the Live WebSocket transport (#4006)
- **Gemini**: guard terminal model turns and unresponded functionCalls in `normalizeGeminiContents`
- **Command Code**: replay raw byte chunks to preserve all NDJSON lines
- **Translator**: stop emitting empty `<think>` markers into OpenAI content
- **CLI Tools**: refresh Codex settings after apply (#4347); keep existing `ANTHROPIC_AUTH_TOKEN` when applying Claude settings
- **Tray**: native arm64 macOS menubar binary, no Rosetta required
- **CLI**: filter model selector by active connections and noAuth providers
- **Usage**: key live byApiKey stats by full api key to prevent team-key collision and preserve API key usage attribution
- **Tailscale**: cap enable-flow health wait at 20s

# v0.5.86-enhanced.4 (2026-09-25)

## Tests no longer write to the real database
- **Fake Zed / kimchi-nope accounts**: `unit/zed-live-models.test.js` created provider connections in the developer's real `~/.9router` on every `npx vitest run` (5 Zed + 1 kimchi-nope per run). A Vitest `globalSetup` now gives every run a throwaway `DATA_DIR` and deletes it afterwards. Existing junk accounts (emails `zed-live-m*@example.com`, `guard-*@example.com`) can be deleted from the dashboard.

## Model import picker
- **Account fallback when listing models**: the picker tries up to 3 active accounts (healthy ones first) and moves past an account whose `/models` comes back empty, e.g. a Zed account with a dead token. If none answers, the provider's warning is shown instead of "No models match".

# v0.5.86-enhanced.3 (2026-09-25)

Interactive model discovery and daily auto-import. The provider page's old "Import models" / "Import free" split button is now a single "Import models" button that opens a picker dialog, available with a connection or a public catalog. The picker filters and tests models before import; filters can be saved as a daily auto-import rule that runs on a schedule.

## Model import picker

- **Import models button** (provider pages, enabled with active connection or public catalog): opens a picker dialog listing upstream models via `/models` (connection) or public catalog, marking ones already present.
- **Filters** (survive filter changes): search (id or name), tier chips (free / paid / credits / unknown), kind chips (llm / image / embedding / tts / stt, shown when more than one kind is present), "Only new", minimum context (Any / 32k / 128k / 200k / 1M), include / exclude id patterns (comma-separated globs with `*`, whole-id, case-insensitive).
- **Selection UI**: "Select all visible", "Clear"; selections survive filter changes across the session.
- **Test before import** (on by default): each selected model gets a real probe through the gateway; first model alone as a warm-up, then up to 4 in parallel; only models that answer are imported with the kind that answered. Progress streams live per model.
- **Daily auto-import rule**: "Use these filters for daily auto-import" checkbox saves the picker's filters + test setting; unchecking it deletes the rule.
- **Settings card** (Profile page, "Daily Model Auto-Import"): enable toggle, run hour (server local time, default 04:00, disabled by default), "Run now", last-run summary per provider, list of providers with rules. Scheduler checks every 15 minutes (first check 2 minutes after start) and runs once per local day at/after the hour; each run imports only new models, never removes existing ones.
- **API**: `GET/POST /api/models/import/{providerId}` (POST streams NDJSON progress), `PUT/DELETE /api/models/import/{providerId}/rule`, `GET/POST /api/models/import/auto`. Code: `src/lib/modelImport/` (candidates, runImport, rules, autoImport, scheduler), `src/shared/utils/importProviderModels.js` (filters), `ImportModelsModal.js`, `profile/AutoModelImportCard.js`. Settings keys: `autoModelImport`, `autoModelImportRules`.
- Compatible providers (`openai-compatible-*`/`anthropic-compatible-*`) keep importing as `llm` regardless of what the test probe answers, since `CompatibleModelsSection` only displays `llm` rows; TTS models can't be tested before import (no probe route exists) — importing one with "Test before import" on now fails it with a clear message instead of a false negative.

# v0.5.86-enhanced.2 (2026-09-25)

Combo fallback speed, after a side-by-side comparison with OmniRoute. A broken combo member used to hold the whole combo; each case below now falls over to the next member. Every fix ships with a test that was red before it (`tests/unit/combo-fast-failover.test.js` drives the real combo loop, chatCore and DefaultExecutor against a local mock upstream).

## Combo fallback
| Broken first member | Before | Now |
|---|---|---|
| 503 / 502 | 8–9 s, 4 calls to the same upstream | 1 call, next member immediately |
| 403 from an API-key provider | +3 s refresh ladder that cannot succeed | no refresh attempt |
| 200 with an empty stream | empty answer forwarded to the client | next member |
| error inside the stream | error forwarded to the client | next member |
| 200 then silence / no headers | stuck > 150 s | next member within 60 s |

- **No same-upstream retries while a next member waits.** Applies across nested combos too; the last member keeps the historical retries.
- **Refresh only when it can work.** New `executor.canRefreshCredentials()`: false for plain API keys; executors with their own refresh (vertex, github, OAuth ones) are unchanged.
- **Stream readiness gate** (`open-sse/utils/streamReadiness.js`): an SSE response reaches the client only after its first real output (text, reasoning, tool call — OpenAI, Claude, Gemini and Responses shapes). Bytes read meanwhile are replayed unchanged. Budget: `COMBO_STREAM_READINESS_TIMEOUT_MS` (new, 60 s) for a member with a next member; `STREAM_FIRST_CHUNK_TIMEOUT_MS` (200 s, previously used by kiro only) otherwise.
- **No pause between members.** The up-to-5 s wait on 502/503/504 before trying the next member is gone.
- **Behavior change:** an empty stream on a plain (non-combo) request is now a 502 instead of an empty 200, so account fallback can try another account.

# v0.5.86-enhanced.1 (2026-09-23 — upstream v0.5.86 sync)

Merged upstream `v0.5.86` (3 feature/fix commits plus release). Adopted official MiMo desktop login by server/cluster and v2.6 routes, Claude Opus 5.5 and CLI fingerprint, lossless proxy-pool headers, and the i18n mutation-observer fix. Enhanced-only behavior remains, including Claude 1M beta forwarding, stricter dashboard guard rules, secret scanning, combo/routing fixes, and CLI packaging safeguards. The imported MiMo proxy was also hardened so an empty server-side cookie jar never falls back to forwarding browser cookies upstream; redirects remain on the same-origin proxy; cookies are host/domain scoped across account and regional servers; unapproved redirect hosts and insecure downgrade redirects are rejected; HTTPS/session state is signed and Secure; and diagnostics no longer log upstream SSO bodies or browser cookie values.

## Upstream v0.5.86
- **Xiaomi MiMo**: server-assisted desktop login for headless/Docker deployments, five account clusters (cn/sgp/ams/ru/in), and v2.6 pro/flash/pro-ultraspeed models with dual-route (account service vs. cloud API).
- **Claude**: add Claude Opus 5.5 support; update CLI fingerprint to 2.1.280.
- **i18n**: translate React text rewrites via characterData mutation observer.
- **Proxy Pools**: preserve request headers through Vercel/Cloudflare/Deno relays.
- **MiMo login security**: keep session in the httpOnly cookie, require dashboard auth on the proxy branch, and stop forwarding authorization headers upstream.

## Capabilities
- **Catalog coverage guard** (`tests/unit/capabilities-catalog-coverage.test.js`): every `claude` and `codex` chat model in the registry must resolve to known limits, not the `DEFAULT_CAPABILITIES` floor (200k / 64k). A model added by an upstream sync that no table or pattern covers now fails the suite by name. Image-generation entries are excluded; `codex-auto-review` (virtual model) is allowlisted with its reason, and stale allowlist entries fail too.
- **Claude Haiku 4.5**: `claude-haiku-4-5-20251001` had no declared limits (the generic haiku pattern carries none). It now resolves to 200k context / 64k output, both id spellings.
- **Codex `gpt-6-luna`**: advertised with a 1.05M context window. The Codex feed says 272k, but a real request through this route consumed 822,486 prompt tokens.

## Baselines
- `tests/__baseline__/providers-baseline.json`: Claude `User-Agent` refreshed to `claude-cli/2.1.280` after the upstream fingerprint bump (upstream left its own baseline stale).

# v0.5.85-enhanced.3 (2026-09-22)

Second half of the combo reasoning/context review, plus the docs build. Each fix ships with a test that was red before it.

## Combo capabilities (what clients and the dashboard are told)
- **One merge for dashboard and `/v1/models`.** The dashboard took reasoning from the first member and the MAX output. `/v1/models` required every member to reason and took the MIN. So `[claude-sonnet-5, gpt-4o-mini]` showed "reasoning, max 128k" in the UI while clients got "no reasoning, max 16k".
  - Both now call `aggregateComboCapabilities` with a shared member resolver (`src/shared/utils/comboMemberResolver.js`: connection prefixes, static aliases, model aliases).
  - Rules follow routing:
    - modalities are a union (auto-switch);
    - tools are an intersection;
    - reasoning is advertised if any member reasons (thinking params are adapted or stripped per member);
    - context and output limits take the **minimum over members with known limits**.
  - An uncatalogued member no longer drags `context_length` down to the 200k default.

## Capability table
- Claude 3.x before 3.7 is no longer marked as reasoning. Sending it `thinking` was a 400.
- Dash-form and dated Claude 4.6+ ids and Fable ids resolve as adaptive with 1M/128k, instead of falling to the budget family at 200k/64k.
- `gemini-2.5-pro`: thinking cannot be disabled, budget range 128–32768.
- `o1`/`o3`/`o4` patterns are anchored at the start of the id. `qwen-turbo4` and `yolo4` were being treated as OpenAI reasoning models.

## Routing
- **Fusion**:
  - Panel and judge calls now keep the cyclic-combo guard. A fusion combo listing itself used to expand until it ran out of memory.
  - A failing judge (context overflow, 5xx, throw) falls back to a successful panel answer instead of discarding the panel.
  - Gemini `thought` parts and Responses reasoning items no longer reach the judge as answers.
- **`[1m]` / 1M context**: the claude executor rebuilt `anthropic-beta` from a fixed list, so the client's `context-1m-*` flag never reached Anthropic. It is now forwarded for opus/sonnet targets.
- **Member thinking suffix on passthrough** (`cc/claude-opus(high)`, `gemini-cli/…(8192)`) is now applied for every provider. Before, only Codex applied it.
- **Output tokens are clamped to the target model's documented maximum** for every format (`max_tokens`, `max_completion_tokens`, `max_output_tokens`, `generationConfig.maxOutputTokens`). A fallback from Opus (128k) to gpt-4o (16k) no longer gets a 400. Uncatalogued models are left alone.

## Docs
- The GitBook build failed on every push (`useEffect is not defined` in `LanguageSwitcher`, left half-refactored by upstream `d29b19bc`). The deploy step, which targets upstream's `9router.github.io` with upstream's key, is now skipped on forks.

# v0.5.85-enhanced.2 (2026-09-22)

Combo reasoning/context review. Each fix ships with a test that was red before it.

## Fixes
- **Combo attempts no longer share nested request state** (`src/sse/handlers/chat.js`). Every attempt, whether the next account or the next combo member, got a shallow `{ ...body }`, so chatCore's in-place normalizers leaked from one attempt into the next. A non-vision member that failed left `[Previous image omitted]` for the vision fallback. `prepareClaudeRequest`'s unsigned thinking placeholder reached a later `cc/` member (Anthropic 400), and `cache_control` breakpoints and Gemini `thinkingConfig` were lost. Each attempt now gets a `structuredClone`. Fusion panel calls are covered by the same path.
- **Adaptive thinking no longer sends `reasoning_effort:"auto"`** to OpenAI-format and StepFun members (`thinkingUnified.js`). Neither enum has `auto`, so a Claude Code combo falling back to gpt-5/openrouter/grok/step got a 400. The field is now omitted and the upstream default applies.
- **claude-adaptive maps `minimal` → `low`**. Anthropic's effort enum starts at `low`. `minimal` came from clients, from small budgets, and from `none` on models that cannot disable thinking (Fable 5.1).
- **Provider thinking override: legacy `on`/`off` never become `reasoning_effort`**. When the client already sent `thinking` (Claude Code always does), the old `else` branch shipped `reasoning_effort:"on"`. The logic moved to `open-sse/handlers/chatCore/providerThinking.js`, where it is testable.
- **Capacity-adapter history trimming** (`open-sse/services/capacityAdapter.js`, `stripHistoryForContext`):
  - Leaves the conversation untouched when it fits the adapter model's window. Before, anything longer than 6 messages was always cut, even with 1M tokens free.
  - When it must trim, it keeps the latest assistant turn with its trailing results and fills in recent turns, not just the head.
  - Cut edges never split a tool call from its result. Before, an orphaned `tool` result reached the vision fallback as a 400.

# v0.5.85-enhanced.1 (2026-09-22 — upstream v0.5.85 sync)

Merged upstream `v0.5.85` (37 commits). Every place where fork and upstream built the same thing was compared; the official implementation was adopted where it is equal or better, fork-only functionality was kept.

## Secret-leak guard

Repo audit found the fork public and HEAD clean, but git history carries `9router-0.5.69.tgz` (committed in `61b84a78`, untracked in `8e0617a5`) with build-HOME state inside: a real `jwt-secret` (dashboard admin-session HS256 key), `machine-id`, and a `db/data.sqlite` that was verified empty of credentials. The secret is confirmed no longer in use on any live instance; the blob remains public in history regardless. Prevention added so this class of mistake cannot land again:

- **`scripts/check-no-secrets.mjs`** — secret-leak guard. Scans staged additions (or explicit paths) for secret-shaped content (provider tokens, private keys, JWTs, AWS/GitHub/Slack/GitLab key patterns, hardcoded values assigned to `JWT_SECRET`/`API_KEY_SECRET`/`MACHINE_ID_SALT`) and forbidden filenames (`*.tgz`, `.env`, `jwt-secret`, `machine-id`, `*.sqlite*`/`*.db`, key material, `.build-home/`, runtime state). Allowlists the known public-by-design values (upstream Windsurf Firebase Web key, the one-char private-key test fixture) and honors a `secret-scan:allow` line marker. No bypass flag by design: false positives are fixed by extending the allowlist in the same commit. Installed as `.git/hooks/pre-commit` by `npm install` (`prepare` → `scripts/install-hooks.mjs`, no-op outside a git checkout, never overwrites a foreign hook), and re-run server-side by `.github/workflows/secret-scan.yml` (`--range` over each push/PR).
- **Guard review fixes**: staged binaries were never flagged for manual review (a binary diff has no `+++ b/` line, so the file name was never captured — now taken from `--numstat`); filename rules were case-sensitive (`Backup.TGZ`, `id_rsa.PEM` slipped through) and missed SQLite `-wal`/`-shm`/`-journal` sidecars; the `.npmrc` rule blocked by filename and is now a content rule on `_authToken`/`_auth`/`_password`; `glpat-xxx…` placeholders are allowed.
- **`CLAUDE.md`** — new "Secret hygiene — hard rules" section: never stage archives/build/state, run the guard, rotate-then-purge (never just untrack), fixtures use obviously-fake values, Firebase Web keys are identifiers not secrets, `.env.example` placeholders only.

## Adopted from upstream (fork version dropped)
- **Cursor AgentService**: upstream `c933eefc` ships the same agent.v1 MCP codec set the fork built in `4ed28c79` (same field numbers), plus the actual fixes: system prompt folded into the user turn (field 8 `custom_system_prompt` caused empty turns), `modelDetails` (field 3) for thinking variants, `encodeField` FIXED64 branch, and the tool loop wired into `execute()`. `open-sse/utils/cursorProtobuf.js` and `open-sse/executors/cursor.js` now match upstream exactly.
- **Docker publish**: upstream's verified multi-platform pipeline gates Docker Hub on the repository name (`decolua/9router`), which covers what the fork's secret-detection step (`85370bc6`/`c5a21724`) worked around — a fork publishes GHCR only. Kept the fork's `actions/checkout@v7` bump.

## Kept from the fork (upstream equivalent is narrower)
- **Combo capabilities on `/v1/models`**: the fork's `comboCapabilities` resolves members through per-connection prefixes and model aliases, recurses nested combos, emits top-level `context_length`/`max_completion_tokens`, and only promises a capability every fallback member delivers. Upstream's `aggregateComboCapabilities` (union for modalities) is still used by the dashboard combo chips.
- **Provider model import**: the fork's generic `handleImportListedModels`/`ImportModelsButtons` stays; upstream's Qoder-only handler patch is ported as a qoder/qoder-cn cross-prefix strip.

## Combined
- Combos page: upstream bulk select/delete/strategy toolbar and ctx/max chip + fork success-rate badge.
- `/v1/models` static list: upstream per-model `capabilities` + fork `lifecycle`; upstream `resolveQoderLiveModels` (qoder + qoder-cn).
- `handleForcedSSEToJson`: upstream `toolNameMap` + fork `usageEventId`; `usage.js`: upstream `getQoderUsageFor` + fork `USAGE_IMPLEMENTED_PROVIDERS`.

## Merge fixes (auto-merged but broken)
- `open-sse/providers/registry/index.js`: fork `bai.js` and upstream `qoder-cn.js` both claimed `p124` (duplicate `const`, app would not boot) — `bai` renumbered to `p128`.
- `open-sse/providers/capabilities.js`: upstream `5c217d34` deleted the `qoder` and `codebuddy-intl` overrides while keeping `PROVIDER_CAPABILITIES["qoder-cn"] = PROVIDER_CAPABILITIES["qoder"]` (now `undefined`); both blocks restored from the merge base.
- `src/app/api/models/test/ping.js`: the fork's kind allowlist silently dropped upstream's new `systemone` kind, so System One tests probed the chat endpoint; added `systemone: ["systemone"]`.
# v0.5.85 (2026-09-22)

## Features
- **System One**: add `/v1/systemone` decision endpoint for Jev models (OpenCode Zen and OpenRouter lanes), wire into sidebar and Media Providers page with interactive probe testing
- **CLI Tools**: add dynamic configuration, settings APIs, and official logos for Pi, OMP, Crush, ForgeCode, Smelt, and CodeWhale
- **Analytics & Usage**: add Requests mode, provider/model breakdown charts, All Time period filter, and refined overview cards
- **Combos**: add Cursor/Claude Default presets; support bulk select/delete and bulk strategy changes (Fallback / Round Robin / Fusion)
- **Model Capabilities**: expose model capability metadata on `/v1/models` and aggregate capabilities across combo targets
- **OpenCode Zen & MiMo**: add OpenCode Zen (`opencode-zen`) provider with free-tier fingerprint; switch default vision fallback to MiMo V2.6 Flash Free
- **Qoder CN**: add `qoder-cn` provider for qoder.com.cn with OAuth flow, COSY protocol, and CN gateway routing

## Fixes
- **Translator**: map Claude `refusal` stop_reason to `content_filter` and surface explanation; strip replayed reasoning fields for Groq, Mistral, and Cerebras (#4220)
- **Antigravity**: drop requestType `agent` to avoid false 429 `RESOURCE_EXHAUSTED`; separate weekly and short-window (5-hour) quotas and deduplicate dashboard rows
- **Responses API**: report usage on `response.completed` so clients can auto-compact (#3432)
- **Hugging Face**: migrate to Inference Providers router (`router.huggingface.co`), expand image models catalog, and add STT route
- **Qoder**: prevent signed request replay (`403/103 Duplicate request`), handle code 110 billing blocks, and preserve upstream SSE error status
- **Performance**: bound usage `lastUsed` scan to a 2-day window; map large budget tokens to `max` reasoning tier
- **Docker**: publish verified multi-platform images (linux/amd64 and linux/arm64) with configurable apk build mirrors

# v0.5.81-enhanced.6 (2026-09-21 — the 39 baseline reds are green)

The suite's documented "not all-green on a plain checkout" state is gone: the offline run now reports **0 failures** (was 3767 pass / 39 fail / 56 skip). `tests/__baseline__/known-fails.txt` is empty — any red is a regression by definition.

## Cursor AgentService codecs (was 35 reds)

- `open-sse/utils/cursorProtobuf.js` gains the agent.v1 MCP codec set: `encodeAgentValue`/`decodeAgentValue` (a full google.protobuf.Value codec — null/bool/double/string/struct/list, with a local `encodeFixed64Field` because `encodeField` has no FIXED64 branch), `encodeMcpToolDefinition`, `encodeMcpTools`, `decodeMcpArgs`, and `encodeMcpResultSuccess/Error/ToolNotFound`. Field numbers verified against Cursor's agent.proto via can1357/oh-my-pi @ `60c9a115` (`RunRequest.mcp_tools`=4, `McpToolDefinition` 1–5 with input_schema as a typed Value, `McpArgs` 1/2/3/5, `McpResult` oneof 1/2/5). This is a distinct contract from the ChatService MCP fields (field 34, JSON-string schemas) and the two are never mixed.
- `open-sse/executors/cursor.js` now exports `isAgentCapableRequest` (unlike the routing predicate, it accepts histories that already contain `tool_calls`/`role:"tool"`) and a 3-arg `buildAgentRunFrame(messages, model, tools)` that emits `mcp_tools` (field 4) when tools are declared and encodes tool history entries. **Live wire behavior is byte-identical to before**: `execute()` still routes on `isAgentTextRequest` and the call site stays 2-arg, so the new branches are export-only until the tool loop is actually wired. The tool-call/tool-result history field numbers are the only unverified ones; they are commented as assumed in-source.
- One bug was caught on the way in by the round-trip tests themselves: the Struct decode initially read the entry list one level too high, so keys came out as raw entry bytes. Fixed before landing.

## Command Code assertions follow upstream (was 4 reds)

- The OpenAI→CommandCode image-block assertions now expect both `mimeType` and `mediaType` (`toNativeImageBlock` has emitted both since `13b468b8`/`092c84ea`).
- The commandcode stream-error test now asserts the thrown `Error` (object errors still stringified readably) instead of a fake content chunk — mid-stream errors throw since the same upstream change.

## Suite hygiene

- `unit/embeddings.cloud.test.js` no longer fails to COLLECT: the `cloud/` worker sources are not part of this repo, so the suite self-skips via a guarded dynamic import and reactivates automatically if that directory ever lands. Tests kept verbatim.
- Baseline docs updated: `known-fails.txt` emptied with the fix history in its header, CLAUDE.md numbers refreshed.

# v0.5.81-enhanced.4 (2026-09-20 — upstream rate-limit policy)

## Fixes
- **Rate-limit policy**: a message-text heuristic ("does the body mention a rate limit?") priced every upstream throttle with the exponential ladder, capped at 5 minutes. Aggregators re-wrap the upstream 429 inside their own 500, so an ordinary congestion spike walked credentials up that ladder — observed live on the Cline accounts at `backoffLevel=15` (one failure away from the 5-minute tier) for an upstream that had asked for `retry_after_seconds: 5`. The new `open-sse/services/rateLimitPolicy.js` classifies the failure from the upstream's own signals and settles it from the upstream's own numbers: a **shared pool** (`limit_source: upstream_provider_shared_pool` / `…shared_capacity`) is bounded by the retry window it advertised (ceiling 60s) and no longer escalates or consumes sibling credentials — every credential shares the pool, so rotating only delayed the honest error; a **daily cap** (`limit_rpd`, `X-RateLimit-Reset`) waits for the reset the upstream states (ceiling 6h) and still rotates, because separate accounts own separate days.
- **`applyCooldownOnly`**: the account loop learns the difference between "do not rotate" and "do not wait". A pooled throttle stops the rotation — no sibling credential can clear a shared pool — while still recording the wait, so the account is paused for the window instead of hammering a saturated pool with no cooldown at all.
- **Migration 003** (`reset-inflated-cline-backoff`): clears the ladder the old heuristic already accumulated on the Cline connections. Version-gated, so a database that already recorded version 3 needs the same reset applied by hand.
- **Tests**: `tests/unit/rate-limit-policy.test.js` (classification, driven by error payloads captured live from Cline → OpenRouter), `tests/unit/rate-limit-policy-lock-site.test.js` (the real `markAccountUnavailable` call site: 1 attempt instead of 3, ~6s lock instead of 300s), `tests/unit/migration-003-reset-inflated-backoff.test.js`, `tests/unit/migration-003-post-import-ordering.test.js`. Verified against a pristine `HEAD` worktree: 39 failures before, 39 after, none new.

# v0.5.81-enhanced.5 (2026-09-21 — rate-limit policy, after two independent audit rounds)

The `.4` release shipped the policy; this one ships it correct. Two adversarial
audit rounds reviewed `.4`, both by execution rather than by reading the diff, and
between them found **eight** defects — six in how the new policy was wired (the
policy table itself was sound; the gate that reaches it was not), and two that the
first round's corrections introduced. All eight are fixed here and every fix is
pinned by a test that fails without it.

## First audit round — six wiring defects

An external review of the `.4` commit found six defects, all fixed here. The two
that mattered were invisible to the original tests, which is the interesting part:

- **`unsupported_model` was classified and then discarded.** It was in the policy
  table but in neither gate flag, so it fell through to the text rules: the
  "free tier retired" case still walked every credential of the combo and got a
  30-second transient cooldown instead of its 30-minute tier. The class was
  unreachable from `checkFallbackError` — and the tests only exercised
  `classifyUpstreamFailure` for it, so the policy looked tested while the gate
  was not. Rotation-free classes now live in one named set
  (`ROTATION_FREE_CLASSES`) so a class that is classified but never gated cannot
  pass silently again, and the invariant "`applyCooldownOnly` never accompanies
  `shouldFallback: true`" is asserted across all classes.
- **Migration 003 never ran where it was needed.** `migrate.js` runs the versioned
  chain BEFORE the legacy `db.json` import, and that import copies `backoffLevel`
  verbatim into the `data` column — so a JSON-origin database got its inflated
  ladder after the chain had run, on a boot that had already stamped version 3.
  The reset is now exported as `resetInflatedClineBackoff()` and called again
  after a successful import; the UPDATE is wrapped so a disk error cannot abort
  the boot (`driver.js` re-throws anything escaping a migration).
- **A literal 404 with a pool marker lost its historical lock.** The structured
  block preempted the 404 status rule, turning a 2-minute per-model lock into the
  30-minute tier and stopping rotation. A `code === 404` guard now runs ahead of
  the structured block: the length of an existing lock is not something a body
  marker gets to change.
- **Numeric parsing accepted malformed values.** `[\d.]+` + `parseFloat` read
  `1e3` as `1` (→ 1000ms instead of 1000000ms) and `1.2.3` as `1.2`. A
  wrong-but-plausible window is worse than no window, because a present hint also
  freezes the ladder; the reader now requires the digits to form the whole token
  and degrades to the policy default otherwise, with `retry_after_seconds_raw` as
  a fallback when the primary value is not numeric.
- **`limitSource` and the escape fold were fragile.** `stringField` stopped at the
  first backslash, so it returned `null` from the second escaping level down; the
  fold now strips every backslash, which makes every query depth-independent. A
  depth-2 regression test pins it.
- **Docs and dead code**: a comment claiming every rotation-free class "carries an
  explicit upstream window" contradicted the class defaults (and the author's own
  test, which used the no-window path), `AFFECTED_PROVIDERS` duplicated the SQL
  predicate, and `combo.js` now documents why it deliberately ignores
  `applyCooldownOnly` (there, `shouldFallback: false` means "try the next MODEL",
  which is upstream orchestration, not credential rotation).

Ablation against the pre-fix tree confirmed which assertions actually discriminate:
the pooled-throttle and retired-tier cases fail before the fix, the retry-window
reader returns `1000`/`1200`/`5000` where it must return `null`, and two original
assertions were replaced because the pre-fix code reached an identical result by a
different route (a 404 that never matched a rate-limit marker, and a loop count
that did not check whether anything was actually recorded).

## Second audit round

That second reviewer cleared D1–D6 by execution (351-combination fuzz of the
`applyCooldownOnly` invariant with zero violations, the full suite 1:1 against the
baseline, and the new assertions proven to fail on the intermediate tree) and found
two defects introduced by the D5 fix itself:

- **The escape fold was too aggressive.** Removing *every* backslash joins its
  neighbours: a generic 500 whose message contained `C:\share\d_pool` collapsed to
  `C:shared_pool`, matched the shared-pool marker, and stopped credential rotation
  for a pool that does not exist (`unavailabl\e for free` reaching the 30-minute
  retired-tier lock is the same mechanism). `unfoldEscapes` now folds only escape
  *sequences* (`\"`, `\\`, `\/`) to a fixed point — the previous single pass missed
  depth 2, removing all backslashes invented text, and folding sequences repeatedly
  covers depth 0–3 without either failure. A side effect: `limitSource` now reads
  correctly at depth 3 as well.
- **The gate set was misnamed and mis-described.** `ROTATION_FREE_CLASSES` also
  contained `daily_quota`, which by policy *must* rotate — the name and the
  comments around it claimed otherwise. It is now `STRUCTURED_CLASSES` ("the answer
  comes from the policy table, not the text rules"), and the relationship is
  asserted instead of asserted-in-prose: a new test fails if any class with
  `rotateUseful: false` is missing from the set (the exact shape of the original
  `unsupported_model` bug), and another pins that `daily_quota` stays rotatable
  while gated.

Two further findings were pinned as deliberate decisions rather than left implicit:
a literal 404's status guard wins over a body that claims a daily cap (historical
2-minute lock, rotation kept), while a 403 — which is not an auth status — lets an
explicit pool marker win over the blind status rule. And `1e3` is now read as the
valid JSON number it is (1000 s) instead of being rejected: refusing a readable
window would degrade to the exponential ladder exactly when the upstream uses that
format.

# v0.5.81-enhanced.3 (2026-09-20 — Alibaba Token Plan quota meter)

## Fixes
- **Alibaba Token Plan quota**: the locally metered weekly credit card read **11% remaining** while the vendor console read **39.7% remaining** (total 2,500) at the same instant — and reached 0% ten minutes later. Root cause: `estimateAlibabaCredits` charged cache-read tokens at the qwen3.8 list rate ($0.25/1M). On a 94.4% cache-hit workload that single term was 46% of a whole weekly plan; the rows the console counted as 1,507.5 credits were metered as 2,229.4. Cache reads are now free in the basket (`ALIBABA_TOKEN_PLAN_RATES`, measured 2026-09-20 20:53Z against the console), which puts the same rows at 1,138.7 credits. Per-model coefficient overrides (`ALIBABA_TOKEN_PLAN_MODEL_RATES`) ship empty on purpose: the vendor does not publish them and one console reading identifies one unknown — the basket is model-normalized, and pricing those rows with their own list prices lands under half the vendor's figure.
- **Alibaba Token Plan window**: the 7-day window was anchored on the first request the router happened to see (it reported reset 09-27 19:03Z for a session that began 09-20 19:03Z) and could swallow traffic from the previous bucket that was still inside the SQL fetch. It now uses the vendor's fixed weekly bucket derived from one observed reset instant (`alitpResetAt` / `quotaResetAt` in `providerSpecificData`, or a fresh 429), projected forward in 7-day steps — 09-19 15:05Z → 09-26 15:05Z, matching the console.
- **Tests**: `tests/unit/alibaba-token-plan-meter.test.js` gains the console-anchored regression (red on the pre-fix cache charge: 6 failures) plus bucket and per-model-override coverage.

# v0.5.81-enhanced.2 (2026-09-20 — dashboard UI polish)

Two externally-authored (Jules) PRs, merged after a two-axis code review; the review
fixes were committed on the PR branches before the squash.

## Fixes
- **ModelSelectModal**: the four metadata fetches (combos, provider-nodes, custom models, disabled models) now run through a single `Promise.allSettled` effect — one batched state update on open, per-endpoint fallback (a failing endpoint degrades to its empty default without blocking the others), `console.error` per failed endpoint, and a `cancelled` cleanup so a closed modal never receives stale writes. Missing `useMemo` deps (`capFilter`, `getCaps`) added: setting only the capability filter previously left combos visible and model groups unfiltered until some other dependency changed. Both `react-hooks/exhaustive-deps` warnings on the file are gone (7 eslint problems → 1 pre-existing).
- **Button**: keyboard `focus-visible` ring matching Input/Select/Toggle, `aria-busy` while loading, and Material Symbols ligature icons hidden from screen readers only when the button has a text label — icon-only buttons (e.g. the translator page's per-step load button) keep an accessible name. New source-level tripwire test `tests/unit/ui-button.test.js`, path anchored via `import.meta.url` (cwd-independent).

# v0.5.81-enhanced.1 (2026-09-19 — upstream sync)

Brings the official v0.5.81 line into the fork (see its section below). Where both
sides had solved the same problem, the better implementation was kept:

## Features
- **Codex**: opt-in 900K context variants — `cx/gpt-5.6-sol-900k`, `-terra-900k`, `-luna-900k` and `cx/gpt-6-astra-900k`. Codex advertises 272K for these models but accepts ~900K (920,043 input tokens OK, 1,000,043 rejected, live 2026-09-04). The variants advertise 900K in `/v1/models` (and so lift any combo built from them) and go upstream as the base id. The base ids keep 272K: a larger advertised window makes clients compact later and spend more subscription usage.

## Adopted from upstream
- **Translator**: Claude `tool_result` images on the OpenAI pivot now follow the tool messages in a user turn (tagged with the call id) instead of riding inside the `tool` message as parts — the OpenAI tool role is text-only and rejects images. The fork's `[tool_error]` marker, dropped-type warning and default MIME are kept.
- **Model catalog**: modalities are keyed by provider + model (`CATALOG_VERSION` 2) instead of model id alone; the fork's `costs` / `lifecycle` sections ride along in the same file.
- **Accounts**: rate-limit / quota / capacity wording now wins even under a 400/422 (account state, not a request error), and any other unmatched 4xx is treated as request-scoped. 401 stays with the fork's refresh flow.
- **Command Code quota**: billing calls are scoped to the org from `/alpha/whoami` (Teams pools), auth failures get an explicit message, and brand plan names (GOAT, Max 10×/20×) come from the official table.

## Kept from the fork
- **Command Code quota**: separate monthly / purchased / free rows with the renewal date; the official collector's `individual-pro` cap of $30 contradicts the published pricing ($80) and was not taken.
- **Usage**: DeepSeek credit balances (official `isCreditBalance`) render with the fork's pt-BR currency formatting.

## Tests
- Four Command Code translator tests are red on the pristine official v0.5.81 tree too; catalogued in `known-fails.txt` rather than masked.

# v0.5.75-enhanced.2 (2026-09-19 — audit & hardening release)

## Features — combo statistics (OmniRoute-inspired)
- **Combos**: success rate per combo and failure breakdown per member model, with zero configuration. Every failed member attempt of a combo now records its own usage row (status `error:<code>`, tokens zero, its own event id, `meta{combo,member,attempt}`) and the winning row carries the combo identity — so `GET /api/usage/combo-stats?range=1h|24h|7d|30d` aggregates honest numbers: a combo answers `successRate` only from attributed traffic (null, rendered `—`, never a fabricated 0/100), members sort worst-first with attempts, failures, last error and the LIVE breaker state merged in. The combos screen shows a compact 24h chip per card (click expands the member breakdown in place — no new page, no new settings), the Usage-by-Combo table gained a Success % column reading the same source, and pre-attribution history surfaces as an amber `parcial` badge instead of quietly skewing numbers. Usage aggregates (daily totals, lifetime counter, ring, charts) filter `error:*` by a predicate shared with the SQL twin — media/embedding `success` and legacy NULL rows keep counting exactly as before; the Alibaba local 7d meter likewise can no longer be anchored by a zero-token failure row.
- **Combos**: cyclic combos are rejected at save time (whole-graph BFS on the post-save shape: self-reference always, 2-cycles on the second save, renames that break a cycle accepted), and the runtime chain-guard turns any legacy cycle into a deterministic 400 instead of the unbounded re-expansion that could exhaust heap per request.
- **Usage history**: `getUsageHistory` hides failure rows unless `includeFailures: true`; the textual logs still show them deliberately.


## Security
- The credential-DB export/import (Settings → Database) accepted ANY value of `x-9r-cli-token` as proof of CLI origin; the token value is now verified against the machine-derived secret, mirroring the dashboard guard.
- `/v1/search` allowed a client body to point `provider_options.baseUrl` at an attacker host while the server attached the OWNER's saved provider key — credential theft for any gateway caller. Overrides may now only shadow the origin the credential belongs to (scheme+host+port), keyless BYO endpoints (SearXNG) unaffected; `169.254.x`/IPv6/redirect-to-loopback blocked with real-DNS guards.
- `/api/version/update` and `/shutdown` (LAN peer could `npm i -g` over the install or kill the app) and the `cli-tools/*-settings` env writers are now loopback-origin-only; pxpipe install/start/stop/restart likewise, with the package pinned (`pxpipe-proxy@0.13.2`) and installed `--ignore-scripts`.
- The guard's public allow-list matched by PREFIX — any child of a public path was credential-free (the new health matrix was already leaking through it); exact matching now, with explicit pre-login OIDC/SAML children.
- SAML: replay closed (missing state now FAILS instead of skipping validation; IdP-initiated rejected by design) and Destination/Recipient audited against config, never `x-forwarded-host`.
- MITM sudo password is no longer encrypted with `sha256(hardcoded repo salt)` when the machine key is unavailable — the operation refuses; previously-stored key-known blobs are purged on detection.
- Published tarballs carried the build machine's `jwt-secret`, `machine-id` and SQLite: pack excludes the HOME redirect, an audit gate ABORTS packing on any secret-looking path, and the historical `9router-0.5.69.tgz` blob was untracked (`*.tgz` ignored).
- Client IP is derived from the socket unless `TRUSTED_PROXY_HOPS=N` explicitly trusts N appending loopback proxies (first-hop `X-Forwarded-For` trust let any client rotate login lockouts and poison other users' IPs); `x-forwarded-host` is unconditionally stripped (it had been leaking into OIDC redirect URIs).

## Fixed — routing & resilience
- A client aborting (or silently dropping) a HALF_OPEN probe no longer strands the circuit breaker there forever; a watchdog (2× reset timeout) fails it closed and `settleProbe` reports disconnects immediately. The dashboard reset button cleared nothing (wrong key shape `provider:conn` vs real `provider:conn:model`) and lied `{ok:true}` — now prefix-sweeps with segment bounds, honest 404s, and the badge shows the worst model state so the button is actually reachable.
- `checkFallbackError` returned `shouldFallback:true` for 100% of errors, so a 400 from the caller's own request locked EVERY account of EVERY combo member for 30–120s (a masked 503 self-DoS). Request errors propagate untouched now; 401 defers to refresh without locking an account; per-model/upstream/backoff semantics preserved.
- Reactive 401 refresh bypassed the credential lock and `refreshWithRetry` hammered the SAME already-rotated refresh token 3× on invalid_grant — a token-family revocation risk (3 POSTs proven, now 1); transient retries kept.
- The OpenAI-format translate path never emitted `data: [DONE]` — SDK clients hung waiting for a terminal; exactly one sentinel per stream now.
- Account loop had no `catch` (exceptions escaped the fallback chain); pending-request counters now settle exactly once (flush × disconnect race and a translate-fail decrement-without-increment fixed); `applyJsonSchemaFallback` stopped mutating the shared body (retries doubled the prompt); 401 refresh stops clearing every model lock of the account, just the model's.
- `/v1/api/chat` (Ollama) turned every upstream error into an empty 200 NDJSON — status and canonical `{"error":…}` now propagate, NDJSON and non-stream replies parse.
- `/v1/audio/voices` self-fetch always 401'd under default login; `/v1/models/info` advertised a nonexistent `/v1/fetch`.
- `POST /api/providers/[id]/test-models` self-fetch was credentialess → "Test models" was permanently broken for custom nodes; real failures no longer swallowed as "No models configured".

## Fixed — catalog & models
- Aliases written via `PUT /api/models` were stored `{provider/model: alias}` — the inverse of the routing convention — so they never resolved (and could clobber real aliases); both read and write fixed, duplicates refused by both alias routes.
- `/v1/models` advertised per the FIRST connection's curation only; enabled-model evidence is now a per-account union (a model survives while ANY account lists it), and per-account curation counts as live evidence against feed-retired.
- `CONNECTION_MODEL_SYNC=off` now truly disables ALL automatic syncs (creation-time and migration included, not just the scheduler); manual sync gained per-connection single-flight + a 30s result-cached cooldown (double-clicks join instead of burning upstream quota or racing the 2-sync counters).
- Legacy (db.json) imports that aborted now RETRY on the next boot (they were skipped forever, silently emptying the app); frozen installs self-heal. sql.js backups actually produce a file (ATTACH was a no-op that threw there); a transient init failure no longer freezes the driver promise until restart.
- sql.js persistence is atomic (tmp+rename) with a boot write-check — no more silent in-memory-only runs; export/import round-trips `disabledModels`; usage retention available via `USAGE_RETENTION_DAYS` (default OFF); exit-handler flush is synchronous.
- Combos validate `models`/`kind`/`name` (empty-name renames corrupted records; non-array models exploded at route time); a duplicate-name race 400s instead of UNIQUE-500ing. Node deletion is transactional and warns (never silently prunes) combos left referencing it.

## Fixed — translator (multi-provider format bridge)
- Gemini-format clients got raw OpenAI SSE in streaming (JSON path converted; streaming didn't): a canonical `openai→gemini` response route now exists (functionCall + thought parts + real finish map).
- openai→claude streaming: tool `name` arriving after `id` produced `name:""` (deferred block open), upstreams omitting `id` (vLLM-compat) lost tool calls entirely (shared fallback id now), duplicate `finish_reason` emitted two `message_stop` (per-route guard; a state-key collision with the responses leg — the init-state "ghost fields" class — found and fixed with an ownership test).
- Partial parallel tool results left orphan `tool_use` blocks Anthropic rejects (400): the claude leg now synthesizes `[No response received]` results symmetric to the openai leg.
- The `"You are Claude Code"` persona is no longer injected into EVERY openai→claude request (paid a 1h cache breakpoint per call; OAuth-fingerprint cases keep it, client systems are never shadowed); `reasoning_effort:"minimal"` no longer requests a 512 budget below the repo's own 1024 floor.
- RTK compression is truly fail-open (mid-loop failures leave the body byte-identical, as documented); claude→openai pivot stops losing `is_error` (explicit `[tool_error]` marker) and base64 tool images (canonical data-URI parts), and warns once per request about types it cannot carry.
- `/v1beta` stops re-implementing Gemini translation outside the translator: request AND response sides delegate to the canonical converters — tools, function calls/responses, inlineData and usage survive; JSON path no longer discards tool_calls it extracted.

## Features (OmniRoute portability, usability preserved)
- Background credential-health sweep: the dashboard status dots stay fresh with zero clicks and zero configuration (per-connection backoff, `healthCheckInterval` override, `CREDENTIAL_HEALTH=off`).
- Proactive OAuth refresh sweep with a per-connection refresh circuit: tokens renew before expiry, invalid_grant never rotates-and-retries nor wipes refresh tokens, 3 failures mark `expired` without clearing model locks; shares the reactive path's lock.
- Reactive catalog sync: an upstream `404 model_not_found` kicks that connection's `/models` sync once (10min cooldown), healing pinned catalogs at the moment of error.
- models.dev lifecycle: `deprecated`/`beta` annotated (chip), `retired` hidden from `/v1/models` and combo fallback ONLY without live/curation evidence — no more manual EOL curation commits.
- Read-only provider health matrix (`/api/health/providers` + chip/popover): success rate, latency, breaker/cooldown and catalog status per provider×model; missing data is `unknown`, never `down`.
- Fork update notice revived: version compare handles `0.5.75-enhanced.N` suffixes (the NaN-blind comparison had silenced it — the same bug class fixed CLI-side months ago; cli and server copies now share one test matrix).

## Chores
- Usage recorded for the previously invisible modalities (images, video-create, tts, stt, search, web-fetch; Gemini embeddings propagates usage instead of zeros) — fire-and-forget, cannot affect responses.
- tts/stt fallback loops reached parity with chat (token refresh, lock clearing on success).
- CLI packaging never packs build-machine state; `cutover-guard` validates `cli/package.json` (the artifact actually published) and FAILS CLOSED when it cannot find an install (`NINE_ROUTER_NOT_INSTALLED=1` to declare a clean machine).
- Launcher restart drains instead of SIGKILL (LISTEN-only port ownership); process matching is fact-based (no more substring kills); tray kill awaited; dead db.json recovery and silent autostart-on-hide removed.

## Tests
- ~60 new test files pinning every fix above (all written RED-first against the audit findings); canonical regression gate `verify-no-regression.mjs` green on the final tree; provider/alias/oauth snapshot baselines byte-stable; `tests/translator` known-bugs table (AGENTS.md §8) updated, three `it.fails` flipped to green.

# v0.5.75-enhanced.1 (2026-09-17)

## Fixes
- **Providers**: removing a model now asks what to do with the combos that use it. The provider page defines which models a combo may contain, but members already saved were never re-validated against it: disabling a model left the combo pointing at something that had vanished from every list while still routing, and deleting a custom model left the reference dangling. Disabling offers a third choice — keep it in the combo — and a model a combo uses now stays in the provider's main list even while disabled, marked, instead of dropping into the collapsed disabled section. Members and any fusion judge naming the model are pruned in one transaction, so a failure cannot leave the saved routing partly edited.
- **Combo**: catalog-based member filtering is now fail-open. The per-account model catalog is a routing hint, not an authority over a combo the user configured: a stale sync, a paginated listing or a plan-scoped listing marks a model `unavailable` after two missing syncs, and a combo whose members all got marked that way was reduced to an empty member list. Empty is truthy, so all six `getComboModels` callers walked into the combo path with zero models and answered 503 without calling a single provider. Members are still stripped when at least one remains routable; when nothing survives, the stored combo is routed and the provider's real error is surfaced. The callers now test `?.length`, restoring the upstream contract of "non-empty array, or null".
- **Accounts**: the circuit breaker is keyed per model (`provider:connectionId:model`) instead of per account. Upstream locks per model (`modelLock_${model}`); an account-wide key let five 5xx from one model open the breaker for every other model on the same account — including sibling members of the same combo, silently removing the fallback the user configured. `getProviderCredentials` consults the breaker only when a model is in hand, so a call without one can no longer hide an account.
- **Accounts**: circuit-breaker failures are counted over a rolling 2-minute window instead of cumulatively for the life of the process. Nothing decayed a failure, so five unrelated blips spread over a day eventually tripped an account that was working fine. Three defects that only surface once the window is live are fixed with it: recovery cleared the counter but left the timestamps, so the first failure after recovering re-opened the breaker; `successCount` was never reset on entering DEGRADED, so a busy account closed on its very next success and DEGRADED meant nothing; and a derived `degradationThreshold` did not follow a later change to `failureThreshold`. Reported `failureCount` is now the windowed count — the number the threshold is actually compared against, so the dashboard badge stops overstating how close an account is to tripping. DEGRADED is likewise a function of the window rather than a latch: it clears as soon as the failures behind it age out, instead of requiring successes that an idle account never sends, so the badge no longer flags an account that already recovered. Failures still inside the window survive that transition, and OPEN is untouched — it stays governed by its reset timeout.
- **Accounts**: the per-account concurrency gate is opt-in again. It defaulted to 3 in-flight requests per account where upstream caps nothing; a parallel agentic client exceeds that routinely, and every request over the cap burned a 2s probe and fell through to the next account before the provider was ever called. Set `maxConcurrency` on a connection to re-enable it.
- **Chat**: a full concurrency gate is no longer reported as unavailable accounts. Skipping a saturated account to try another one still spreads load, but when no other account is left the request now waits for a slot (`ACCOUNT_CAPACITY_WAIT_MS`, default 60s) instead of answering `All accounts unavailable` in 2.0s without ever calling the provider. If the wait does expire, the error names the real cause.
- **Combo**: the final error now pairs the status with the message it came from, and lists what was tried (`[tried a:403; b:503]`). Pinning the status to the first member while the message came from the last made a fully-tried combo look like it died on member 1.
- **Usage**: every billable attempt carries a `usageEventId` generated once per attempt, so retries and account fallbacks are counted separately while a repeated write of the same event is idempotent. Removes the old heuristic that collapsed distinct events sharing a timestamp and token count. Adds migration `002-usage-event-id` (column + partial unique index).
- **Shutdown**: a single coordinator owns SIGINT/SIGTERM, installed from `instrumentation.js` at server boot — a gateway-only process (only `/v1/*` is ever hit) never runs the dashboard layout and was therefore left with no handler at all once the SQLite adapters stopped exiting on signals. It drains in-flight usage writes and buffered request details, runs every registered cleanup, then checkpoints the WAL before exiting. Bounded, and a duplicate delivery of the same signal (systemd cgroup + launcher) no longer aborts the drain.
- **CLI**: the launcher asks the server to stop and waits up to 8s before escalating to SIGKILL. It used to kill it outright, which discarded the drain above. It also stops sending the server's stdout to `/dev/null` — it now goes to `~/.9router/server.log` (capped, rotated), which is what makes routing incidents diagnosable after the fact.
- **OAuth (Cursor)**: `better-sqlite3` is imported lazily inside its strategy, so the auto-import route stays importable when the optional native binding is missing and falls through to the CLI strategy.
- **Search**: drop a redundant branch that returned the same value twice.

## Chores
- **Versioning**: the fork is now named after the upstream release it is built from plus its own build counter — `0.5.75-enhanced.1`. Inventing a higher number would claim an upstream release that does not exist; anchoring it keeps "which upstream am I on" answerable, and the next fork build is `.2`. `cutover-guard` compares numeric bases, so installing this over the official 0.5.75 is a same-version cut and a lower base is still refused. The CLI's own comparison was `Number("75-enhanced")` — NaN, so every comparison answered "same version" by accident, which would have silenced the update notice for good; it now strips the suffix explicitly, so a genuinely newer upstream release (0.5.76 and up) still shows up. The update screen adds one line for fork builds: the command it prints installs the official package and replaces the fork.

## Tests
- Repaired suites asserting contracts the code no longer has (Kiro top-level `systemPrompt`, Windsurf endpoint, `got-scraping` transport, DNS `lookup` with `all: true`, Antigravity 429 attempts, HTTP/2 Cursor catalog, module-relative paths in the security audit) and converted four `node:test` files to Vitest so they are collected at all.
- Regression baseline regenerated: `verify-no-regression.mjs` derived the test path from a hardcoded `/app/` prefix and reported every failure as new in any other checkout.

# v0.5.81 (2026-09-18)

## Features
- **Xiaomi MiMo**: merge MiMo Desktop support into `xiaomi-mimo` with dual auth (API key + Desktop/OAuth session), Preview models support, and encrypted-callback OAuth flow
- **Claude Code**: add 1M-context toggle (`[1m]` marker) and drive `CLAUDE_CODE_AUTO_COMPACT_WINDOW` directly from the dashboard
- **Models**: add DeepSeek-V4.1-Flash to DeepSeek provider, CodeBuddy-Intl, and Ollama (`deepseek-v4.1-flash:cloud`); enable `low`..`max` reasoning effort levels and vision capability for DeepSeek-V4.*
- **i18n**: integrate Persian (fa) translation

## Fixes
- **Cursor**: stop AgentService empty turns (`OUT 0`) and silent hangs — fold system prompts instead of `custom_system_prompt`, send `ModelDetails`, read Composer/Grok `thinking_delta`, ack request-context without echoing MCP tools, and reject IDE execs so the model can continue
- **RTK**: for Cursor, compress source-format `tool_result` / `role:tool` **before** translation — its translator rewrites those shapes, so post-translate compression missed them. Other providers keep the post-translate pass unchanged
- **OpenCode / OpenCode Go**: resolve 403 `FreeTierError` and 429 rate limits with canonical session format, valid User-Agent, and stable upstream session reuse; force stream and declare `forceStream` for free-tier SSE aggregation; cloak decoy tools, normalize Muse Free tool choice, and strip prior reasoning items on Responses models; route Union Alpha via Messages API
- **Kiro**: preserve underscores in tool names (`mcp__server__tool`) and restore client tool names in responses; use neutral placeholder for tool-result-only turns; forward tool-result images
- **Stream**: report aborts after HTTP 200 in-band (per-format error frames) instead of closing silently
- **Command Code**: preserve images and `reasoning_effort` on `/alpha/generate`; retry transient stream errors and avoid fake stop chunks; add Quota Tracker support
- **Zed**: harden OAuth lifecycle (preserve `systemId`, renew proxy timeout), support live model resolution, and lower display priority in OAuth list
- **Antigravity**: scope cached thought signatures to model family; strip Claude Code billing headers from system prompts; sanitize Hermes system identity
- **Codex**: route bare `codex-auto-review` requests to the Codex provider (#4135)
- **Auth**: do not cool down an account for request-scoped 4xx errors
- **Usage**: improve DeepSeek credit balance display as currency credit instead of 0/total quota bar
- **Model Catalog**: scope synced catalog to gateways and declare vision capabilities for DeepSeek V4.1-Flash IDs

# v0.5.75 (2026-09-10)

## Features
- **Video**: add OpenRouter and Vertex AI (Veo) video generation on `/v1/videos/*` via a provider adapter layer; poll requests resolve their provider from `x-connection-id` or `?provider=`
- **Antigravity**: add weekly quota tracking (Gemini weekly / Claude & GPT weekly) and free-tier handling from `retrieveUserQuotaSummary` (#3892)
- **Codex**: add GPT Image 2.5, Flare and Sunburst image models with multi-image support; add the same ids to the OpenAI catalog
- **Qoder**: surface usage to all clients and stop inlining large attachments — images upload through `/api/v2/image/upload` like qodercli, oversized file blocks become stubs, context tier auto-escalates
- **OpenCode Go**: add newly published models (glm-5.3, kimi-k3, deepseek-flash, longcat-2.0, hy4-preview, hy3 on chat/completions; qwen3.8-max, qwen3.8-flash on `/messages`; grok-4.6, gpt-5.6-luna on Responses) and list `deepseek-v4.1-flash` first in the catalog
- **CLI tools**: group the model selector by provider with full-text search and manual custom model ID entry
- **CodeBuddy-CN**: replace `deepseek-v4-flash` with `deepseek-v4.1-flash`

## Fixes
- **Tools**: scope Claude tool type defaulting to gateways declaring `requireClaudeToolType` — the global default broke Anthropic-compatible endpoints that only accept the legacy typeless tool shape (#3905)
- **Claude**: cap re-anchored `cache_control` at the 4-marker budget so a spent budget no longer 400s and triggers a full combo failover; wrap bare single-object content turns before the mid-conversation-system fold
- **Cline / Airforce**: unwrap the `{"success":true,"data":…}` envelope on non-stream chat completions (#3644); add the live Cline/ClinePass model catalog and refresh Airforce free models
- **Cline**: stop `workos:`-prefixing ClinePass API keys (401 on every request, #2333) and add clinepass token refresh
- **Kiro**: never send a top-level `systemPrompt` (`400 REQUEST_BODY_INVALID`); route requests through current runtime surfaces (#3776)
- **Codex**: strip Unicode-property tool schema patterns the validator rejects (#3922); restore the `Version` header and single-source the CLI version
- **DeepSeek**: keep Anthropic-only tool types when forwarding to `/anthropic/v1/messages`
- **Qoder**: drop the Responses usage plumbing from shared translator/handler code, which changed token accounting for every provider, not just Qoder
- **Antigravity**: normalize contents and handle intermediate tool responses; protect the OAuth token-refresh path from Google anti-abuse rate limits (#3813)
- **Providers**: clear stale connection health state (`modelLock_*`, `backoffLevel`, `rateLimitedUntil`, `errorCode`) when a connection is re-validated (#3810, #3830); remove the duplicate `qwen` provider that shadowed `alims-intl`
- **Video / Vertex**: reject job ids and model ids that would escape the request URL path (SSRF)
- **Usage**: parse the Fable weekly limit from `limits[]` instead of fabricating a row (#3847)
- **Auth**: set a 24h `maxAge` on the dashboard session cookie

## Enhanced
- **Usage**: hide quota cards for providers without a collector; group same-provider accounts; raise the usage client page size to 500
- **Providers**: Import models / Import free on Available Models; Sync refreshes the catalog and no longer duplicates Import
- **Combos**: Add Model picker uses the account catalog instead of stale registry ids (Token Plan `qwen3.8-max` / `qwen3.8-flash`)
- **Combos**: passthrough providers (Cline) keep unlisted combo members; only drop ids the catalog marked unavailable
- **Cline**: `modelsFetcher` for import/sync without stripping remapped `cl/...` members after the first catalog sync
- **Usage**: Alibaba Token Plan meters the 7-day quota only — the plan no longer offers a 5-hour window — and a vendor `insufficient_quota` 429 now overrides the local token estimate, so an exhausted week reads 2500/2500 with its reset instant instead of ~22% used
- **Build**: `cli:pack` refuses to pack a version older than the package installed on the machine (cutover guard, `ALLOW_DOWNGRADE=1` to override) and flags tarballs that are tracked release artifacts; `npm run cutover:verify` checks the live service after install

# v0.5.69 (2026-09-05)

## Features
- **Codex**: add GPT 6.0 Astra (`gpt-6-astra`) with vision, thinking and search capabilities
- **Usage**: add Claude Fable quota tracker support with weekly window normalization (`weekly fable (7d)`)
- **Dashboard**: group Antigravity Gemini and Claude quotas in Quota Tracker, prune stale hidden keys
- **OpenCode Go**: add `muse-spark-1.3-contributor` model and support parallel tool calls on Responses path (#3819)
- **Providers & Models**: align CodeBuddy-CN catalog/capabilities with server config; add GPT-5.6 Sol, Terra, Luna image aliases on Codex (#3806); refresh Qoder catalog with capability mapping and image pass-through
- **CLI tools**: replace Copilot MITM with VS Code extension setup guide
- **Gemini**: persist and replay `thoughtSignature` scoped by session namespace

## Fixes
- **Claude**: normalize adaptive auto effort (`output_config.effort`) (#3792)
- **Antigravity**: prevent Google anti-abuse rate limits during multi-account refresh (#3813)
- **Anthropic-compatible**: forward Claude beta flags to nodes fronting Anthropic (#3797)
- **Dashboard**: dynamic mode label for local/remote detection (#3801)
- **Codex**: format reset credit API errors cleanly (#3778)
- **Security**: guard cowork MCP tools probe against SSRF (#3783)
- **OpenCode Go**: track OpenCode Go quota (#3791) and send stable session headers (#3800)
- **Logger**: suppress noisy background token refresh logs
- **CLI**: export packed `.tgz` directly into workspace root instead of parent directory

## Enhanced
- **Usage**: hide quota cards for providers without a collector; group same-provider accounts; raise the usage client page size to 500
- **Providers**: Import models / Import free on Available Models; Sync refreshes the catalog and no longer duplicates Import
- **Combos**: Add Model picker uses the account catalog instead of stale registry ids (Token Plan `qwen3.8-max` / `qwen3.8-flash`)
- **Combos**: passthrough providers (Cline) keep unlisted combo members; only drop ids the catalog marked unavailable
- **Cline**: `modelsFetcher` for import/sync without stripping remapped `cl/...` members after the first catalog sync
- **Models**: sync OpenRouter/OpenCode/Kilo/ClinePass/NVIDIA catalogs so Import free works beyond OrcaRouter
- **Providers**: Import free button on connections that expose free catalog models
- **Usage**: resolve provider labels (registry name, custom node name, short Custom OpenAI id for deleted nodes)
- **Usage**: add Usage by Provider and Usage by Combo views (only entries with traffic)
- **Pricing**: when a model has no known price, fall back to OpenRouter/models.dev rates (tier + usage cost)
- **Models**: fix catalog tier precedence (provider price before markers); half-zero prices are paid; `prompt:0`+request is credits; free-wins merge lets paid overwrite unknown
- **Models**: strip `/chat/completions` (and messages/responses) when deriving per-account `/models` URL
- **Dashboard**: provider page shows last-24h requests / spent / tokens; clarify model pricing chips (`per-req`, not account balance); refresh catalog UI after manual sync
- **Chat/Search/Fetch**: combo expansion skips catalog-unavailable members on all three paths
- **Usage**: prefer official OpenCode Go quota collector (drop custom `opencodeGo.js` duplicate after upstream landed it)
- **Usage**: Alibaba Token Plan meters the 7-day quota only — the plan no longer offers a 5-hour window — and a vendor `insufficient_quota` 429 now overrides the local token estimate, so an exhausted week reads 2500/2500 with its reset instant instead of ~22% used
- **Build**: `cli:pack` refuses to pack a version older than the package installed on the machine (cutover guard, `ALLOW_DOWNGRADE=1` to override) and flags tarballs that are tracked release artifacts; `npm run cutover:verify` checks the live service after install

# v0.5.65 (2026-09-03)

## Features
- **Fetch**: add Ollama Cloud web fetch provider
- **Gemini / Antigravity**: add Gemini 3.8 Flash support and bump IDE fingerprint to 2.11.0
- **Claude**: add Claude Fable 5.1 support (adaptive thinking with `output_config.effort`), bump Claude Code fingerprint to 2.1.258 for new-model access
- **Providers**: add client-side status filter (All / Active / Inactive / No connection) on the Providers dashboard; add max height and scroll for connection list
- **Providers & Models**: streamline tokenrouter model catalog down to 22 flagship/newest models and add missing provider icons; refresh Codebuddy-CN catalog (add hy4-preview/hy3/glm-5.3/kimi-k3-1, drop EOL glm-5.0/glm-4.7)
- **Models**: capability toggles (vision, reasoning) when adding custom models with upsert and live caps refresh
- **CLI tools**: support saving and managing custom API key presets
- **Quota**: add usage and rate-limit tracking for Groq via `x-ratelimit-*` headers
- **i18n**: complete Indonesian translation (1391 keys)

- **Dashboard**: expandable account `lastError` on provider connection rows (click more/less; full message with pre-wrap)
- **Dashboard**: show which combos reference each model on the provider detail page (layers chip, full list in title)

## Fixes
- **Security**: close SSRF guard bypasses in `ssrfGuard.js` (alternate IPv6 encodings, hostname trailing dots, wildcard DNS resolution check, safe redirect handling) (#3714)
- **Model markers**: strip the `[1m]` context marker Claude Code appends to model names (`claude-opus-5[1m]`) preventing model resolution failures (#3690)
- **Claude**: drop `server_tool_use` blocks carrying foreign IDs to avoid Anthropic 400 rejections; never anchor cache breakpoints on `defer_loading` tools (#3567)
- **Antigravity**: strike-break optimistic quota readings that keep 429ing by blocking the connection+model pair for 15m after 3 strikes (#3681); preserve client identity on model catalog requests (#3414)
- **Auth**: protect root `/responses` rewrite requiring API key validation in dashboardGuard
- **Chat & Docker**: return 503 Service Unavailable when all credentials are rate-limited; explicitly bundle `node-machine-id` into standalone Docker runtime image
- **OpenCode**: route Muse Spark models to `/zen/v1/responses` and declare vision support; filter inactive free model
- **Kiro**: preserve inline images as OpenAI-compatible `image_url` parts in OpenAI MITM; remove redundant top-level `systemPrompt` from payload
- **Usage**: read Responses-shape `cached_tokens` in `extractUsageFromResponse` for non-streaming traffic
- **Models**: support single model lookup with provider-prefixed IDs (e.g. `cc/claude-sonnet-5`)
- **Translator**: route Gemini thinking through `reasoning_effort` on OpenAI-compatible wire; convert `prefixItems` and ensure array items in Gemini schema sanitizer
- **UI**: apply persisted theme before first paint to prevent flash on reload; translate combo vision adapter label

# v0.5.59 (2026-08-29)

## Features
- **Search**: new web search providers — Antigravity (Google Search grounding
  on the existing OAuth account pool, citations keyed and merged by URL) and
  Xquik (X search with `x-api-key` auth, cursor pagination, credit-based
  usage), both on `POST /v1/search`. Based on #3437 by @Nautilaceae
- **Search**: ollama-search and zai-search borrow a chat provider's API key
  instead of requiring their own connection, driven by a new
  `credentialFallback` registry field. zai-search later folded into the `glm`
  provider itself so the web search page shows the shared connection
- **Models**: daily background sync of model capabilities from models.dev —
  modalities keyed by model id (majority of sources must declare one),
  context/output limits keyed by provider + model, strictly additive and
  sitting below the hand-written tables. ETag + mtime cache, 60s startup
  delay, `MODEL_CATALOG_SYNC=off` to disable
- **Models**: add GLM-5.3-Flash (1M context, natively multimodal), DeepSeek
  V4 Vision, Grok 4.5/4.6 (500k context); correct glm-4.6v/4.5v video input
  and output limits, backfill glm-4.6v on glm-cn
- **Usage**: show the Zed plan quota on the dashboard — plan, edit
  predictions, hosted model requests and billing-cycle reset; unlimited rows
  render as "N used · Unlimited"
- **Usage**: track GPT-5.3-Codex-Spark quota windows (spark_session /
  spark_weekly) from the Codex usage response (#3431)
- **Antigravity**: quota-aware routing — on 409/429 fetch live quota for the
  exact per-model resetAt and skip only the exhausted account/model pair;
  report the earliest reset when every account is blocked (#3561)
- **Antigravity**: map image `size` to the aspect-ratio model suffix (-WxH);
  add the Gemini 3.7 Flash tiers to MITM defaultModels so they show up in
  the dashboard model-mapping table
- **Dashboard**: bulk import Grok CLI accounts from JSON — paste an array or
  drag-drop multiple .json files, all OAuth connections created in a single
  call, mirroring the codex flow
- **CLI tools**: endpoint presets shared across every tool card through one
  live-resyncing store, instead of per-card localStorage copies that never
  saw each other's saved endpoints
- **Token Saver**: configurable compression timeout (`headroomTimeoutMs`) —
  the fixed 3000 ms made busy machines time out and send inconsistently
  compressed bodies, hurting prompt caching
- **i18n**: pt-BR expanded to 1132 terms

## Fixes
- **Claude Code**: add Claude Fable 5.1 and advertise Claude Code 2.1.258 in
  both the request header and billing identity; use its permanent adaptive-thinking
  mode with `output_config.effort`
- **Stream**: record usage when a client closes on the terminal event — the
  Responses API has no [DONE] sentinel, so codex closed the socket on
  `response.completed` and cancelled the reader before flush() ran its usage
  side effects; the tail now lives in a once-guarded finalizeStream(). Also
  stop logging a disconnect for every completed Responses call
- **Stream**: parse the trailing NDJSON line an Ollama stream leaves behind
  without a closing newline — the final chunk carrying `done_reason` and the
  token counts was dropped
- **Session**: read the Claude Code session id from the
  `x-claude-code-session-id` header — `metadata.user_id` is dropped by
  Responses translation, splitting one conversation across several
  `prompt_cache_key` values and missing the upstream prefix cache
- **Usage**: preserve nested `cached_tokens` — the top-level-only read
  persisted `cached_tokens: 0` for every Responses-format provider (codex,
  grok-cli, …), billing cache hits at the full input rate
- **Usage**: GLM quotas accept CREDIT_LIMIT plans and multi-interval windows
  (5h session / 7d weekly) instead of overwriting a single "session" key
- **Models**: the catalog sync no longer erases its own output — deltas were
  measured against the previous run's writes (the second run cut `providers`
  from 20 entries to 5); one vote per provider in the modality tally, ETag
  restored from file on startup, and the worker thread dropped after the
  bundler rewrote its path into a module-not-found error
- **Executor**: CommandCode returns errors as a `type:"error"` event inside
  an HTTP 200 NDJSON stream — peek the first events before committing, abort
  and return a real 4xx/5xx so combo/account fallback triggers instead of
  streaming the error text as content
- **Search**: scope failure locks on the credential-fallback path — a failing
  search locked `modelLock___all` and took the shared glm key offline for
  chat as well; locks are now attributed to the connection's owner and
  scoped to `websearch:<provider>`
- **Providers**: connection tests get a 15s AbortSignal timeout instead of
  hanging and exhausting the browser socket pool; guard undefined provider
  names on the providers page
- **Antigravity**: sanitize competing-client branding via a config-driven
  rule table (Zed's Claude-agent prompt, opencode → antigravity) — upstream
  answers 429 Quota Exhausted. Applied in the executor so the shared
  openai-to-gemini translator leaves gemini/vertex/zed untouched
- **MiniMax**: preserve images on the sourceFormat-matched OpenAI transport
  — MiniMax-M3 resolved a Claude-shaped body posted to the OpenAI endpoint,
  silently dropping `image_url` blocks (#3418)
- **Claude**: decloak tool names in same-format streaming passthrough —
  OAuth-cloaked names (CLAUDE_TOOL_SUFFIX) leaked to the client and every
  tool call was rejected as unknown
- **Tools**: default a missing `tools[].type` to "custom" on Claude-format
  requests — strict Anthropic-compatible gateways (MiniMax) reject the
  request with 400 otherwise
- **Translator**: zai thinkingFormat sends the top-level `reasoning_effort`
  object GLM-5.2+ requires — every GLM-5.x request ran at the model default
  (max); gated on GLM-5.2+ since older GLM does not read it (#2721)
- **RTK**: system prompt injection matches each target wire format
  (Chat/Responses/Claude/Gemini/Kiro) and is exact-idempotent across retries,
  so distinct prompts sharing a long prefix are no longer collapsed (#3202).
  Also set the diagnostic before the silent null return on Responses
  translation failure so the panel is no longer blank
- **OpenCode**: route muse-spark through /zen/v1/responses (it 500s on
  chat/completions), normalizing the Chat fields the Responses API rejects
  and clamping max/ultra effort to xhigh
- **CLI**: install better-sqlite3 without build tools on Node 22+ (N-API
  13.0.3 ships per-platform prebuilds, `--ignore-scripts` skips the implicit
  node-gyp build); Node < 22 stays on 12.6.2, working installs untouched
- **CLI tools**: send the API key Codex actually reads —
  `[model_providers.9router.http_headers]` instead of auth.json (which left
  every request 401 and clobbered an existing ChatGPT login); subagent model
  moved to `agents.default_subagent_model`
- **OAuth**: refresh Cline tokens with the extension JSON contract
- **Dashboard**: clamp the API key mask length — keys shorter than 8 chars
  threw RangeError and crashed the media-provider detail page
- **UI**: wait for the Material Symbols font itself before revealing icons —
  `document.fonts.ready` resolved before the 4MB woff2 even started loading,
  leaving icons blank until a second load

# v0.5.55 (2026-08-14)

## Features
- **Auth**: native SAML 2.0 SSO alongside OIDC — AuthnRequest generation, ACS
  assertion handling, SP metadata export, admin config test, replay-protected
  via a `saml_state` cookie matched against `InResponseTo`
- **Providers**: add Alibaba Token Plan (`token-plan.ap-southeast-1`) — the
  fourth Alibaba key type, Singapore-only and OpenAI-compatible transport only
- **Providers**: add `glm-5.3` to GLM Coding and GLM (China)
- **Providers**: Kimchi accepts API keys as well as OAuth (dual auth), with a
  working Test Connection for both modes
- **Antigravity**: add Gemini 3.7 Flash and its tiered high/medium/low variants
  (also in the Gemini registry) with pricing and quota tracking
- **TTS**: add Fish Audio — model id travels in an HTTP `model` header, voice
  is a `reference_id` (preset or cloned voice model)
- **OpenCode-Go**: route by request format via declared transports instead of
  forcing every client into `/messages` — Codex/OpenAI clients no longer pay a
  lossy Responses→OpenAI→Claude double translation. Per-model `supportedFormats`
  guard; the bespoke executor is gone (its shared `_lastModel` cache could cross
  auth headers between concurrent requests)
- **Usage**: dedup + cache Claude quota calls (120s TTL keyed by access token,
  in-flight promise dedup, last-good read on soft failure) to stop multiple
  tabs tripping 429; manual refresh (↻) sends `force=1` to bypass the cache

## Fixes
- **Docker**: ship `sql.js` in the image so the pure-JS DB fallback can start —
  file tracing carried the package's JS without `dist/sql-wasm.wasm`, so a
  container with no native driver aborted with ENOENT and never got a database
  (#3248)
- **Usage**: read Gemini `usageMetadata` out of the antigravity `{ response }`
  envelope — every non-streaming antigravity request logged `IN 0 | OUT 0`
  (#3260)
- **Claude**: re-anchor passthrough cache breakpoints — the client's own
  `cache_control` markers point at pre-normalization offsets, so the tail was
  re-cached every request. Last system block and last tool pinned at 1h TTL,
  last assistant turn at 5m, mid-conversation system messages folded into the
  neighbouring user turn instead of hoisted into `body.system`
- **Combos**: detect images from Hermes and attachment payloads (`images[]`,
  `experimental_attachments`, message-level `image_url`/`audio_url`, inline
  `data:` URIs) so the Vision Adapter auto-switch fires for Hermes/Ollama/
  Vercel AI SDK shapes
- **Kiro**: intercept chat via `x-amz-target` — Kiro IDE 1.0.228+ moved
  `GenerateAssistantResponse` to `POST /` + header, bypassing MITM. Also emit
  the now-mandatory initial-response frame and map the `auto` model slot
- **Kiro**: report real output tokens and stop discarding usable turns
- **Qoder**: detect billing blocks at stream start and return a synthetic 403
  so combo/account fallback triggers instead of leaking the error into chat
- **Antigravity**: strip competitive system prompts (Zed IDE's Claude-agent
  prompt) that Antigravity flags with a 429 Quota Exhausted
- **OpenCode**: send the official client fingerprint on free-tier requests so
  the Console stops classifying traffic as unidentified and rate-limiting it;
  session id resolves conversation-stable to preserve prompt caching
- **Responses**: don't close the message on an empty `tool_calls` array — some
  providers attach one to every chunk, and the truthy check ended the message
  on the first content token (#3234)
- **Translator**: preserve `prompt_cache_key` when converting chat to responses
- **Models**: expose snake_case token limits on `/v1/models`
- **Combos**: strip `stream_options` from the Fusion panel fan-out to avoid a
  DeepSeek 400 (#3024); raise the dashboard model-test probe budget to 1024 and
  soft-pass reasoning-only responses (#3010)
- **Headroom**: the toggle reflects the `headroomEnabled` setting even when the
  proxy is down — it previously showed OFF while the engine kept calling
  `/v1/compress`; proxy status stays visible via the status chip
- **Hermes**: add the `api_key` parameter to the model block in YAML config
- **Providers**: add llm7 to provider test support

## Docs
- **i18n**: add Spanish, French, and Brazilian Portuguese README translations

## Security
- **Real IP**: `x-9r-real-ip` and the Host fallback were trusted from
  client-controlled headers whenever `custom-server.js` was not in the request
  path (`npm run start`, `start:bun`), letting a remote caller pose as local to
  skip API key auth and reach `LOCAL_ONLY_PATHS` (`/api/mcp/*`,
  `/api/tunnel/enable`, `/api/auth/reset-password`). The server now stamps a
  per-process `x-9r-peer-token` on every request it sanitizes and only trusts
  `x-9r-real-ip` behind it — falling back to Host in development and failing
  closed in production (GHSA-pjm4-8fpg-f9p6). Also fixes IPv6 loopback
  detection (`::1`, `::ffff:127.0.0.1`) and routes `npm run start` /
  `start:bun` through `custom-server.js`
- **Search**: `resolveBaseUrl()` rejects client-supplied non-public baseUrls
  (SSRF guard on `/v1/search`)
- **Login**: fresh-install remote login with the default password returns 403
  without issuing a JWT
- **Usage**: `/api/usage/request-details` redacts request/response payloads

# v0.5.50 (2026-08-05)

## Features
- **Providers**: add TokenRouter (300+ models via OpenAI-compatible gateway) with
  exact per-model pricing for 110 models and `reasoning_effort` thinking config
- **Providers**: add Self-hosted STT / TTS / Embedding — point 9Router at your own
  OpenAI-compatible speech and embedding servers (whisper.cpp, faster-whisper,
  Kokoro-FastAPI, llama-server, vLLM, Infinity). Unlike the named cloud providers
  these read `baseUrl` per connection, so one provider can front several machines
- **Combos**: default-enable vision/audio capacity adapter (auto-routes to a
  vision/audio-capable model when the target lacks that capability, falling back
  to `oc/mimo-v2.5-free`), wired into chat handler routing
- **Endpoint**: auto-provision a "Default Key" for first-time users so `/v1`
  works without a manual dashboard step
- **Codex**: support GPT-5.6 Max/Ultra reasoning-level overrides (cx/ routes only)
- **Qoder**: support PAT (Personal Access Token) connections end-to-end, alongside
  OAuth device flow
- **CLI tools**: add OpenDesign (manalkaff/opendesign) support
- **Headroom**: report effective payload savings (tool schema/history bytes broken
  out, byte-savings % reflects actual outbound reduction)
- **Ollama**: Cloud quota tracker (session + weekly) + proactive background OAuth
  token refresh scheduler for all providers

## Fixes
- **Providers**: remove Qwen (OAuth flow stopped working reliably)
- **Passthrough**: detect codex-tui/Codex Desktop as native Codex client — they
  were falling through to the translator and losing fields like `reasoning.summary`
- **OAuth**: scope antigravity header fixes to loadCodeAssist/onboardUser only
- **OAuth**: keep `open` external in the build so xAI/Grok token refresh works on
  Windows
- **OAuth**: declare missing `searchParams` in register-session handler (was a
  500 instead of JSON on error)
- **DB**: `ENABLE_REQUEST_LOGS` env var now overrides the UI setting correctly;
  observability defaults to off (opt-in)
- **Translator**: preserve Codex Responses Lite tool use across chat-native
  OpenAI-compatible providers
- **Translator**: don't drop image-only user messages in `prepareClaudeRequest`
- **Translator**: drop JSON Schema keywords Gemini rejects (`uniqueItems`,
  `contains`, `multipleOf`, `unevaluatedProperties`, `unevaluatedItems`,
  `contentSchema`)
- **Claude**: remove global header cache that leaked one client's identity
  headers onto another client/account sharing the server; gate `anthropic-beta`
  by model instead
- **Antigravity**: drop retired Gemini 3.0 quota tiers, show Gemini 3.6 Flash
  usage bars
- **Cloudflare AI**: declare API key authentication (dashboard showed "No
  connections" despite an active key)
- **GitHub Copilot**: hold monthly-exhausted accounts until UTC month reset
  instead of only cooling down 120s
- **CodeBuddy**: dodge Tencent CN content filter, add usage tracking, normalize
  codebuddy-intl messages
- **Usage**: stop losing cached prompt tokens in the forced-SSE→JSON path
- **Grok CLI**: display the public subscription tier from the OAuth token claim
- **Providers**: count apikey connections for Ollama free-tier card; free-tier/
  apikey providers without `authModes` now default to apikey (were treated
  oauth-only)
- **Build**: include static/public assets in standalone output (login page hung
  on 404s when run via PM2)
- **Server**: support IntelliJ IDEA OpenAI-compatible clients over HTTP (h2c
  upgrade handling)
- **Auth**: redirect already-logged-in sessions away from `/login`
- **CLI tools**: enable Apply button for dynamic OpenAI/Anthropic-compatible
  provider connections
- **CLI**: include complete API artifacts in the CLI package
- **TTS**: a bare self-hosted model name is the MODEL, not the voice — `kokoro`
  was parsed as a voice against a default model, 404ing or synthesising with the
  wrong one
- **Embeddings**: self-hosted embeddings no longer fall back to `api.openai.com`
  when a connection has no `baseUrl` — that silently sent the input text and API
  key to OpenAI under a provider named "Self-hosted"
- **Embeddings**: an adapter that rejects a misconfigured connection now returns
  400 with the reason instead of escaping the handler uncaught
- **Embeddings**: bound the upstream fetch with `FETCH_CONNECT_TIMEOUT_MS` — an
  endpoint that drops packets never returns headers, so the request previously
  hung indefinitely

## Docs
- **i18n**: fix port typo, add RTK Token Saver feature descriptions

# v0.5.45 (2026-07-30)

## Features
- **TTS**: add Xiaomi MiMo text-to-speech (preset voices 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean, style control, language hint dropdown with Auto-detect, i18n for Style label/placeholder)
- **Providers**: add Poolside (OpenAI-compatible)
- **Providers**: add api-airforce, baidu, bazaarlink, bluesminds, kilo-gateway, llm7, morph, sambanova, tencent
- **OAuth**: zed / trae / windsurf providers + harden callback proxies
- **CLI tools**: set Claude Code max context tokens
- **Qoder**: PAT auth + refresh model list
- **Gemini**: Gemini 3.6 Flash tier routing + Gemini 3.5 Flash Lite
- **Claude**: bump default Opus to `claude-opus-5`
- **Kiro**: add Claude Opus 5 models
- **Usage**: Kimi and DeepSeek usage handlers
- **Usage**: SuperGrok weekly pool via gRPC-web

## Fixes
- **Refresh**: rotate `refresh_token` between retry attempts
- **Kiro**: canonicalize tool history and route API keys correctly
- **Kiro**: normalize dashboard thinking intensity models
- **Cursor**: stop leaking agent tool errors as text
- **Gemini**: fill empty tool schemas after `$ref` strip
- **Antigravity**: strip `stream_options` from non-stream requests
- **Jina-reader**: recover after transient errors, use JSON POST API
- **Usage**: record exact embedding tokens
- **Tunnel**: preserve successor cloudflared PID
- **Console-log**: initialize capture at server boot + prevent SSE proxy buffering
- **Dashboard**: count dual-auth, free-tier OAuth and API-key connections correctly
- **Dashboard**: flex quota rows, thin global scrollbars, no hidden-row overflow

## Docs
- **i18n**: expand pt-BR translation to 986 terms
- README: Indonesian translation

# v0.5.40 (2026-07-20)

## Features
- **i18n**: add Khmer (km) translations
- **CLI tools**: configure Grok Build subagent models
- **Kimi**: merge OAuth into dual-auth provider, add K3 / K2.7 models
- **Dashboard**: ProviderTopology flow animation

## Fixes
- **DB**: resolve better-sqlite3 parameter binding crash
- **Translator**: pass `service_tier` through OpenAI → Responses conversion
- **Kiro**: map GPT-5.6 reasoning effort fields
- **Kiro**: validate terminal streams before emitting output
- **Kiro**: map GPT reasoning effort fields
- **Codex**: current `client_version` + refresh-aware model sync
- **Alicode-intl**: split into Coding Plan + Model Studio providers
- **Cursor**: HTTP/2 AgentService support + version bump 3.12.17
- **Dashboard**: cut duplicate API/icon spam, lazy-load provider assets


# v0.5.35 (2026-07-16)

## Features
- **xAI**: Grok Imagine video generation (`/v1/videos`) + CLI
- **CLI tools**: Grok Build setup — choose separate main/general-purpose/explore/plan models and preserve each model's context window
- **GitHub Copilot**: route Claude models through Copilot's native `/v1/messages`
- **Kiro**: add GPT-5.6 model family (#2596)
- **RTK**: `X-9Router-Token-Saver` header to bypass token savers per request
- **Providers**: quota visibility settings
- **Translator**: drop temperature for all Claude models
- **i18n**: Thai (th) + Persian (fa) translations / README

## Fixes
- **Providers**: bulk-add API keys no longer overwrite existing keys (gap-fill `Key N`)
- **Anthropic**: lowercase `anthropic-version` header to prevent duplication on `/v1/messages`
- **Alicode-intl**: use DashScope compatible-mode endpoint so standard keys work
- **Grok CLI**: align Grok Build with current subscription protocol (#2590)
- **Grok CLI**: surface `expiresAt` so proactive token refresh fires (#2546)
- **Kiro**: improve direct session cache reuse
- **Models**: populate capabilities for live-catalog LLM models
- **Models**: list compatible provider models in `/v1/models`
- **Thinking**: send explicit `thinking:{type:adaptive}` alongside `output_config.effort`
- **Translator**: strip `client_metadata` when converting openai-responses → openai

## Improvements
- **Perf**: skip inactive background services on startup

## Docs
- README: Persian YouTube tutorial

# v0.5.30 (2026-07-10)

## Features
- **Perplexity**: add Agent API provider (#2492)
- **Grok CLI**: add Grok CLI / Grok Build provider with OAuth device-code flow (#2502)
- **Featherless**: add OpenAI-compatible provider presets
- **SearXNG**: configure endpoint via SEARXNG_URL env (#2499)
- **Providers**: add max thinking level for gpt-5.6-sol (#2500)
- **Headroom**: add extras detection and install UI (#2403)
- **Headroom**: activate/uninstall extras + fix interpreter detection
- **PXPipe**: PXPIPE token saver — multimodal prompt compression (#2465)
- **Proxy-Pools**: auto-rotate strategy for no-auth providers (#2409)

## Fixes
- **Cloudflare-AI**: support accountId in bulk key import (#2449)
- **DB**: backup on schema change, MCP child cleanup, codex models, usage providers OOM
- **Codex**: avoid bare-email OAuth dedup (#2477)
- **CLI**: allow staged app bundle builds (#2479)
- **Headroom**: compress Kiro conversation state (#2488)
- **Gemini-CLI**: raise output floor for thinking and add validated toolConfig (#2486)
- **GitHub**: label Copilot profiles by account identity (#2498)
- **OpenAI-to-Claude**: unwrap bare {function:{…}} tools without parent type (#2473)
- **Translator**: clamp thinking effort max->xhigh for OpenAI format (#2466)
- **RTK/find**: detect and group Windows backslash-style find output (#2448)
- **Codex**: handle fast tier and capacity SSE (#2452)
- **Volcengine-ark**: clamp Kimi max_tokens to 32768 endpoint cap
- **Antigravity**: align provider fingerprint with IDE Desktop 2.1.1 (#2389)
- **Pricing**: update Claude/Codex model rates and add new models

## Improvements
- **i18n(zh-CN)**: complete Chinese translations for all UI strings (#2436)
- **API**: caching for tunnel and version status endpoints
- **Perf**: faster dev startup and lighter bundle

# v0.5.20 (2026-07-07)

## Features
- **Thinking**: per-model thinking level picker on provider page — appends `(level)` suffix to copied model names for forced reasoning effort across all formats (openai, claude, gemini, deepseek, kimi, qwen, zai, minimax, hunyuan, step)
- **RTK**: add JS-native git-log filter (#2423)
- **Caveman**: add targeted upstream-aligned style rules (#2424)
- **i18n**: add Farsi (fa) language support (#2385)

## Fixes
- **Thinking**: strip `(level)` suffix from upstream `body.model` so providers no longer reject requests
- **Translator**: preserve developer instructions in openai-responses conversion (#2434)
- **count_tokens**: count structured Anthropic blocks (#2419)
- **Volcengine-ark**: clamp GLM-5 max_tokens to model output ceiling (#2428)
- **Kimi**: normalize reasoning_effort to backend enum (#2427)
- **Claude**: reconcile max_tokens vs thinking budget and lift per-model ceiling (#2381)
- **Kiro**: deliver system prompt natively, add Opus 4.5/4.7/4.8, tolerate dash version ids (#2366)
- **Headroom**: proxy dashboard through app (#2372)
- **MITM**: recover from stale lock file on server start

# v0.5.18 (2026-07-03)

## Features
- **Usage**: track cached tokens + correct input/output/cache cost (#2209) — hodtien
- **Codex**: show reset credit expiry details (#2290) — Rafli Ahmad Zulfikar
- **NVIDIA**: add new models and capabilities — decolua
- **ClinePass**: add provider support — sternelee

## Fixes
- **Usage**: dedupe streaming request-details log entries — Qin Li
- **Claude**: drop foreign thinking signatures in passthrough — decolua
- Prevent non-SSE stream pipe crash and cross-IdP account overwrites (#2244) — KunN-21
- **Kiro**: route IdC auth to regional CodeWhisperer surface (#2297) — Volodymyr Saakian
- **Kiro**: add Claude Sonnet 5 model support (#2264) — Edison42
- **Xiaomi-tokenplan**: region selector, key validation, multi-connection (#2251) — MiQieR
- **Translator**: strict Anthropic content block compliance (#2225) — Sahrul Ramadhan Hardiansyah
- **Kimchi**: strip reasoning_content echo to bound multi-turn input tokens — KunN-21
- **Kimchi**: bump User-Agent to kimchi/0.1.40 (#2256) — Ansh7473
- **Codebuddy-cn**: strip empty tool_calls arrays to preserve reasoning — zmf
- **Antigravity**: preserve Claude tool delta index (#2223) — Sutarto Jordan Chrisfivo
- **MITM**: generate root CA on server startup (#2228) — Sutarto Jordan Chrisfivo

# v0.5.15 (2026-06-29)

## Features
- Add Kimchi OAuth provider — Nant361
- Refine Qwen vision/video + thinking model patterns — decolua
- Opt-in Codex auto-ping quota keep-alive — Emirhan

## Fixes
- **Responses**: handle response.done terminal events (#2142) — rifuki
- **Headroom**: skip unsafe responses tool history (#2132) — Sutarto Jordan Chrisfivo
- **Translator**: map mid-conversation system message to user (claude→openai) — decolua
- **Gemini**: normalize contents to prevent 400 invalid_argument (#2192) — warelik
- **Gemini**: backfill thoughtSignature + suppress stream done sentinel — WARELIK
- **Alicode**: preserve cache_control for DashScope providers (#2069) — Rex
- **Antigravity**: strip deprecated/readOnly/writeOnly from tool schemas — iletai, Yudhistira-Official
- **CodeBuddy CN**: show bonus packs as one-time, not monthly-replenishing — whale9820
- **Kiro**: strip leaked <thinking> tags from content stream (#2158) — hamsa0x7
- **Tray**: make Windows context menu DPI-aware — Emirhan
- **Kilocode**: expose full gateway catalog in combo model picker — jellylarper
- **OpenCode**: fix Go GLM — decolua

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page — decolua
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source — decolua
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- CodeBuddy CN: show one-shot bonus packs as expiring, not monthly-replenishing
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout — decolua
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)
