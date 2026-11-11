import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, CLAUDE_STOP, MODEL_FALLBACK } from "../schema/index.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { extractReasoningText } from "../concerns/reasoning.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { hasValidUsage } from "../../utils/usageTracking.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";

// Anthropic requires a non-empty tool_use.name inside content_block_start and
// there is no way to update it after the block opens. Some upstreams never
// send a name at all; emit a placeholder rather than name:"" (breaks clients)
// or a stop_reason:"tool_use" with zero tool_use blocks (breaks tool loops).
const TOOL_NAME_FALLBACK = "unknown_tool";

// Legacy "proxy_" prefix used by older request translators. Response strips it
// defensively so tool names from such turns resolve back (e.g. proxy_Read → Read
// for arg sanitization). Current request translator emits no prefix ("") — strip
// is then a no-op. Kept intentionally; do NOT couple to request's empty prefix.
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages);
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Emit content_block_start for a pending tool call exactly once. Name is baked
// into content_block_start by the Claude SSE format and can never be corrected
// afterwards, so this runs only when the name is resolved — or at finish with
// the fallback placeholder. Never emits name: "".
function openToolBlock(state, results, entry) {
  const toolBlockIndex = state.nextBlockIndex++;
  entry.blockIndex = toolBlockIndex;
  entry.started = true;

  let toolName = entry.name || TOOL_NAME_FALLBACK;
  if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
    toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
  }

  results.push({
    type: "content_block_start",
    index: toolBlockIndex,
    content_block: {
      type: CLAUDE_BLOCK.TOOL_USE,
      id: entry.id,
      name: toolName,
      input: {}
    }
  });
}

// Close every open content block exactly once. Tool args are buffered until the
// terminal chunk (sanitize at finish), so this is also where they are emitted.
function closeAllBlocks(state, results) {
  if (state.claudeBlocksClosed) return;
  state.claudeBlocksClosed = true;

  stopThinkingBlock(state, results);
  stopTextBlock(state, results);

  for (const [idx, toolInfo] of state.toolCalls || []) {
    // Name never resolved — open now with the fallback placeholder so the
    // client still receives a valid tool_use block (before any input_json_delta).
    if (!toolInfo.started) openToolBlock(state, results, toolInfo);

    const buffered = state.toolArgBuffers?.get(idx);
    if (buffered) {
      const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
      results.push({
        type: "content_block_delta",
        index: toolInfo.blockIndex,
        delta: { type: "input_json_delta", partial_json: sanitized }
      });
    }
    results.push({
      type: "content_block_stop",
      index: toolInfo.blockIndex
    });
  }
}

