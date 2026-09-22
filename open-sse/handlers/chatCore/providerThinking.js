// Provider-level thinking override (dashboard → settings.providerThinking[provider]).
// Current UI stores "auto" or an effort level; "on"/"off" are legacy values that
// map to the extended thinking switch and only apply when the client sent none.
// Legacy values must never fall into reasoning_effort: "on"/"off" are not
// effort levels and every upstream enum rejects them.
export function applyProviderThinkingOverride(body, providerThinking) {
  const mode = providerThinking?.mode;
  if (!mode || mode === "auto") return body;
  if (mode === "on") return body.thinking ? body : { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
  if (mode === "off") return body.thinking ? body : { ...body, thinking: { type: "disabled" } };
  return body.reasoning_effort ? body : { ...body, reasoning_effort: mode };
}
