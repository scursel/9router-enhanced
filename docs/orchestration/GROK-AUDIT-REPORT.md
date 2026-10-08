# Auditoria independente — sync upstream v0.5.99

Auditor: Grok (worker `term_1a95c1c8-d78e-42f0-8b99-7af67bbcbf4e`, task `task_017d9a1f0f39`, dispatch `ctx_d456f04e1a61`).
Data: 2026-10-08. Worktree: `/home/scursel/orca/workspaces/9router-enhanced/sync-upstream-v0.5.99`.
Branch: `sync/upstream-v0.5.99` (árvore limpa).

Commits conferidos:

| Papel | SHA | Assunto |
|---|---|---|
| Base do fork | `2faeefa9` | `scursel/coney` |
| Upstream | `ce4460ef` | `v0.5.99` |
| Merge | `18d3c27b` | `chore(sync): merge upstream v0.5.99 → v0.5.99-enhanced.1` (pais `2faeefa9` + `ce4460ef`) |
| Relatório do executor | `002db928` | `docs(sync): add upstream v0.5.99 synchronization report` |

HEAD é `002db928`. Não há push, PR nem deploy neste worktree.

**Veredito: aprovado para PR, com ressalvas de gate.** Nenhuma feature do fork pedida no enunciado foi perdida, e os 20 conflitos seguem a tabela do §3. Dois gates não reproduziram o número literal do commit de merge neste host (vitest e eslint). Não há correção de código obrigatória antes do PR.

## 1. Features do fork

| Feature | Estado |
|---|---|
| Soft-error guard | Presente. `chat.js` passa `shouldContinueOnSuccess: softErrorContinue` (`createSoftErrorContinuePolicy`). |
| Semáforo por conta | Presente. `acquire` / `resolveAccountSemaphoreKey` antes do probe HALF_OPEN. |
| Circuit breaker + latch `settleOutcome` | Presente. Um settle por request, inclusive no `catch` do loop de contas (HALF_OPEN não fica sem desfecho) e no `finally` que solta o semáforo. |
| Cota dinâmica Antigravity | Presente. `parseAntigravityQuotaModels` lê `agentModelSorts` e suprime ids com `deprecatedModelIds` quando o substituto existe. O set estático ainda inclui os 3.5 e os ids pedidos: `gemini-3.1-pro-high`, `claude-sonnet-5-5` (+ low/medium/high), `claude-opus-5-5` (+ low/medium/high). |
| Web routing | Presente em `search.js` e `fetch.js`: `getComboModels`, `assertWebComboKind`, `resolveWebProviderId`, `runWebCombo`, `recordModalityUsage`. |
| Escopo visível em `/v1/models` | Presente. `GET` faz `buildModelsList([LLM_KIND], { skipDynamicFetch, scope: modelsScopeFromRequest(request) })`, depois `filterModelsListForKey`, depois `?tier=free`. |
| Hash de API key no uso + lookup em claro | Presente. `publicApiKeyBuckets` publica `sha256` truncado. `getApiKeyByKey` faz `SELECT * FROM apiKeys WHERE key = ?` com a chave apresentada. O teste `key-access-migration` cobre o lookup `sk-v2-plain-key-12345`. |
| Tema / layout mobile | Presente. `Header.js`: `searchVisible` esconde o título no celular, `ThemeToggle variant="header"`, crumbs `hidden sm:flex`, Donate `hidden sm:flex`. `ModelRow.js` mantém chips, combos, `pointer-fine:` e ícones `text-[17px]`, e ganhou `w-full sm:w-auto`, `break-all sm:truncate` e o grupo `sm:shrink-0`. |

## 2. Os 20 conflitos contra o §3

Diff conferido contra `2faeefa9` e `ce4460ef`.

