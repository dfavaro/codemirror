import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import WebSocket from "ws";
import { createRequire } from "module";
import {
  createSession,
  decryptDelta,
  encryptDelta,
  importKeyFromHash,
  IV_BYTE_LENGTH
} from "../crypto";
import { EncryptedWsProvider, RoomMetadata } from "../provider";
import { LANGUAGE_OPTIONS } from "../editor";
import { kotlinCompletionSource, swiftCompletionSource } from "../completions";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { formatCountdown } from "../ui";

const require = createRequire(import.meta.url);
const { createRelayServer } = require("../../../server/server.js");

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 15
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("CodeMirror Zero-Knowledge Crypto (AES-GCM-256)", () => {
  it("generates a UUIDv4 roomId and a 256-bit JWK hash key that imports cleanly", async () => {
    const { roomId, hashKey } = await createSession();
    expect(roomId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(hashKey.length).toBeGreaterThan(20);

    const key = await importKeyFromHash(`#${hashKey}`);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });

  it("encrypts and decrypts binary Yjs deltas with a unique 12-byte IV and 16-byte GCM auth tag", async () => {
    const { hashKey } = await createSession();
    const key = await importKeyFromHash(hashKey);

    const doc = new Y.Doc();
    doc.getText("codemirror").insert(0, "const secret = 'zero-knowledge';");
    const delta = Y.encodeStateAsUpdate(doc);

    const frame1 = await encryptDelta(delta, key);
    const frame2 = await encryptDelta(delta, key);

    // 12-byte IV + plaintext length + 16-byte GCM tag
    expect(frame1.byteLength).toBe(IV_BYTE_LENGTH + delta.byteLength + 16);

    // IVs must be cryptographically distinct across frames
    const iv1 = frame1.slice(0, IV_BYTE_LENGTH);
    const iv2 = frame2.slice(0, IV_BYTE_LENGTH);
    expect(Buffer.from(iv1).equals(Buffer.from(iv2))).toBe(false);

    const decrypted = await decryptDelta(frame1, key);
    expect(Buffer.from(decrypted).equals(Buffer.from(delta))).toBe(true);
  });

  it("rejects tampered ciphertext or wrong decryption keys", async () => {
    const sessionA = await createSession();
    const sessionB = await createSession();
    const keyA = await importKeyFromHash(sessionA.hashKey);
    const keyB = await importKeyFromHash(sessionB.hashKey);

    const payload = new TextEncoder().encode("sensitive interview prompt");
    const encrypted = await encryptDelta(payload, keyA);

    // Wrong key must fail authentication
    await expect(decryptDelta(encrypted, keyB)).rejects.toThrow();

    // Tampered byte in ciphertext must fail GCM authentication tag verification
    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptDelta(tampered, keyA)).rejects.toThrow();
  });
});

