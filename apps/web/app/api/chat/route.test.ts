import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { assistantFileLinkPrompt } from "@/lib/assistant-file-links";

mock.module("server-only", () => ({}));

type TestSessionRecord = {
  id: string;
  userId: string;
  title: string;
  repoOwner: string | null;
  repoName: string | null;
  autoCommitPushOverride?: boolean | null;
  autoCreatePrOverride?: boolean | null;
  sandboxState: {
    type: "vercel";
    sandboxName?: string;
    expiresAt?: number;
  } | null;
};

type TestChatRecord = {
  sessionId: string;
  modelId: string | null;
  activeStreamId: string | null;
};

let authState:
  | { ok: true; userId: string }
  | { ok: false; response: Response } = {
  ok: true,
  userId: "user-1",
};
let sessionRecord: TestSessionRecord | null;
let chatRecord: TestChatRecord | null;
let parsedBodyOk = true;
let requireIdentifiersOk = true;
let existingRunStatus = "completed";
let getRunShouldThrow = false;
let compareAndSetDefaultResult = true;
let ensureError: Error | null = null;
let ensureCalls: Record<string, unknown>[] = [];
let startCalls: unknown[][] = [];
let preferencesState = {
  autoCommitPush: true,
  autoCreatePr: false,
  modelVariants: [],
};
let persistToolResultsCalls: unknown[][] = [];

const compareAndSetChatActiveStreamIdSpy = mock(
  async () => compareAndSetDefaultResult,
);
const originalFetch = globalThis.fetch;

globalThis.fetch = (async () => {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

mock.module("ai", () => ({
  createUIMessageStreamResponse: ({
    stream,
    headers,
  }: {
    stream: ReadableStream;
    headers?: Record<string, string>;
  }) => new Response(stream, { status: 200, headers }),
}));

mock.module("workflow/api", () => ({
  start: async (...args: unknown[]) => {
    startCalls.push(args);
    return {
      runId: "wrun_test-123",
      getReadable: () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
    };
  },
  getRun: () => {
    if (getRunShouldThrow) {
      throw new Error("Run not found");
    }

    return {
      status: Promise.resolve(existingRunStatus),
      getReadable: () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      cancel: () => Promise.resolve(),
    };
  },
}));

mock.module("@/app/workflows/chat", () => ({
  runAgentWorkflow: async () => {},
}));

mock.module("@/lib/chat/create-cancelable-readable-stream", () => ({
  createCancelableReadableStream: (stream: ReadableStream) => stream,
}));

mock.module("@/lib/db/sessions", () => ({
  compareAndSetChatActiveStreamId: compareAndSetChatActiveStreamIdSpy,
  createChatMessageIfNotExists: async () => undefined,
  getChatById: async () => chatRecord,
  isFirstChatMessage: async () => false,
  touchChat: async () => {},
  updateChat: async () => {},
  updateSession: async (_sessionId: string, patch: Record<string, unknown>) =>
    patch,
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => preferencesState,
}));

mock.module("@/lib/model-variants", () => ({
  getAllVariants: () => [],
}));

mock.module("./_lib/model-selection", () => ({
  resolveChatModelSelection: ({
    selectedModelId,
  }: {
    selectedModelId: string | null;
  }) => ({
    id: selectedModelId ?? "anthropic/claude-haiku-4.5",
  }),
}));

mock.module("./_lib/request", () => ({
  parseChatRequestBody: async (req: Request) => {
    if (!parsedBodyOk) {
      return {
        ok: false,
        response: Response.json(
          { error: "Invalid JSON body" },
          { status: 400 },
        ),
      };
    }

    return {
      ok: true,
      body: (await req.json()) as {
        sessionId: string;
        chatId: string;
        messages: Array<unknown>;
      },
    };
  },
  requireChatIdentifiers: (body: Record<string, unknown>) => {
    if (!requireIdentifiersOk) {
      return {
        ok: false,
        response: Response.json(
          { error: "sessionId and chatId are required" },
          { status: 400 },
        ),
      };
    }

    return {
      ok: true,
      sessionId: String(body.sessionId),
      chatId: String(body.chatId),
    };
  },
}));

mock.module("./_lib/chat-context", () => ({
  requireAuthenticatedUser: async () => authState,
  requireOwnedSessionChat: async () => {
    if (!sessionRecord) {
      return {
        ok: false,
        response: Response.json(
          { error: "Session not found" },
          { status: 404 },
        ),
      };
    }
    if (sessionRecord.userId !== "user-1") {
      return {
        ok: false,
        response: Response.json({ error: "Unauthorized" }, { status: 403 }),
      };
    }
    if (!chatRecord) {
      return {
        ok: false,
        response: Response.json({ error: "Chat not found" }, { status: 404 }),
      };
    }

    return {
      ok: true,
      sessionRecord,
      chat: chatRecord,
    };
  },
}));

mock.module("./_lib/runtime", () => ({
  createChatRuntime: async () => ({
    sandbox: {
      workingDirectory: "/vercel/sandbox",
      currentBranch: "main",
      environmentDetails: null,
    },
    skills: [],
  }),
}));

mock.module("@/lib/sandbox/lifecycle", () => ({
  buildActiveLifecycleUpdate: () => ({}),
}));

mock.module("@/lib/sandbox/ensure-session-sandbox", () => {
  class SessionSandboxEnsureError extends Error {
    status: number;

    constructor(message: string, status = 500) {
      super(message);
      this.name = "SessionSandboxEnsureError";
      this.status = status;
    }
  }

  return {
    SessionSandboxEnsureError,
    ensureSessionSandbox: async (input: Record<string, unknown>) => {
      ensureCalls.push(input);
      if (ensureError) {
        throw ensureError;
      }
      return {
        sessionRecord,
        sandbox: null,
      };
    },
  };
});

mock.module("./_lib/persist-tool-results", () => ({
  persistAssistantMessagesWithToolResults: async (...args: unknown[]) => {
    persistToolResultsCalls.push(args);
  },
}));

const routeModulePromise = import("./route");

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function createValidRequest() {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "session-1",
      chatId: "chat-1",
      messages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Fix the bug" }],
        },
      ],
    }),
  });
}

