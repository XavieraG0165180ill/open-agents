import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("next/server", () => ({
  after: (task: Promise<unknown>) => {
    void Promise.resolve(task);
  },
}));

const updateSessionSpy = mock(async (_sessionId: string, patch: unknown) => ({
  id: "session-1",
  userId: "user-1",
  status: "running",
  ...(patch as Record<string, unknown>),
}));

mock.module("@/lib/db/sessions", () => ({
  deleteSession: async () => {},
  getSessionById: async () => ({
    id: "session-1",
    userId: "user-1",
    status: "running",
    snapshotUrl: null,
    sandboxState: null,
  }),
  updateSession: updateSessionSpy,
}));

mock.module("@/lib/sandbox/archive-session", () => ({
  archiveSession: async () => ({
    session: {
      id: "session-1",
      userId: "user-1",
      status: "archived",
    },
  }),
}));

mock.module("@/lib/sandbox/utils", () => ({
  hasRuntimeSandboxState: () => false,
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({
    user: {
      id: "user-1",
    },
  }),
}));

const routeModulePromise = import("./route");

function createRequest(body: unknown) {
  return new Request("http://localhost/api/sessions/session-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/sessions/[sessionId] PATCH", () => {
  beforeEach(() => {
    updateSessionSpy.mockClear();
  });

  test("rejects unknown fields in session updates", async () => {
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(
      createRequest({ sandboxState: { type: "vercel" } }),
      {
        params: Promise.resolve({ sessionId: "session-1" }),
      },
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid session update");
    expect(updateSessionSpy).not.toHaveBeenCalled();
  });

  test("accepts allowed session update fields", async () => {
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(createRequest({ title: "Renamed session" }), {
      params: Promise.resolve({ sessionId: "session-1" }),
    });
    const body = (await response.json()) as {
      session: { title: string };
    };

    expect(response.status).toBe(200);
    expect(updateSessionSpy).toHaveBeenCalledWith("session-1", {
      title: "Renamed session",
    });
    expect(body.session.title).toBe("Renamed session");
  });
});
