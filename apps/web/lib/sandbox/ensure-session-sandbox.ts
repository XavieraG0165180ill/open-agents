import "server-only";

import {
  connectSandbox,
  type Sandbox,
  type SandboxState,
} from "@open-harness/sandbox";
import { getGitHubAccount } from "@/lib/db/accounts";
import {
  claimSessionSandboxEnsureLease,
  getSessionById,
  releaseSessionSandboxEnsureLease,
  updateSession,
} from "@/lib/db/sessions";
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
  getSessionSandboxName,
  getPersistentSandboxName,
  hasRuntimeSandboxState,
  isSandboxActive,
} from "@/lib/sandbox/utils";
import {
  getVercelCliSandboxSetup,
  syncVercelCliAuthToSandbox,
} from "@/lib/sandbox/vercel-cli-auth";
import { installGlobalSkills } from "@/lib/skills/global-skill-installer";
import { buildDevelopmentDotenvFromVercelProject } from "@/lib/vercel/projects";
import { getUserVercelToken } from "@/lib/vercel/token";

const SANDBOX_ENSURE_LEASE_TTL_MS = 10 * 60 * 1000;
const SANDBOX_ENSURE_POLL_MS = 250;
const SANDBOX_ENSURE_WAIT_TIMEOUT_MS = 60 * 1000;

export class SessionSandboxEnsureError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "SessionSandboxEnsureError";
    this.status = status;
  }
}

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;

type SandboxEnsureUser = {
  id: string;
  username?: string | null;
  name?: string | null;
  email?: string | null;
};

type EnsureSessionSandboxMode = "wait" | "best-effort";

