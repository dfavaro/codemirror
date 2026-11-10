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
 * Renders the minimal centered Homepage with Logo, 1-line description, and "Start session" CTA (FR-1).
 */
export function renderLandingView(
  root: HTMLElement,
  onCreateSession: () => Promise<void>
): void {
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

        <div class="pt-1">
          <button
            id="new-session-btn"
            type="button"
            class="cursor-pointer inline-flex items-center justify-center gap-2.5 px-6 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-semibold text-sm sm:text-base shadow-lg shadow-emerald-500/15 transition-all"
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
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Starting session...";
    try {
      await onCreateSession();
    } catch (err) {
      console.error("Failed to create session:", err);
      btn.disabled = false;
      btn.textContent = "Start session";
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

export interface RoomShellController {
  editorContainer: HTMLElement;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setExpiresAt: (expiresAtMs: number) => void;
  setSelectedLanguage: (lang: SupportedLanguage) => void;
  showExpiredBanner: () => void;
  destroy: () => void;
}

/**
 * Renders the Room Workspace UI with persistent header (Logo, Language selector,
 * 24h Countdown Timer, Connection Indicator, and "Copy Encrypted Link" button)
 * and full-viewport CodeMirror container.
 */
export function renderRoomShell(
  root: HTMLElement,
  options: {
    roomId: string;
    initialLanguage: SupportedLanguage;
    initialLinkCopied?: boolean;
    onLanguageSelect: (lang: SupportedLanguage) => void;
    onLogoClick: () => void;
  }
): RoomShellController {
  let expiresAtMs = Date.now() + TWENTY_FOUR_HOURS_MS;

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

        <!-- Right: Connection Status Indicator & Copy Encrypted Link Button -->
        <div class="flex items-center gap-3">
          <div
            id="connection-badge"
            class="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-zinc-950/90 border border-zinc-800 text-xs font-mono text-amber-300"
          >
            <span id="connection-dot" class="h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span>
            <span id="connection-label">Reconnecting</span>
          </div>

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
        </div>
      </header>

      <!-- Expired Banner (hidden unless room expires) -->
      <div
        id="expired-banner"
        class="hidden bg-red-950/90 border-b border-red-800 px-4 py-2 text-xs font-mono text-red-200 text-center"
      >
        This 24-hour disposable session has expired and been purged from storage.
      </div>

      <!-- Main Full-Viewport CodeMirror 6 Container -->
      <main id="editor-viewport" class="flex-1 w-full h-full overflow-hidden relative bg-zinc-950"></main>
    </div>
  `;

  const editorContainer = root.querySelector<HTMLElement>("#editor-viewport")!;
  const countdownText = root.querySelector<HTMLElement>("#countdown-text")!;
  const connectionBadge = root.querySelector<HTMLElement>("#connection-badge")!;
  const connectionDot = root.querySelector<HTMLElement>("#connection-dot")!;
  const connectionLabel = root.querySelector<HTMLElement>("#connection-label")!;
  const copyLinkBtn = root.querySelector<HTMLButtonElement>("#copy-link-btn")!;
  const copyLinkLabel = root.querySelector<HTMLElement>("#copy-link-label")!;
  const languageSelect = root.querySelector<HTMLSelectElement>("#language-select")!;
  const brandHomeBtn = root.querySelector<HTMLButtonElement>("#brand-home-btn")!;
  const expiredBanner = root.querySelector<HTMLElement>("#expired-banner")!;

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
    showExpiredBanner() {
      expiredBanner.classList.remove("hidden");
      updateCountdownDisplay();
    },
    destroy() {
      clearInterval(timerInterval);
      if (copyTimeout) clearTimeout(copyTimeout);
    }
  };
}
