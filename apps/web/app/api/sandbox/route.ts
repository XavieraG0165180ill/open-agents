import { connectSandbox } from "@open-harness/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
} from "@/app/api/sessions/_lib/session-context";
import { getGitHubAccount } from "@/lib/db/accounts";
import { updateSession } from "@/lib/db/sessions";
import { parseGitHubUrl } from "@/lib/github/client";
import { getRepoToken } from "@/lib/github/get-repo-token";
import { getUserGitHubToken } from "@/lib/github/user-token";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "@/lib/sandbox/config";
import {
  ensureSessionSandbox,
  SessionSandboxEnsureError,
} from "@/lib/sandbox/ensure-session-sandbox";
import {
  canOperateOnSandbox,
  clearSandboxState,
  hasResumableSandboxState,
} from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

interface CreateSandboxRequest {
  repoUrl?: string;
  branch?: string;
  isNewBranch?: boolean;
  sessionId?: string;
  sandboxType?: "vercel";
}

export async function POST(req: Request) {
  let body: CreateSandboxRequest;
  try {
    body = (await req.json()) as CreateSandboxRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.sandboxType && body.sandboxType !== "vercel") {
    return Response.json({ error: "Invalid sandbox type" }, { status: 400 });
  }

  const { repoUrl, branch = "main", isNewBranch = false, sessionId } = body;

  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (sessionId) {
    const sessionContext = await requireOwnedSession({
      userId: session.user.id,
      sessionId,
    });
    if (!sessionContext.ok) {
      return sessionContext.response;
    }

    try {
      const { sandbox } = await ensureSessionSandbox({
        sessionId,
        sessionRecord: sessionContext.sessionRecord,
        user: {
          id: session.user.id,
          username: session.user.username,
          name: session.user.name,
          email: session.user.email,
        },
      });

      return Response.json({
        createdAt: Date.now(),
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        currentBranch: sandbox?.currentBranch,
        mode: "vercel",
      });
    } catch (error) {
      if (error instanceof SessionSandboxEnsureError) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      }

      console.error(
        `Failed to ensure sandbox for session ${sessionId}:`,
        error,
      );
      return Response.json(
        { error: "Failed to create sandbox" },
        { status: 500 },
      );
    }
  }

  let githubToken: string | null = null;
  if (repoUrl) {
    const parsedRepo = parseGitHubUrl(repoUrl);
    if (!parsedRepo) {
      return Response.json(
        { error: "Invalid GitHub repository URL" },
        { status: 400 },
      );
    }

    try {
      const tokenResult = await getRepoToken(session.user.id, parsedRepo.owner);
      githubToken = tokenResult.token;
    } catch {
      return Response.json(
        { error: "Connect GitHub to access repositories" },
        { status: 403 },
      );
    }
  } else {
    githubToken = await getUserGitHubToken();
  }

  const githubAccount = await getGitHubAccount(session.user.id);
  const githubNoreplyEmail =
    githubAccount?.externalUserId && githubAccount.username
      ? `${githubAccount.externalUserId}+${githubAccount.username}@users.noreply.github.com`
      : undefined;

  const sandbox = await connectSandbox({
    state: {
      type: "vercel",
      ...(repoUrl
        ? {
            source: {
              repo: repoUrl,
              branch: isNewBranch ? undefined : branch,
              newBranch: isNewBranch ? branch : undefined,
              token: githubToken ?? undefined,
            },
          }
        : {}),
    },
    options: {
      env: githubToken ? { GITHUB_TOKEN: githubToken } : undefined,
      gitUser: {
        name:
          session.user.name ?? githubAccount?.username ?? session.user.username,
        email:
          githubNoreplyEmail ??
          session.user.email ??
          `${session.user.username}@users.noreply.github.com`,
      },
      timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    },
  });

  return Response.json({
    createdAt: Date.now(),
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    currentBranch: sandbox.currentBranch,
    mode: "vercel",
  });
}

export async function DELETE(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("sessionId" in body) ||
    typeof (body as Record<string, unknown>).sessionId !== "string"
  ) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const { sessionId } = body as { sessionId: string };

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;

  if (!canOperateOnSandbox(sessionRecord.sandboxState)) {
    return Response.json({ success: true, alreadyStopped: true });
  }

  const sandbox = await connectSandbox(sessionRecord.sandboxState);
  await sandbox.stop();

  const clearedState = clearSandboxState(sessionRecord.sandboxState);
  await updateSession(sessionId, {
    sandboxState: clearedState,
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleState:
      hasResumableSandboxState(clearedState) || !!sessionRecord.snapshotUrl
        ? "hibernated"
        : "provisioning",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  });

  return Response.json({ success: true });
}
