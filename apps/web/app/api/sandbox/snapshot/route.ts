import { connectSandbox } from "@open-harness/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
  requireOwnedSessionWithSandboxGuard,
} from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import {
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  buildHibernatedLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  canOperateOnSandbox,
  clearSandboxState,
  getPersistentSandboxName,
  hasResumableSandboxState,
  hasRuntimeSandboxState,
} from "@/lib/sandbox/utils";

interface CreateSnapshotRequest {
  sessionId: string;
}

interface RestoreSnapshotRequest {
  sessionId: string;
}

function getSessionSandboxName(sessionId: string): string {
  return `session_${sessionId}`;
}

function isResumeTargetMissingError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("sandbox not found") ||
    normalized.includes("status code 404") ||
    normalized.includes("status code 410")
  );
}

/**
 * POST - Pause the current sandbox session while preserving any durable persistent sandbox identity.
 */
export async function POST(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: CreateSnapshotRequest;
  try {
    body = (await req.json()) as CreateSnapshotRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSessionWithSandboxGuard({
    userId: authResult.userId,
    sessionId,
    sandboxGuard: canOperateOnSandbox,
    sandboxErrorMessage: "Sandbox not initialized",
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;
  const sandboxState = sessionRecord.sandboxState;
  if (!sandboxState) {
    return Response.json({ error: "Sandbox not initialized" }, { status: 400 });
  }

  try {
    const sandbox = await connectSandbox(sandboxState);
    await sandbox.stop();

    const clearedState = clearSandboxState(sessionRecord.sandboxState);
    const preservesPersistentSandbox = hasResumableSandboxState(clearedState);

    await updateSession(sessionId, {
      snapshotUrl: preservesPersistentSandbox
        ? null
        : sessionRecord.snapshotUrl,
      snapshotCreatedAt: preservesPersistentSandbox
        ? null
        : sessionRecord.snapshotCreatedAt,
      sandboxState: clearedState,
      lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
      ...buildHibernatedLifecycleUpdate(),
    });

    return Response.json({
      createdAt: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Failed to pause sandbox: ${message}` },
      { status: 500 },
    );
  }
}

/**
 * PUT - Restore a snapshot by creating a new sandbox from it.
 */
export async function PUT(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: RestoreSnapshotRequest;
  try {
    body = (await req.json()) as RestoreSnapshotRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;

  // If archive finalization is still running, return 409 until the background
  // task either stores a snapshot or clears runtime sandbox state after a
  // recoverable archive failure.
  if (!sessionRecord.sandboxState) {
    console.error(
      `[Snapshot Restore] session=${sessionId} error=no_sandbox_state resumable=${hasResumableSandboxState(sessionRecord.sandboxState)}`,
    );
    return Response.json(
      { error: "No sandbox state available for restoration" },
      { status: 400 },
    );
  }
  if (sessionRecord.sandboxState.type !== "vercel") {
    return Response.json(
      {
        error:
          "Snapshot restoration is only supported for the current cloud sandbox provider",
      },
      { status: 400 },
    );
  }

  const sandboxType = sessionRecord.sandboxState.type;
  const sandboxName =
    getPersistentSandboxName(sessionRecord.sandboxState) ??
    getSessionSandboxName(sessionId);
  const hasPersistentSandbox = hasResumableSandboxState(
    sessionRecord.sandboxState,
  );

  if (
    !sessionRecord.snapshotUrl &&
    !hasPersistentSandbox &&
    hasRuntimeSandboxState(sessionRecord.sandboxState)
  ) {
    console.warn(
      `[Snapshot Restore] session=${sessionId} pending=true sandboxType=${sandboxType}`,
    );
    return Response.json(
      {
        error:
          "Sandbox is still being paused. Please wait a few seconds and try again.",
      },
      { status: 409 },
    );
  }

  if (!sessionRecord.snapshotUrl && !hasPersistentSandbox) {
    console.error(
      `[Snapshot Restore] session=${sessionId} error=no_resume_target sandboxType=${sandboxType}`,
    );
    return Response.json(
      { error: "No saved sandbox is available for this session" },
      { status: 404 },
    );
  }

  // Warn if sandbox appears to still be running.
  if (canOperateOnSandbox(sessionRecord.sandboxState)) {
    console.log(
      `[Snapshot Restore] session=${sessionId} already_running=true sandboxType=${sandboxType}`,
    );
    return Response.json({
      success: true,
      alreadyRunning: true,
      restoredFrom: hasPersistentSandbox
        ? sandboxName
        : sessionRecord.snapshotUrl,
    });
  }

  try {
    const sandbox = hasPersistentSandbox
      ? await connectSandbox(
          {
            type: sandboxType,
            sandboxName,
          },
          {
            ports: DEFAULT_SANDBOX_PORTS,
            resume: true,
          },
        )
      : await connectSandbox(
          {
            type: sandboxType,
            sandboxName,
            snapshotId: sessionRecord.snapshotUrl ?? undefined,
          },
          {
            timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
            ports: DEFAULT_SANDBOX_PORTS,
          },
        );

    const newState = sandbox.getState?.();
    const restoredState = (newState ?? {
      type: sandboxType,
      sandboxName,
    }) as Parameters<typeof updateSession>[1]["sandboxState"];

    await updateSession(sessionId, {
      sandboxState: restoredState,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
      ...buildActiveLifecycleUpdate(restoredState),
    });

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "snapshot-restored",
    });

    console.log(
      `[Snapshot Restore] session=${sessionId} success=true sandboxType=${sandboxType} sandboxName=${"name" in sandbox ? sandbox.name : "n/a"} restoredFrom=${hasPersistentSandbox ? sandboxName : sessionRecord.snapshotUrl}`,
    );

    return Response.json({
      success: true,
      restoredFrom: hasPersistentSandbox
        ? sandboxName
        : sessionRecord.snapshotUrl,
      sandboxName: "name" in sandbox ? sandbox.name : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (hasPersistentSandbox && isResumeTargetMissingError(message)) {
      await updateSession(sessionId, {
        sandboxState: { type: sandboxType },
        snapshotUrl: null,
        snapshotCreatedAt: null,
        ...buildHibernatedLifecycleUpdate(),
      });
      return Response.json(
        { error: "No saved sandbox is available for this session" },
        { status: 404 },
      );
    }

    console.error(
      `[Snapshot Restore] session=${sessionId} success=false error=${message}`,
    );
    return Response.json(
      { error: `Failed to resume sandbox: ${message}` },
      { status: 500 },
    );
  }
}
