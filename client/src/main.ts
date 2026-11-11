import "./style.css";
import * as Y from "yjs";
import {
  AIProvider,
  attachHostAiResponder,
  ChatMessage,
  loadHostRoomAiKey,
  saveHostRoomAiKey
} from "./ai";
import { createSession, importKeyFromHash } from "./crypto";
import { EncryptedWsProvider } from "./provider";
import { EditorController, initializeEditor } from "./editor";
import {
  copyTextToClipboard,
  renderLandingView,
  renderMissingKeyView,
  renderRoomShell,
  RoomShellController
} from "./ui";

const appRoot = document.querySelector<HTMLElement>("#app")!;

let activeProvider: EncryptedWsProvider | null = null;
let activeEditor: EditorController | null = null;
let activeShell: RoomShellController | null = null;
let activeDoc: Y.Doc | null = null;
let detachAiResponder: (() => void) | null = null;
let pendingInitialCopyFeedback = false;

function cleanupActiveRoom(): void {
  detachAiResponder?.();
  detachAiResponder = null;

  activeProvider?.destroy();
  activeProvider = null;

  activeEditor?.destroy();
  activeEditor = null;

  activeShell?.destroy();
  activeShell = null;

  activeDoc?.destroy();
  activeDoc = null;
}

function parseRoomIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/room\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function startNewSession(aiApiKey?: string): Promise<void> {
  const { roomId, hashKey } = await createSession();
  if (aiApiKey && aiApiKey.trim().length > 0) {
    saveHostRoomAiKey(roomId, aiApiKey);
  }
  const targetUrl = `/room/${encodeURIComponent(roomId)}#${hashKey}`;
  window.history.pushState({}, "", targetUrl);
  pendingInitialCopyFeedback = await copyTextToClipboard(window.location.href);
  await routeApplication();
}

async function mountRoomSession(roomId: string, hashFragment: string): Promise<void> {
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await importKeyFromHash(hashFragment);
  } catch {
    renderMissingKeyView(appRoot, () => startNewSession());
    return;
  }

  const doc = new Y.Doc();
  activeDoc = doc;

  const ymeta = doc.getMap<string>("meta");
  const ychat = doc.getArray<ChatMessage>("chat");

  let editorCtrl: EditorController | null = null;
  const initialLinkCopied = pendingInitialCopyFeedback;
  pendingInitialCopyFeedback = false;

  const shell = renderRoomShell(appRoot, {
    roomId,
    initialLanguage: "kotlin",
    initialLinkCopied,
    onLanguageSelect: (lang) => {
      editorCtrl?.setLanguage(lang);
    },
    onSendAiPrompt: (prompt) => {
      ychat.push([
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "user",
          content: prompt,
          createdAt: Date.now()
        }
      ]);
    },
    onLogoClick: () => {
      cleanupActiveRoom();
      window.history.pushState({}, "", "/");
      void routeApplication();
    }
  });
  activeShell = shell;

  const syncAiShellState = () => {
    const enabled = ymeta.get("aiEnabled") === "true";
    const provider = (ymeta.get("aiProvider") as AIProvider | undefined) || "openai";
    const thinking = ymeta.get("aiThinking") === "true";
    shell.setAiState({
      enabled,
      provider,
      thinking,
      messages: ychat.toArray()
    });
  };

  ymeta.observe(syncAiShellState);
  ychat.observe(syncAiShellState);

  const hostAiKey = loadHostRoomAiKey(roomId);
  if (hostAiKey) {
    detachAiResponder = attachHostAiResponder(doc, hostAiKey);
  }
  syncAiShellState();

  editorCtrl = initializeEditor(shell.editorContainer, doc, (syncedLang) => {
    shell.setSelectedLanguage(syncedLang);
  });
  activeEditor = editorCtrl;

  activeProvider = new EncryptedWsProvider(doc, roomId, cryptoKey, {
    onStatusChange: (status) => {
      shell.setConnectionStatus(status);
    },
    onMetadata: (meta) => {
      shell.setExpiresAt(meta.expiresAt);
    },
    onSessionExpired: () => {
      shell.showExpiredBanner();
    }
  });

  editorCtrl.view.focus();
}

async function routeApplication(): Promise<void> {
  cleanupActiveRoom();

  const roomId = parseRoomIdFromPath(window.location.pathname);
  if (!roomId) {
    renderLandingView(appRoot, startNewSession);
    return;
  }

  await mountRoomSession(roomId, window.location.hash);
}

window.addEventListener("popstate", () => {
  void routeApplication();
});

window.addEventListener("hashchange", () => {
  if (parseRoomIdFromPath(window.location.pathname)) {
    void routeApplication();
  }
});

void routeApplication();