describe("CodeMirror End-to-End Relay & Late-Joiner Catch-Up", () => {
  let relay: ReturnType<typeof createRelayServer>;
  let wsBaseUrl: string;

  beforeEach(async () => {
    relay = createRelayServer({ inMemory: true });
    await new Promise<void>((resolve) => {
      relay.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = relay.server.address();
    wsBaseUrl = `ws://127.0.0.1:${address.port}/ws`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      relay.wss.close(() => {
        relay.server.close(() => resolve());
      });
    });
  });

  it("synchronizes encrypted keystrokes across peers while keeping the relay zero-knowledge", async () => {
    const { roomId, hashKey } = await createSession();
    const key = await importKeyFromHash(hashKey);

    const docA = new Y.Doc();
    const docB = new Y.Doc();

    let metaReceived: RoomMetadata | null = null;

    const providerA = new EncryptedWsProvider(docA, roomId, key, {
      wsUrl: wsBaseUrl,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      onMetadata: (meta) => {
        metaReceived = meta;
      }
    });

    const providerB = new EncryptedWsProvider(docB, roomId, key, {
      wsUrl: wsBaseUrl,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket
    });

    await waitForCondition(
      () => providerA.getStatus() === "connected" && providerB.getStatus() === "connected"
    );

    const secretCode = "function twoSum(nums: number[], target: number) { return [0, 1]; }";
    docA.getText("codemirror").insert(0, secretCode);
    docA.getMap("meta").set("language", "python");

    await waitForCondition(
      () =>
        docB.getText("codemirror").toString() === secretCode &&
        docB.getMap("meta").get("language") === "python"
    );

    expect(metaReceived).not.toBeNull();
    expect(metaReceived!.roomId).toBe(roomId);
    expect(metaReceived!.expiresAt).toBeGreaterThan(Date.now());

    // Verify zero-knowledge property: server memory contains no plaintext
    const serverRoom = relay.rooms.get(roomId);
    expect(serverRoom).toBeDefined();
    for (const rawDelta of serverRoom.pendingDeltas) {
      expect(rawDelta.toString("utf8")).not.toContain("twoSum");
    }

    providerA.destroy();
    providerB.destroy();
  });

  it("reconstructs exact buffer for late-joining peers from encrypted snapshot + uncommitted deltas", async () => {
    const { roomId, hashKey } = await createSession();
    const key = await importKeyFromHash(hashKey);

    const docHost = new Y.Doc();
    const providerHost = new EncryptedWsProvider(docHost, roomId, key, {
      wsUrl: wsBaseUrl,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket
    });

    await waitForCondition(() => providerHost.getStatus() === "connected");

    // Step 1: Host writes initial prompt and persists an encrypted snapshot (0x02)
    docHost.getText("codemirror").insert(0, "// Step 1: Saved in Firestore snapshot\n");
    await providerHost.flushSnapshotNow();

    await waitForCondition(() => {
      const serverRoom = relay.rooms.get(roomId);
      return Boolean(serverRoom?.snapshot);
    });

    // Step 2: Host types additional uncommitted deltas (0x01) after the snapshot
    docHost
      .getText("codemirror")
      .insert(docHost.getText("codemirror").length, "const liveTyping = true;\n");

    await waitForCondition(() => {
      const serverRoom = relay.rooms.get(roomId);
      return serverRoom?.pendingDeltas.length > 0;
    });

    // Step 3: Late joiner connects and must receive both the snapshot and uncommitted deltas
    const docLateJoiner = new Y.Doc();
    const providerLateJoiner = new EncryptedWsProvider(docLateJoiner, roomId, key, {
      wsUrl: wsBaseUrl,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket
    });

    const expectedFullDocument =
      "// Step 1: Saved in Firestore snapshot\nconst liveTyping = true;\n";

    await waitForCondition(
      () => docLateJoiner.getText("codemirror").toString() === expectedFullDocument
    );

    expect(docLateJoiner.getText("codemirror").toString()).toBe(expectedFullDocument);

    providerHost.destroy();
    providerLateJoiner.destroy();
  });

  it("notifies clients and closes with 4004 when a room has passed its 24-hour TTL", async () => {
    const { roomId, hashKey } = await createSession();
    const key = await importKeyFromHash(hashKey);

    // Pre-seed an expired room in the relay store
    await relay.store.saveRoom(roomId, {
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      expiresAt: Date.now() - 1 * 60 * 60 * 1000,
      snapshot: null
    });

    let expiredTriggered = false;
    const doc = new Y.Doc();
    const provider = new EncryptedWsProvider(doc, roomId, key, {
      wsUrl: wsBaseUrl,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      onSessionExpired: () => {
        expiredTriggered = true;
      }
    });

    await waitForCondition(() => expiredTriggered);
    expect(expiredTriggered).toBe(true);
    provider.destroy();
  });
});

