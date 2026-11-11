import * as Y from "yjs";
import { resolveRelayHttpUrl } from "./provider";

export type AIProvider =
  | "opencode"
  | "opencode-go"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "xai"
  | "mistral";

export type AIProviderSelection = "auto" | AIProvider;

export const AI_PROVIDER_OPTIONS: { id: AIProviderSelection; label: string }[] = [
  { id: "auto", label: "Auto-detect" },
  { id: "opencode", label: "OpenCode (opencode.ai)" },
  { id: "opencode-go", label: "OpenCode Go" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic Claude" },
  { id: "gemini", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "groq", label: "Groq" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "xai", label: "xAI (Grok)" },
  { id: "mistral", label: "Mistral" }
];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status?: "done" | "error";
  provider?: AIProvider;
}

/**
 * Fixed, non-editable system instructions enforcing strictly coding-related assistance.
 */
export const CODING_ONLY_SYSTEM_PROMPT = [
  "You are an embedded AI coding assistant inside CodeMirror, a collaborative technical interview and pair-programming code pad.",
  "STRICT SCOPE RULE: You must ONLY answer questions related to programming, software engineering, algorithms, data structures, code debugging, syntax, APIs, testing, or system design.",
  "If the user asks about ANY non-coding topic (such as trip planning, travel, cooking, general trivia, creative writing, politics, or casual non-technical chat), you MUST politely refuse in one short sentence and state that this chat is strictly for coding and software engineering purposes.",
  "Keep your coding explanations concise, accurate, and practical. Use markdown fenced code blocks when providing code snippets."
].join("\n");

const MAX_CODE_CONTEXT_CHARS = 24_000;

/**
 * Auto-detects the AI provider from the API key prefix.
 * - `oc_sk_...` -> OpenCode (opencode.ai)
 * - `sk-ant-...` -> Anthropic Claude
 * - `AIza...` -> Google Gemini
 * - `sk-or-...` -> OpenRouter
 * - `gsk_...` -> Groq
 * - `xai-...` -> xAI Grok
 * - `sk-...` (or fallback) -> OpenAI
 */
export function detectProviderFromKey(apiKey: string): AIProvider {
  const trimmed = apiKey.trim();
  if (trimmed.startsWith("oc_sk_")) {
    return "opencode";
  }
  if (trimmed.startsWith("sk-ant-")) {
    return "anthropic";
  }
  if (trimmed.startsWith("AIza")) {
    return "gemini";
  }
  if (trimmed.startsWith("sk-or-")) {
    return "openrouter";
  }
  if (trimmed.startsWith("gsk_")) {
    return "groq";
  }
  if (trimmed.startsWith("xai-")) {
    return "xai";
  }
  return "openai";
}

export function resolveProvider(
  apiKey: string,
  selection?: AIProviderSelection
): AIProvider {
  if (selection && selection !== "auto") {
    return selection;
  }
  return detectProviderFromKey(apiKey);
}

export function getProviderLabel(provider: AIProvider): string {
  switch (provider) {
    case "opencode":
      return "OpenCode";
    case "opencode-go":
      return "OpenCode Go";
    case "anthropic":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "openrouter":
      return "OpenRouter";
    case "groq":
      return "Groq";
    case "deepseek":
      return "DeepSeek";
    case "xai":
      return "xAI Grok";
    case "mistral":
      return "Mistral";
    case "openai":
    default:
      return "OpenAI";
  }
}

/**
 * Builds the complete system prompt combining the fixed coding-only guardrail
 * with the live editor language and code buffer.
 */
export function buildSystemPromptWithContext(
  language: string,
  codeContext: string
): string {
  const trimmedCode = codeContext.slice(0, MAX_CODE_CONTEXT_CHARS);
  const codeSection =
    trimmedCode.trim().length > 0
      ? `\n\nCurrent editor language: ${language}\nCurrent editor buffer:\n\`\`\`${language}\n${trimmedCode}\n\`\`\``
      : `\n\nCurrent editor language: ${language}\nCurrent editor buffer is empty.`;

  return `${CODING_ONLY_SYSTEM_PROMPT}${codeSection}`;
}

export interface SendCodingChatOptions {
  apiKey: string;
  provider?: AIProviderSelection;
  roomId?: string;
  messages: ChatMessage[];
  codeContext: string;
  language: string;
  fetchImpl?: typeof fetch;
  proxyUrl?: string;
}

interface OpenAICompatibleProviderSpec {
  endpoint: string;
  model: string;
  requiresProxyByDefault: boolean;
  includeOpenCodeHeaders?: boolean;
}

const OPENAI_COMPATIBLE_SPECS: Record<
  Exclude<AIProvider, "anthropic" | "gemini">,
  OpenAICompatibleProviderSpec
