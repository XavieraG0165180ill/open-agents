import { connectSandbox, type SandboxState } from "@open-harness/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
  type SessionRecord,
} from "@/app/api/sessions/_lib/session-context";
import { getGitHubAccount } from "@/lib/db/accounts";
import { updateSession } from "@/lib/db/sessions";
import { parseGitHubUrl } from "@/lib/github/client";
import { getRepoToken } from "@/lib/github/get-repo-token";
import { getUserGitHubToken } from "@/lib/github/user-token";
import {
  DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  getVercelCliSandboxSetup,
  syncVercelCliAuthToSandbox,
} from "@/lib/sandbox/vercel-cli-auth";
import { installGlobalSkills } from "@/lib/skills/global-skill-installer";
import {
  canOperateOnSandbox,
  clearSandboxState,
  hasResumableSandboxState,
  isSandboxUnavailableError,
} from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";
import { buildDevelopmentDotenvFromVercelProject } from "@/lib/vercel/projects";
import { getUserVercelToken } from "@/lib/vercel/token";

interface CreateSandboxRequest {
  repoUrl?: string;
  branch?: string;
  isNewBranch?: boolean;
  sessionId?: string;
  sandboxType?: "vercel";
}

function getSessionSandboxName(sessionId: string): string {
  return `session_${sessionId}`;
}

function isSandboxNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("sandbox not found") ||
    normalized.includes("status code 404") ||
    normalized.includes("status code 410")
  );
}

async function syncVercelProjectEnvVarsToSandbox(params: {
  userId: string;
  sessionRecord: SessionRecord;
  sandbox: Awaited<ReturnType<typeof connectSandbox>>;
}): Promise<void> {
  if (!params.sessionRecord.vercelProjectId) {
    return;
  }

  const token = await getUserVercelToken(params.userId);
  if (!token) {
    return;
  }

  const dotenvContent = await buildDevelopmentDotenvFromVercelProject({
    token,
    projectIdOrName: params.sessionRecord.vercelProjectId,
    teamId: params.sessionRecord.vercelTeamId,
  });
  if (!dotenvContent) {
    return;
  }

  await params.sandbox.writeFile(
    `${params.sandbox.workingDirectory}/.env.local`,
    dotenvContent,
    "utf-8",
  );
}

async function syncVercelCliAuthForSandbox(params: {
  userId: string;
  sessionRecord: SessionRecord;
  sandbox: Awaited<ReturnType<typeof connectSandbox>>;
}): Promise<void> {
  const setup = await getVercelCliSandboxSetup({
    userId: params.userId,
    sessionRecord: params.sessionRecord,
  });

  await syncVercelCliAuthToSandbox({
    sandbox: params.sandbox,
    setup,
  });
}

