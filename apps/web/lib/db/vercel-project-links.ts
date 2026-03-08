import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./client";
import {
  type NewVercelProjectLink,
  type VercelProjectLink,
  vercelProjectLinks,
} from "./schema";

function normalizeRepoCoordinates(repoOwner: string, repoName: string) {
  return {
    repoOwner: repoOwner.trim().toLowerCase(),
    repoName: repoName.trim().toLowerCase(),
  };
}

export async function getVercelProjectLinkForRepo(
  userId: string,
  repoOwner: string,
  repoName: string,
): Promise<VercelProjectLink | null> {
  const normalized = normalizeRepoCoordinates(repoOwner, repoName);

  const [link] = await db
    .select()
    .from(vercelProjectLinks)
    .where(
      and(
        eq(vercelProjectLinks.userId, userId),
        eq(vercelProjectLinks.repoOwner, normalized.repoOwner),
        eq(vercelProjectLinks.repoName, normalized.repoName),
      ),
    )
    .limit(1);

  return link ?? null;
}

interface UpsertVercelProjectLinkInput {
  userId: string;
  repoOwner: string;
  repoName: string;
  projectId: string;
  projectName: string;
  teamId?: string | null;
  teamSlug?: string | null;
}

export async function upsertVercelProjectLink(
  input: UpsertVercelProjectLinkInput,
): Promise<VercelProjectLink> {
  const normalized = normalizeRepoCoordinates(input.repoOwner, input.repoName);
  const now = new Date();

  const values: NewVercelProjectLink = {
    id: nanoid(),
    userId: input.userId,
    repoOwner: normalized.repoOwner,
    repoName: normalized.repoName,
    projectId: input.projectId,
    projectName: input.projectName,
    teamId: input.teamId ?? null,
    teamSlug: input.teamSlug ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const [link] = await db
    .insert(vercelProjectLinks)
    .values(values)
    .onConflictDoUpdate({
      target: [
        vercelProjectLinks.userId,
        vercelProjectLinks.repoOwner,
        vercelProjectLinks.repoName,
      ],
      set: {
        projectId: input.projectId,
        projectName: input.projectName,
        teamId: input.teamId ?? null,
        teamSlug: input.teamSlug ?? null,
        updatedAt: now,
      },
    })
    .returning();

  if (!link) {
    throw new Error("Failed to upsert Vercel project link");
  }

  return link;
}
