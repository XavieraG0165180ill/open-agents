import {
  requireAuthenticatedUser,
  requireOwnedSession,
} from "@/app/api/sessions/_lib/session-context";
import type { PullRequestCheckRun } from "@/lib/github/client";
import { getRepoToken } from "@/lib/github/get-repo-token";
import { Octokit } from "@octokit/rest";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

type FixChecksRequest = {
  checkRuns: PullRequestCheckRun[];
};

const MAX_LOG_LENGTH = 8000;
const MAX_CHECK_RUNS = 10;

function formatFixMessage(
  checkRuns: PullRequestCheckRun[],
  logs: Record<string, string>,
): string {
  const sections = checkRuns.map((run) => {
    let section = `## ${run.name}`;
    if (run.detailsUrl) {
      section += `\n[View details](${run.detailsUrl})`;
    }

    const logText = run.id > 0 ? logs[String(run.id)] : undefined;
    if (logText && logText !== "(Unable to fetch logs)") {
      const truncated =
        logText.length > MAX_LOG_LENGTH
          ? `${logText.slice(0, MAX_LOG_LENGTH)}\n\n... (truncated, ${logText.length - MAX_LOG_LENGTH} more characters)`
          : logText;
      section += `\n\n\`\`\`\n${truncated}\n\`\`\``;
    }

    return section;
  });

  const noun = checkRuns.length === 1 ? "check is" : "checks are";
  const failNoun = checkRuns.length === 1 ? "failure" : "failures";

  return `# Fix Failing Checks\n\nThe following ${noun} failing on this pull request. Please investigate the ${failNoun}, identify the root cause, and push a fix.\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * Builds a fully formatted "fix failing checks" message including CI logs.
 *
 * Requires the GitHub App to have `actions: read` permission.
 *
 * Request body:
 *   { checkRuns: PullRequestCheckRun[] } — the failing check runs
 *
 * Returns:
 *   { message: string } — the formatted message ready to send to the chat
 */
export async function POST(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId } = await context.params;
  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;

  if (!sessionRecord.repoOwner || !sessionRecord.repoName) {
    return Response.json(
      { error: "Session is not linked to a GitHub repository" },
      { status: 400 },
    );
  }

  let body: FixChecksRequest;
  try {
    body = (await req.json()) as FixChecksRequest;
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { checkRuns } = body;
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
    return Response.json({ error: "No check runs provided" }, { status: 400 });
  }

  if (checkRuns.length > MAX_CHECK_RUNS) {
    return Response.json(
      { error: `Too many check runs (max ${MAX_CHECK_RUNS})` },
      { status: 400 },
    );
  }

  // Fetch logs for check runs that have valid IDs
  const runsWithIds = checkRuns.filter((r) => r.id > 0);
  const logs: Record<string, string> = {};

  if (runsWithIds.length > 0) {
    let token: string;
    try {
      const tokenResult = await getRepoToken(
        authResult.userId,
        sessionRecord.repoOwner,
      );
      token = tokenResult.token;
    } catch {
      // Continue without logs if we can't get a token
      return Response.json({ message: formatFixMessage(checkRuns, logs) });
    }

    const octokit = new Octokit({ auth: token });
    const owner = sessionRecord.repoOwner;
    const repo = sessionRecord.repoName;

    await Promise.all(
      runsWithIds.map(async (run) => {
        try {
          const response =
            await octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner,
              repo,
              job_id: run.id,
            });
          logs[String(run.id)] =
            typeof response.data === "string"
              ? response.data
              : String(response.data);
        } catch {
          logs[String(run.id)] = "(Unable to fetch logs)";
        }
      }),
    );
  }

  return Response.json({ message: formatFixMessage(checkRuns, logs) });
}
