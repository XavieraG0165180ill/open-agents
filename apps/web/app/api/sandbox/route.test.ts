import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const ensureCalls: Array<Record<string, unknown>> = [];
const connectCalls: Array<Record<string, unknown>> = [];
let ensureError: Error | null = null;
let ensureResult = {
  sessionRecord: {
    id: "session-1",
    userId: "user-1",
    sandboxState: {
      type: "vercel",
      sandboxName: "session_session-1",
      expiresAt: Date.now() + 120_000,
    },
  },
  sandbox: {
    currentBranch: "main",
  },
};

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({
    user: {
      id: "user-1",
      username: "nico",
      name: "Nico",
      email: "nico@example.com",
    },
  }),
}));

mock.module("@/lib/db/accounts", () => ({
  getGitHubAccount: async () => ({
    externalUserId: "12345",
    username: "nico-gh",
  }),
}));

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireAuthenticatedUser: async () => ({ ok: true, userId: "user-1" }),
  requireOwnedSession: async () => ({
    ok: true,
    sessionRecord: {
      id: "session-1",
      userId: "user-1",
      sandboxState: { type: "vercel", sandboxName: "session_session-1" },
      snapshotUrl: null,
    },
  }),
}));

mock.module("@/lib/db/sessions", () => ({
  updateSession: async () => ({}),
}));

mock.module("@/lib/github/client", () => ({
  parseGitHubUrl: (repoUrl: string) => {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match?.[1] || !match[2]) {
      return null;
    }
    return { owner: match[1], repo: match[2] };
  },
}));

mock.module("@/lib/github/get-repo-token", () => ({
  getRepoToken: async () => ({ token: "github-token" }),
}));

mock.module("@/lib/github/user-token", () => ({
  getUserGitHubToken: async () => null,
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
      return ensureResult;
    },
  };
});

mock.module("@open-harness/sandbox", () => ({
  connectSandbox: async (config: Record<string, unknown>) => {
    connectCalls.push(config);
    return {
      currentBranch: "main",
      stop: async () => {},
    };
  },
}));

const routeModulePromise = import("./route");

describe("/api/sandbox POST", () => {
  beforeEach(() => {
    ensureCalls.length = 0;
    connectCalls.length = 0;
    ensureError = null;
    ensureResult = {
      sessionRecord: {
        id: "session-1",
        userId: "user-1",
        sandboxState: {
          type: "vercel",
          sandboxName: "session_session-1",
          expiresAt: Date.now() + 120_000,
        },
      },
      sandbox: {
        currentBranch: "main",
      },
    };
  });

  test("delegates session-backed creation to ensureSessionSandbox", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "vercel",
        }),
      }),
    );
    const body = (await response.json()) as {
      mode: string;
      currentBranch?: string;
    };

    expect(response.ok).toBe(true);
    expect(body.mode).toBe("vercel");
    expect(body.currentBranch).toBe("main");
    expect(ensureCalls).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        user: expect.objectContaining({ id: "user-1" }),
      }),
    ]);
    expect(connectCalls).toHaveLength(0);
  });

  test("propagates ensure helper status errors", async () => {
    const { POST } = await routeModulePromise;
    const { SessionSandboxEnsureError } =
      await import("@/lib/sandbox/ensure-session-sandbox");
    ensureError = new SessionSandboxEnsureError("Connect GitHub", 403);

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "vercel",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Connect GitHub" });
  });

  test("creates a non-session sandbox directly when sessionId is omitted", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/vercel/open-harness",
          sandboxType: "vercel",
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(connectCalls[0]).toMatchObject({
      state: {
        type: "vercel",
        source: {
          repo: "https://github.com/vercel/open-harness",
          branch: "main",
        },
      },
    });
  });

  test("rejects unsupported sandbox types", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "invalid",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid sandbox type",
    });
  });
});
