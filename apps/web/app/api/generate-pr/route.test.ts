import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

let rateLimitAllowed = true;

const takeRateLimitSpy = mock(async () => ({
  allowed: rateLimitAllowed,
  limit: 10,
  remaining: rateLimitAllowed ? 9 : 0,
  retryAfterSeconds: 60,
}));

mock.module("@open-harness/sandbox", () => ({
  connectSandbox: async () => ({
    workingDirectory: "/vercel/sandbox",
    exec: async () => ({ success: true, stdout: "", stderr: "" }),
  }),
}));

mock.module("ai", () => ({
  gateway: () => "mock-model",
  generateText: async () => ({ text: "feat: test" }),
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({
    user: {
      id: "user-1",
      username: "octocat",
      name: "Octo Cat",
    },
  }),
}));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => ({
    id: "session-1",
    userId: "user-1",
    sandboxState: { type: "vercel" },
    repoOwner: "acme",
    repoName: "repo",
  }),
  updateSession: async () => ({}),
}));

mock.module("@/lib/sandbox/utils", () => ({
  isSandboxActive: () => true,
}));

mock.module("@/lib/rate-limit", () => ({
  takeRateLimit: takeRateLimitSpy,
  createRateLimitResponse: (_result: unknown, message?: string) =>
    Response.json(
      { error: message ?? "Too many requests. Please try again later." },
      { status: 429 },
    ),
}));

mock.module("@/app/api/generate-pr/_lib/generate-pr-helpers", () => ({
  ensureForkExists: async () => ({ success: true, forkRepoName: "repo" }),
  extractGitHubOwnerFromRemoteUrl: () => "acme",
  forkPushRetryConfig: { attempts: 1, delayMs: 1 },
  generateBranchName: () => "oc/test-branch",
  isPermissionPushError: () => false,
  isRetryableForkPushError: () => false,
  looksLikeCommitHash: () => false,
  redactGitHubToken: (text: string) => text,
  sleepForForkRetry: async () => {},
}));

mock.module("@/lib/db/accounts", () => ({
  getGitHubAccount: async () => null,
}));

mock.module("@/lib/github/get-repo-token", () => ({
  getRepoToken: async () => ({ token: "ghp_test", type: "user" as const }),
}));

mock.module("@/lib/git/pr-content", () => ({
  generatePullRequestContentFromSandbox: async () => ({
    success: true,
    title: "PR title",
    body: "PR body",
  }),
}));

mock.module("@/lib/github/user-token", () => ({
  getUserGitHubToken: async () => null,
}));

const routeModulePromise = import("./route");

function createRequest() {
  return new Request("http://localhost/api/generate-pr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "session-1",
      sessionTitle: "Fix bug",
      baseBranch: "main",
      branchName: "feature/test",
    }),
  });
}

describe("/api/generate-pr route", () => {
  beforeEach(() => {
    rateLimitAllowed = true;
    takeRateLimitSpy.mockClear();
  });

  test("rate limits expensive generate-pr requests", async () => {
    const { POST } = await routeModulePromise;
    rateLimitAllowed = false;

    const response = await POST(createRequest());
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(429);
    expect(body.error).toBe(
      "Too many pull request generation requests. Please wait and try again.",
    );
    expect(takeRateLimitSpy).toHaveBeenCalledTimes(1);
  });
});
