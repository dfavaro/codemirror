import * as Y from "yjs";
import {
  decryptDelta,
  encryptDelta,
  FRAME_TYPE_DELTA,
  FRAME_TYPE_DESTROY,
  FRAME_TYPE_SNAPSHOT,
  unwrapEncryptedFrame,
  wrapEncryptedFrame
} from "./crypto";

export type ConnectionStatus = "connected" | "reconnecting";

export interface RoomMetadata {
  roomId: string;
  createdAt: number;
  expiresAt: number;
}

export interface EncryptedWsProviderOptions {
  wsUrl?: string;
  snapshotIntervalMs?: number;
  WebSocketPolyfill?: typeof WebSocket;
  onStatusChange?: (status: ConnectionStatus) => void;
  onMetadata?: (meta: RoomMetadata) => void;
  onSessionExpired?: () => void;
  onSessionEnded?: () => void;
  onDecryptionError?: (err: unknown) => void;
}

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000; // 30 seconds per FR-5

/**
 * Resolves the WebSocket relay URL for a given roomId.
 * Notice: The encryption key is NEVER included in the URL or query string.
 */
export function resolveRelayWsUrl(roomId: string, customBaseUrl?: string): string {
  const base =
    customBaseUrl ||
    (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_WS_RELAY_URL) ||
    "";

  if (base) {
    const normalized = base.replace(/\/+$/, "");
    const url = new URL(normalized.endsWith("/ws") ? normalized : `${normalized}/ws`);
    url.searchParams.set("room", roomId);
    return url.toString();
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(roomId)}`;
  }

  return `ws://localhost:8080/ws?room=${encodeURIComponent(roomId)}`;
}

/**
 * Resolves an HTTP endpoint on the relay server (such as `/api/ai-proxy`)
 * from VITE_WS_RELAY_URL or current origin.
 */
export function resolveRelayHttpUrl(path: string, customBaseUrl?: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base =
    customBaseUrl ||
    (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_WS_RELAY_URL) ||
    "";

  if (base) {
    const httpBase = base
      .replace(/^wss:/i, "https:")
      .replace(/^ws:/i, "http:")
      .replace(/\/ws\/?$/i, "")
      .replace(/\/+$/, "");
    return `${httpBase}${normalizedPath}`;
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}${normalizedPath}`;
  }

  return `http://localhost:8080${normalizedPath}`;
}

/**
 * Zero-Knowledge WebSocket Provider for Yjs.
 * Encrypts all outgoing Y.Doc updates with AES-GCM-256 and decrypts incoming binary frames.
 */
