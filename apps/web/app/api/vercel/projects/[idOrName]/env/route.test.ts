import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

let session: { user?: { id: string } } | undefined;
let vercelToken: string | null;
let upstreamStatus: number;
let upstreamStatusText: string;
let upstreamBody: string;
let upstreamContentType: string | null;
let fetchError: Error | null;

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => session,
}));

mock.module("@/lib/vercel/token", () => ({
  getUserVercelToken: async (_userId: string) => vercelToken,
}));

const routeModulePromise = import("./route");

describe("/api/vercel/projects/[idOrName]/env", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    session = { user: { id: "user-1" } };
    vercelToken = "vca_test_token";
    upstreamStatus = 200;
    upstreamStatusText = "OK";
    upstreamBody = JSON.stringify({
      envs: [{ id: "env_1", key: "MY_ENV", value: "redacted" }],
    });
    upstreamContentType = "application/json; charset=utf-8";
    fetchError = null;

    console.error = mock(() => {}) as typeof console.error;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: getRequestUrl(input), init });

      if (fetchError) {
        return Promise.reject(fetchError);
      }

      const headers = upstreamContentType
        ? { "Content-Type": upstreamContentType }
        : undefined;

      return Promise.resolve(
        new Response(upstreamBody, {
          status: upstreamStatus,
          statusText: upstreamStatusText,
          headers,
        }),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
  });

  test("returns 401 when the user is not authenticated", async () => {
    session = undefined;

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request("http://localhost/api/vercel/projects/my-project/env"),
      { params: Promise.resolve({ idOrName: "my-project" }) },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
    expect(fetchCalls).toHaveLength(0);
  });

  test("returns 401 when no Vercel token is available", async () => {
    vercelToken = null;

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request("http://localhost/api/vercel/projects/my-project/env"),
      { params: Promise.resolve({ idOrName: "my-project" }) },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Vercel not connected" });
    expect(fetchCalls).toHaveLength(0);
  });

  test("forwards the request to Vercel with the stored access token", async () => {
    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request(
        "http://localhost/api/vercel/projects/my-project/env?gitBranch=feature%2Ftest&decrypt=true&teamId=team_123&unknown=value",
      ),
      { params: Promise.resolve({ idOrName: "my-project" }) },
    );

    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      "https://api.vercel.com/v10/projects/my-project/env?gitBranch=feature%2Ftest&decrypt=true&teamId=team_123",
    );

    const headers = new Headers(fetchCalls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer vca_test_token");
    expect(fetchCalls[0]?.init?.cache).toBe("no-store");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await response.json()).toEqual({
      envs: [{ id: "env_1", key: "MY_ENV", value: "redacted" }],
    });
  });

  test("passes through upstream API errors for permission debugging", async () => {
    upstreamStatus = 403;
    upstreamStatusText = "Forbidden";
    upstreamBody = JSON.stringify({ error: { code: "forbidden" } });

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request("http://localhost/api/vercel/projects/my-project/env"),
      { params: Promise.resolve({ idOrName: "my-project" }) },
    );

    expect(response.status).toBe(403);
    expect(response.statusText).toBe("Forbidden");
    expect(await response.json()).toEqual({ error: { code: "forbidden" } });
  });

  test("returns 500 when the upstream request throws", async () => {
    fetchError = new Error("network down");

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request("http://localhost/api/vercel/projects/my-project/env"),
      { params: Promise.resolve({ idOrName: "my-project" }) },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to fetch Vercel project environment variables",
    });
  });
});
