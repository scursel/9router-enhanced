/**
 * Interpret a `/api/models/test` response for the dashboard.
 *
 * The route falls back across model kinds: a model registered under a kind its
 * provider does not serve on that route (an LLM on the embedding page, a chat
 * model on the image page) is retried on the next kind instead of being
 * reported as broken. A success that only happened after that fallback carries
 * a `note`, which is worth showing — the model works, but not on the route its
 * kind implies.
 *
 * Returns `{ status, message }` where status is "ok" | "error" and message is
 * empty when there is nothing to say.
 */
export function readModelTestResult(data) {
  if (!data || typeof data !== "object") {
    return { status: "error", message: "Model not reachable" };
  }

  if (data.ok) {
    return { status: "ok", message: data.note || "" };
  }

  return { status: "error", message: data.error || "Model not reachable" };
}
