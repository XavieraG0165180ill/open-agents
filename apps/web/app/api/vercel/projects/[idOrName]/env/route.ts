import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  fetchVercelProjectEnvironmentResponse,
  type VercelProjectReference,
} from "@/lib/vercel/projects";
import { getUserVercelToken } from "@/lib/vercel/token";

const FORWARDED_QUERY_PARAMS = [
  "gitBranch",
  "source",
  "customEnvironmentId",
  "customEnvironmentSlug",
] as const;

export const dynamic = "force-dynamic";

function buildProjectEnvironmentQuery(req: Request) {
  const requestUrl = new URL(req.url);
  const query: {
    gitBranch?: string;
    decrypt?: boolean;
    source?: string;
    customEnvironmentId?: string;
    customEnvironmentSlug?: string;
  } = {};

  for (const key of FORWARDED_QUERY_PARAMS) {
    const value = requestUrl.searchParams.get(key);
    if (value) {
      query[key] = value;
    }
  }

  const decrypt = requestUrl.searchParams.get("decrypt");
  if (decrypt === "true") {
    query.decrypt = true;
  } else if (decrypt === "false") {
    query.decrypt = false;
  }

  return query;
}

function buildProjectReference(
  req: Request,
  idOrName: string,
): VercelProjectReference {
  const requestUrl = new URL(req.url);

  return {
    projectId: idOrName,
    projectName: idOrName,
    teamId: requestUrl.searchParams.get("teamId"),
    teamSlug: requestUrl.searchParams.get("slug"),
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ idOrName: string }> },
) {
  const session = await getServerSession();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const token = await getUserVercelToken(session.user.id);

  if (!token) {
    return NextResponse.json(
      { error: "Vercel not connected" },
      { status: 401 },
    );
  }

  const { idOrName } = await params;

  if (!idOrName) {
    return NextResponse.json(
      { error: "Project id or name is required" },
      { status: 400 },
    );
  }

  try {
    const upstreamResponse = await fetchVercelProjectEnvironmentResponse(
      token,
      buildProjectReference(req, idOrName),
      buildProjectEnvironmentQuery(req),
    );

    const body = await upstreamResponse.text();
    const headers = new Headers();
    const contentType = upstreamResponse.headers.get("content-type");

    if (contentType) {
      headers.set("Content-Type", contentType);
    }

    headers.set("Cache-Control", "no-store");

    return new Response(body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  } catch (error) {
    console.error(
      "Failed to fetch Vercel project environment variables:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to fetch Vercel project environment variables" },
      { status: 500 },
    );
  }
}
