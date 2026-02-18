import "server-only";

import {
  connectSandbox,
  type FileEntry,
  type SandboxState,
} from "@open-harness/sandbox";
import { after } from "next/server";
import {
  claimSandboxProvisioning,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import { downloadAndExtractTarball } from "@/lib/github/tarball";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "./config";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "./lifecycle";
import { kickSandboxLifecycleWorkflow } from "./lifecycle-kick";
import { hasRuntimeSandboxState } from "./utils";

const WORKING_DIR = "/vercel/sandbox";

/**
 * Convert simple file strings to FileEntry format.
 */
function toFileEntries(
  files: Record<string, string>,
): Record<string, FileEntry> {
  const entries: Record<string, FileEntry> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = { type: "file", content };
  }
  return entries;
}

export interface CreateSandboxInput {
  repoUrl?: string;
  branch?: string;
  isNewBranch?: boolean;
  sessionId: string;
  sandboxType: "hybrid" | "vercel" | "just-bash";
  githubToken: string | null;
  gitUser: { name: string; email: string };
}

export interface CreateSandboxResult {
  createdAt: number;
  timeout: number | null;
  currentBranch: string | undefined;
  mode: string;
  timing: { readyMs: number };
}

/**
 * Core sandbox creation logic shared between the sandbox API route and
 * background provisioning triggered by session creation.
 *
 * This function:
 * 1. Downloads the repo tarball (if needed)
 * 2. Creates the sandbox via connectSandbox()
 * 3. Updates the session DB with the new sandbox state
 * 4. Kicks off the lifecycle workflow
 */
export async function createSandboxForSession(
  input: CreateSandboxInput,
): Promise<CreateSandboxResult> {
  const {
    repoUrl,
    branch = "main",
    isNewBranch = false,
    sessionId,
    sandboxType,
    githubToken,
    gitUser,
  } = input;

  // Atomically claim provisioning to prevent double sandbox creation.
  // Both the background after() from session creation and the client's
  // POST /api/sandbox call createSandboxForSession -- this CAS on
  // lifecycleVersion ensures only one caller proceeds past this point.
  // New sessions start with lifecycleVersion=0; the winner sets it to 1.
  const existingSession = await getSessionById(sessionId);
  const currentVersion = existingSession?.lifecycleVersion ?? 0;
  const claimed = await claimSandboxProvisioning(sessionId, currentVersion);
  if (!claimed) {
    // Another caller already claimed provisioning. Check if a sandbox exists.
    const refreshed = await getSessionById(sessionId);
    if (refreshed && hasRuntimeSandboxState(refreshed.sandboxState)) {
      console.log(
        `[Sandbox] Skipping creation for session ${sessionId} -- sandbox already provisioned`,
      );
      return {
        createdAt: Date.now(),
        timeout:
          sandboxType === "just-bash" ? null : DEFAULT_SANDBOX_TIMEOUT_MS,
        currentBranch: repoUrl ? branch : undefined,
        mode: sandboxType,
        timing: { readyMs: 0 },
      };
    }
    // No runtime state yet -- the other caller is likely still working.
    // Wait briefly then check again to avoid orphaned sandboxes.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const afterWait = await getSessionById(sessionId);
    if (afterWait && hasRuntimeSandboxState(afterWait.sandboxState)) {
      console.log(
        `[Sandbox] Skipping creation for session ${sessionId} -- sandbox provisioned by another caller`,
      );
      return {
        createdAt: Date.now(),
        timeout:
          sandboxType === "just-bash" ? null : DEFAULT_SANDBOX_TIMEOUT_MS,
        currentBranch: repoUrl ? branch : undefined,
        mode: sandboxType,
        timing: { readyMs: 0 },
      };
    }
    // Still no runtime state after waiting. The other caller may have
    // failed. Fall through and create the sandbox ourselves.
    console.warn(
      `[Sandbox] Claim failed but no sandbox found for session ${sessionId} after waiting -- proceeding with creation`,
    );
  }

  const startTime = Date.now();

  const env: Record<string, string> = {};
  if (githubToken) {
    env.GITHUB_TOKEN = githubToken;
  }

  // Download and extract tarball if repo provided (needed for hybrid and just-bash)
  let files: Record<string, FileEntry> = {};
  if (repoUrl && (sandboxType === "hybrid" || sandboxType === "just-bash")) {
    let tarballResult;
    try {
      tarballResult = await downloadAndExtractTarball(
        repoUrl,
        branch,
        githubToken ?? undefined,
        WORKING_DIR,
      );
    } catch {
      // Retry without token for public repos
      tarballResult = await downloadAndExtractTarball(
        repoUrl,
        branch,
        undefined,
        WORKING_DIR,
      );
    }
    files = toFileEntries(tarballResult.files);
  }

  const source = repoUrl
    ? {
        repo: repoUrl,
        branch: isNewBranch ? undefined : branch,
        token: githubToken ?? undefined,
      }
    : undefined;

  let sandbox;

  if (sandboxType === "just-bash") {
    sandbox = await connectSandbox({
      state: {
        type: "just-bash",
        files,
        workingDirectory: WORKING_DIR,
        source,
      },
      options: { env },
    });
  } else if (sandboxType === "vercel") {
    sandbox = await connectSandbox({
      state: {
        type: "vercel",
        source,
      },
      options: {
        env,
        gitUser,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
      },
    });
  } else {
    // Default: hybrid sandbox (local first, then cloud)
    sandbox = await connectSandbox({
      state: {
        type: "hybrid",
        files,
        workingDirectory: WORKING_DIR,
        source,
      },
      options: {
        env,
        gitUser,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        scheduleBackgroundWork: (cb) => after(cb),
        hooks: {
          onCloudSandboxReady: async (sandboxId) => {
            const currentSession = await getSessionById(sessionId);
            if (currentSession?.sandboxState?.type === "hybrid") {
              const nextState: SandboxState = { type: "hybrid", sandboxId };
              await updateSession(sessionId, {
                sandboxState: nextState,
                lifecycleVersion: getNextLifecycleVersion(
                  currentSession.lifecycleVersion,
                ),
                ...buildActiveLifecycleUpdate(nextState),
              });
              console.log(
                `[Sandbox] Cloud sandbox ready for session ${sessionId}: ${sandboxId}`,
              );

              kickSandboxLifecycleWorkflow({
                sessionId,
                reason: "cloud-ready",
              });
            }
          },
          onCloudSandboxFailed: async (error) => {
            await updateSession(sessionId, {
              lifecycleState: "failed",
              lifecycleError: error.message,
            });
            console.error(
              `[Sandbox] Cloud sandbox failed for session ${sessionId}:`,
              error.message,
            );
          },
        },
      },
    });
  }

  const sessionRecord = await getSessionById(sessionId);
  if (sandbox.getState) {
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

  const readyMs = Date.now() - startTime;

  return {
    createdAt: Date.now(),
    timeout: sandboxType === "just-bash" ? null : DEFAULT_SANDBOX_TIMEOUT_MS,
    currentBranch: repoUrl ? branch : undefined,
    mode: sandboxType,
    timing: { readyMs },
  };
}