> = {
  opencode: {
    endpoint: "https://opencode.ai/inference/openai/v1/chat/completions",
    model: "claude-haiku-4-5",
    requiresProxyByDefault: true,
    includeOpenCodeHeaders: true
  },
  "opencode-go": {
    endpoint: "https://opencode.ai/inference/go/openai/v1/chat/completions",
    model: "claude-haiku-5-5",
    requiresProxyByDefault: true,
    includeOpenCodeHeaders: true
  },
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    requiresProxyByDefault: false
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-4o-mini",
    requiresProxyByDefault: false
  },
  groq: {
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    requiresProxyByDefault: false
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    requiresProxyByDefault: true
  },
  xai: {
    endpoint: "https://api.x.ai/v1/chat/completions",
    model: "grok-3-mini",
    requiresProxyByDefault: true
  },
  mistral: {
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-small-latest",
    requiresProxyByDefault: true
  }
};

async function executeProviderRequest(
  targetUrl: string,
  headers: Record<string, string>,
  bodyObj: unknown,
  options: {
    fetchFn: typeof fetch;
    useProxyByDefault: boolean;
    customFetchInjected: boolean;
    proxyUrl?: string;
  }
): Promise<Response> {
  const effectiveProxyUrl = options.proxyUrl || resolveRelayHttpUrl("/api/ai-proxy");

  const sendViaProxy = () =>
    options.fetchFn(effectiveProxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: targetUrl,
        headers,
        body: bodyObj
      })
    });

  if (options.proxyUrl || (options.useProxyByDefault && !options.customFetchInjected)) {
    return sendViaProxy();
  }

  try {
    return await options.fetchFn(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(bodyObj)
    });
  } catch (err) {
    if (!options.customFetchInjected) {
      return sendViaProxy();
    }
    throw err;
  }
}

/**
 * Executes a BYOK chat completion against OpenCode (Pay-as-you-go & Go), OpenAI,
 * Anthropic Claude, Google Gemini, OpenRouter, Groq, DeepSeek, xAI Grok, or Mistral.
 */
export async function sendCodingChatCompletion(
  options: SendCodingChatOptions
): Promise<string> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("Missing AI API key.");
  }

  const provider = resolveProvider(apiKey, options.provider);
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const customFetchInjected = Boolean(options.fetchImpl);
  const systemPrompt = buildSystemPromptWithContext(
    options.language,
    options.codeContext
  );

  const history = options.messages
    .filter((m) => m.content.trim().length > 0 && m.status !== "error")
    .slice(-20);

  if (provider === "anthropic") {
    const response = await executeProviderRequest(
      "https://api.anthropic.com/v1/messages",
      {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      {
        model: "claude-3-5-sonnet-latest",
        max_tokens: 2048,
        system: systemPrompt,
        messages: history.map((m) => ({
          role: m.role,
          content: m.content
        }))
      },
      {
        fetchFn,
        useProxyByDefault: false,
        customFetchInjected,
        proxyUrl: options.proxyUrl
      }
    );

    const data = (await response.json().catch(() => ({}))) as {
      content?: { type?: string; text?: string }[];
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(data.error?.message || `Anthropic HTTP ${response.status}`);
    }

    const reply = data.content
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (!reply) {
      throw new Error("Empty response from Anthropic.");
    }
    return reply;
  }

  if (provider === "gemini") {
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;
    const response = await executeProviderRequest(
      geminiEndpoint,
      {},
      {
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: history.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }]
        })),
        generationConfig: {
          temperature: 0.2
        }
      },
      {
        fetchFn,
        useProxyByDefault: false,
        customFetchInjected,
        proxyUrl: options.proxyUrl
      }
    );

    const data = (await response.json().catch(() => ({}))) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(data.error?.message || `Gemini HTTP ${response.status}`);
    }

    const reply = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("\n")
      .trim();

    if (!reply) {
      throw new Error("Empty response from Gemini.");
    }
    return reply;
  }

  // OpenAI-compatible providers (OpenCode, OpenCode Go, OpenAI, OpenRouter, Groq, DeepSeek, xAI, Mistral)
  const callOpenAICompatible = async (
    targetProvider: Exclude<AIProvider, "anthropic" | "gemini">
  ): Promise<Response> => {
    const spec = OPENAI_COMPATIBLE_SPECS[targetProvider];
    const headers: Record<string, string> = {
      Authorization: ["Bearer", apiKey].join(" ")
    };
    if (spec.includeOpenCodeHeaders) {
      const sanitizedRoom = (options.roomId || "codemirror").replace(/[^a-zA-Z0-9_-]/g, "");
      headers["x-opencode-session"] = `ses_${sanitizedRoom}`;
    }

    return executeProviderRequest(
      spec.endpoint,
      headers,
      {
        model: spec.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map((m) => ({
            role: m.role,
            content: m.content
          }))
        ]
      },
      {
        fetchFn,
        useProxyByDefault: spec.requiresProxyByDefault,
        customFetchInjected,
        proxyUrl: options.proxyUrl
      }
    );
  };

  let response = await callOpenAICompatible(provider);

  if (
    !response.ok &&
    provider === "opencode" &&
    (!options.provider || options.provider === "auto")
  ) {
    const goFallbackResponse = await callOpenAICompatible("opencode-go").catch(() => null);
    if (goFallbackResponse && goFallbackResponse.ok) {
      response = goFallbackResponse;
    }
  }

  const data = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(
      data.error?.message || `${getProviderLabel(provider)} HTTP ${response.status}`
    );
  }

  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    throw new Error(`Empty response from ${getProviderLabel(provider)}.`);
  }
  return reply;
}