async function installSessionGlobalSkills(params: {
  sessionRecord: SessionRecord;
  sandbox: Awaited<ReturnType<typeof connectSandbox>>;
}): Promise<void> {
  const globalSkillRefs = params.sessionRecord.globalSkillRefs ?? [];
  if (globalSkillRefs.length === 0) {
    return;
  }

  await installGlobalSkills({
    sandbox: params.sandbox,
    globalSkillRefs,
  });
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

  // Get session for auth
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
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

  // Validate session ownership
  let sessionRecord: SessionRecord | undefined;
  if (sessionId) {
    const sessionContext = await requireOwnedSession({
      userId: session.user.id,
      sessionId,
    });
    if (!sessionContext.ok) {
      return sessionContext.response;
    }

    sessionRecord = sessionContext.sessionRecord;
  }

  const githubAccount = await getGitHubAccount(session.user.id);
  const githubNoreplyEmail =
    githubAccount?.externalUserId && githubAccount.username
      ? `${githubAccount.externalUserId}+${githubAccount.username}@users.noreply.github.com`
      : undefined;

  const gitUser = {
    name: session.user.name ?? githubAccount?.username ?? session.user.username,
    email:
      githubNoreplyEmail ??
      session.user.email ??
      `${session.user.username}@users.noreply.github.com`,
  };

  const env: Record<string, string> = {};
  if (githubToken) {
    env.GITHUB_TOKEN = githubToken;
  }

  const startTime = Date.now();
  const sessionSandboxName = sessionId
    ? getSessionSandboxName(sessionId)
    : undefined;

  const source = repoUrl
    ? {
        repo: repoUrl,
        branch: isNewBranch ? undefined : branch,
        newBranch: isNewBranch ? branch : undefined,
        token: githubToken ?? undefined,
      }
    : undefined;

  let sandbox: Awaited<ReturnType<typeof connectSandbox>> | null = null;
  let resumedExistingSandbox = false;

  if (sessionSandboxName) {
    try {
      sandbox = await connectSandbox({
        state: { type: "vercel", sandboxName: sessionSandboxName },
        options: {
          env,
          ports: DEFAULT_SANDBOX_PORTS,
          resume: true,
        },
      });
      resumedExistingSandbox = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isSandboxNotFoundError(message)) {
        throw error;
      }
    }
  }

  if (!sandbox) {
    sandbox = await connectSandbox({
      state: {
        type: "vercel",
        ...(sessionSandboxName ? { sandboxName: sessionSandboxName } : {}),
        source,
      },
      options: {
        env,
        gitUser,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        ports: DEFAULT_SANDBOX_PORTS,
        baseSnapshotId: DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
      },
    });
  }

  if (sessionId && sandbox.getState) {
    const nextState = sandbox.getState() as SandboxState;
    await updateSession(sessionId, {
      sandboxState: nextState,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(
        sessionRecord?.lifecycleVersion,
      ),
      ...buildActiveLifecycleUpdate(nextState),
    });

    if (sessionRecord) {
      if (!resumedExistingSandbox) {
        try {
          await syncVercelProjectEnvVarsToSandbox({
            userId: session.user.id,
            sessionRecord,
            sandbox,
          });
        } catch (error) {
          console.error(
            `Failed to sync Vercel env vars for session ${sessionRecord.id}:`,
            error,
          );
        }
      }

      try {
        await syncVercelCliAuthForSandbox({
          userId: session.user.id,
          sessionRecord,
          sandbox,
        });
      } catch (error) {
        console.error(
          `Failed to prepare Vercel CLI auth for session ${sessionRecord.id}:`,
          error,
        );
      }

      if (!resumedExistingSandbox) {
        try {
          await installSessionGlobalSkills({
            sessionRecord,
            sandbox,
          });
        } catch (error) {
          console.error(
            `Failed to install global skills for session ${sessionRecord.id}:`,
            error,
          );
        }
      }
    }

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "sandbox-created",
    });
  }

  const readyMs = Date.now() - startTime;

  return Response.json({
    createdAt: Date.now(),
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    currentBranch: sandbox.currentBranch,
    mode: "vercel",
    timing: { readyMs },
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

  // If there's no sandbox to stop, return success (idempotent)
  if (!canOperateOnSandbox(sessionRecord.sandboxState)) {
    return Response.json({ success: true, alreadyStopped: true });
  }

  // Connect and stop using unified API
  try {
    const sandbox = await connectSandbox(sessionRecord.sandboxState);
    await sandbox.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isSandboxUnavailableError(message)) {
      throw error;
    }
  }

  const clearedState = clearSandboxState(sessionRecord.sandboxState);
  const canResume =
    hasResumableSandboxState(clearedState) ||
    Boolean(sessionRecord.snapshotUrl);

  await updateSession(sessionId, {
    sandboxState: clearedState,
    snapshotUrl: hasResumableSandboxState(clearedState)
      ? null
      : sessionRecord.snapshotUrl,
    snapshotCreatedAt: hasResumableSandboxState(clearedState)
      ? null
      : sessionRecord.snapshotCreatedAt,
    lifecycleState: canResume ? "hibernated" : "provisioning",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  });

  return Response.json({ success: true });
}
