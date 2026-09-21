> **Contexto de arquivamento** (adicionado ao arquivar; o relatório abaixo está
> íntegro, sem edição). Segunda rodada de auditoria adversarial da política de
> rate-limit, executada por sessão independente e read-only em 2026-09-21.
>
> - **Auditou até** `c7bfcbf7`. **Não cobre** `044a7c1b`, que corrige os dois
>   defeitos novos que este relatório aponta (N1: o fold de escape removia toda
>   barra invertida e fundia `C:\share\d_pool` em `shared_pool`, parando a rotação
>   de credenciais num 500 genérico; N2: `ROTATION_FREE_CLASSES` continha
>   `daily_quota`, que por política deve rotacionar). As duas suspeitas de
>   assimetria 401×403 e de 404+`limit_rpd` foram depois pinadas como decisões
>   deliberadas por teste, e a suspeita de notação científica foi resolvida lendo
>   `1e3` como o número JSON válido que ele é.
> - **Status dos achados:** D1–D6 FIXADOS (em `c7bfcbf7`), N1–N2 corrigidos em
>   `044a7c1b`. O que empacotou tudo foi o `chore(release)` `1dad4336`
>   (`v0.5.81-enhanced.5`).
> - **Primeira rodada** (a que achou D1–D6) não gerou arquivo próprio; o resumo
>   dela está na seção "First audit round" do `CHANGELOG.md` sob
>   `v0.5.81-enhanced.5`.

# Auditoria adversarial — fix de rate-limit no 9Router

**Alvo:** `af23b010` — "fix(rate-limit): settle upstream throttles from the upstream's own numbers" e `c7bfcbf7` — "fix(rate-limit): close the gaps an adversarial audit found".
**Método:** provas por execução (`node --input-type=module`, `npx vitest`), ablação em worktrees descartáveis contra as árvores pré-fix, fuzz do invariante e comparação 1:1 da suíte completa com `tests/__baseline__/known-fails.txt`.
**Escopo:** read-only no repositório — nada foi modificado, commitado ou feito push.

---

## VEREDITO

**APROVADO COM RESSALVAS** — D1–D6 fixados e provados por execução, a suíte fecha 39/39 em 1:1 com o baseline e nenhum contrato pré-existente quebrou; mas o `stripBackslashes` do segundo commit introduz uma classe nova de falso positivo demonstrável (N1) e um comentário novo contradiz a tabela de políticas (N2).

## DEFEITOS: STATUS

**D1 — FIXADO.** `checkFallbackError(500, UNSUPPORTED_FREE_500, 0|9|15)` → `{shouldFallback:false, cooldownMs:1800000, applyCooldownOnly:true, newBackoffLevel:<inalterado>}` nos três níveis (`open-sse/services/accountFallback.js:146-165`). `daily_quota` entra no conjunto mas **rotaciona**: `checkFallbackError(500, DAILY_CAP_500, 9)` → `{shouldFallback:true, cooldownMs:300000, newBackoffLevel:9}`; com reset declarado → 10.800.997 ms (~3h). Na árvore `af23b010` os testes do tier aposentado reprovaram: `expected undefined to be true` (applyCooldownOnly) e `expected 3 to be 1` (loop).

**D2 — FIXADO.** Hook em `src/lib/db/migrate.js:433-436`, dentro do caminho de import bem-sucedido (após o commit da transação; o early-return de `MigrationAborted` vem **antes**, então o reset só roda com import OK). `driver.js:81-87` fecha o adapter e re-lança o que escapar de migração. Na árvore pré-segundo-fix: `resetInflatedClineBackoff is not a function` (ordenação) e `Error: simulated disk I/O error on UPDATE` propagava — ambos passam no HEAD.

**D3 — FIXADO.** `checkFallbackError(404, '{"limit_source":"upstream_provider_shared_pool"}')` → `{shouldFallback:true, cooldownMs:120000}` sem flag; wrapper 500 com `code:404` + pool no corpo continua alcançando o bloco estruturado (`{shouldFallback:false, cooldownMs:6000, applyCooldownOnly:true}`). Teste reprova na árvore mid: `expected { shouldFallback: false, …(3) } to deeply equal { shouldFallback: true, …(1) }`.