| Arquivo | Regra | Resultado |
|---|---|---|
| `package.json`, `cli/package.json` | `0.5.99-enhanced.1`; `enquirer`; `@aws-sdk/credential-providers` opcional com o comentário; scripts `precli:pack`, `cutover:verify`, `prepare` | Ok. |
| `CHANGELOG.md` | Entrada `0.5.99-enhanced.1` no topo; as duas histórias abaixo | Ok. |
| `registry/index.js` | Upstream `p134..p137`; `orcarouter` em `p138`; os cinco no array | Ok. `orcarouter.js` não divergiu da base. Os quatro providers novos batem com o upstream (diff vazio). |
| `usage/google.js` | Parser do fork + ids novos; 3.5 ficam | Ok. |
| `thinkingUnified.js` | União | Ok. Muse em `resolveFormat`; `case "openai-responses"`; skip de `"auto"` em `openai`, `step` e `openai-responses`; um clamp `minimal→low` no `claude-adaptive` (não duplicado no case responses); piso `CLAUDE_MIN_BUDGET_TOKENS` no `claude-budget`; import do piso mantido. |
| `Header.js` | União mobile | Ok. Ver §1. |
| `ModelRow.js` | Base = fork + três ajustes do upstream | Ok. Diff contra o fork: três classes. Props do fork continuam. |
| `ClaudeToolCard.js`, `EndpointPageClient.js` | Base mobile do fork; Hermes e key-access do upstream | Ok, com troca de técnica. O miolo é o do upstream (`eea08215` / Hermes). O fork reaparece em alvos de toque: `pointer-coarse:text-[18px]`, botão `w-full sm:w-auto` / “Select Model”, `break-words` no nome da key. O delete da key usa `opacity-100 sm:opacity-0 sm:group-hover:opacity-100` (visível no celular). As grids `sm:grid-cols-[8rem_auto_1fr_auto]` continuam nos blocos que ainda têm a coluna extra. |
| `api/providers/route.js` | `toProviderConnectionResponse` + `apiKeyOptionalWith`; sem `isActive: true`; catalog sync `{ automatic: true }` | Ok. |
| `api/providers/[id]/route.js` | Resposta sanitizada + `sessionToken` AWS + `if (!updated) return 404` | Ok. |
| `api/v1/models/route.js` | Ordem scope → key-access → tier=free | Ok. Diff contra o fork: import + uma linha de filtro. |
| `api/v1/models/[...model]/route.js` | `filterModelsListForKey` nos dois caminhos; `scope` / `MODELS_SCOPE_ALL` mantidos | Ok. Três caminhos filtrados. |
| `api/v1beta/models/[...path]/route.js` | `enforceKeyAccessResolved` + F33 do fork | Ok. Diff contra o fork: só o guard. O conversor inline do upstream (`convertGeminiToInternal`) não voltou; o caminho F33 permanece. |
| `sse/handlers/chat.js` | Base do fork + key-access antes do bypass/combo; `filterAdapterModels` nas duas expansões e no combo aninhado | Ok. O combo aninhado não reavalia `enforceKeyAccess` (a decisão fica no alvo externo), como o plano pede. |
| `search.js`, `fetch.js` | Base do fork; `enforceKeyAccessProvider(..., comboModels?.length ? comboModels : null)` depois de `getComboModels` e antes do branch | Ok. |
| `imageGeneration.js` | `enforceKeyAccess`; `onUsage` → `recordImageRequestUsage`; `recordModalityUsage` só se `usageRecorded` é falso; caminho `noAuth` | Ok. `noAuth` não tem `onUsage`, então grava modalidade uma vez. |
| `auth.js` | Breakers, `applyCooldownOnly`, `lastErrorCode` default 503, e `getAntigravityModelQuota(connQuotas, model) \|\| connQuotas?.[model]` nos dois pontos | Ok. |

Segurança da resposta de conexão: `toProviderConnectionResponse` remove `apiKey`, `accessToken`, `refreshToken` e `idToken`. Em providers AWS também remove `providerSpecificData.sessionToken`. O guard `if (!updated)` continua antes de serializar, então um update perdido não vira `200 { connection: {} }`.

## 3. Armadilhas do §4

