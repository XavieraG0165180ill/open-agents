import { beforeEach, describe, expect, mock, test } from "bun:test";

const execSpy = mock(async (command: string) => {
  if (command === "ls -A") {
    return { success: true, stdout: "README.md\n" };
  }

  if (command === "git rev-parse --git-dir") {
    return { success: true, stdout: ".git" };
  }

  if (command === "git add -A") {
    return { success: true, stdout: "" };
  }

  if (command === "git diff --cached --stat") {
    return { success: true, stdout: " README.md | 1 +\n" };
  }

  if (command.startsWith("git config user.name")) {
    return { success: true, stdout: "" };
  }

  if (command.startsWith("git config user.email")) {
    return { success: true, stdout: "" };
  }

  if (command.startsWith("git remote remove origin")) {
    return { success: true, stdout: "" };
  }

  if (command.startsWith("git remote add origin")) {
    return { success: true, stdout: "" };
  }

  if (command.startsWith("git commit -m")) {
    return { success: true, stdout: "[main abc123] feat: initial commit" };
  }

  if (command === "git branch -M main") {
    return { success: true, stdout: "" };
  }

  if (command === "git push -u origin main") {
    return {
      success: false,
      stdout: "",
      stderr:
        "fatal: unable to access https://x-access-token:ghp_secret@github.com/acme/demo.git",
    };
  }

  return { success: true, stdout: "" };
});

mock.module("ai", () => ({
  gateway: () => "mock-model",
  generateText: async () => ({ text: "feat: initial commit" }),
}));

mock.module("@/lib/db/accounts", () => ({
  getGitHubAccount: async () => null,
}));

mock.module("@/lib/github/client", () => ({
  createRepository: async () => ({
    success: true,
    cloneUrl: "https://github.com/acme/demo.git",
    repoUrl: "https://github.com/acme/demo",
    owner: "acme",
    repoName: "demo",
  }),
}));

const modulePromise = import("./create-repo-workflow");

describe("runCreateRepoWorkflow", () => {
  beforeEach(() => {
    execSpy.mockClear();
  });

  test("redacts tokens from push failure responses", async () => {
    const { runCreateRepoWorkflow } = await modulePromise;

    const result = await runCreateRepoWorkflow({
      sandbox: {
        exec: execSpy,
      } as never,
      cwd: "/vercel/sandbox",
      repoName: "demo",
      sessionTitle: "Create demo repo",
      owner: "acme",
      accountType: "User",
      repoToken: "ghp_secret",
      installationToken: null,
      sessionUser: {
        id: "user-1",
        username: "octocat",
        name: "Octo Cat",
        email: "octocat@example.com",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected workflow to fail");
    }

    const body = (await result.response.json()) as { error: string };
    expect(body.error).toContain(
      "https://x-access-token:***@github.com/acme/demo.git",
    );
    expect(body.error).not.toContain("ghp_secret");
  });
});