**D4 — FIXADO.** Bateria de fronteiras (`parseRetryHintMs`): `5`→5000, `2.5`→2500, `"5"`→5000, seguido de `,`/espaço/`}`/fim de string→5000; `1e3`/`1E3`/`1.2.3`/`5abc`/`-5`/`.5`/`[5]`/`5e2`→**null**; fallback `retry_after_seconds_raw`→8000. A regex antiga, comparada lado a lado, lia `1e3`→1 (1000 ms) e `1.2.3`→1.2. Sem NaN possível: o hint vem de `Math.round` de valor finito ≥ 0.

**D5 — FIXADO (profundidade).** `limit_source` e hint extraídos nas profundidades 0–3 e decisão `shared_pool` mantida na 3 (`applyCooldownOnly` 6 s). O falso positivo pedido **dispara** — ver N1.

**D6 — FIXADO, com ressalva (N2).** `AFFECTED_PROVIDERS` sumiu (`INFLATED_LADDER_PROVIDERS` alimenta placeholders **e** params; o teste de params reprova na árvore mid), o comentário "Both carry an explicit upstream window" foi reescrito, e `open-sse/services/combo.js:417-425` documenta o porquê do flag não ser lido.

## DEFEITOS NOVOS

**N1 (demonstrado — severidade média-baixa).** `rateLimitPolicy.js:138-140` remove **toda** barra invertida, sintetizando marcadores que não existiam. Input: `{"error":{"message":"scan the log dir C:\\share\\d_pool for details","code":500}}` — o texto bruto **não** contém "shared_pool" (verificado) — e `classifyUpstreamFailure(500, …)` retorna `shared_pool`, cooldown 30000; via `checkFallbackError` vira `applyCooldownOnly:true`: um 500 qualquer com esse texto **para de rotacionar**. Idem `unavailabl\e for free` → `unsupported_model` (30 min, sem rotação). O unwrap antigo (`\\(["\\/])`) não disparava (verificado: `false`). O JSDoc (`rateLimitPolicy.js:135-136`) afirma que um backslash literal "só perderia aquele byte" — falso: ele também **junta vizinhos** em marcadores.

**N2 (demonstrado — severidade baixa).** `accountFallback.js:38-39` ("Failure classes whose policy forbids rotation") e `:145` ("whose whole point is to skip rotation") contradizem a policy de `daily_quota` (`rotateUseful:true`, `rateLimitPolicy.js:78-83`) — o fuzz mostra `daily_quota` → `shouldFallback:true` sempre. O conjunto significa "resolvido estruturalmente", não "sem rotação" — exatamente a classe de defeito (comentário × código) que o D6 dizia ter limpado.

## SUSPEITAS (não comprovadas)

- **401 × 403 assimétricos com marcador de pool**: 401 → gate de auth `{false,0}` (não grava cooldown); 403 com o mesmo corpo → `applyCooldownOnly` (grava e para de rotacionar). A spec diz que 401/403 "passam intactos"; para 403, o marcador ganha. Pode ser intencional (o JSDoc dá prioridade aos marcadores), mas nada pina isso.
- **404 + `limit_rpd`** → 2 min com rotação (o "espere o reset" é sombreado pelo guard). Conforme a spec ("404 literal mantém o lock histórico"), mas é um dos casos que o guard captura — enumerados: 404+pool, 404+"unavailable for free", 404+limit_rpd, 404+"rate limit", todos → 120000.
- **429 com hint em notação científica** (`1e3`): hint ilegível degrada para a escada (nível+1) — conforme o doc ("nunca menor que o pedido"), mas reabre o lock longo exatamente quando o upstream usa esse formato.

## PONTOS CORRETOS VERIFICADOS

