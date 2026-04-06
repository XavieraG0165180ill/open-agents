import type { Sandbox, SandboxHooks } from "../interface";
import { VercelSandbox } from "./sandbox";
import type { VercelState } from "./state";

interface ConnectOptions {
  env?: Record<string, string>;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  ports?: number[];
  baseSnapshotId?: string;
  skipGitWorkspaceBootstrap?: boolean;
  resume?: boolean;
  persistent?: boolean;
}

function getRemainingTimeout(
  expiresAt: number | undefined,
): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const remaining = expiresAt - Date.now();
  return remaining > 10_000 ? remaining : undefined;
}

function getSandboxName(state: VercelState): string | undefined {
  return state.sandboxName ?? state.sandboxId;
}

/**
 * Connect to the Vercel-backed cloud sandbox based on the provided state.
 *
 * - If `snapshotId` is present, creates a new named persistent sandbox from that legacy snapshot
 * - If `sandboxName` is present, reconnects to the named sandbox (optionally resuming it)
 * - If `source` is present, creates a new named sandbox and prepares the repo
 * - Otherwise, creates an empty sandbox
 */
export async function connectVercel(
  state: VercelState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  const sandboxName = getSandboxName(state);

  // Legacy snapshot restore/migration
  if (state.snapshotId) {
    return VercelSandbox.create({
      ...(sandboxName ? { name: sandboxName } : {}),
      env: options?.env,
      gitUser: options?.gitUser,
      hooks: options?.hooks,
      ...(options?.timeout !== undefined && { timeout: options.timeout }),
      ...(options?.ports && { ports: options.ports }),
      baseSnapshotId: state.snapshotId,
      persistent: options?.persistent ?? true,
    });
  }

  // Reconnect/resume named persistent sandbox
  if (sandboxName) {
    const remainingTimeout =
      getRemainingTimeout(state.expiresAt) ?? options?.timeout;

    return VercelSandbox.connect(sandboxName, {
      env: options?.env,
      hooks: options?.hooks,
      remainingTimeout,
      ports: options?.ports,
      resume: options?.resume,
    });
  }

  // Create from source
  if (state.source) {
    return VercelSandbox.create({
      ...(sandboxName ? { name: sandboxName } : {}),
      source: {
        url: state.source.repo,
        branch: state.source.branch,
        token: state.source.token,
        newBranch: state.source.newBranch,
      },
      env: options?.env,
      gitUser: options?.gitUser,
      hooks: options?.hooks,
      ...(options?.timeout !== undefined && { timeout: options.timeout }),
      ...(options?.ports && { ports: options.ports }),
      ...(options?.baseSnapshotId && {
        baseSnapshotId: options.baseSnapshotId,
      }),
      ...(options?.skipGitWorkspaceBootstrap && {
        skipGitWorkspaceBootstrap: true,
      }),
      persistent: options?.persistent ?? true,
    });
  }

  // Create empty sandbox
  return VercelSandbox.create({
    ...(sandboxName ? { name: sandboxName } : {}),
    env: options?.env,
    gitUser: options?.gitUser,
    hooks: options?.hooks,
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
    ...(options?.ports && { ports: options.ports }),
    ...(options?.baseSnapshotId && {
      baseSnapshotId: options.baseSnapshotId,
    }),
    ...(options?.skipGitWorkspaceBootstrap && {
      skipGitWorkspaceBootstrap: true,
    }),
    persistent: options?.persistent ?? true,
  });
}
