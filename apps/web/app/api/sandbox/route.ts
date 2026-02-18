import { connectSandbox, type SandboxState } from "@open-harness/sandbox";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { parseGitHubUrl } from "@/lib/github/client";
import { getRepoToken } from "@/lib/github/get-repo-token";
import { getUserGitHubToken } from "@/lib/github/user-token";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "@/lib/sandbox/config";
import { createSandboxForSession } from "@/lib/sandbox/create";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import { canOperateOnSandbox, clearSandboxState } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

interface CreateSandboxRequest {
  repoUrl?: string;
  branch?: string;
  isNewBranch?: boolean;
  sessionId?: string;
  sandboxId?: string;
  sandboxType?: "hybrid" | "vercel" | "just-bash";
}

export async function POST(req: Request) {
  let body: CreateSandboxRequest;
  try {
    body = (await req.json()) as CreateSandboxRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    repoUrl,
    branch = "main",
    isNewBranch = false,
    sessionId,
    sandboxId: providedSandboxId,
    sandboxType = "hybrid",
  } = body;

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
  let sessionRecord;
  if (sessionId) {
    sessionRecord = await getSessionById(sessionId);
    if (!sessionRecord) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    if (sessionRecord.userId !== session.user.id) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const gitUser = {
    name: session.user.name ?? session.user.username,
    email:
      session.user.email ?? `${session.user.username}@users.noreply.vercel.app`,
  };

  const env: Record<string, string> = {};
  if (githubToken) {
    env.GITHUB_TOKEN = githubToken;
  }

  // ============================================
  // RECONNECT: Existing sandbox
  // ============================================
  if (providedSandboxId) {
    const sandbox = await connectSandbox({
      state: { type: "hybrid", sandboxId: providedSandboxId },
      options: { env },
    });

    if (sessionId && sandbox.getState) {
      const nextState = sandbox.getState() as SandboxState;
      await updateSession(sessionId, {
        sandboxState: nextState,
        lifecycleVersion: getNextLifecycleVersion(
          sessionRecord?.lifecycleVersion,
        ),
        ...buildActiveLifecycleUpdate(nextState),
      });
      kickSandboxLifecycleWorkflow({
        sessionId,
        reason: "sandbox-created",
      });
    }

    return Response.json({
      sandboxId: providedSandboxId,
      createdAt: Date.now(),
      timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
      currentBranch: sandbox.currentBranch,
      mode: "hybrid",
    });
  }

  // ============================================
  // NEW SANDBOX: Create based on sandboxType
  // ============================================
  if (!sessionId) {
    return Response.json(
      { error: "sessionId is required for sandbox creation" },
      { status: 400 },
    );
  }

  const result = await createSandboxForSession({
    repoUrl,
    branch,
    isNewBranch,
    sessionId,
    sandboxType,
    githubToken,
    gitUser,
  });

  return Response.json(result);
}

export async function DELETE(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
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

  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  if (sessionRecord.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  // If there's no sandbox to stop, return success (idempotent)
  if (!canOperateOnSandbox(sessionRecord.sandboxState)) {
    return Response.json({ success: true, alreadyStopped: true });
  }

  // Connect and stop using unified API
  const sandbox = await connectSandbox(sessionRecord.sandboxState);
  await sandbox.stop();

  await updateSession(sessionId, {
    sandboxState: clearSandboxState(sessionRecord.sandboxState),
    lifecycleState: sessionRecord.snapshotUrl ? "hibernated" : "provisioning",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  });

  return Response.json({ success: true });
}