- **Invariante `applyCooldownOnly` ⟂ `shouldFallback:true`**: fuzz de 351 combinações (13 status × 9 formas de payload × 3 níveis de ladder) — **0 violações**, cooldown sempre número finito ≥ 0; `Math.min` nunca gera NaN/0 (`retry_after_seconds:0` → 1000 ms; hint gigante → teto da classe).
- **Contratos pré-existentes intactos**: `tests/unit/f25-checkfallback-classification.test.js` e `tests/unit/account-fallback-4xx.test.js` passam no HEAD; 400 contexto→`{false,0}`; 406/413/422→`{false,0}`; 401→`{false,0}`; 402/403/404/429+"nope"→fallback; 429 nível 0→`newBackoffLevel:1`, 2000 ms; 500/503 e status 0/null→30 s.
- **Suíte completa**: HEAD = **39 falhas | 3748 passam**, lista **idêntica 1:1** ao `tests/__baseline__/known-fails.txt` (diff normalizado vazio; +1 collect-failure `embeddings.cloud`, documentado no cabeçalho do baseline). Árvore `af23b010` com os testes novos = 52 (39 + 13 discriminantes); com os próprios testes da árvore = **39** — a alegação "39 antes, 39 depois, nenhuma nova" fecha.
- **Testes discriminam e ninguém foi enfraquecido**: 13 asserções falham só na árvore mid (tier aposentado ×2, 404+marker, `1e3`→1000, `1.2.3`→1200, ordenação da migração ×3, UPDATE falho, params da migração, contagem do loop, adapter real); o diff de testes entre os dois commits é aditivo/reforçador — o teste do 404 ganhou a asserção de rota (`applyCooldownOnly` indefinido) e o de params da migração ficou mais forte.
- **Escada preservada em throttle delimitado**: shared-pool nível 9 → `newBackoffLevel:9`, lock 6 s < 60 s; classe fantasma (no conjunto sem linha na tabela) degrada para a policy `server` (`rotateUseful:true`) sem emitir a flag — invariante segura.

## RECOMENDAÇÕES

1. **(média-baixa, N1)** Trocar o strip-all por desenrolar até o ponto fixo do par escapado — aplicar `replace(/\\(["\\/])/g,"$1")` em loop 2–3× — cobre profundidade 0–3 sem sintetizar marcadores; alternativa mínima: nos `includes()` de marcador, exigir aspas em volta (`\\*"shared_pool\\*"`).
2. **(baixa, N2)** Renomear `ROTATION_FREE_CLASSES` → `STRUCTURED_CLASSES` ou corrigir os comentários em `accountFallback.js:38-39` e `:145`.
3. **(baixa)** Pinar a completude com um teste: para toda classe com `rotateUseful:false` exceto `auth`/`request`, `SET.has(class) === true` — transforma o "decisão consciente" do comentário em verificação automática contra a recaída do D1.
4. **(cosmético)** `rateLimitPolicy.js:40` lista "permanent 404" como gatilho de `unsupported_model`, mas via `checkFallbackError` um 404 literal nunca chega lá (guard) — ajustar a redação.

## APÊNDICE — evidências e artefatos

- Comandos: `git show af23b010` / `git show c7bfcbf7`; provas em `/tmp/audit-ratelimit/proofs.mjs` (`node proofs.mjs`); suítes contra as árvores pré-fix via `git worktree add /tmp/audit-prefix af23b010^` e `/tmp/audit-mid af23b010` (ambas **removidas** ao fim); suíte completa: `cd tests && npx vitest run`.
- Números observados: prefix (af23b010^) — 3 arquivos nem carregam (`rateLimitPolicy.js`/export não existiam) e lock-site 8 falhas | 3 passam; mid (af23b010) com testes novos — **13 falhas | 38 passam**; mid com testes próprios — **39 falhas**; HEAD — **39 falhas | 3748 passam**.
- Logs crus: `/tmp/audit-ratelimit/full-after.log`, `full-before.log`, `full-before-owntests.log`, `after-fails.txt`, `known.norm`/`after.norm`.
- Worktrees pré-existentes que não são desta auditoria: `/tmp/base-head2` (af23b010) e `/tmp/mut-head` (c7bfcbf7) — deixados intactos.
