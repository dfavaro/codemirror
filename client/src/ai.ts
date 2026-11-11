import * as Y from "yjs";

export type AIProvider = "openai" | "anthropic" | "gemini";

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
 * - `sk-ant-...` -> Anthropic Claude
 * - `AIza...` -> Google Gemini
 * - `sk-...` (or fallback) -> OpenAI
 */
export function detectProviderFromKey(apiKey: string): AIProvider {
  const trimmed = apiKey.trim();
  if (trimmed.startsWith("sk-ant-")) {
    return "anthropic";
  }
  if (trimmed.startsWith("AIza")) {
    return "gemini";
  }
  return "openai";
}

export function getProviderLabel(provider: AIProvider): string {
  switch (provider) {
    case "anthropic":
      return "Claude";
    case "gemini":
      return "Gemini";
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
  provider?: AIProvider;
  messages: ChatMessage[];
  codeContext: string;
  language: string;
  fetchImpl?: typeof fetch;
}

/**
 * Executes a direct browser BYOK chat completion against OpenAI, Anthropic, or Google Gemini.
 */
export async function sendCodingChatCompletion(
  options: SendCodingChatOptions
): Promise<string> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("Missing AI API key.");
  }

  const provider = options.provider ?? detectProviderFromKey(apiKey);
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const systemPrompt = buildSystemPromptWithContext(
    options.language,
    options.codeContext
  );

  const history = options.messages
    .filter((m) => m.content.trim().length > 0 && m.status !== "error")
    .slice(-20);

  if (provider === "openai") {
    const response = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map((m) => ({
            role: m.role,
            content: m.content
          }))
        ]
      })
    });

    const data = (await response.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(data.error?.message || `OpenAI HTTP ${response.status}`);
    }

    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error("Empty response from OpenAI.");
    }
    return reply;
  }

  if (provider === "anthropic") {
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 2048,
        system: systemPrompt,
        messages: history.map((m) => ({
          role: m.role,
          content: m.content
        }))
      })
    });

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

  // Google Gemini (`gemini-2.5-flash`)
  const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;
  const response = await fetchFn(geminiEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
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
    })
  });

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

const HOST_KEY_STORAGE_PREFIX = "codemirror_ai_key_";

export function saveHostRoomAiKey(roomId: string, apiKey: string): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(`${HOST_KEY_STORAGE_PREFIX}${roomId}`, apiKey.trim());
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

/**
 * Attaches a host-side responder to the room's `Y.Doc`.
 * Only the host browser (which holds the local API key) executes LLM calls when
 * any room participant appends a user message to `Y.Array("chat")`.
 */
export function attachHostAiResponder(
  doc: Y.Doc,
  hostApiKey: string,
  fetchImpl?: typeof fetch
): () => void {
  const ychat = doc.getArray<ChatMessage>("chat");
  const ymeta = doc.getMap<string>("meta");
  const ytext = doc.getText("codemirror");
  const provider = detectProviderFromKey(hostApiKey);

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
        provider,
        messages,
        codeContext,
        language,
        fetchImpl
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