const HOST_KEY_STORAGE_PREFIX = "codemirror_ai_key_";
const HOST_PROVIDER_STORAGE_PREFIX = "codemirror_ai_provider_";

export function saveHostRoomAiKey(
  roomId: string,
  apiKey: string,
  provider: AIProviderSelection = "auto"
): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(`${HOST_KEY_STORAGE_PREFIX}${roomId}`, apiKey.trim());
      sessionStorage.setItem(`${HOST_PROVIDER_STORAGE_PREFIX}${roomId}`, provider);
    }
  } catch {
    // Ignore storage restriction in headless environments
  }
}

export function loadHostRoomAiKey(roomId: string): string | null {
  try {
    if (typeof sessionStorage !== "undefined") {
      const value = sessionStorage.getItem(`${HOST_KEY_STORAGE_PREFIX}${roomId}`);
      return value && value.trim().length > 0 ? value.trim() : null;
    }
  } catch {
    // Ignore storage restriction
  }
  return null;
}

export function loadHostRoomAiProvider(roomId: string): AIProviderSelection {
  try {
    if (typeof sessionStorage !== "undefined") {
      const value = sessionStorage.getItem(
        `${HOST_PROVIDER_STORAGE_PREFIX}${roomId}`
      ) as AIProviderSelection | null;
      return value || "auto";
    }
  } catch {
    // Ignore storage restriction
  }
  return "auto";
}

export function clearHostRoomAiKey(roomId: string): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(`${HOST_KEY_STORAGE_PREFIX}${roomId}`);
      sessionStorage.removeItem(`${HOST_PROVIDER_STORAGE_PREFIX}${roomId}`);
    }
  } catch {
    // Ignore storage restriction
  }
}

/**
 * Attaches a host-side responder to the room's `Y.Doc`.
 * Only the host browser (which holds the local API key) executes LLM calls when
 * any room participant appends a user message to `Y.Array("chat")`.
 */
export function attachHostAiResponder(
  doc: Y.Doc,
  hostApiKey: string,
  fetchImpl?: typeof fetch,
  options?: {
    provider?: AIProviderSelection;
    roomId?: string;
    proxyUrl?: string;
  }
): () => void {
  const ychat = doc.getArray<ChatMessage>("chat");
  const ymeta = doc.getMap<string>("meta");
  const ytext = doc.getText("codemirror");
  const provider = resolveProvider(hostApiKey, options?.provider);

  // Ensure the room metadata broadcasts that AI is enabled
  doc.transact(() => {
    if (ymeta.get("aiEnabled") !== "true") {
      ymeta.set("aiEnabled", "true");
    }
    if (ymeta.get("aiProvider") !== provider) {
      ymeta.set("aiProvider", provider);
    }
  });

  const handledUserMessageIds = new Set<string>();
  // Pre-seed already answered messages so reloading the host tab doesn't re-run old messages
  const initialMessages = ychat.toArray();
  for (let i = 0; i < initialMessages.length; i++) {
    const msg = initialMessages[i];
    if (msg.role === "user" && i < initialMessages.length - 1) {
      handledUserMessageIds.add(msg.id);
    }
  }

  let isProcessing = false;

  const processQueue = async () => {
    if (isProcessing) return;

    const messages = ychat.toArray();
    const lastMessage = messages[messages.length - 1];
    if (
      !lastMessage ||
      lastMessage.role !== "user" ||
      handledUserMessageIds.has(lastMessage.id)
    ) {
      return;
    }

    handledUserMessageIds.add(lastMessage.id);
    isProcessing = true;
    ymeta.set("aiThinking", "true");

    try {
      const language = ymeta.get("language") || "kotlin";
      const codeContext = ytext.toString();
      const replyText = await sendCodingChatCompletion({
        apiKey: hostApiKey,
        provider: options?.provider ?? provider,
        roomId: options?.roomId,
        messages,
        codeContext,
        language,
        fetchImpl,
        proxyUrl: options?.proxyUrl
      });

      ychat.push([
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: replyText,
          createdAt: Date.now(),
          status: "done",
          provider
        }
      ]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Request failed";
      ychat.push([
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: `AI Error (${getProviderLabel(provider)}): ${errorMessage}`,
          createdAt: Date.now(),
          status: "error",
          provider
        }
      ]);
    } finally {
      ymeta.set("aiThinking", "false");
      isProcessing = false;
      // Check if another user message arrived while we were processing
      const latestAfter = ychat.toArray();
      const tail = latestAfter[latestAfter.length - 1];
      if (tail && tail.role === "user" && !handledUserMessageIds.has(tail.id)) {
        void processQueue();
      }
    }
  };

  const observer = () => {
    void processQueue();
  };

  ychat.observe(observer);
  void processQueue();

  return () => {
    ychat.unobserve(observer);
  };
}
