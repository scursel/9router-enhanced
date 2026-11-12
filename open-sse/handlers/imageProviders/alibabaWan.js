import { nowSec } from "./_base.js";

// The Alibaba image API (Wan models) is not OpenAI-compatible (own request body and
// response shapes), so these models need their own adapter instead of the generic one.
// It is selected by what the node IS (an Alibaba Cloud Model Studio host + a Wan model
// id), never by a node id, so it works on any installation.
const WAN_MODEL_RE = /^wan/i;
const ALIBABA_HOSTS = [
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "maas.aliyuncs.com", // Token Plan: token-plan.<region>.maas.aliyuncs.com
];
const WAN_API_PATH = "/compatible-mode/v1/chat/completions";

function alibabaOrigin(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  let u;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const ok = ALIBABA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return ok ? u.origin : null;
}

// Single selection rule: Alibaba host (https) AND Wan model id.
export function isAlibabaWanRequest(model, baseUrl) {
  return WAN_MODEL_RE.test(String(model || "")) && alibabaOrigin(baseUrl) !== null;
}

export default {
  // Same origin as the node (intl or mainland), fixed API path: no user-controlled path.
  buildUrl: (model, credentials) => {
    const origin = alibabaOrigin(credentials?.providerSpecificData?.baseUrl);
    if (!origin) throw new Error("Alibaba Wan requires an https Alibaba Cloud base URL on the node");
    return origin + WAN_API_PATH;
  },
  buildHeaders: (credentials) => {
    const key = credentials?.apiKey || credentials?.accessToken || "";
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
  },
  buildBody: (model, body) => {
    const raw = String(body.size || "1024x1024");
    const size = raw.includes("4096")
      ? "4K"
      : raw.includes("2048") || raw.includes("1536")
        ? "2K"
        : "1K";
    const content = [{ text: String(body.prompt || "") }];
    const refs = [];
    if (Array.isArray(body.images)) refs.push(...body.images);
    if (body.image) refs.push(body.image);
    for (const image of refs.filter((x) => typeof x === "string" && x).slice(0, 4)) {
      content.push({ image });
    }
    const parameters = {
      size,
      watermark: typeof body.watermark === "boolean" ? body.watermark : false,
    };
    for (const key of ["negative_prompt", "prompt_extend", "seed", "enable_interleave"]) {
      if (body[key] !== undefined) parameters[key] = body[key];
    }
    return {
      model,
      messages: [{ role: "user", content }],
      parameters,
    };
  },
  normalize: (payload) => {
    const data = [];
    const seen = new Set();
    const add = (item) => {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        data.push(item);
      }
    };
    const walk = (value) => {
      if (typeof value === "string") {
        if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) {
          add({ url: value });
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (typeof value.b64_json === "string" && value.b64_json) {
        add({ b64_json: value.b64_json });
      }
      for (const key of [
        "url",
        "image_url",
        "image",
        "data",
        "output",
        "choices",
        "message",
        "content",
        "images",
      ]) {
        walk(value[key]);
      }
    };
    walk(payload);
    return { created: nowSec(), data };
  },
};
