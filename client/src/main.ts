import "./style.css";
import * as Y from "yjs";
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
let pendingInitialCopyFeedback = false;

function cleanupActiveRoom(): void {
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

async function startNewSession(): Promise<void> {
  const { roomId, hashKey } = await createSession();
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
    renderMissingKeyView(appRoot, startNewSession);
    return;
  }

  const doc = new Y.Doc();
  activeDoc = doc;

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
    onLogoClick: () => {
      cleanupActiveRoom();
      window.history.pushState({}, "", "/");
      void routeApplication();
    }
  });
  activeShell = shell;

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