describe("/api/chat route", () => {
  beforeEach(() => {
    authState = { ok: true, userId: "user-1" };
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      title: "Session title",
      repoOwner: "acme",
      repoName: "repo",
      autoCommitPushOverride: null,
      autoCreatePrOverride: null,
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
    };
    chatRecord = {
      sessionId: "session-1",
      modelId: null,
      activeStreamId: null,
    };
    parsedBodyOk = true;
    requireIdentifiersOk = true;
    existingRunStatus = "completed";
    getRunShouldThrow = false;
    compareAndSetDefaultResult = true;
    ensureError = null;
    ensureCalls = [];
    startCalls = [];
    preferencesState = {
      autoCommitPush: true,
      autoCreatePr: false,
      modelVariants: [],
    };
    persistToolResultsCalls = [];
    compareAndSetChatActiveStreamIdSpy.mockClear();
  });

  test("starts a workflow after ensuring the sandbox", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.ok).toBe(true);
    expect(response.headers.get("x-workflow-run-id")).toBe("wrun_test-123");
    expect(ensureCalls).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        user: { id: "user-1" },
      }),
    ]);
    expect(startCalls[0]?.[1]).toEqual([
      expect.objectContaining({
        maxSteps: 500,
        agentOptions: expect.objectContaining({
          customInstructions: assistantFileLinkPrompt,
        }),
      }),
    ]);
  });

  test("passes autoCreatePrEnabled when auto commit and auto PR are enabled", async () => {
    const { POST } = await routeModulePromise;
    preferencesState.autoCreatePr = true;

    const response = await POST(createValidRequest());

    expect(response.ok).toBe(true);
    expect(startCalls[0]?.[1]).toEqual([
      expect.objectContaining({
        autoCommitEnabled: true,
        autoCreatePrEnabled: true,
      }),
    ]);
  });

  test("returns 401 when not authenticated", async () => {
    authState = {
      ok: false,
      response: Response.json({ error: "Not authenticated" }, { status: 401 }),
    };
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Not authenticated",
    });
  });

  test("returns 404 when session does not exist", async () => {
    sessionRecord = null;
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Session not found",
    });
  });

  test("returns ensure-helper errors before starting the workflow", async () => {
    const { POST } = await routeModulePromise;
    const { SessionSandboxEnsureError } =
      await import("@/lib/sandbox/ensure-session-sandbox");
    ensureError = new SessionSandboxEnsureError("Connect GitHub", 403);

    const response = await POST(createValidRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Connect GitHub" });
    expect(startCalls).toHaveLength(0);
  });

  test("reconnects to an existing running workflow instead of starting a new one", async () => {
    if (!chatRecord) {
      throw new Error("chatRecord must be set");
    }
    chatRecord.activeStreamId = "wrun_existing-456";
    existingRunStatus = "running";
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.ok).toBe(true);
    expect(response.headers.get("x-workflow-run-id")).toBe("wrun_existing-456");
    expect(startCalls).toHaveLength(0);
  });

  test("returns 409 when the active stream CAS is lost", async () => {
    compareAndSetDefaultResult = false;
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Another workflow is already running for this chat",
    });
  });

  test("persists assistant tool results on submit", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.ok).toBe(true);
    expect(persistToolResultsCalls).toEqual([["chat-1", expect.any(Array)]]);
  });
});
