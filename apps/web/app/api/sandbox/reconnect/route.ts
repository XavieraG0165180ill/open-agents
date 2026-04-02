import { connectSandbox, type SandboxState } from "@open-harness/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
  type SessionRecord,
} from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import {
  buildHibernatedLifecycleUpdate,
  getSandboxExpiresAtDate,
} from "@/lib/sandbox/lifecycle";
import {
  getSessionSandboxState,
  type SessionSandboxResumeMode,
} from "@/lib/sandbox/session-state";
import {
  clearSandboxState,
  isSandboxUnavailableError,
} from "@/lib/sandbox/utils";

export type ReconnectStatus =
  | "connected"
  | "expired"
  | "not_found"
  | "no_sandbox";

export type ReconnectResponse = {
  status: ReconnectStatus;
  hasSnapshot: boolean;
  resumeMode: SessionSandboxResumeMode;
  /** Timestamp (ms) when sandbox expires. Only present when status is "connected". */
  expiresAt?: number;
  lifecycle: {
    serverTime: number;
    state: string | null;
    lastActivityAt: number | null;
    hibernateAfter: number | null;
    sandboxExpiresAt: number | null;
  };
};

function buildLifecyclePayload(
  sessionRecord: SessionRecord | null | undefined,
) {
  return {
    serverTime: Date.now(),
    state: sessionRecord?.lifecycleState ?? null,
    lastActivityAt: sessionRecord?.lastActivityAt?.getTime() ?? null,
    hibernateAfter: sessionRecord?.hibernateAfter?.getTime() ?? null,
    sandboxExpiresAt: sessionRecord?.sandboxExpiresAt?.getTime() ?? null,
  };
}

function getStateExpiresAt(state: unknown): number | undefined {
  if (!state || typeof state !== "object") return undefined;
  const expiresAt = (state as { expiresAt?: unknown }).expiresAt;
  return typeof expiresAt === "number" ? expiresAt : undefined;
}

export async function GET(req: Request): Promise<Response> {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

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
  const sessionSandbox = getSessionSandboxState(sessionRecord);

  const state = sessionRecord.sandboxState;
  if (!state || !sessionSandbox.hasSandboxIdentity) {
    console.log(
      `[Reconnect] session=${sessionId} status=no_sandbox hasSnapshot=${sessionSandbox.hasLegacySnapshot} hasIdentity=false`,
    );
    return Response.json({
      status: "no_sandbox",
      hasSnapshot: sessionSandbox.hasLegacySnapshot,
      resumeMode: sessionSandbox.resumeMode,
      lifecycle: buildLifecyclePayload(sessionRecord),
    } satisfies ReconnectResponse);
  }

  // Connect without auto-resuming so we can distinguish running sandboxes from
  // persistent sandboxes that are currently stopped.
  try {
    const sandbox = await connectSandbox({
      state: state as SandboxState,
      options: { resume: false },
    });
    const probe = await sandbox.exec("pwd", sandbox.workingDirectory, 15_000);
    if (!probe.success) {
      const probeError =
        probe.stderr?.trim() || probe.stdout?.trim() || "sandbox probe failed";
      if (isSandboxUnavailableError(probeError)) {
        throw new Error(probeError);
      }
      console.warn(
        `[Reconnect] session=${sessionId} non-fatal probe failure while reconnecting: ${probeError}`,
      );
    }

    const refreshedState =
      (sandbox.getState?.() as SandboxState | undefined) ??
      ({
        ...state,
        ...(sandbox.expiresAt ? { expiresAt: sandbox.expiresAt } : {}),
      } as SandboxState);
    // Only sync sandbox state/expiry and recover stale failed lifecycle state
    // without resetting lastActivityAt/hibernateAfter, otherwise every reconnect
    // probe (including page entry) defeats the inactivity timer.
    const shouldRecoverFailedLifecycle =
      sessionRecord.lifecycleState === "failed";
    const updatedSession = await updateSession(sessionId, {
      sandboxState: refreshedState,
      sandboxExpiresAt: getSandboxExpiresAtDate(refreshedState),
      ...(shouldRecoverFailedLifecycle
        ? {
            lifecycleState: "active",
            lifecycleError: null,
          }
        : {}),
    });

    const refreshedSessionSandbox = getSessionSandboxState({
      id: sessionRecord.id,
      sandboxState: refreshedState,
      snapshotUrl: sessionRecord.snapshotUrl,
    });
    console.log(
      `[Reconnect] session=${sessionId} status=connected hasSnapshot=${refreshedSessionSandbox.hasLegacySnapshot} expiresAt=${sandbox.expiresAt ?? "null"}`,
    );
    return Response.json({
      status: "connected",
      hasSnapshot: refreshedSessionSandbox.hasLegacySnapshot,
      resumeMode: refreshedSessionSandbox.resumeMode,
      expiresAt: sandbox.expiresAt,
      lifecycle: buildLifecyclePayload(updatedSession ?? sessionRecord),
    } satisfies ReconnectResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isSandboxUnavailableError(message)) {
      console.warn(
        `[Reconnect] session=${sessionId} transient reconnect error, preserving runtime state: ${message}`,
      );
      // Only forward expiresAt if it's still in the future; stale values
      // cause the client to compute a zero/negative timeout and flip to expired.
      const rawExpiresAt = getStateExpiresAt(state);
      const safeExpiresAt =
        rawExpiresAt !== undefined && rawExpiresAt > Date.now()
          ? rawExpiresAt
          : undefined;
      return Response.json({
        status: "connected",
        hasSnapshot: sessionSandbox.hasLegacySnapshot,
        resumeMode: sessionSandbox.resumeMode,
        expiresAt: safeExpiresAt,
        lifecycle: buildLifecyclePayload(sessionRecord),
      } satisfies ReconnectResponse);
    }

    // Sandbox no longer exists (expired or stopped)
    const clearedSandboxState = clearSandboxState(sessionRecord.sandboxState);
    await updateSession(sessionId, {
      sandboxState: clearedSandboxState,
      ...buildHibernatedLifecycleUpdate(),
    });
    const clearedSessionSandbox = getSessionSandboxState({
      id: sessionRecord.id,
      sandboxState: clearedSandboxState,
      snapshotUrl: sessionRecord.snapshotUrl,
    });
    console.error(
      `[Reconnect] session=${sessionId} status=expired hasSnapshot=${clearedSessionSandbox.hasLegacySnapshot} error=${message}`,
    );
    return Response.json({
      status: "expired",
      hasSnapshot: clearedSessionSandbox.hasLegacySnapshot,
      resumeMode: clearedSessionSandbox.resumeMode,
      lifecycle: {
        serverTime: Date.now(),
        state: "hibernated",
        lastActivityAt: null,
        hibernateAfter: null,
        sandboxExpiresAt: null,
      },
    } satisfies ReconnectResponse);
  }
}