1. **`SCHEMA_VERSION = 3`.** O backup usa `backupSchemaVersion`, separado do `schemaVersion` das migrações. `runVersionedMigrations` aplica `001`–`003` só quando `schemaVersion` é menor (003 = reset do backoff do Cline, versão 3). Em seguida `syncSchemaFromTables` acrescenta colunas que faltam, inclusive `accessRestricted` e `accessAllow`. Um DB de produção com backup em 2 e migração 003 já aplicada faz o backup `schema-2-to-3` e não roda a 003 de novo. DB novo cria as colunas no `CREATE TABLE`. O teste `upgrades a v2 DB to v3...` em `tests/unit/key-access-migration.test.js` exige as duas colunas, o lookup em claro e um diretório `schema-2-to-3`.
2. **Lookup da key.** `getKeyAccessContext` chama `getApiKeyByKey` na tabela `apiKeys`, não o hash do usage.
3. **Snapshots P0.** `golden-url-header.test.js` troca UUIDs por `<UUID>` (cobre `X-Mavis-Session-Id`). O snap tem `"X-Mavis-Session-Id": "<UUID>"` e `User-Agent` `9Router/0.5.99-enhanced.1`. Não há `9Router/0.5.95` nem `9Router/0.5.99` sem o sufixo enhanced nesse arquivo.
4. **Testes de quota.** `antigravity-mitm.test.js` aponta o default para `gemini-3.8-flash-medium` (catálogo novo). `antigravity-claude-5-5.test.js` é arquivo novo do upstream. Os dois `it` de family quota em `antigravity-quota-routing.test.js` ficaram **fora** do `describe`, iguais ao upstream `ce4460ef`. O `beforeEach` é do módulo, então eles ainda rodam. Não é regressão do fork; a indentação é a do upstream.
5. **Baselines.** `verify-providers`, `verify-alias` e `verify-oauth-urls` passaram byte a byte nesta auditoria (94 providers, 128 tokens, OAuth equal).
   - Providers: entradas novas `minimax-code`, `minimax-code-global`, `bedrock`, `bedrock-xai`.
   - Alias: seis tokens novos (`br`, `bedrock`, `aws-bedrock`, `brx`, `bedrock-xai`, `bedrock-grok`). Nenhum alias antigo mudou de alvo. `modelKeys` só ganhou `br`, `brx`, `el`, `mm`, `mmg`.
   - `idToAlias` ganhou mais 40 ids que já estavam no registry do fork (elevenlabs, cartesia, e o restante de mídia). A causa é o upstream: `PROVIDER_ID_TO_ALIAS` passou de `Object.keys(PROVIDERS)` para `REGISTRY.map`. Não há remoção nem retarget.
   - OAuth: `oauth-urls-baseline.json` e `verify-oauth-urls.mjs` **não mudaram**. O script não lista minimax-code, e `tokenUrl` está em `ADDED_FIELDS` do verify-providers (sai da comparação). As URLs estão nos arquivos de provider, idênticas ao upstream, mas o gate de OAuth não as trava. É um furo de cobertura do §4.5, não uma URL errada.

`known-fails.txt` continua só com comentários. A lista efetiva está vazia.

`tests/__baseline__/current.json` foi reescrito no merge (~1,8 MB de JSON de vitest com paths absolutos deste worktree e do histórico antigo). Nenhum gate lê esse arquivo. O scan de segredos do range não acusou segredo nele.

## 4. Gates medidos de novo

