import {
  requireAuthenticatedUser,
  requireOwnedSession,
} from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import { SANDBOX_EXPIRES_BUFFER_MS } from "@/lib/sandbox/config";
import {
  getLifecycleDueAtMs,
  getSandboxExpiresAtDate,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  getSessionSandboxState,
  type SessionSandboxResumeMode,
} from "@/lib/sandbox/session-state";

export type SandboxStatusResponse = {
  status: "active" | "no_sandbox";
  hasSnapshot: boolean;
  resumeMode: SessionSandboxResumeMode;
  lifecycleVersion: number;
  lifecycle: {
    serverTime: number;
    state: string | null;
    lastActivityAt: number | null;
    hibernateAfter: number | null;
    sandboxExpiresAt: number | null;
  };
};

function isLifecycleActiveState(state: string | null): boolean {
  return (
    state === "active" || state === "provisioning" || state === "restoring"
  );
}

function isSessionExpired(record: { sandboxExpiresAt: Date | null }): boolean {
  if (!record.sandboxExpiresAt) {
    return false;
  }

  return (
    Date.now() >= record.sandboxExpiresAt.getTime() - SANDBOX_EXPIRES_BUFFER_MS
  );
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
  let effectiveSessionRecord = sessionRecord;

  const runtimeSandboxExpiresAt = getSandboxExpiresAtDate(
    sessionRecord.sandboxState,
  );
  const sessionSandbox = getSessionSandboxState(sessionRecord);
  const hasRecoverableFailedLifecycle =
    sessionRecord.lifecycleState === "failed" &&
    sessionSandbox.hasActiveRuntime &&
    !isSessionExpired({ sandboxExpiresAt: runtimeSandboxExpiresAt });

  // If the lifecycle evaluator previously failed but runtime state is still
  // active, recover lifecycle state so UI does not get stuck in "Paused".
  if (hasRecoverableFailedLifecycle) {
    const recoveredSession = await updateSession(sessionRecord.id, {
      lifecycleState: "active",
      lifecycleError: null,
      sandboxExpiresAt: getSandboxExpiresAtDate(sessionRecord.sandboxState),
    });
    if (recoveredSession) {
      effectiveSessionRecord = recoveredSession;
    }
  }

  const effectiveSandbox = getSessionSandboxState(effectiveSessionRecord);
  const effectiveIsExpired = isSessionExpired(effectiveSessionRecord);
  const effectiveIsActive =
    isLifecycleActiveState(effectiveSessionRecord.lifecycleState) &&
    !effectiveIsExpired &&
    effectiveSandbox.hasActiveRuntime;

  // Safety net: if the sandbox has stale runtime state (expired or overdue for
  // hibernation), kick the lifecycle to clean up DB state in the background.
  if (effectiveSessionRecord.lifecycleState === "active") {
    const now = Date.now();
    const dueAtMs = getLifecycleDueAtMs(effectiveSessionRecord);
    if (effectiveIsExpired || now >= dueAtMs) {
      kickSandboxLifecycleWorkflow({
        sessionId: effectiveSessionRecord.id,
        reason: "status-check-overdue",
      });
    }
  }

  return Response.json({
    status: effectiveIsActive ? "active" : "no_sandbox",
    hasSnapshot: effectiveSandbox.hasLegacySnapshot,
    resumeMode: effectiveSandbox.resumeMode,
    lifecycleVersion: effectiveSessionRecord.lifecycleVersion,
    lifecycle: {
      serverTime: Date.now(),
      state: effectiveSessionRecord.lifecycleState,
      lastActivityAt: effectiveSessionRecord.lastActivityAt?.getTime() ?? null,
      hibernateAfter: effectiveSessionRecord.hibernateAfter?.getTime() ?? null,
      sandboxExpiresAt:
        effectiveSessionRecord.sandboxExpiresAt?.getTime() ?? null,
    },
  } satisfies SandboxStatusResponse);
}
