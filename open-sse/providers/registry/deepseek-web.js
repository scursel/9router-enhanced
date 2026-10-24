export default {
  id: "deepseek-web",
  priority: 220,
  alias: "deepseek-web",
  aliases: [
    "ds-web",
  ],
  uiAlias: "deepseek-web",
  display: {
    name: "DeepSeek Web",
    icon: "auto_awesome",
    color: "#4D6BFE",
    textIcon: "DS",
    website: "https://chat.deepseek.com",
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your userToken from chat.deepseek.com localStorage (DevTools → Application → Local Storage)",
  transport: {
    baseUrl: "https://chat.deepseek.com/api/v0/chat/completion",
    format: "openai",
    authType: "cookie",
  },
  // The web app picks the model, not us: the executor only sends a mode
  // (model_type "expert" for ids containing pro/expert, "default" otherwise)
  // plus on/off thinking and search flags. Names say which mode an id hits;
  // the legacy ids (chat/reasoner/R1/V3.2/Search) are aliases of those modes.
  // Ids stay stable because combos reference them.
  models: [
    { id: "deepseek-v4-pro", name: "DeepSeek Expert (web)" },
    { id: "deepseek-v4-pro-think", name: "DeepSeek Expert Think (web)", supportsReasoning: true },
    { id: "deepseek-v4-pro-search", name: "DeepSeek Expert Search (web)" },
    { id: "deepseek-v4-pro-think-search", name: "DeepSeek Expert Think+Search (web)", supportsReasoning: true },
    { id: "deepseek-v4-flash", name: "DeepSeek V4.1 Flash (web default)" },
    { id: "deepseek-v4-flash-think", name: "DeepSeek V4.1 Flash Think (web default)", supportsReasoning: true },
    { id: "deepseek-v4-flash-search", name: "DeepSeek V4.1 Flash Search (web default)" },
    { id: "deepseek-v4-flash-think-search", name: "DeepSeek V4.1 Flash Think+Search (web default)", supportsReasoning: true },
    { id: "deepseek-chat", name: "DeepSeek V4.1 Flash (alias: chat)" },
    { id: "deepseek-reasoner", name: "DeepSeek V4.1 Flash Think (alias: reasoner)", supportsReasoning: true },
    { id: "DeepSeek-R1", name: "DeepSeek V4.1 Flash Think (alias: R1)", supportsReasoning: true },
    { id: "DeepSeek-R1-Search", name: "DeepSeek V4.1 Flash Think+Search (alias: R1)", supportsReasoning: true },
    { id: "DeepSeek-V3.2", name: "DeepSeek V4.1 Flash (alias: V3.2)" },
    { id: "DeepSeek-Search", name: "DeepSeek V4.1 Flash Search (alias)" },
  ],
};
