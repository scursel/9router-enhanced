# Known Issues

Bugs conhecidos identificados em produção, aguardando correção no fork. Ordem de leitura:
status → impacto → sintoma → causa-raiz → evidências → correção proposta.

---

## KI-1 — Relay proxy pools: fetch não envia credenciais do Cloudflare Access (2026-10-15)

**Status:** RESOLVIDO em `v0.5.104-enhanced.2` (2026-10-16).
**Componente:** `open-sse/utils/proxyFetch.js` (`proxyAwareFetch()`), `src/app/api/proxy-pools/[id]/test/route.js`, `src/app/api/proxy-pools/cloudflare-deploy/route.js` e `start-9router.sh`.
**Impacto (anterior):** todos os requests que usavam os relay pools (`relay-*.scursel.workers.dev`) falhavam de
forma contínua com HTML de login do Access em vez da resposta do alvo. Na prática: os modelos
**TOKENHARBOR** roteados via relay caíam para fallback em ~100% das tentativas (degradação
silenciosa — o combo escondia a falha), e o pool de relays ficava inutilizado.

### Sintoma (log literal — `~/.9router/server.log`)

```
[HH:MM:SS] ℹ️  [PROXY] TOKENHARBOR | deepseek-v4.1-flash | conn=hermes | pool=65736adf-… | vercel-relay=https://relay-1a07d643fc4-2.scursel.workers.dev
[HH:MM:SS] 🔴 ✗ BLOCKED 200 · tokenharbor/deepseek-v4.1-flash · non-SSE (text/html)
    Sign in ・ Cloudflare Access
[HH:MM:SS] 🔴 ✗ ERROR: upstream non-SSE: 200
```

A página de login do Access chega com **HTTP 200 + `content-type: text/html`**; o detector de
SSE (`non-SSE`) classifica como resposta inválida e o modelo é marcado como falho.

### Causa-raiz

Timeline:
- **2026-09-07** — relays criados e testados (`proxyPools` do `~/.9router/db/data.sqlite`, 6
  workers `relay-<id>.scursel.workers.dev`). Funcionavam: não havia Access na frente.
- **2026-09-15** — criado o Access app **"All Workers"** (`f8ddc7ad-79d5-46dd-b58f-31fcd28ac574`),
  que protege todos os `*.workers.dev` da conta, com policy `non_identity` para o service token
  **hermes-agent** (`token_id 65dc5086-d4ef-410e-8a07-a6761fb4d89f`).
- **Desde então** — os relays passaram a **exigir autenticação** de Access, mas o fetch de relay
  do 9Router **não envia credencial alguma**: em `proxyAwareFetch()` o relay recebe apenas
  `x-relay-target` e `x-relay-path` (montados a partir da URL alvo). Não existe qualquer
  tratamento de `CF-Access-Client-Id`/`CF-Access-Client-Secret` no caminho.

**Não é** credencial expirada nem "login que falhou": nenhuma tentativa de autenticação é feita e
nenhuma credencial é enviada. Falta suporte no código (o Access entrou depois, sem ajuste no fork).
O mesmo vale para o pacote instalado (`app/.next-cli-build/server/chunks/1628.js`, função
minificada do relay — mesmo comportamento; grep sem nenhuma referência a `CF-Access`).

### Evidências (coletadas em 2026-10-15)

1. Relay **sem** credenciais → `HTTP 302` → `https://yellow-base-f94b.cloudflareaccess.com/cdn-cgi/access/login/...`
2. Relay **com** credenciais do service token (chaves `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`,
   disponíveis no Bitwarden Secrets Manager) → worker alcançado (`HTTP 400 Missing x-relay-target`;
   com `x-relay-target` válido → resposta normal do alvo: testado em home do ML, MadeiraMadeira etc.)
3. Os 6 relays respondem idêntico: `302` sem creds / `400` com creds.
4. Código: `proxyAwareFetch()` não menciona Access em nenhuma versão (repo e pacote instalado).

### Correção aplicada (2026-10-16 — `v0.5.104-enhanced.2`)

1. **`open-sse/utils/proxyFetch.js` (`getCfAccessRelayHeaders` + `proxyAwareFetch`):**
   - Injeta `CF-Access-Client-Id` e `CF-Access-Client-Secret` apenas sobre `https:` e para origens autorizadas (por padrão `.scursel.workers.dev`, ou lista explícita em `CF_ACCESS_RELAY_HOSTS`), normalizando hostnames com ponto final e bloqueando domínios PaaS de terceiros (`.vercel.app`, `.deno.dev`, `.netlify.app`) e tenants `*.workers.dev` não relacionados.
   - Usa `redirect: "manual"` na chamada ao relay para impedir que redirecionamentos `3xx` cross-origin encaminhem os headers `CF-Access-*` para fora da origem autorizada.
   - Detecta respostas/redirects de login do Cloudflare Access (`/cdn-cgi/access/login` / `.cloudflareaccess.com/`) e lança erro explícito (`[ProxyFetch] Cloudflare Access blocked relay request...`).
2. **`src/app/api/proxy-pools/cloudflare-deploy/route.js` + 6 Workers em produção:**
   - Atualizado `RELAY_WORKER_CODE` e republicados todos os 6 Workers existentes (`relay-mtrmx7oe` e `relay-1a07d64*-0..4`) para remover `cf-access-client-id`, `cf-access-client-secret`, `cf-access-jwt-assertion`, `cf-access-authenticated-user-identity` e o cookie `CF_Authorization` antes do `fetch(targetUrl)`.
3. **`src/app/api/proxy-pools/[id]/test/route.js` (`testVercelRelay`):**
   - Envia os headers de Access, usa `redirect: "manual"`, exige `HTTP 200` com `content-type: application/json` e valida o payload JSON retornado pelo alvo de teste (`httpbin.org/get`).
4. **Ambiente do serviço (`~/.9router/token-plan.env` e `start-9router.sh`):**
   - Credenciais configuradas em `~/.9router/token-plan.env` (`0600`) e fallback via BWS em `start-9router.sh` protegido com `timeout 5s` e log de diagnóstico em `stderr`.

### Não fazer

- Não afrouxar/bypassar o Access (os `workers.dev` voltariam a ser públicos — o service token
  existe exatamente para permitir este uso de forma autenticada).
- Não "consertar" trocando de pool: todos os 6 relays têm a mesma proteção.