| Gate | Resultado nesta auditoria |
|---|---|
| `cd tests && npx vitest run` | **Exit 1.** `Test Files  1 failed \| 488 passed \| 18 skipped (507)`. `Tests  2 failed \| 5128 passed \| 12 expected fail \| 118 skipped \| 1 todo (5261)`. Duração 414 s. O commit de merge afirma 5130 pass / 0 fail. 5128+2 = 5130: os dois testes a mais são os que falharam aqui. |
| Falhas | `unit/xai-oauth-service.test.js`: “generates dashboard auth data…” estoura o timeout padrão de 5000 ms; “exchanges dashboard codes…” quebra com `response` undefined (`response.ok`). Repetido com a máquina ociosa (de novo 2 failed / 3 passed). Com `--testTimeout 30000` o arquivo passa 5/5; o caso de generate levou ~8 s (import frio do barrel de providers dentro do teste). O arquivo de teste e `src/lib/oauth/providers/xai.js` / `services/xai.js` são idênticos ao upstream. O único delta do merge em `providers/index.js` contra o fork são os imports `minimax-code` e `minimax-code-global`. A segunda falha é o discovery ainda em voo do teste que estourou, não um endpoint errado. |
| `verify-no-regression` | O script exige um `results.json` (`exit 2` sem argumento). Não gerei JSON da suíte. Com `known-fails` vazio, as 2 falhas acima seriam regressão para esse gate. Não são falha de produto do merge. |
| Baselines | Os três verdes. Ver §3.5. |
| `npm run build` | **Exit 0.** `postbuild` copiou static, public e `custom-server.js` para `.next/standalone/`. Pacote `9router-app@0.5.99-enhanced.1`. |
| `npx eslint .` | **Exit 1.** 137 errors, 216 warnings. Não é “0 erros”. 28 erros estão em arquivos que mudaram desde `2faeefa9` (ClaudeToolCard, HermesToolCard, EndpointPageClient, proxy-pools, modais). A mesma regra `react-hooks/purity` / setState em effect dispara em cards que o merge não tocou (Codex, Antigravity, Cline, …). Hermes e proxy-pools vieram do upstream. Não é um erro novo inventado na resolução dos conflitos, e também não é uma árvore com eslint limpo. |
| `node scripts/check-no-secrets.mjs` | Exit 0, “nothing staged — clean”. Sem `--no-verify` (não houve commit nesta auditoria). |
| `node scripts/check-no-secrets.mjs --range 2faeefa9..HEAD` | Exit 0, com aviso de binário não escaneável em `public/providers/bedrock.png` e `bedrock-xai.png`. Nenhum padrão de segredo. |
| Marcadores de conflito | `rg` de `<<<<<<<` / `>>>>>>>` fora de `node_modules` e `.next`: nenhum. |

Testes novos pedidos no §5.3 existem: schema v2→v3 em `key-access-migration.test.js`, lookup em claro no mesmo arquivo, key-access com scope visible em `models-visible-scope.test.js` (“applies key-access together with visible scope”), e combo search em `key-access-handlers.test.js` (“search combo key-access via getComboModels”). Os arquivos focados do §5.2 estão no tree (`gemini-duplicate-tool-call-ids`, `gemini-contents-normalization`, `key-access*`, `minimax-code*`, `codex-image-usage-persistence`, `muse-responses-wire`, `antigravity-claude-5-5`, `antigravity-mitm`, `models-visible-scope`, `stream-finish-then-close`, `thinking-auto-minimal-mapping`, `f24b-account-loop-catch`, `web-canonical-ids`, `web-empty-fallback`, `f28-search-key-exfil`).

## 5. O que não bloqueia o PR

- Cobertura do baseline de OAuth não inclui o `tokenUrl` do MiniMax Code. Os arquivos de provider são os do upstream.
- `current.json` grande e com path local. Não vaza segredo segundo o scanner; não alimenta gate.
- Os `it` de family quota fora do `describe` são herança literal do upstream.
- ESLint da árvore inteira continua vermelho pelo mesmo padrão dos cards antigos.
- O timeout de 5 s do xAI OAuth reproduz neste host e passou no run que o executor registrou. O comportamento, com timeout folgado, está certo.

## 6. Segurança

Nada a corrigir no merge para vazar credencial. A resposta HTTP de provider deixa de espalhar o objeto cru e passa pelo sanitizador, que também tira `sessionToken` AWS. O lookup de key-access não usa o hash do histórico. O range `2faeefa9..HEAD` não acusou segredo; os PNGs novos de Bedrock são binários opacos para o scanner (ícones de provider, não blobs de estado). Não rodei `--no-verify`. Não há credencial real neste relatório.
