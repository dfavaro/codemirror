import {
  AI_PROVIDER_OPTIONS,
  AIProvider,
  AIProviderSelection,
  ChatMessage,
  detectProviderFromKey,
  getProviderLabel
} from "./ai";
import { LANGUAGE_OPTIONS, SupportedLanguage } from "./editor";
import { ConnectionStatus } from "./provider";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Formats remaining milliseconds into the PRD countdown format: "Expires in: 23h 48m"
 */
export function formatCountdown(expiresAtMs: number, nowMs: number = Date.now()): string {
  const remainingMs = Math.max(0, expiresAtMs - nowMs);
  if (remainingMs <= 0) {
    return "Session Expired";
  }

  const totalMinutes = Math.ceil(remainingMs / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `Expires in: ${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * Copies text to the user's clipboard using navigator.clipboard with a DOM fallback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback
  }

  try {
    if (typeof document !== "undefined") {
      const input = document.createElement("input");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      return true;
    }
  } catch {
    // Ignore clipboard error in headless environments
  }
  return false;
}

/**
 * Renders the minimal centered Homepage with Logo, 1-line description,
 * optional AI provider + API key input, and "Start session" CTA (FR-1).
 */
export function renderLandingView(
  root: HTMLElement,
  onCreateSession: (aiApiKey?: string, aiProvider?: AIProviderSelection) => Promise<void>
): void {
  const providerOptionsHtml = AI_PROVIDER_OPTIONS.map(
    (opt) => `<option value="${opt.id}">${opt.label}</option>`
  ).join("");

  root.innerHTML = `
    <main class="min-h-screen w-full bg-zinc-950 text-zinc-100 flex items-center justify-center px-6">
      <div class="max-w-md w-full text-center space-y-6">
        <div class="inline-flex items-center justify-center gap-3">
          <div class="h-10 w-10 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-mono font-semibold text-base">
            &lt;/&gt;
          </div>
          <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-white">CodeMirror</h1>
        </div>

        <p class="text-zinc-400 text-sm sm:text-base">
          Disposable, end-to-end encrypted collaborative code pad.
        </p>

        <div class="pt-1 space-y-3 max-w-sm mx-auto">
          <div class="flex gap-2">
            <label for="ai-provider-select" class="sr-only">AI Provider</label>
            <select
              id="ai-provider-select"
              title="AI Provider"
              class="w-36 shrink-0 px-2.5 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 focus:border-emerald-500 focus:outline-none text-xs font-mono text-zinc-200 transition cursor-pointer"
            >
              ${providerOptionsHtml}
            </select>

            <label for="ai-key-input" class="sr-only">Optional AI API Key</label>
            <input
              id="ai-key-input"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="Optional: AI API key"
              class="flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 focus:border-emerald-500 focus:outline-none text-xs sm:text-sm font-mono text-zinc-200 placeholder-zinc-500 transition"
            />
          </div>

          <button
            id="new-session-btn"
            type="button"
            class="cursor-pointer w-full inline-flex items-center justify-center gap-2.5 px-6 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-semibold text-sm sm:text-base shadow-lg shadow-emerald-500/15 transition-all"
          >
            <span>Start session</span>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </button>
        </div>
      </div>
    </main>
  `;

  const btn = root.querySelector<HTMLButtonElement>("#new-session-btn");
  const aiKeyInput = root.querySelector<HTMLInputElement>("#ai-key-input");
  const aiProviderSelect = root.querySelector<HTMLSelectElement>("#ai-provider-select");

  let userManuallySelectedProvider = false;

  aiProviderSelect?.addEventListener("change", () => {
    userManuallySelectedProvider = aiProviderSelect.value !== "auto";
  });

  const syncDetectedProvider = () => {
    if (!aiKeyInput || !aiProviderSelect) return;
    const rawKey = aiKeyInput.value.trim();
    if (!rawKey) {
      userManuallySelectedProvider = false;
      aiProviderSelect.value = "auto";
      return;
    }
    if (!userManuallySelectedProvider || aiProviderSelect.value === "auto") {
      aiProviderSelect.value = detectProviderFromKey(rawKey);
    }
  };

  aiKeyInput?.addEventListener("input", syncDetectedProvider);
  aiKeyInput?.addEventListener("paste", () => {
    setTimeout(syncDetectedProvider, 0);
  });

  const triggerCreate = async () => {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Starting session...";
    try {
      const optionalKey = aiKeyInput?.value.trim() || undefined;
      const selectedProvider =
        (aiProviderSelect?.value as AIProviderSelection | undefined) || "auto";
      await onCreateSession(optionalKey, selectedProvider);
    } catch (err) {
      console.error("Failed to create session:", err);
      btn.disabled = false;
      btn.textContent = "Start session";
    }
  };

  btn?.addEventListener("click", () => {
    void triggerCreate();
  });

  aiKeyInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void triggerCreate();
    }
  });
}

/**
 * Renders an error state when a user navigates to /room/<id> without the #secretKey hash fragment.
 */
export function renderMissingKeyView(
  root: HTMLElement,
  onNewSession: () => Promise<void>
): void {
  root.innerHTML = `
    <div class="min-h-screen w-full bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div class="max-w-md w-full p-6 rounded-xl bg-zinc-900 border border-zinc-800 space-y-4 text-center">
        <div class="mx-auto h-10 w-10 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 font-mono">
          !
        </div>
        <h2 class="text-lg font-semibold text-white">Missing Decryption Key</h2>
        <p class="text-sm text-zinc-400 leading-relaxed">
          This room requires a zero-knowledge encryption key in the URL fragment (<code class="font-mono text-zinc-200">#...</code>).
          Ask the host to share the complete encrypted link, or start a new session.
        </p>
        <div class="pt-2">
          <button
            id="fallback-new-session-btn"
            type="button"
            class="cursor-pointer px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold text-sm transition"
          >
            Start session
          </button>
        </div>
      </div>
    </div>
  `;

  root
    .querySelector<HTMLButtonElement>("#fallback-new-session-btn")
    ?.addEventListener("click", () => {
      void onNewSession();
    });
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatChatMessageHtml(content: string): string {
  const parts = content.split(/```([\s\S]*?)```/g);
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) {
        const cleaned = part.replace(/^[a-zA-Z0-9_-]+\n/, "");
        return `<pre class="my-2 p-2.5 rounded-md bg-zinc-950 border border-zinc-800 font-mono text-xs text-emerald-300 overflow-x-auto whitespace-pre"><code>${escapeHtml(
          cleaned
        )}</code></pre>`;
      }
      return `<span class="whitespace-pre-wrap">${escapeHtml(part)}</span>`;
    })
    .join("");
}

export interface RoomAiState {
  enabled: boolean;
  provider?: AIProvider;
  thinking?: boolean;
  messages: ChatMessage[];
}

export interface RoomShellController {
  editorContainer: HTMLElement;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setExpiresAt: (expiresAtMs: number) => void;
  setSelectedLanguage: (lang: SupportedLanguage) => void;
  setAiState: (state: RoomAiState) => void;
  showExpiredBanner: () => void;
  destroy: () => void;
}

/**
 * Renders the Room Workspace UI with persistent header (Logo, Language selector,
 * 24h Countdown Timer, Connection Indicator, optional AI Chat toggle, and "Copy link" button),
 * full-viewport CodeMirror container, and optional AI Coding Assistant side panel.
 */
export function renderRoomShell(
  root: HTMLElement,
  options: {
    roomId: string;
    initialLanguage: SupportedLanguage;
    initialLinkCopied?: boolean;
    onLanguageSelect: (lang: SupportedLanguage) => void;
    onSendAiPrompt?: (prompt: string) => void;
    onEndSession?: () => void;
    onLogoClick: () => void;
  }
): RoomShellController {
  let expiresAtMs = Date.now() + TWENTY_FOUR_HOURS_MS;
  let aiHasAutoOpened = false;
  let aiPanelOpen = false;

  const languageOptionsHtml = LANGUAGE_OPTIONS.map(
    (opt) =>
      `<option value="${opt.id}" ${opt.id === options.initialLanguage ? "selected" : ""}>${opt.label}</option>`
  ).join("");

  root.innerHTML = `
    <div class="h-screen w-screen flex flex-col bg-zinc-950 text-zinc-100 overflow-hidden">
      <!-- Persistent Session Utility Header (FR-8) -->
      <header class="h-13 shrink-0 px-4 border-b border-zinc-800/90 bg-zinc-900/90 backdrop-blur flex items-center justify-between gap-4 select-none">
        <!-- Left: Logo / Branding & Language Selector -->
        <div class="flex items-center gap-3 min-w-0">
          <button
            id="brand-home-btn"
            type="button"
            title="CodeMirror Home"
            class="cursor-pointer flex items-center gap-2.5 text-zinc-100 hover:text-emerald-400 transition"
          >
            <div class="h-7 w-7 rounded-md bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-mono font-semibold text-xs">
              &lt;/&gt;
            </div>
            <span class="font-semibold tracking-tight text-sm sm:text-base">CodeMirror</span>
          </button>

          <span class="text-zinc-700">|</span>

          <label class="sr-only" for="language-select">Syntax Highlighting</label>
          <select
            id="language-select"
            class="cursor-pointer bg-zinc-950 border border-zinc-800 hover:border-zinc-700 text-zinc-200 text-xs font-mono rounded-md px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 transition"
          >
            ${languageOptionsHtml}
          </select>
        </div>

        <!-- Center: Countdown Timer Display -->
        <div class="flex items-center justify-center">
          <div
            id="countdown-badge"
            class="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-zinc-950/90 border border-zinc-800 text-xs font-mono text-zinc-300"
          >
            <svg class="w-3.5 h-3.5 text-zinc-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span id="countdown-text">${formatCountdown(expiresAtMs)}</span>
          </div>
        </div>

        <!-- Right: Connection Status Indicator, AI Chat Toggle & Copy Link Button -->
        <div class="flex items-center gap-2.5">
          <div
            id="connection-badge"
            class="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-zinc-950/90 border border-zinc-800 text-xs font-mono text-amber-300"
          >
            <span id="connection-dot" class="h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span>
            <span id="connection-label">Reconnecting</span>
          </div>

          <button
            id="toggle-ai-btn"
            type="button"
            class="hidden cursor-pointer items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-950 border border-zinc-800 hover:border-emerald-500/50 text-zinc-200 text-xs font-mono transition"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            <span>AI Chat</span>
          </button>

          <button
            id="copy-link-btn"
            type="button"
            class="cursor-pointer inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-semibold text-xs tracking-tight transition shadow-sm"
          >
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span id="copy-link-label">Copy link</span>
          </button>

          <button
            id="end-session-btn"
            type="button"
            class="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-900/60 bg-red-950/30 hover:bg-red-950/70 text-red-300 font-medium text-xs tracking-tight transition"
          >
            <span id="end-session-label">End session</span>
          </button>
        </div>
      </header>

      <!-- Expired Banner (hidden unless room expires) -->
      <div
        id="expired-banner"
        class="hidden bg-red-950/90 border-b border-red-800 px-4 py-2 text-xs font-mono text-red-200 text-center"
      >
        This 24-hour disposable session has expired and been purged from storage.
      </div>

      <!-- Main Workspace Row: Editor + Optional AI Side Panel -->
      <div class="flex-1 w-full h-full flex overflow-hidden relative bg-zinc-950">
        <main id="editor-viewport" class="flex-1 min-w-0 h-full overflow-hidden relative bg-zinc-950"></main>

        <!-- AI Coding Assistant Side Panel (shown only when session started with AI key) -->
        <aside
          id="ai-side-panel"
          class="hidden w-88 sm:w-96 shrink-0 h-full border-l border-zinc-800 bg-zinc-900/95 flex-col overflow-hidden"
        >
          <div class="px-3.5 py-2.5 border-b border-zinc-800 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-xs font-semibold text-zinc-100">AI Assistant</span>
              <span
                id="ai-provider-badge"
                class="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-mono text-emerald-400"
              >
                OpenAI
              </span>
              <span class="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] font-mono text-zinc-400">
                Coding Only
              </span>
            </div>
            <button
              id="close-ai-panel-btn"
              type="button"
              title="Hide AI Panel"
              class="cursor-pointer text-zinc-400 hover:text-zinc-200 text-xs font-mono px-1.5 py-0.5 rounded hover:bg-zinc-800 transition"
            >
              ✕
            </button>
          </div>

          <div
            id="ai-messages-list"
            class="flex-1 overflow-y-auto p-3.5 space-y-3 text-xs leading-relaxed"
          >
            <div class="text-zinc-500 font-mono text-[11px] text-center py-6">
              Ask coding, debugging, or algorithm questions about the current editor buffer.
            </div>
          </div>

          <div
            id="ai-thinking-indicator"
            class="hidden px-3.5 py-1.5 border-t border-zinc-800/80 bg-zinc-950/60 text-[11px] font-mono text-emerald-400 flex items-center gap-2"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Thinking...</span>
          </div>

          <form id="ai-prompt-form" class="p-3 border-t border-zinc-800 bg-zinc-950/80 flex gap-2">
            <textarea
              id="ai-prompt-input"
              rows="2"
              placeholder="Ask a coding question... (Enter to send)"
              class="flex-1 resize-none rounded-md bg-zinc-900 border border-zinc-800 focus:border-emerald-500 focus:outline-none px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500"
            ></textarea>
            <button
              id="ai-send-btn"
              type="submit"
              class="cursor-pointer self-end px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold text-xs transition"
            >
              Send
            </button>
          </form>
        </aside>
      </div>
    </div>
  `;

  const editorContainer = root.querySelector<HTMLElement>("#editor-viewport")!;
  const countdownText = root.querySelector<HTMLElement>("#countdown-text")!;
  const connectionBadge = root.querySelector<HTMLElement>("#connection-badge")!;
  const connectionDot = root.querySelector<HTMLElement>("#connection-dot")!;
  const connectionLabel = root.querySelector<HTMLElement>("#connection-label")!;
  const copyLinkBtn = root.querySelector<HTMLButtonElement>("#copy-link-btn")!;
  const copyLinkLabel = root.querySelector<HTMLElement>("#copy-link-label")!;
  const endSessionBtn = root.querySelector<HTMLButtonElement>("#end-session-btn")!;
  const endSessionLabel = root.querySelector<HTMLElement>("#end-session-label")!;
  const languageSelect = root.querySelector<HTMLSelectElement>("#language-select")!;
  const brandHomeBtn = root.querySelector<HTMLButtonElement>("#brand-home-btn")!;
  const expiredBanner = root.querySelector<HTMLElement>("#expired-banner")!;

  const toggleAiBtn = root.querySelector<HTMLButtonElement>("#toggle-ai-btn")!;
  const aiSidePanel = root.querySelector<HTMLElement>("#ai-side-panel")!;
  const closeAiPanelBtn = root.querySelector<HTMLButtonElement>("#close-ai-panel-btn")!;
  const aiProviderBadge = root.querySelector<HTMLElement>("#ai-provider-badge")!;
  const aiMessagesList = root.querySelector<HTMLElement>("#ai-messages-list")!;
  const aiThinkingIndicator = root.querySelector<HTMLElement>("#ai-thinking-indicator")!;
  const aiPromptForm = root.querySelector<HTMLFormElement>("#ai-prompt-form")!;
  const aiPromptInput = root.querySelector<HTMLTextAreaElement>("#ai-prompt-input")!;

  const syncAiPanelVisibility = () => {
    if (aiPanelOpen) {
      aiSidePanel.classList.remove("hidden");
      aiSidePanel.classList.add("flex");
      toggleAiBtn.classList.add("border-emerald-500/60", "text-emerald-300");
    } else {
      aiSidePanel.classList.add("hidden");
      aiSidePanel.classList.remove("flex");
      toggleAiBtn.classList.remove("border-emerald-500/60", "text-emerald-300");
    }
  };

  toggleAiBtn.addEventListener("click", () => {
    aiPanelOpen = !aiPanelOpen;
    syncAiPanelVisibility();
  });

  closeAiPanelBtn.addEventListener("click", () => {
    aiPanelOpen = false;
    syncAiPanelVisibility();
  });

  const submitAiPrompt = () => {
    const prompt = aiPromptInput.value.trim();
    if (!prompt) return;
    aiPromptInput.value = "";
    options.onSendAiPrompt?.(prompt);
  };

  aiPromptForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitAiPrompt();
  });

  aiPromptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitAiPrompt();
    }
  });

  const updateCountdownDisplay = () => {
    countdownText.textContent = formatCountdown(expiresAtMs);
  };

  const timerInterval = setInterval(updateCountdownDisplay, 15_000);

  languageSelect.addEventListener("change", () => {
    options.onLanguageSelect(languageSelect.value as SupportedLanguage);
  });

  brandHomeBtn.addEventListener("click", () => {
    options.onLogoClick();
  });

  let copyTimeout: ReturnType<typeof setTimeout> | null = null;
  const showCopiedFeedback = (label = "Copied!") => {
    copyLinkLabel.textContent = label;
    if (copyTimeout) clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => {
      copyLinkLabel.textContent = "Copy link";
    }, 2200);
  };

  if (options.initialLinkCopied) {
    showCopiedFeedback("Link Copied!");
  }

  copyLinkBtn.addEventListener("click", async () => {
    await copyTextToClipboard(window.location.href);
    showCopiedFeedback("Copied!");
  });

  let confirmingEnd = false;
  let endConfirmTimeout: ReturnType<typeof setTimeout> | null = null;

  const resetEndSessionBtn = () => {
    confirmingEnd = false;
    endSessionLabel.textContent = "End session";
    endSessionBtn.className =
      "cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-900/60 bg-red-950/30 hover:bg-red-950/70 text-red-300 font-medium text-xs tracking-tight transition";
  };

  endSessionBtn.addEventListener("click", () => {
    if (!confirmingEnd) {
      confirmingEnd = true;
      endSessionLabel.textContent = "Confirm?";
      endSessionBtn.className =
        "cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-500 bg-red-600 hover:bg-red-500 text-white font-semibold text-xs tracking-tight transition";
      if (endConfirmTimeout) clearTimeout(endConfirmTimeout);
      endConfirmTimeout = setTimeout(resetEndSessionBtn, 3000);
      return;
    }

    if (endConfirmTimeout) clearTimeout(endConfirmTimeout);
    options.onEndSession?.();
  });

  return {
    editorContainer,
    setConnectionStatus(status: ConnectionStatus) {
      if (status === "connected") {
        connectionBadge.className =
          "inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-zinc-950/90 border border-zinc-800 text-xs font-mono text-emerald-300";
        connectionDot.className = "h-2 w-2 rounded-full bg-emerald-400";
        connectionLabel.textContent = "Connected";
      } else {
        connectionBadge.className =
          "inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-zinc-950/90 border border-zinc-800 text-xs font-mono text-amber-300";
        connectionDot.className = "h-2 w-2 rounded-full bg-amber-400 animate-pulse";
        connectionLabel.textContent = "Reconnecting";
      }
    },
    setExpiresAt(nextExpiresAtMs: number) {
      expiresAtMs = nextExpiresAtMs;
      updateCountdownDisplay();
    },
    setSelectedLanguage(lang: SupportedLanguage) {
      if (languageSelect.value !== lang) {
        languageSelect.value = lang;
      }
    },
    setAiState(state: RoomAiState) {
      if (!state.enabled) {
        toggleAiBtn.classList.add("hidden");
        toggleAiBtn.classList.remove("inline-flex");
        aiPanelOpen = false;
        syncAiPanelVisibility();
        return;
      }

      toggleAiBtn.classList.remove("hidden");
      toggleAiBtn.classList.add("inline-flex");

      if (!aiHasAutoOpened) {
        aiHasAutoOpened = true;
        aiPanelOpen = true;
        syncAiPanelVisibility();
      }

      if (state.provider) {
        aiProviderBadge.textContent = getProviderLabel(state.provider);
      }

      if (state.thinking) {
        aiThinkingIndicator.classList.remove("hidden");
      } else {
        aiThinkingIndicator.classList.add("hidden");
      }

      if (state.messages.length === 0) {
        aiMessagesList.innerHTML = `
          <div class="text-zinc-500 font-mono text-[11px] text-center py-6">
            Ask coding, debugging, or algorithm questions about the current editor buffer.
          </div>
        `;
      } else {
        aiMessagesList.innerHTML = state.messages
          .map((m) => {
            const isUser = m.role === "user";
            const isError = m.status === "error";
            const bubbleClass = isUser
              ? "bg-emerald-500/15 border-emerald-500/30 text-zinc-100 ml-6"
              : isError
              ? "bg-red-950/50 border-red-800/70 text-red-200 mr-4"
              : "bg-zinc-950 border-zinc-800 text-zinc-200 mr-4";
            const roleLabel = isUser
              ? "You / Room"
              : m.provider
              ? getProviderLabel(m.provider)
              : "AI";
            return `
              <div class="p-2.5 rounded-lg border ${bubbleClass}">
                <div class="text-[10px] font-mono text-zinc-400 mb-1">${escapeHtml(roleLabel)}</div>
                <div class="text-xs leading-relaxed break-words">${formatChatMessageHtml(m.content)}</div>
              </div>
            `;
          })
          .join("");
        aiMessagesList.scrollTop = aiMessagesList.scrollHeight;
      }
    },
    showExpiredBanner() {
      expiredBanner.classList.remove("hidden");
      updateCountdownDisplay();
    },
    destroy() {
      clearInterval(timerInterval);
      if (copyTimeout) clearTimeout(copyTimeout);
      if (endConfirmTimeout) clearTimeout(endConfirmTimeout);
    }
  };
}
