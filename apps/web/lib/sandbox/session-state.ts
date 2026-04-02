import type { SandboxState } from "@open-harness/sandbox";

const PERSISTENT_SANDBOX_NAME_PREFIX = "session_";

export type SessionSandboxResumeMode =
  | "persistent"
  | "legacy-snapshot"
  | "none";

export interface SessionSandboxRecordLike {
  id?: string | null;
  sandboxState: SandboxState | null | undefined;
  snapshotUrl?: string | null;
}

export interface SessionSandboxStateInfo {
  sandboxIdentity: string | null;
  persistentSandboxName: string | null;
  resumeTargetSandboxName: string | null;
  activeRuntimeExpiresAt: number | null;
  legacySnapshotId: string | null;
  hasSandboxIdentity: boolean;
  hasActiveRuntime: boolean;
  hasPersistentSandbox: boolean;
  hasLegacySnapshot: boolean;
  resumeMode: SessionSandboxResumeMode;
  canResume: boolean;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getSandboxId(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  return asNonEmptyString((state as { sandboxId?: unknown }).sandboxId);
}

function getExpiresAt(state: unknown): number | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const expiresAt = (state as { expiresAt?: unknown }).expiresAt;
  return typeof expiresAt === "number" ? expiresAt : null;
}

export function buildSessionSandboxName(sessionId: string): string {
  return `${PERSISTENT_SANDBOX_NAME_PREFIX}${sessionId}`;
}

export function isPersistentSessionSandboxName(
  sandboxId: string | null | undefined,
): sandboxId is string {
  return (
    typeof sandboxId === "string" &&
    sandboxId.startsWith(PERSISTENT_SANDBOX_NAME_PREFIX)
  );
}

export function getSessionSandboxState(
  record: SessionSandboxRecordLike,
): SessionSandboxStateInfo {
  const sandboxIdentity = getSandboxId(record.sandboxState);
  const persistentSandboxName = isPersistentSessionSandboxName(sandboxIdentity)
    ? sandboxIdentity
    : null;
  const activeRuntimeExpiresAt = getExpiresAt(record.sandboxState);
  const legacySnapshotId = asNonEmptyString(record.snapshotUrl);
  const hasSandboxIdentity = sandboxIdentity !== null;
  const hasActiveRuntime =
    hasSandboxIdentity && activeRuntimeExpiresAt !== null;
  const hasPersistentSandbox = persistentSandboxName !== null;
  const hasLegacySnapshot = legacySnapshotId !== null;
  const resumeMode: SessionSandboxResumeMode = hasPersistentSandbox
    ? "persistent"
    : hasLegacySnapshot
      ? "legacy-snapshot"
      : "none";

  return {
    sandboxIdentity,
    persistentSandboxName,
    resumeTargetSandboxName:
      persistentSandboxName ??
      (record.id ? buildSessionSandboxName(record.id) : null),
    activeRuntimeExpiresAt,
    legacySnapshotId,
    hasSandboxIdentity,
    hasActiveRuntime,
    hasPersistentSandbox,
    hasLegacySnapshot,
    resumeMode,
    canResume: hasPersistentSandbox || hasLegacySnapshot,
  };
}
