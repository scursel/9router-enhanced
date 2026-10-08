# Relatório de Sincronização: Upstream v0.5.99 → `0.5.99-enhanced.1`

**Data:** 08/10/2026  
**Repositório:** `9router-enhanced` (fork de `decolua/9router`)  
**Base:** `scursel/coney` @ `2faeefa9` (`0.5.95-enhanced.1` + PR #13)  
**Upstream Alvo:** `upstream/master` @ `ce4460ef` (`v0.5.99`, 28 commits desde o merge-base `a99cf572` = `v0.5.95`)  
**Branch de Trabalho:** `sync/upstream-v0.5.99`  
**Merge Commit:** `18d3c27b` (`chore(sync): merge upstream v0.5.99 → v0.5.99-enhanced.1`)  

---

## 1. Resumo Executivo & Métricas

A sincronização integrou 28 commits do upstream `v0.5.99` preservando 100% das extensões e melhorias do fork `9router-enhanced`.

### Métricas da Suíte de Testes
| Métrica | Pré-Merge (`0.5.95-enhanced.1`) | Pós-Merge (`0.5.99-enhanced.1`) | Delta |
|---|---|---|---|
| **Arquivos de Teste** | 487 | 507 | +20 arquivos |
| **Testes Passando** | 4.721 | 5.130 | +409 testes |
| **Testes Falhando** | 0 | 0 | 0 |
| **Falhas Esperadas (`it.fails`)** | 12 | 12 | 0 |
| **Skips** | 79 | 118 | +39 (testes reais / cloud) |
| **Todos** | 1 | 1 | 0 |
| **Total de Testes** | 4.813 | 5.261 | +448 testes |
| **Tempo de Execução** | ~180s | ~182s | estável |
| **Regressões Detectadas** | 0 | 0 | `known-fails.txt` vazio |

---

## 2. Resolução dos Conflitos de Merge (20 Arquivos)

Todos os 20 arquivos em conflito textual mapeados no plano foram resolvidos estritamente segundo as regras do §3:

1. **`package.json` / `cli/package.json`**:
   - Versão definida como `0.5.99-enhanced.1`.
   - Adotadas as novas dependências do upstream: `enquirer`, `@aws-sdk/credential-providers` (em `optionalDependencies` com comentário explicativo).
   - Preservados todos os scripts do fork (`precli:pack`, `cutover:verify`, `prepare`).

2. **`CHANGELOG.md`**:
   - Entrada `0.5.99-enhanced.1` adicionada no topo sumarizando as novidades do upstream e as features mantidas do fork.

3. **`open-sse/providers/registry/index.js`**:
   - Adicionados os provedores `minimax-code`, `minimax-code-global`, `bedrock`, `bedrock-xai`.
   - Renumerado o provedor do fork `orcarouter.js` para a posição `p138` (comentário do buffer atualizado para iniciar após o upstream).

4. **`open-sse/services/usage/google.js`**:
   - Mantida integralmente a parser dinâmica do fork (`parseAntigravityQuotaModels`, lendo `agentModelSorts` e `deprecatedModelIds`, classificação tier free/paid/unknown).
   - Acrescentados em `ANTIGRAVITY_QUOTA_MODELS`: `gemini-3.1-pro-high`, variantes `claude-sonnet-5-5` (-low, -medium, -high) e `claude-opus-5-5` (-low, -medium, -high).
   - Mantidos os IDs 3.5 com supressão dinâmica quando houver modelo substituto.

5. **`open-sse/translator/concerns/thinkingUnified.js`**:
   - União: preservados imports de `CLAUDE_MIN_BUDGET_TOKENS`, skip de `"auto"` em `openai` e `step`, clamp `minimal→low` e piso de 1024 no `claude-budget`.
   - Adotados do upstream: suporte a Muse em `resolveFormat` e o case `openai-responses` (incluindo o skip de `"auto"` de forma análoga a `openai`).

6. **`src/shared/components/Header.js`**:
   - União: do fork, `searchVisible` (oculta título no mobile com busca ativa), espaçamento compacto e `ThemeToggle variant="header"`.
   - Do upstream: breadcrumb retrátil (`hidden sm:flex` nos intermediários, truncate, ícone compacto) e botão de doação com responsividade mobile.

7. **`src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`**:
   - Base = fork (chips de contexto e reasoning, nomes de combos, seleção visual, add-to-combo, `pointer-fine:`, ícones estilizados).
   - Incorporadas melhorias não-conflitantes do upstream: classes de wrapping `w-full sm:w-auto`, truncamento adaptativo e agrupamento de botões de ação em `flex shrink-0`.

8. **`src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js` e `EndpointPageClient.js`**:
   - Base = layout mobile do fork combinado com refinamentos de layout mobile do upstream (`eea08215`).
   - Adotadas integralmente as novas funcionalidades de UI do upstream para Hermes e controle de acesso a API keys (KeyAccessControls).

9. **`src/app/api/providers/route.js`**:
   - Adotados `toProviderConnectionResponse` e `apiKeyOptionalWith` (Bedrock).
   - Mantidos do fork: remoção de `isActive: true` estático e sincronização assíncrona do catálogo (`syncConnectionCatalog(..., { automatic: true })`).

10. **`src/app/api/providers/[id]/route.js`**:
    - Adotados `toProviderConnectionResponse` e sanitização/gerenciamento de `sessionToken` da AWS.
    - Mantido guard do fork `if (!updated) return 404` antes de responder.

11. **`src/app/api/v1/models/route.js`**:
    - Sequência preservada: `buildModelsList([LLM_KIND], { skipDynamicFetch, scope: modelsScopeFromRequest(request) })` → `filterModelsListForKey(await getKeyAccessContext(request), …)` → filtro `?tier=free`.
    - Escopo visível do dashboard e restrição RBAC por API key ativos e combinados.

12. **`src/app/api/v1/models/[...model]/route.js`**:
    - Adotado `filterModelsListForKey` em ambos os fluxos, preservando parâmetros de escopo e opções do fork.

13. **`src/app/api/v1beta/models/[...path]/route.js`**:
    - Adotado `enforceKeyAccessResolved`, preservando os testes F33 de ferramentas de resposta do fork.

14. **`src/sse/handlers/chat.js`**:
    - Base = fork: semáforo de concorrência e circuit breaker por conta, latch `settleOutcome`, captura de exceção no loop de contas, soft-error guard e delegação de HALF_OPEN.
    - Inseridos `getKeyAccessContext` e `enforceKeyAccess(modelStr)` antes da resolução de combos, e aplicados `filterAdapterModels` nas chamadas do adapter de capacidade.

15. **`src/sse/handlers/search.js` e `src/sse/handlers/fetch.js`**:
    - Base = fork: `getComboModels` + roteamento web (`assertWebComboKind`, `resolveWebProviderId`, `runWebCombo`, `recordModalityUsage`).
    - Inserida validação `enforceKeyAccessProvider(await getKeyAccessContext(request), providerInput, comboModels?.length ? comboModels : null)` antes do branch de combo.

16. **`src/sse/handlers/imageGeneration.js`**:
    - Adotados do upstream: controle de acesso por key e rastreamento exato via `onUsage` → `recordImageRequestUsage` (Codex).
    - Mantido `recordModalityUsage` do fork como fallback condicionado à flag `usageRecorded`, evitando contagem duplicada. Mantido suporte a noAuth.

17. **`src/sse/services/auth.js`**:
    - Preservados disjuntores, leitura de `Retry-After` de disjuntores abertos, `applyCooldownOnly` e `lastErrorCode` padrão 503.
    - Adotada resolução upstream de cota Antigravity: `getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model]`.

---

## 3. Armadilhas Sem Conflito Textual Resolvidas (§4)

1. **Colisão de `SCHEMA_VERSION` e Migração Segura (§4.1)**:
   - Ambas as branches haviam subido a versão para 2. Como bancos de dados de produção do fork já estavam na versão 2, novas colunas `accessRestricted` e `accessAllow` na tabela `apiKeys` não teriam backup prévio automático disparado.
   - A versão foi incrementada para **3** em `src/lib/db/schema.js`.
   - Adicionada proteção em `src/lib/db/migrations/002-usage-event-id.js` caso a tabela `usageHistory` ainda não exista durante a cadeia de inicialização de testes.
   - Escrito teste unitário verificando upgrade de um banco v2 para v3 com backup de segurança `schema-2-to-3`.

2. **Plaintext Key Lookup para Key Access (§4.2)**:
   - O fork utiliza hashes criptográficos na tabela `usageHistory`, mas o upstream implementou a verificação de acesso consultando diretamente a tabela `apiKeys` via `getApiKeyByKey`.
   - Verificado e testado que `getApiKeyByKey` lê a chave em texto puro corretamente sem interferir no hashing de auditoria de uso.

3. **Snapshots Determinísticos de URLs e Headers (§4.3)**:
   - Os testes P0 em `tests/translator/golden-url-header.test.js` atualizados para a nova versão `0.5.99-enhanced.1`.
   - Como os provedores MiniMax Code geram cabeçalho dinâmico `X-Mavis-Session-Id` com `randomUUID()`, a função `sanitize` foi estendida para mascarar UUIDs dinâmicos como `<UUID>`, tornando os snapshots 100% determinísticos entre execuções.

4. **Parser Dinâmica de Quota Antigravity (§4.4)**:
   - O upstream assumia modelos fixos; o fork utiliza ordenação e detecção dinâmica. Modelos 3.5 são mantidos no catálogo enquanto não substituídos, satisfazendo a suíte com fidelidade ao comportamento do fork.

5. **Deltas de Baselines (§4.5)**:
   - `tests/__baseline__/providers-baseline.json`: adicionados `minimax-code`, `minimax-code-global`, `bedrock`, `bedrock-xai` e transporte `openai-responses` no Kimi.
   - `tests/__baseline__/alias-baseline.json`: adicionados aliases `mm` e `mmg`, e atualizadas as chaves de modelos correspondentes.
   - `tests/__baseline__/oauth-urls-baseline.json`: byte-a-byte idêntico.

---

## 4. Testes Novos e Ajustados

### Novos Testes Escritos neste Sync (§5.3):
- **`tests/unit/key-access-migration.test.js`**:
  - Teste de migração: upgrade de base v2 para v3, geração do backup `schema-2-to-3`, criação das colunas `accessRestricted` / `accessAllow` e preservação de chaves pré-existentes como irrestritas.
  - Teste de busca por chave plaintext na tabela `apiKeys`.
- **`tests/unit/models-visible-scope.test.js`**:
  - Validação combinada: filtro de escopo visível do dashboard (`scope=visible`) conjuntamente com restrição por chave de API (`filterModelsListForKey`).
- **`tests/unit/key-access-handlers.test.js`**:
  - Validação de restrição de chave em chamadas para `/v1/search` quando a requisição especifica um combo expandido via `getComboModels`.

### Testes Ajustados (Correções de Compatibilidade):
- **`tests/unit/combo-caps-resolver.test.js`**:
  - O commit `0f7f6e72` do upstream alterou a janela de contexto de GLM-5.3 de 200k para 1M. O teste, que usava GLM-5.3 como exemplo de fallback para 200k, foi ajustado para usar `glm-5.1` (preservando a asserção original sem violar a regra de capacidades reais do modelo).
- **`src/app/api/providers/[id]/test/testUtils.js`**:
  - Com a inclusão de `sttConfig` em ElevenLabs, a ordem de sondagem na lista `MEDIA_CONFIG_BODIES` priorizava STT (que exige multipart/form-data) sobre TTS (JSON). Reordenado para testar `ttsConfig` antes, mantendo a sondagem genérica funcional.
- **`tests/unit/key-access.test.js`**:
  - Adicionado mock para `getProviderConnections` em `@/lib/localDb`.
- **`scripts/check-no-secrets.mjs`**:
  - Adicionada a chave de exemplo padrão da documentação pública da AWS (`AKIAIOSFODNN7EXAMPLE`, utilizada em `tests/unit/aws-credentials.test.js`) na lista de identificadores públicos permitidos (`KNOWN_PUBLIC_KEYS`).

---

## 5. Resultados dos Gates (§5)

| Gate | Descrição | Comando | Resultado |
|---|---|---|---|
| **Gate 1** | Suíte de testes completa | `cd tests && npx vitest run` | **PASS** (5.130 pass, 0 fail, 12 expected fail, 118 skip, 1 todo) |
| **Gate 2** | Detecção de regressão | `node tests/__baseline__/verify-no-regression.mjs tests/__baseline__/current.json` | **PASS** (0 regressões, `known-fails.txt` vazio) |
| **Gate 3** | Testes críticos e novos | `npx vitest run ...` | **PASS** (18 arquivos / 221 testes + 6 arquivos / 50 testes 100% verdes) |
| **Gate 4** | Baselines byte-for-byte | `node tests/__baseline__/verify-*.mjs` | **PASS** (providers: 94 prov; alias: 128 tok; oauth: OK) |
| **Gate 5** | Build de produção | `npm run build` | **PASS** (Next.js standalone compilado com sucesso) |
| **Gate 6** | ESLint | `npx eslint .` | **PASS** (0 erros novos; baseline legado mantido) |
| **Gate 7** | Verificação de credenciais | `node scripts/check-no-secrets.mjs` | **PASS** (executado e aprovado sem `--no-verify`) |
| **Gate 8** | Marcadores de conflito | `git grep '<<<<<<<\|>>>>>>>'` | **PASS** (0 marcadores encontrados) |

---

## 6. Estado Atual & Próximos Passos

- O merge commit foi concluído na branch `sync/upstream-v0.5.99` no worktree local.
- Conforme as restrições inegociáveis do projeto: **nenhum push remoto foi realizado, nenhuma PR foi aberta e nenhum deploy foi acionado**.
- A árvore de trabalho está limpa e pronta para auditoria final.
