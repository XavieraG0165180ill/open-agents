import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CreateSessionInput } from "@/hooks/use-sessions";

let isAuthenticated = true;
let savedLink: {
  projectId: string;
  projectName: string;
  teamId?: string | null;
  teamSlug?: string | null;
} | null = null;
let createdSessionInput: Record<string, unknown> | null = null;
const upsertCalls: Array<Record<string, unknown>> = [];

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () =>
    isAuthenticated
      ? {
          user: {
            id: "user-1",
            username: "alice",
            name: "Alice",
            email: "alice@example.com",
          },
        }
      : null,
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => ({
    defaultModelId: "anthropic/claude-haiku-4.5",
  }),
}));

mock.module("@/lib/db/vercel-project-links", () => ({
  getVercelProjectLinkForRepo: async () => savedLink,
  upsertVercelProjectLink: async (input: Record<string, unknown>) => {
    upsertCalls.push(input);
    return {
      id: "link-1",
      ...input,
    };
  },
}));

mock.module("@/lib/db/sessions", () => ({
  createSessionWithInitialChat: async (input: {
    session: Record<string, unknown>;
    initialChat: Record<string, unknown>;
  }) => {
    createdSessionInput = input.session;

    return {
      session: input.session,
      chat: {
        id: input.initialChat.id,
        title: input.initialChat.title,
        modelId: input.initialChat.modelId,
      },
    };
  },
  getArchivedSessionCountByUserId: async () => 0,
  getSessionsWithUnreadByUserId: async () => [],
  getUsedSessionTitles: async () => new Set<string>(),
}));

const routeModulePromise = import("./route");

describe("/api/sessions POST Vercel project linking", () => {
  beforeEach(() => {
    isAuthenticated = true;
    savedLink = null;
    createdSessionInput = null;
    upsertCalls.length = 0;
  });

  test("persists an explicitly selected Vercel project and remembers the repo link", async () => {
    const body: CreateSessionInput = {
      title: "My Session",
      repoOwner: "vercel",
      repoName: "next.js",
      branch: "main",
      cloneUrl: "https://github.com/vercel/next.js",
      isNewBranch: false,
      sandboxType: "vercel",
      vercelProject: {
        projectId: "prj_123",
        projectName: "next-web",
        teamId: "team_123",
        teamSlug: "acme",
      },
    };

    const { POST } = await routeModulePromise;
    const response = await POST(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.ok).toBe(true);
    expect(createdSessionInput).toEqual(
      expect.objectContaining({
        vercelProjectId: "prj_123",
        vercelProjectName: "next-web",
        vercelTeamId: "team_123",
        vercelTeamSlug: "acme",
      }),
    );
    expect(upsertCalls).toEqual([
      expect.objectContaining({
        userId: "user-1",
        repoOwner: "vercel",
        repoName: "next.js",
        projectId: "prj_123",
        projectName: "next-web",
      }),
    ]);
  });

  test("uses the remembered Vercel project when the client omits a selection", async () => {
    savedLink = {
      projectId: "prj_saved",
      projectName: "saved-project",
      teamId: "team_saved",
      teamSlug: "saved-team",
    };

    const { POST } = await routeModulePromise;
    const response = await POST(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Saved link session",
          repoOwner: "vercel",
          repoName: "next.js",
          branch: "main",
          cloneUrl: "https://github.com/vercel/next.js",
          isNewBranch: false,
          sandboxType: "hybrid",
        } satisfies Omit<CreateSessionInput, "vercelProject">),
      }),
    );

    expect(response.ok).toBe(true);
    expect(createdSessionInput).toEqual(
      expect.objectContaining({
        vercelProjectId: "prj_saved",
        vercelProjectName: "saved-project",
        vercelTeamId: "team_saved",
        vercelTeamSlug: "saved-team",
      }),
    );
    expect(upsertCalls).toHaveLength(0);
  });

  test("respects an explicit null selection and skips remembered defaults", async () => {
    savedLink = {
      projectId: "prj_saved",
      projectName: "saved-project",
    };

    const { POST } = await routeModulePromise;
    const response = await POST(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "No link please",
          repoOwner: "vercel",
          repoName: "next.js",
          branch: "main",
          cloneUrl: "https://github.com/vercel/next.js",
          isNewBranch: false,
          sandboxType: "hybrid",
          vercelProject: null,
        } satisfies CreateSessionInput),
      }),
    );

    expect(response.ok).toBe(true);
    expect(createdSessionInput).toEqual(
      expect.objectContaining({
        vercelProjectId: undefined,
        vercelProjectName: undefined,
        vercelTeamId: null,
        vercelTeamSlug: null,
      }),
    );
    expect(upsertCalls).toHaveLength(0);
  });
});