export type EnsureSessionSandboxResult = {
  sessionRecord: SessionRecord;
  sandbox: Sandbox | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSandboxEnsureLeaseId() {
  return `sandbox-ensure:${Date.now()}:${crypto.randomUUID()}`;
}

function hasSnapshotState(state: SandboxState | null | undefined) {
  return Boolean(
    state &&
    typeof state === "object" &&
    "snapshotId" in state &&
    typeof state.snapshotId === "string" &&
    state.snapshotId.length > 0,
  );
}

function buildSessionSandboxState(
  sessionRecord: SessionRecord,
  source:
    | {
        repo: string;
        branch?: string;
        newBranch?: string;
        token?: string;
      }
    | undefined,
): SandboxState {
  const currentState =
    sessionRecord.sandboxState ?? ({ type: "vercel" } as SandboxState);
  const persistentSandboxName =
    getPersistentSandboxName(currentState) ??
    getSessionSandboxName(sessionRecord.id);

  if (
    getPersistentSandboxName(currentState) ||
    hasSnapshotState(currentState)
  ) {
    return {
      ...currentState,
      ...(source ? { source } : {}),
    } as SandboxState;
  }

  return {
    ...currentState,
    type: "vercel",
    sandboxName: persistentSandboxName,
    ...(source ? { source } : {}),
  } as SandboxState;
}

async function syncVercelProjectEnvVarsToSandbox(params: {
  userId: string;
  sessionRecord: SessionRecord;
  sandbox: Sandbox;
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
  sandbox: Sandbox;
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
  sandbox: Sandbox;
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

async function resolveGitHubToken(
  sessionRecord: SessionRecord,
  userId: string,
) {
  const repoOwner =
    sessionRecord.repoOwner ??
    (sessionRecord.cloneUrl
      ? parseGitHubUrl(sessionRecord.cloneUrl)?.owner
      : null);

  if (repoOwner) {
    try {
      const tokenResult = await getRepoToken(userId, repoOwner);
      return tokenResult.token;
    } catch {
      throw new SessionSandboxEnsureError(
        "Connect GitHub to access repositories",
        403,
      );
    }
  }

  return getUserGitHubToken();
}

function buildGitUser(params: {
  user: SandboxEnsureUser;
  githubAccount: Awaited<ReturnType<typeof getGitHubAccount>>;
}) {
  const githubNoreplyEmail =
    params.githubAccount?.externalUserId && params.githubAccount.username
      ? `${params.githubAccount.externalUserId}+${params.githubAccount.username}@users.noreply.github.com`
      : undefined;

  return {
    name:
      params.user.name ??
      params.githubAccount?.username ??
      params.user.username ??
      params.user.id,
    email:
      githubNoreplyEmail ??
      params.user.email ??
      `${params.user.username ?? params.user.id}@users.noreply.github.com`,
  };
}

async function waitForSandboxEnsureCompletion(
  sessionId: string,
): Promise<SessionRecord | null> {
  const deadline = Date.now() + SANDBOX_ENSURE_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const sessionRecord = await getSessionById(sessionId);
    if (!sessionRecord) {
      return null;
    }
    if (isSandboxActive(sessionRecord.sandboxState)) {
      return sessionRecord;
    }

    const leaseId = sessionRecord.sandboxEnsureLeaseId;
    const leaseExpiresAt = sessionRecord.sandboxEnsureLeaseExpiresAt;
    const leaseExpired =
      !leaseId || !leaseExpiresAt || leaseExpiresAt.getTime() <= Date.now();

    if (leaseExpired) {
      return sessionRecord;
    }

    await sleep(SANDBOX_ENSURE_POLL_MS);
  }

  return (await getSessionById(sessionId)) ?? null;
}

async function connectAndPersistSessionSandbox(params: {
  user: SandboxEnsureUser;
  sessionRecord: SessionRecord;
}): Promise<EnsureSessionSandboxResult> {
  const { user, sessionRecord } = params;
  const githubAccount = await getGitHubAccount(user.id);
  const githubToken = await resolveGitHubToken(sessionRecord, user.id);
  const source = sessionRecord.cloneUrl
    ? {
        repo: sessionRecord.cloneUrl,
        branch: sessionRecord.isNewBranch
          ? undefined
          : (sessionRecord.branch ?? undefined),
        newBranch: sessionRecord.isNewBranch
          ? (sessionRecord.branch ?? undefined)
          : undefined,
        token: githubToken ?? undefined,
      }
    : undefined;
  const connectState = buildSessionSandboxState(sessionRecord, source);
  const shouldRunProvisionSetup = !hasRuntimeSandboxState(
    sessionRecord.sandboxState,
  );

  const sandbox = await connectSandbox({
    state: connectState,
    options: {
      env: githubToken ? { GITHUB_TOKEN: githubToken } : undefined,
      gitUser: buildGitUser({ user, githubAccount }),
      timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
      ports: DEFAULT_SANDBOX_PORTS,
      baseSnapshotId: DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
      persistent: Boolean(getPersistentSandboxName(connectState)),
      resume: true,
      createIfMissing: true,
    },
  });

  if (shouldRunProvisionSetup) {
    try {
      await syncVercelProjectEnvVarsToSandbox({
        userId: user.id,
        sessionRecord,
        sandbox,
      });
    } catch (error) {
      console.error(
        `Failed to sync Vercel env vars for session ${sessionRecord.id}:`,
        error,
      );
    }

    try {
      await syncVercelCliAuthForSandbox({
        userId: user.id,
        sessionRecord,
        sandbox,
      });
    } catch (error) {
      console.error(
        `Failed to prepare Vercel CLI auth for session ${sessionRecord.id}:`,
        error,
      );
    }

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

  const nextState =
    (sandbox.getState?.() as SandboxState | undefined) ?? connectState;
  const updatedSession = await updateSession(sessionRecord.id, {
    sandboxState: nextState,
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
    ...buildActiveLifecycleUpdate(nextState),
  });

  kickSandboxLifecycleWorkflow({
    sessionId: sessionRecord.id,
    reason: "sandbox-created",
  });

  return {
    sessionRecord: updatedSession ?? {
      ...sessionRecord,
      sandboxState: nextState,
    },
    sandbox,
  };
}

export async function ensureSessionSandbox(params: {
  sessionId: string;
  user: SandboxEnsureUser;
  sessionRecord?: SessionRecord;
  ownerId?: string;
  mode?: EnsureSessionSandboxMode;
}): Promise<EnsureSessionSandboxResult> {
  const ownerId = params.ownerId ?? createSandboxEnsureLeaseId();
  const mode = params.mode ?? "wait";
  let sessionRecord =
    params.sessionRecord ?? (await getSessionById(params.sessionId));

  if (!sessionRecord) {
    throw new SessionSandboxEnsureError("Session not found", 404);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isSandboxActive(sessionRecord.sandboxState)) {
      return { sessionRecord, sandbox: null };
    }

    const claimed = await claimSessionSandboxEnsureLease(
      sessionRecord.id,
      ownerId,
      new Date(Date.now() + SANDBOX_ENSURE_LEASE_TTL_MS),
    );

    if (claimed) {
      try {
        return await connectAndPersistSessionSandbox({
          user: params.user,
          sessionRecord,
        });
      } finally {
        await releaseSessionSandboxEnsureLease(sessionRecord.id, ownerId);
      }
    }

    if (mode === "best-effort") {
      return { sessionRecord, sandbox: null };
    }

    const waitedSessionRecord = await waitForSandboxEnsureCompletion(
      sessionRecord.id,
    );
    if (!waitedSessionRecord) {
      throw new SessionSandboxEnsureError("Session not found", 404);
    }
    if (isSandboxActive(waitedSessionRecord.sandboxState)) {
      return { sessionRecord: waitedSessionRecord, sandbox: null };
    }

    sessionRecord = waitedSessionRecord;
  }

  throw new SessionSandboxEnsureError("Timed out while preparing sandbox", 503);
}
