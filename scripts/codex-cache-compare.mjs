#!/usr/bin/env node
// Measures Codex prompt-cache hits for the layout the gateway is currently running with.
// Procedure:
//  1. Start the gateway normally (default CODEX_SYSTEM_PROMPT_LAYOUT=input, the upstream layout) and run this script; note the average.
//  2. Restart the gateway with CODEX_SYSTEM_PROMPT_LAYOUT=instructions (the fork's earlier layout).
//  3. Run the script again with a different --seed (or wait a few minutes) so it cannot hit the first run's cache.
//  4. Compare the two averages. Higher is better: cached input tokens are billed at a lower
//     rate and count less against plan limits.
// Usage: node scripts/codex-cache-compare.mjs --base http://localhost:20128 --key <api key> --model cx/gpt-5.5 [--runs 4] [--seed 1]
// The key may come from the NINEROUTER_API_KEY env var. It is never printed.

const USAGE = "Usage: node scripts/codex-cache-compare.mjs --base <url> --key <gateway api key> --model <model id, e.g. cx/gpt-5.5> [--runs 4] [--seed 1]\n(--key defaults to the NINEROUTER_API_KEY env var)";

function parseArgs(argv) {
  const o = { base: "http://localhost:20128", runs: 4, seed: "1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (["--base", "--key", "--model", "--runs", "--seed"].includes(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

function filler(seed, words = 2400) {
  const vocab = ["alpha", "bravo", "cedar", "delta", "ember", "forge", "glade", "harbor", "ivory", "juniper", "kernel", "lumen", "meadow", "nectar", "onyx", "prism"];
  let x = 0;
  for (const c of String(seed)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const out = [];
  for (let i = 0; i < words; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push(vocab[x % vocab.length]);
  }
  return out.join(" ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return 0; }
  const key = o.key || process.env.NINEROUTER_API_KEY;
  const runs = parseInt(o.runs, 10);
  if (!key || !o.model || !Number.isInteger(runs) || runs < 1) { console.error(USAGE); return 2; }
  const url = `${o.base.replace(/\/+$/, "")}/v1/responses`;
  const system = `You are a careful assistant. Reference notes (ignore them): ${filler(o.seed)}`;
  const payload = JSON.stringify({
    model: o.model,
    stream: false,
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: system }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with the single word: ok" }] },
    ],
  });

  const pcts = [];
  for (let n = 1; n <= runs; n++) {
    if (n > 1) await sleep(2000);
    let res, text;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: payload });
      text = await res.text();
    } catch (e) {
      console.error(`Run ${n}: cannot reach ${url}: ${e?.cause?.code || e?.cause?.message || e?.message || e}`);
      return 1;
    }
    if (!res.ok) { console.error(`Run ${n}: HTTP ${res.status}\n${text.slice(0, 300)}`); return 1; }
    let usage;
    try { usage = JSON.parse(text).usage; } catch { /* handled below */ }
    if (!usage) { console.log(`run ${n}  status ${res.status}  no usage object in response`); continue; }
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens;
    if (cached === undefined || cached === null) {
      console.log(`run ${n}  status ${res.status}  input ${input ?? "?"}  cached: usage has no cached-token field`);
      continue;
    }
    const pct = input > 0 ? (cached / input) * 100 : 0;
    if (n > 1) pcts.push(pct);
    console.log(`run ${n}  status ${res.status}  input ${input}  cached ${cached}  cached% ${pct.toFixed(1)}`);
  }
  if (pcts.length) console.log(`Average cached% over runs 2..${runs}: ${(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1)}%`);
  else console.log("Summary: no cached-token data for runs 2..N (need --runs >= 2 and a cached_tokens field).");
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e.message); console.error(USAGE); process.exit(2); });
