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
import {
  attachHostAiResponder,
  buildSystemPromptWithContext,
  ChatMessage,
  CODING_ONLY_SYSTEM_PROMPT,
  detectProviderFromKey,
  resolveProvider,
  sanitizeApiKey,
  sendCodingChatCompletion
} from "../ai";
import {
  addCursorsToLineEnds,
  handleTabKey,
  insertBlankLineAbove,
  LANGUAGE_OPTIONS,
  VSCODE_KEYBINDINGS
} from "../editor";
import { kotlinCompletionSource, swiftCompletionSource } from "../completions";
import { EditorSelection, EditorState, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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

  it("inserts spaces at the cursor position (not start of row) on Tab when no completion is active, and supports VS Code line/cursor commands", () => {
    const createMockView = (initialState: EditorState): EditorView => {
      const mock = {
        state: initialState,
        dispatch(...specs: TransactionSpec[]) {
          mock.state = mock.state.update(...specs).state;
        }
      };
      return mock as unknown as EditorView;
    };

    const view = createMockView(
      EditorState.create({
        doc: "val count = 1",
        selection: { anchor: 4 } // cursor right after "val "
      })
    );

    const handled = handleTabKey(view);
    expect(handled).toBe(true);
    // Must insert 2 spaces at cursor position (index 4), NOT at index 0
    expect(view.state.doc.toString()).toBe("val   count = 1");
    expect(view.state.selection.main.head).toBe(6);

    // VS Code Cmd+Shift+Enter: insert blank line above preserving indentation
    const indentedView = createMockView(
      EditorState.create({
        doc: "  println(count)",
        selection: { anchor: 10 }
      })
    );
    expect(insertBlankLineAbove(indentedView)).toBe(true);
    expect(indentedView.state.doc.toString()).toBe("  \n  println(count)");
    expect(indentedView.state.selection.main.head).toBe(2);

    // VS Code Shift+Alt+I: add cursors to ends of selected lines
    const multiLineView = createMockView(
      EditorState.create({
        doc: "val a = 1\nval b = 2\nval c = 3",
        selection: EditorSelection.range(0, 29),
        extensions: [EditorState.allowMultipleSelections.of(true)]
      })
    );
    expect(addCursorsToLineEnds(multiLineView)).toBe(true);
    expect(multiLineView.state.selection.ranges.map((r) => r.head)).toEqual([9, 19, 29]);

    // Verify core VS Code shortcuts are registered in VSCODE_KEYBINDINGS
    const registeredKeys = VSCODE_KEYBINDINGS.map((b) => b.key);
    expect(registeredKeys).toContain("Tab");
    expect(registeredKeys).toContain("Mod-d");
    expect(registeredKeys).toContain("Mod-l");
    expect(registeredKeys).toContain("Shift-Mod-k");
    expect(registeredKeys).toContain("Shift-Mod-Enter");
    expect(registeredKeys).toContain("Alt-ArrowUp");
    expect(registeredKeys).toContain("Shift-Alt-ArrowDown");
    expect(registeredKeys).toContain("Mod-/");
    expect(registeredKeys).toContain("Shift-Alt-a");
  });

  it("auto-detects BYOK AI providers, enforces coding-only system prompt with live editor context, and executes host-proxied room chat over Yjs", async () => {
    expect(detectProviderFromKey("oc_sk_testOpenCodeKey")).toBe("opencode");
    expect(detectProviderFromKey("opencode_testKey")).toBe("opencode");
    expect(detectProviderFromKey("sk-ant-api03-test")).toBe("anthropic");
    expect(detectProviderFromKey("AIzaSyTestGeminiKey")).toBe("gemini");
    expect(detectProviderFromKey("  'AIzaSyQuotedGeminiKey'  ")).toBe("gemini");
    expect(detectProviderFromKey("Bearer sk-ant-api03-bearer")).toBe("anthropic");
    expect(sanitizeApiKey("  \"Bearer AIzaSyKey123\"  ")).toBe("AIzaSyKey123");
    expect(detectProviderFromKey("sk-or-v1-testOpenRouter")).toBe("openrouter");
    expect(detectProviderFromKey("gsk_testGroqKey")).toBe("groq");
    expect(detectProviderFromKey("xai-testGrokKey")).toBe("xai");
    expect(detectProviderFromKey("sk-proj-testOpenAiKey")).toBe("openai");
    expect(resolveProvider("oc_sk_testOpenCodeKey", "opencode-go")).toBe("opencode-go");
    expect(resolveProvider("sk-custom", "deepseek")).toBe("deepseek");

    // Simulate strict browser Window.prototype.fetch that throws Illegal invocation if `this` is bound to an options object
    const strictWindowFetch = async function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("'fetch' called on an object that does not implement interface Window.");
      }
      const urlStr = String(input);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "Gemini response OK." }] } }]
          })
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Default response OK." } }]
        })
      } as Response;
    } as typeof fetch;

    const geminiReply = await sendCodingChatCompletion({
      apiKey: "AIzaSyGeminiKey",
      provider: "auto",
      messages: [{ id: "g1", role: "user", content: "Write binary search", createdAt: 1 }],
      codeContext: "",
      language: "kotlin",
      fetchImpl: strictWindowFetch
    });
    expect(geminiReply).toBe("Gemini response OK.");

    const prompt = buildSystemPromptWithContext("kotlin", "val state = MutableStateFlow(0)");
    expect(prompt).toContain(CODING_ONLY_SYSTEM_PROMPT);
    expect(prompt).toContain("trip planning");
    expect(prompt).toContain("Current editor language: kotlin");
    expect(prompt).toContain("val state = MutableStateFlow(0)");

    // Verify OpenCode (opencode.ai) headers and automatic fallback to OpenCode Go on auto-detect
    const calledUrls: string[] = [];
    const calledHeaders: Record<string, string>[] = [];
    const openCodeFetch: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      calledUrls.push(urlStr);
      calledHeaders.push((init?.headers as Record<string, string>) || {});

      if (urlStr.includes("/inference/openai/v1/chat/completions")) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: { message: "Subscription is OpenCode Go" } })
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "OpenCode Go response Ready." } }]
        })
      } as Response;
    };

    const openCodeReply = await sendCodingChatCompletion({
      apiKey: "oc_sk_live_12345",
      provider: "auto",
      roomId: "room-abc-123",
      messages: [{ id: "1", role: "user", content: "Explain coroutines", createdAt: 1 }],
      codeContext: "suspend fun run() {}",
      language: "kotlin",
      fetchImpl: openCodeFetch
    });

    expect(openCodeReply).toBe("OpenCode Go response Ready.");
    expect(calledUrls).toEqual([
      "https://opencode.ai/inference/openai/v1/chat/completions",
      "https://opencode.ai/inference/go/openai/v1/chat/completions"
    ]);
    expect(calledHeaders[0]["x-opencode-session"]).toBe("ses_room-abc-123");

    // Verify host-browser responder over Y.Doc (Y.Array("chat") + Y.Map("meta"))
    const doc = new Y.Doc();
    doc.getText("codemirror").insert(0, "fun add(a: Int, b: Int) = a + b");

    let capturedBody = "";
    const mockFetch: typeof fetch = async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Time complexity is O(1)." } }]
        })
      } as Response;
    };

    const detach = attachHostAiResponder(doc, "sk-proj-mock-host-key", mockFetch);
    const ymeta = doc.getMap<string>("meta");
    const ychat = doc.getArray<ChatMessage>("chat");

    expect(ymeta.get("aiEnabled")).toBe("true");
    expect(ymeta.get("aiProvider")).toBe("openai");

    // Any participant in the room pushes a question to Y.Array("chat")
    ychat.push([
      {
        id: "msg-1",
        role: "user",
        content: "What is the time complexity of add?",
        createdAt: Date.now()
      }
    ]);

    await waitForCondition(() => ychat.length === 2);

    const messages = ychat.toArray();
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Time complexity is O(1).");
    expect(capturedBody).toContain("fun add(a: Int, b: Int) = a + b");
    expect(ymeta.get("aiThinking")).toBe("false");

    detach();
    doc.destroy();
  });

  it("destroys room session on End session (FRAME_TYPE_DESTROY) and proxies opencode.ai via /api/ai-proxy", async () => {
    let upstreamHitUrl = "";
    let upstreamHitHeaders: Record<string, string> = {};

    const customRelay = createRelayServer({
      inMemory: true,
      fetchImpl: async (url: string, init: { headers?: Record<string, string> }) => {
        upstreamHitUrl = url;
        upstreamHitHeaders = init?.headers || {};
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content: "Proxied OpenCode answer" } }]
            })
        };
      }
    });

    await new Promise<void>((resolve) => {
      customRelay.server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = customRelay.server.address();
    const customHttpBase = `http://127.0.0.1:${addr.port}`;
    const customWsBase = `ws://127.0.0.1:${addr.port}/ws`;

    try {
      // 1. Test stateless /api/ai-proxy pass-through for opencode.ai
      const proxiedReply = await sendCodingChatCompletion({
        apiKey: "oc_sk_proxy_test",
        provider: "opencode",
        roomId: "testroom",
        messages: [{ id: "m1", role: "user", content: "Fix bug", createdAt: 1 }],
        codeContext: "val x = 1",
        language: "kotlin",
        proxyUrl: `${customHttpBase}/api/ai-proxy`
      });

      expect(proxiedReply).toBe("Proxied OpenCode answer");
      expect(upstreamHitUrl).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
      expect(upstreamHitHeaders["User-Agent"]).toBe("codemirror-agent/1.0");
      expect(upstreamHitHeaders["x-opencode-session"]).toBe("ses_testroom");

      // Disallowed SSRF host is rejected with 400
      const disallowedRes = await fetch(`${customHttpBase}/api/ai-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://evil.example.com/v1/chat", body: {} })
      });
      expect(disallowedRes.status).toBe(400);

      // 2. Test End Session room destruction (deletes room & notifies peers)
      const { roomId, hashKey } = await createSession();
      const key = await importKeyFromHash(hashKey);

      const docA = new Y.Doc();
      const docB = new Y.Doc();
      let peerBEnded = false;

      const providerA = new EncryptedWsProvider(docA, roomId, key, {
        wsUrl: customWsBase,
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket
      });
      const providerB = new EncryptedWsProvider(docB, roomId, key, {
        wsUrl: customWsBase,
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        onSessionEnded: () => {
          peerBEnded = true;
        }
      });

      await waitForCondition(
        () => providerA.getStatus() === "connected" && providerB.getStatus() === "connected"
      );

      docA.getText("codemirror").insert(0, "secret interview code");
      await providerA.flushSnapshotNow();
      await waitForCondition(() => docB.getText("codemirror").toString() === "secret interview code");

      // Verify room exists in store before End Session
      const storedBefore = await customRelay.store.getRoom(roomId);
      expect(storedBefore?.snapshot).toBeTruthy();

      // Host or participant clicks "End session" -> Confirm
      providerA.destroyRoom();

      await waitForCondition(() => peerBEnded);
      const storedAfter = await customRelay.store.getRoom(roomId);
      expect(storedAfter).toBeNull();
      expect(customRelay.rooms.has(roomId)).toBe(false);

      providerB.destroy();
      docA.destroy();
      docB.destroy();
    } finally {
      await new Promise<void>((resolve) => customRelay.server.close(() => resolve()));
    }
  });
});