export class EncryptedWsProvider {
  public readonly doc: Y.Doc;
  public readonly roomId: string;
  private readonly key: CryptoKey;
  private readonly wsUrl: string;
  private readonly snapshotIntervalMs: number;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly onStatusChange?: (status: ConnectionStatus) => void;
  private readonly onMetadata?: (meta: RoomMetadata) => void;
  private readonly onSessionExpired?: () => void;
  private readonly onSessionEnded?: () => void;
  private readonly onDecryptionError?: (err: unknown) => void;

  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "reconnecting";
  private destroyed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private hasInitialSnapshotSaved = false;
  private outboundQueue: Uint8Array[] = [];
  private processingChain: Promise<void> = Promise.resolve();

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || this.destroyed) {
      return;
    }

    this.processingChain = this.processingChain
      .then(async () => {
        const encrypted = await encryptDelta(update, this.key);
        const frame = wrapEncryptedFrame(FRAME_TYPE_DELTA, encrypted);
        this.sendBinaryFrame(frame);
        this.scheduleSnapshot();
      })
      .catch((err) => {
        console.error("Failed to encrypt outgoing Yjs update:", err);
      });
  };

  private readonly handleVisibilityChange = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      void this.flushSnapshotNow();
    }
  };

  constructor(
    doc: Y.Doc,
    roomId: string,
    key: CryptoKey,
    options: EncryptedWsProviderOptions = {}
  ) {
    this.doc = doc;
    this.roomId = roomId;
    this.key = key;
    this.wsUrl = resolveRelayWsUrl(roomId, options.wsUrl);
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.WebSocketImpl = options.WebSocketPolyfill ?? WebSocket;
    this.onStatusChange = options.onStatusChange;
    this.onMetadata = options.onMetadata;
    this.onSessionExpired = options.onSessionExpired;
    this.onSessionEnded = options.onSessionEnded;
    this.onDecryptionError = options.onDecryptionError;

    this.doc.on("update", this.handleDocUpdate);

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }

    this.connect();
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status !== next) {
      this.status = next;
    }
    this.onStatusChange?.(next);
  }

  private connect(): void {
    if (this.destroyed) return;

    try {
      const ws = new this.WebSocketImpl(this.wsUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        if (this.destroyed) {
          ws.close();
          return;
        }
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        this.flushOutboundQueue();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.destroyed) return;

        if (typeof event.data === "string") {
          this.handleControlMessage(event.data);
          return;
        }

        const rawBytes =
          event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : ArrayBuffer.isView(event.data)
            ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
            : new Uint8Array(event.data);

        this.processingChain = this.processingChain
          .then(async () => {
            const { encryptedPayload } = unwrapEncryptedFrame(rawBytes);
            const decrypted = await decryptDelta(encryptedPayload, this.key);
            this.doc.transact(() => {
              Y.applyUpdate(this.doc, decrypted, "remote");
            }, "remote");
          })
          .catch((err) => {
            this.onDecryptionError?.(err);
          });
      };

      ws.onclose = (event: CloseEvent) => {
        if (this.destroyed) return;
        if (event.code === 4004) {
          this.onSessionExpired?.();
          this.destroy();
          return;
        }
        if (event.code === 4005) {
          this.onSessionEnded?.();
          this.destroy();
          return;
        }
        this.setStatus("reconnecting");
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        // Error is followed by onclose which triggers reconnection
      };
    } catch {
      this.setStatus("reconnecting");
      this.scheduleReconnect();
    }
  }

  private handleControlMessage(rawJson: string): void {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed?.type === "room_meta" && typeof parsed.expiresAt === "number") {
        this.onMetadata?.({
          roomId: parsed.roomId || this.roomId,
          createdAt: parsed.createdAt || parsed.expiresAt - 24 * 60 * 60 * 1000,
          expiresAt: parsed.expiresAt
        });
      } else if (parsed?.type === "room_destroyed") {
        this.onSessionEnded?.();
        this.destroy();
      }
    } catch {
      // Ignore unrecognized non-binary messages
    }
  }

  private sendBinaryFrame(frame: Uint8Array): void {
    if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
      this.ws.send(frame);
    } else {
      this.outboundQueue.push(frame);
    }
  }

  private flushOutboundQueue(): void {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return;
    while (this.outboundQueue.length > 0) {
      const frame = this.outboundQueue.shift()!;
      this.ws.send(frame);
    }
  }

  /**
   * Debounces full-document encrypted snapshots every 30 seconds of active editing (FR-5),
   * while also persisting an initial snapshot shortly after the first edit in a new room.
   */
  private scheduleSnapshot(): void {
    if (this.destroyed) return;

    if (!this.hasInitialSnapshotSaved) {
      this.hasInitialSnapshotSaved = true;
      setTimeout(() => {
        if (!this.destroyed) {
          void this.flushSnapshotNow();
        }
      }, 1500);
    }

    if (this.snapshotTimer) {
      return;
    }

    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.flushSnapshotNow();
    }, this.snapshotIntervalMs);
  }

  /**
   * Immediately encodes the full Y.Doc state, encrypts it with AES-GCM-256,
   * prefixes it with FRAME_TYPE_SNAPSHOT (0x02), and transmits it to the relay.
   */
  public async flushSnapshotNow(): Promise<void> {
    if (this.destroyed) return;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    const fullState = Y.encodeStateAsUpdate(this.doc);
    const encrypted = await encryptDelta(fullState, this.key);
    const snapshotFrame = wrapEncryptedFrame(FRAME_TYPE_SNAPSHOT, encrypted);
    this.sendBinaryFrame(snapshotFrame);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Sends FRAME_TYPE_DESTROY (0x03) to permanently delete the room on the relay
   * and Cloud Firestore, disconnecting all connected peers, then closes locally.
   */
  public destroyRoom(): void {
    if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
      try {
        this.ws.send(new Uint8Array([FRAME_TYPE_DESTROY]));
      } catch {
        // Ignore send error before destroy
      }
    }
    this.destroy();
  }

  public destroy(): void {
    this.destroyed = true;
    this.doc.off("update", this.handleDocUpdate);

    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors on destroy
      }
      this.ws = null;
    }
  }
}
