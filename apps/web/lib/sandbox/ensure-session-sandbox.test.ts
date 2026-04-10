import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const claimCalls: Array<Record<string, unknown>> = [];
const releaseCalls: Array<Record<string, unknown>> = [];
const updateCalls: Array<Record<string, unknown>> = [];
const connectCalls: Array<Record<string, unknown>> = [];
const kickCalls: Array<Record<string, unknown>> = [];

let sessionRecord: Record<string, unknown> | null;
let shouldClaimLease = true;
let repoToken: string | null = "github-token";

mock.module("@/lib/db/accounts", () => ({
  getGitHubAccount: async () => ({
    externalUserId: "12345",
    username: "nico-gh",
  }),
}));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => sessionRecord,
  claimSessionSandboxEnsureLease: async (
    sessionId: string,
    leaseId: string,
    expiresAt: Date,
  ) => {
    claimCalls.push({ sessionId, leaseId, expiresAt });
    if (!shouldClaimLease) {
      return false;
    }
    sessionRecord = {
      ...sessionRecord,
      sandboxEnsureLeaseId: leaseId,
      sandboxEnsureLeaseExpiresAt: expiresAt,
    };
    return true;
  },
  releaseSessionSandboxEnsureLease: async (
    sessionId: string,
    leaseId: string,
  ) => {
    releaseCalls.push({ sessionId, leaseId });
    sessionRecord = {
      ...sessionRecord,
      sandboxEnsureLeaseId: null,
      sandboxEnsureLeaseExpiresAt: null,
    };
    return true;
  },
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push({ sessionId, patch });
    sessionRecord = { ...sessionRecord, ...patch };
    return sessionRecord;
  },
}));

mock.module("@/lib/github/client", () => ({
  parseGitHubUrl: () => ({ owner: "vercel", repo: "open-harness" }),
}));

mock.module("@/lib/github/get-repo-token", () => ({
  getRepoToken: async () => {
    if (!repoToken) {
      throw new Error("missing token");
    }
    return { token: repoToken };
  },
}));

mock.module("@/lib/github/user-token", () => ({
  getUserGitHubToken: async () => repoToken,
}));

mock.module("@/lib/vercel/token", () => ({
  getUserVercelToken: async () => "vercel-token",
}));

mock.module("@/lib/vercel/projects", () => ({
  buildDevelopmentDotenvFromVercelProject: async () => null,
}));

mock.module("@/lib/sandbox/vercel-cli-auth", () => ({
  getVercelCliSandboxSetup: async () => ({ auth: null, projectLink: null }),
  syncVercelCliAuthToSandbox: async () => {},
}));

mock.module("@/lib/skills/global-skill-installer", () => ({
  installGlobalSkills: async () => {},
}));

mock.module("@/lib/sandbox/lifecycle", () => ({
  buildActiveLifecycleUpdate: () => ({ lifecycleState: "active" }),
  getNextLifecycleVersion: (currentVersion: number | null | undefined) =>
    (currentVersion ?? 0) + 1,
}));

mock.module("@/lib/sandbox/lifecycle-kick", () => ({
  kickSandboxLifecycleWorkflow: (input: Record<string, unknown>) => {
    kickCalls.push(input);
  },
}));

mock.module("@open-harness/sandbox", () => ({
  connectSandbox: async (config: Record<string, unknown>) => {
    connectCalls.push(config);
    return {
      currentBranch: "main",
      workingDirectory: "/vercel/sandbox",
      writeFile: async () => {},
      getState: () => ({
        type: "vercel",
        sandboxName: "session_session-1",
        expiresAt: Date.now() + 120_000,
      }),
    };
  },
}));

const ensureModulePromise = import("./ensure-session-sandbox");

describe("ensureSessionSandbox", () => {
  beforeEach(() => {
    claimCalls.length = 0;
    releaseCalls.length = 0;
    updateCalls.length = 0;
    connectCalls.length = 0;
    kickCalls.length = 0;
    shouldClaimLease = true;
    repoToken = "github-token";
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      title: "Session title",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
      repoOwner: "vercel",
      repoName: "open-harness",
      branch: "main",
      cloneUrl: "https://github.com/vercel/open-harness",
      isNewBranch: false,
      autoCommitPushOverride: null,
      autoCreatePrOverride: null,
      vercelProjectId: null,
      vercelProjectName: null,
      vercelTeamId: null,
      vercelTeamSlug: null,
      globalSkillRefs: [],
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      lifecycleState: "provisioning",
      lifecycleVersion: 3,
      lastActivityAt: null,
      sandboxExpiresAt: null,
      hibernateAfter: null,
      lifecycleRunId: null,
      lifecycleError: null,
      sandboxEnsureLeaseId: null,
      sandboxEnsureLeaseExpiresAt: null,
      linesAdded: 0,
      linesRemoved: 0,
      prNumber: null,
      prStatus: null,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      snapshotSizeBytes: null,
      cachedDiff: null,
      cachedDiffUpdatedAt: null,
    };
  });

  test("returns immediately when the sandbox is already active", async () => {
    const { ensureSessionSandbox } = await ensureModulePromise;

    sessionRecord = {
      ...sessionRecord,
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
        expiresAt: Date.now() + 120_000,
      },
    };

    const result = await ensureSessionSandbox({
      sessionId: "session-1",
      sessionRecord: sessionRecord as never,
      user: { id: "user-1" },
    });

    expect(result.sandbox).toBeNull();
    expect(claimCalls).toHaveLength(0);
    expect(connectCalls).toHaveLength(0);
  });

  test("claims the lease, connects the named sandbox, and persists refreshed state", async () => {
    const { ensureSessionSandbox } = await ensureModulePromise;

    const result = await ensureSessionSandbox({
      sessionId: "session-1",
      sessionRecord: sessionRecord as never,
      user: { id: "user-1", username: "nico" },
    });

    expect(result.sessionRecord.sandboxState).toMatchObject({
      sandboxName: "session_session-1",
    });
    expect(claimCalls).toHaveLength(1);
    expect(connectCalls[0]).toMatchObject({
      state: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      options: {
        persistent: true,
        resume: true,
        createIfMissing: true,
      },
    });
    expect(updateCalls).toHaveLength(1);
    expect(releaseCalls).toHaveLength(1);
    expect(kickCalls).toEqual([
      { sessionId: "session-1", reason: "sandbox-created" },
    ]);
  });

  test("throws a 403 error when repository access is unavailable", async () => {
    const { ensureSessionSandbox, SessionSandboxEnsureError } =
      await ensureModulePromise;

    repoToken = null;

    await expect(
      ensureSessionSandbox({
        sessionId: "session-1",
        sessionRecord: sessionRecord as never,
        user: { id: "user-1" },
      }),
    ).rejects.toBeInstanceOf(SessionSandboxEnsureError);

    await expect(
      ensureSessionSandbox({
        sessionId: "session-1",
        sessionRecord: sessionRecord as never,
        user: { id: "user-1" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
