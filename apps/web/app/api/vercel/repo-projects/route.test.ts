import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

let session: {
  user: {
    id: string;
  };
} | null = null;
let token: string | null = null;
let savedLink: {
  projectId: string;
} | null = null;
let projects: Array<{
  projectId: string;
  projectName: string;
  teamId?: string | null;
  teamSlug?: string | null;
  teamName?: string | null;
}> = [];

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => session,
}));

mock.module("@/lib/vercel/token", () => ({
  getUserVercelToken: async () => token,
}));

mock.module("@/lib/db/vercel-project-links", () => ({
  getVercelProjectLinkForRepo: async () => savedLink,
}));

mock.module("@/lib/vercel/projects", () => ({
  listVercelProjectCandidatesForRepo: async () => projects,
  pickSelectedVercelProjectId: (
    candidates: Array<{ projectId: string }>,
    savedProjectId?: string | null,
  ) => {
    if (
      savedProjectId &&
      candidates.some((candidate) => candidate.projectId === savedProjectId)
    ) {
      return savedProjectId;
    }

    return candidates.length === 1 ? (candidates[0]?.projectId ?? null) : null;
  },
}));

const routeModulePromise = import("./route");

describe("/api/vercel/repo-projects", () => {
  beforeEach(() => {
    session = { user: { id: "user-1" } };
    token = "vca_test_token";
    savedLink = null;
    projects = [];
  });

  test("returns 401 when unauthenticated", async () => {
    session = null;

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request(
        "http://localhost/api/vercel/repo-projects?repoOwner=vercel&repoName=next.js",
      ),
    );

    expect(response.status).toBe(401);
  });

  test("returns the remembered project selection when it still matches", async () => {
    savedLink = { projectId: "prj_2" };
    projects = [
      {
        projectId: "prj_1",
        projectName: "alpha",
      },
      {
        projectId: "prj_2",
        projectName: "beta",
        teamId: "team_123",
        teamSlug: "acme",
        teamName: "Acme",
      },
    ];

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request(
        "http://localhost/api/vercel/repo-projects?repoOwner=vercel&repoName=next.js",
      ),
    );

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      projects: Array<{ projectId: string; isSavedDefault?: boolean }>;
      selectedProjectId: string | null;
    };

    expect(body.selectedProjectId).toBe("prj_2");
    expect(
      body.projects.find((project) => project.projectId === "prj_2"),
    ).toEqual(expect.objectContaining({ isSavedDefault: true }));
  });

  test("auto-selects the only matching project when there is no saved default", async () => {
    projects = [
      {
        projectId: "prj_1",
        projectName: "alpha",
      },
    ];

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request(
        "http://localhost/api/vercel/repo-projects?repoOwner=vercel&repoName=next.js",
      ),
    );

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      selectedProjectId: string | null;
    };

    expect(body.selectedProjectId).toBe("prj_1");
  });

  test("returns 401 when the Vercel token is unavailable", async () => {
    token = null;

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request(
        "http://localhost/api/vercel/repo-projects?repoOwner=vercel&repoName=next.js",
      ),
    );

    expect(response.status).toBe(401);
  });
});