// Emit message_delta + message_stop exactly once. Deferred until usage is known
// when the finish chunk carries none: the OpenAI include_usage trailer arrives
// AFTER finish_reason, and a message_delta emitted at finish would freeze the
// estimate before the real counts could replace it.
function emitTerminal(state, results) {
  const stopReason = state.finishReason
    ? convertFinishReason(state.finishReason)
    : ((state.toolCalls?.size || 0) > 0 ? CLAUDE_STOP.TOOL_USE : CLAUDE_STOP.END_TURN);

  state.openaiToClaudeFinishSent = true;
  state.claudeFinishPending = false;
  state.finishReasonSent = true;

  results.push({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: state.usage || { input_tokens: 0, output_tokens: 0 }
  });
  results.push({ type: "message_stop" });
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  // Flush: the upstream ended without a finish_reason (or a deferred terminal
  // never saw its usage trailer). Emit whatever is buffered and terminate the
  // message — otherwise the client is left with an open block and no
  // message_delta/message_stop. An upstream error is already terminal.
  if (!chunk) {
    if (state?.openaiToClaudeFinishSent || state?.streamError || !state?.messageStartSent) return null;
    const results = [];
    closeAllBlocks(state, results);
    emitTerminal(state, results);
    return results;
  }

  // Mid-stream upstream error (`{"error":{...}}`). stream.js turns
  // state.streamError into a client-format error frame.
  if (chunk.error) {
    const error = chunk.error;
    const message = error?.message || (typeof error === "string" ? error : null) || "Upstream error";
    state.streamError = { status: HTTP_STATUS.BAD_GATEWAY, message };
    state.claudeFinishPending = false;
    state.openaiToClaudeFinishSent = true;
    state.finishReasonSent = true;
    return null;
  }

  // Track usage from OpenAI chunk if available. MUST run before the choices
  // guard: the standard stream_options.include_usage trailer is
  // `{"choices":[],"usage":{...}}`, and dropping it left the client with the
  // estimate injected at finish_reason.
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;

    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens
    const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };

    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }

    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }

    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  if (!chunk.choices?.[0]) {
    // The usage trailer arrived after a deferred finish — terminate now with
    // the real counts.
    if (state.claudeFinishPending) {
      const results = [];
      emitTerminal(state, results);
      return results;
    }
    return null;
  }

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || MODEL_FALLBACK;
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: ROLE.ASSISTANT,
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Handle reasoning (thinking) across vendor shapes - GLM/DeepSeek/Qwen/MiniMax/etc.
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content
  if (delta?.content) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content }
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      let entry = state.toolCalls.get(idx);

      if (!entry) {
        // First fragment for this index: allocate id immediately (upstreams like
        // vLLM/compat gateways may omit it entirely — siblings use fallbackToolCallId).
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);
        entry = {
          id: tc.id || fallbackToolCallId(idx),
          name: tc.function?.name || "",
          blockIndex: null,
          started: false
        };
        state.toolCalls.set(idx, entry);
      }

      // Late-arriving name: some upstreams send id in one chunk and name in a
      // later one. content_block_start can only carry the name once, so hold the
      // block closed (args still buffer) until the name resolves. GLM/fireworks
      // repeat id+null-name on every arg chunk — the `!entry.name` guard keeps
      // the first real name.
      if (!entry.name && tc.function?.name) entry.name = tc.function.name;
      // A real id arriving after a fallback one (rare): adopt it while unstarted.
      if (tc.id && !entry.started && tc.id !== entry.id) entry.id = tc.id;

      if (entry.name && !entry.started) openToolBlock(state, results, entry);

      if (tc.function?.arguments) {
        // Buffer args instead of streaming — sanitize at finish to fix bad params
        if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
        state.toolArgBuffers.set(idx, (state.toolArgBuffers.get(idx) || "") + tc.function.arguments);
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    // Duplicated finish_reason (seen from some gateways) must not emit a second
    // message_delta/message_stop — terminate exactly once per message.
    //
    // The guard MUST key off state owned by THIS route. `finishReasonSent` is
    // not ours to read: initState() hands one flat object to every leg of a
    // double-hop pivot, and response/openai-responses.js already sets it while
    // producing the very chunk that terminates the stream. Consulting it here
    // made responses→openai→claude swallow its own finish — pending tool args
    // stranded in toolArgBuffers, tool_use blocks left open, no message_stop.
    // It is still SET below: the shared initState contract means "this message
    // is terminal", which sibling legs and downstream usage injection rely on.
    if (state.openaiToClaudeFinishSent || state.claudeFinishPending) {
      return results.length > 0 ? results : null;
    }

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;
    state.finishReasonSent = true;

    closeAllBlocks(state, results);

    // Terminate now when the counts are already known. Otherwise defer
    // message_delta/message_stop until the include_usage trailer (or the
    // stream end): emitting at finish would freeze the stream.js estimate and
    // the real usage could never reach the client.
    if (hasValidUsage(state.usage)) {
      emitTerminal(state, results);
    } else {
      state.claudeFinishPending = true;
    }
  }

  return results.length > 0 ? results : null;
}

const convertFinishReason = (reason) => fromOpenAIFinish(reason, "claude");

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