describe("Session Countdown Formatter & Supported Languages", () => {
  it("formats remaining time in PRD format (Expires in: 23h 48m)", () => {
    const now = 1_700_000_000_000;
    const expiresAt = now + (23 * 60 + 48) * 60 * 1000;
    expect(formatCountdown(expiresAt, now)).toBe("Expires in: 23h 48m");
    expect(formatCountdown(now - 1000, now)).toBe("Session Expired");
  });

  it("includes Kotlin, Swift, and core interview languages in LANGUAGE_OPTIONS sorted alphabetically", () => {
    const ids = LANGUAGE_OPTIONS.map((opt) => opt.id);
    expect(ids).toContain("kotlin");
    expect(ids).toContain("swift");
    expect(ids).toContain("typescript");
    expect(ids).toContain("python");
    expect(ids).toContain("go");
    expect(ids).toContain("java");
    expect(ids).toContain("rust");
    expect(ids).toContain("sql");

    const labels = LANGUAGE_OPTIONS.map((opt) => opt.label);
    const sortedLabels = [...labels].sort((a, b) => a.localeCompare(b));
    expect(labels).toEqual(sortedLabels);
  });

  it("provides Kotlin keyword, stdlib, kotlinx.coroutines StateFlow/Flow, Jetpack Compose, snippet, and dot-member autocompletions", () => {
    // 1. Typing a top-level identifier prefix ("Mut")
    const state1 = EditorState.create({ doc: "private val _state = Mut" });
    const ctx1 = new CompletionContext(state1, state1.doc.length, false);
    const res1 = kotlinCompletionSource(ctx1);
    expect(res1).not.toBeNull();
    const labels1 = res1!.options.map((o) => o.label);
    // Built-in CodeMirror clike Kotlin keywords & types
    expect(labels1).toContain("val");
    expect(labels1).toContain("suspend");
    expect(labels1).toContain("String");
    // Curated stdlib, kotlinx.coroutines.flow, & Jetpack Compose symbols
    expect(labels1).toContain("StateFlow");
    expect(labels1).toContain("MutableStateFlow");
    expect(labels1).toContain("SharedFlow");
    expect(labels1).toContain("MutableSharedFlow");
    expect(labels1).toContain("Flow");
    expect(labels1).toContain("stateflow");
    expect(labels1).toContain("CoroutineScope");
    expect(labels1).toContain("Dispatchers");
    expect(labels1).toContain("remember");
    expect(labels1).toContain("mutableStateOf");
    expect(labels1).toContain("LaunchedEffect");
    expect(labels1).toContain("Column");
    expect(labels1).toContain("LazyColumn");
    expect(labels1).toContain("Modifier");
    expect(labels1).toContain("composable");
    expect(labels1).toContain("mutableListOf");
    expect(labels1).toContain("mutableMapOf");
    expect(labels1).toContain("dataclass");

    // 2. Typing after a dot ("_state.as")
    const state2 = EditorState.create({ doc: "_state.as" });
    const ctx2 = new CompletionContext(state2, state2.doc.length, false);
    const res2 = kotlinCompletionSource(ctx2);
    expect(res2).not.toBeNull();
    expect(res2!.from).toBe("_state.".length);
    const labels2 = res2!.options.map((o) => o.label);
    expect(labels2).toContain("asStateFlow");
    expect(labels2).toContain("asSharedFlow");
    expect(labels2).toContain("value");
    expect(labels2).toContain("update");
    expect(labels2).toContain("collect");
    expect(labels2).toContain("stateIn");
    expect(labels2).toContain("collectAsStateWithLifecycle");
    expect(labels2).toContain("fillMaxSize");
    expect(labels2).toContain("padding");
    expect(labels2).toContain("filter");
    expect(labels2).toContain("firstOrNull");
    expect(labels2).toContain("map");
    expect(labels2).toContain("groupBy");

    // 3. Typing an annotation ("@Com")
    const state3 = EditorState.create({ doc: "@Com" });
    const ctx3 = new CompletionContext(state3, state3.doc.length, false);
    const res3 = kotlinCompletionSource(ctx3);
    expect(res3).not.toBeNull();
    expect(res3!.options.map((o) => o.label)).toContain("@Composable");
  });

  it("provides Swift and SwiftUI autocompletions (keywords, Views, @State attributes, and modifiers)", () => {
    const state1 = EditorState.create({ doc: "VSt" });
    const ctx1 = new CompletionContext(state1, state1.doc.length, false);
    const res1 = swiftCompletionSource(ctx1);
    expect(res1).not.toBeNull();
    const labels1 = res1!.options.map((o) => o.label);
    expect(labels1).toContain("VStack");
    expect(labels1).toContain("NavigationStack");
    expect(labels1).toContain("View");
    expect(labels1).toContain("swiftui");

    const state2 = EditorState.create({ doc: "@St" });
    const ctx2 = new CompletionContext(state2, state2.doc.length, false);
    const res2 = swiftCompletionSource(ctx2);
    expect(res2).not.toBeNull();
    const labels2 = res2!.options.map((o) => o.label);
    expect(labels2).toContain("@State");
    expect(labels2).toContain("@StateObject");
    expect(labels2).toContain("@Binding");
    expect(labels2).toContain("@Observable");

    const state3 = EditorState.create({ doc: "view.pad" });
    const ctx3 = new CompletionContext(state3, state3.doc.length, false);
    const res3 = swiftCompletionSource(ctx3);
    expect(res3).not.toBeNull();
    const labels3 = res3!.options.map((o) => o.label);
    expect(labels3).toContain("padding");
    expect(labels3).toContain("frame");
    expect(labels3).toContain("navigationTitle");
  });
});
