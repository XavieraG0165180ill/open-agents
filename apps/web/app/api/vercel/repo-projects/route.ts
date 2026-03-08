import { getVercelProjectLinkForRepo } from "@/lib/db/vercel-project-links";
import {
  type VercelApiError,
  listVercelProjectCandidatesForRepo,
  pickSelectedVercelProjectId,
} from "@/lib/vercel/projects";
import { getServerSession } from "@/lib/session/get-server-session";
import { getUserVercelToken } from "@/lib/vercel/token";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession();

  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const requestUrl = new URL(req.url);
  const repoOwner = requestUrl.searchParams.get("repoOwner")?.trim();
  const repoName = requestUrl.searchParams.get("repoName")?.trim();

  if (!repoOwner || !repoName) {
    return Response.json(
      { error: "repoOwner and repoName are required" },
      { status: 400 },
    );
  }

  const token = await getUserVercelToken(session.user.id);

  if (!token) {
    return Response.json({ error: "Vercel not connected" }, { status: 401 });
  }

  try {
    const [savedLink, projects] = await Promise.all([
      getVercelProjectLinkForRepo(session.user.id, repoOwner, repoName),
      listVercelProjectCandidatesForRepo(token, repoOwner, repoName),
    ]);

    const selectedProjectId = pickSelectedVercelProjectId(
      projects,
      savedLink?.projectId,
    );

    return Response.json({
      projects: projects.map((project) => ({
        ...project,
        isSavedDefault: savedLink?.projectId === project.projectId,
      })),
      selectedProjectId,
    });
  } catch (error) {
    const apiError = error as VercelApiError | undefined;
    const status = typeof apiError?.status === "number" ? apiError.status : 500;

    console.error("Failed to fetch Vercel projects for repository:", error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch Vercel projects for repository",
      },
      { status },
    );
  }
}
