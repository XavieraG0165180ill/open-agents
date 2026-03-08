import "server-only";

const VERCEL_API_BASE_URL = "https://api.vercel.com";
const VERCEL_PROJECTS_PATH = "/v10/projects";
const VERCEL_TEAMS_PATH = "/v2/teams";

export interface VercelProjectReference {
  projectId: string;
  projectName: string;
  teamId?: string | null;
  teamSlug?: string | null;
}

export interface VercelProjectCandidate extends VercelProjectReference {
  teamName?: string | null;
  isSavedDefault?: boolean;
}

export interface VercelProjectEnvironmentVariable {
  id?: string;
  key: string;
  value: string;
  target?: string | string[] | null;
  createdAt?: number;
  updatedAt?: number;
}

interface VercelTeamSummary {
  id: string;
  slug: string | null;
  name: string | null;
}

interface VercelProjectEnvironmentQuery {
  gitBranch?: string;
  decrypt?: boolean;
  source?: string;
  customEnvironmentId?: string;
  customEnvironmentSlug?: string;
}

export class VercelApiError extends Error {
  status: number;
  statusText: string;
  body: string;
  contentType: string | null;

  constructor(params: {
    status: number;
    statusText: string;
    body: string;
    contentType: string | null;
  }) {
    super(params.body || params.statusText);
    this.name = "VercelApiError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.body = params.body;
    this.contentType = params.contentType;
  }

  static async fromResponse(response: Response): Promise<VercelApiError> {
    return new VercelApiError({
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
      contentType: response.headers.get("content-type"),
    });
  }
}

function buildVercelApiUrl(
  pathname: string,
  searchParams?: URLSearchParams,
): string {
  const url = new URL(pathname, VERCEL_API_BASE_URL);

  if (searchParams) {
    url.search = searchParams.toString();
  }

  return url.toString();
}

async function fetchVercelApi(
  token: string,
  pathname: string,
  searchParams?: URLSearchParams,
): Promise<Response> {
  return fetch(buildVercelApiUrl(pathname, searchParams), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
}

function extractProjects(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const result = payload as { projects?: unknown };
  return Array.isArray(result.projects) ? result.projects : [];
}

function parseTeams(payload: unknown): VercelTeamSummary[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const result = payload as { teams?: unknown };
  if (!Array.isArray(result.teams)) {
    return [];
  }

  return result.teams.flatMap((team): VercelTeamSummary[] => {
    if (!team || typeof team !== "object") {
      return [];
    }

    const teamRecord = team as Record<string, unknown>;

    if (typeof teamRecord.id !== "string") {
      return [];
    }

    return [
      {
        id: teamRecord.id,
        slug: typeof teamRecord.slug === "string" ? teamRecord.slug : null,
        name: typeof teamRecord.name === "string" ? teamRecord.name : null,
      },
    ];
  });
}

function toProjectCandidate(
  rawProject: unknown,
  scope: VercelTeamSummary | null,
): VercelProjectCandidate | null {
  if (!rawProject || typeof rawProject !== "object") {
    return null;
  }

  const project = rawProject as Record<string, unknown>;

  if (typeof project.id !== "string" || typeof project.name !== "string") {
    return null;
  }

  return {
    projectId: project.id,
    projectName: project.name,
    teamId: scope?.id ?? null,
    teamSlug: scope?.slug ?? null,
    teamName: scope?.name ?? null,
  };
}

function compareProjectCandidates(
  left: VercelProjectCandidate,
  right: VercelProjectCandidate,
): number {
  const leftScope = left.teamName ?? "";
  const rightScope = right.teamName ?? "";

  if (leftScope !== rightScope) {
    if (!leftScope) return -1;
    if (!rightScope) return 1;
    return leftScope.localeCompare(rightScope);
  }

  return left.projectName.localeCompare(right.projectName);
}

async function listAccessibleTeams(
  token: string,
): Promise<VercelTeamSummary[]> {
  const searchParams = new URLSearchParams({ limit: "100" });
  const response = await fetchVercelApi(token, VERCEL_TEAMS_PATH, searchParams);

  if (!response.ok) {
    throw await VercelApiError.fromResponse(response);
  }

  return parseTeams((await response.json()) as unknown);
}

async function listRepoProjectsInScope(
  token: string,
  repoUrl: string,
  scope: VercelTeamSummary | null,
): Promise<VercelProjectCandidate[]> {
  const searchParams = new URLSearchParams({
    repoUrl,
    limit: "100",
  });

  if (scope?.id) {
    searchParams.set("teamId", scope.id);
  }

  const response = await fetchVercelApi(
    token,
    VERCEL_PROJECTS_PATH,
    searchParams,
  );

  if (!response.ok) {
    throw await VercelApiError.fromResponse(response);
  }

  return extractProjects((await response.json()) as unknown)
    .map((project) => toProjectCandidate(project, scope))
    .filter((project): project is VercelProjectCandidate => project !== null);
}

export async function listVercelProjectCandidatesForRepo(
  token: string,
  repoOwner: string,
  repoName: string,
): Promise<VercelProjectCandidate[]> {
  const repoUrl = `https://github.com/${repoOwner}/${repoName}`;

  let scopes: Array<VercelTeamSummary | null> = [null];

  try {
    scopes = [null, ...(await listAccessibleTeams(token))];
  } catch (error) {
    console.error(
      "Failed to list Vercel teams while matching projects:",
      error,
    );
  }

  const results = await Promise.allSettled(
    scopes.map((scope) => listRepoProjectsInScope(token, repoUrl, scope)),
  );

  const candidates = new Map<string, VercelProjectCandidate>();
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }

    for (const project of result.value) {
      if (!candidates.has(project.projectId)) {
        candidates.set(project.projectId, project);
      }
    }
  }

  if (
    candidates.size === 0 &&
    rejected.length === results.length &&
    rejected[0]
  ) {
    const [error] = rejected;
    throw error.reason instanceof Error
      ? error.reason
      : new Error(String(error.reason));
  }

  return Array.from(candidates.values()).toSorted(compareProjectCandidates);
}

export function pickSelectedVercelProjectId(
  projects: VercelProjectCandidate[],
  savedProjectId?: string | null,
): string | null {
  if (
    savedProjectId &&
    projects.some((project) => project.projectId === savedProjectId)
  ) {
    return savedProjectId;
  }

  return projects.length === 1 ? (projects[0]?.projectId ?? null) : null;
}

export async function fetchVercelProjectEnvironmentResponse(
  token: string,
  project: VercelProjectReference,
  query: VercelProjectEnvironmentQuery = {},
): Promise<Response> {
  const searchParams = new URLSearchParams();

  if (query.gitBranch) {
    searchParams.set("gitBranch", query.gitBranch);
  }

  if (query.decrypt !== undefined) {
    searchParams.set("decrypt", String(query.decrypt));
  }

  if (query.source) {
    searchParams.set("source", query.source);
  }

  if (query.customEnvironmentId) {
    searchParams.set("customEnvironmentId", query.customEnvironmentId);
  }

  if (query.customEnvironmentSlug) {
    searchParams.set("customEnvironmentSlug", query.customEnvironmentSlug);
  }

  if (project.teamId) {
    searchParams.set("teamId", project.teamId);
  } else if (project.teamSlug) {
    searchParams.set("slug", project.teamSlug);
  }

  return fetchVercelApi(
    token,
    `${VERCEL_PROJECTS_PATH}/${encodeURIComponent(project.projectId)}/env`,
    searchParams,
  );
}

function toProjectEnvironmentVariable(
  rawValue: unknown,
): VercelProjectEnvironmentVariable | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const envVar = rawValue as Record<string, unknown>;

  if (typeof envVar.key !== "string" || typeof envVar.value !== "string") {
    return null;
  }

  return {
    id: typeof envVar.id === "string" ? envVar.id : undefined,
    key: envVar.key,
    value: envVar.value,
    target:
      typeof envVar.target === "string" || Array.isArray(envVar.target)
        ? envVar.target
        : undefined,
    createdAt:
      typeof envVar.createdAt === "number" ? envVar.createdAt : undefined,
    updatedAt:
      typeof envVar.updatedAt === "number" ? envVar.updatedAt : undefined,
  };
}

function extractProjectEnvironmentVariables(
  payload: unknown,
): VercelProjectEnvironmentVariable[] {
  if (Array.isArray(payload)) {
    return payload
      .map((value) => toProjectEnvironmentVariable(value))
      .filter(
        (value): value is VercelProjectEnvironmentVariable => value !== null,
      );
  }

  if (payload && typeof payload === "object") {
    const result = payload as { envs?: unknown };

    if (Array.isArray(result.envs)) {
      return result.envs
        .map((value) => toProjectEnvironmentVariable(value))
        .filter(
          (value): value is VercelProjectEnvironmentVariable => value !== null,
        );
    }
  }

  const singleValue = toProjectEnvironmentVariable(payload);
  return singleValue ? [singleValue] : [];
}

export async function getVercelProjectEnvironmentVariables(
  token: string,
  project: VercelProjectReference,
  query: VercelProjectEnvironmentQuery = {},
): Promise<VercelProjectEnvironmentVariable[]> {
  const response = await fetchVercelProjectEnvironmentResponse(
    token,
    project,
    query,
  );

  if (!response.ok) {
    throw await VercelApiError.fromResponse(response);
  }

  return extractProjectEnvironmentVariables((await response.json()) as unknown);
}

function normalizeEnvironmentTargets(
  target?: string | string[] | null,
): string[] {
  if (Array.isArray(target)) {
    return target.filter((value): value is string => typeof value === "string");
  }

  return typeof target === "string" ? [target] : [];
}

export function selectDevelopmentProjectEnvironmentVariables(
  envVars: VercelProjectEnvironmentVariable[],
): VercelProjectEnvironmentVariable[] {
  const filtered = envVars
    .filter((envVar) =>
      normalizeEnvironmentTargets(envVar.target).includes("development"),
    )
    .toSorted((left, right) => {
      const targetCountDelta =
        normalizeEnvironmentTargets(left.target).length -
        normalizeEnvironmentTargets(right.target).length;

      if (targetCountDelta !== 0) {
        return targetCountDelta;
      }

      const leftUpdatedAt = left.updatedAt ?? left.createdAt ?? 0;
      const rightUpdatedAt = right.updatedAt ?? right.createdAt ?? 0;
      return rightUpdatedAt - leftUpdatedAt;
    });

  const deduped = new Map<string, VercelProjectEnvironmentVariable>();

  for (const envVar of filtered) {
    if (!deduped.has(envVar.key)) {
      deduped.set(envVar.key, envVar);
    }
  }

  return Array.from(deduped.values()).toSorted((left, right) =>
    left.key.localeCompare(right.key),
  );
}

export async function getProjectDevelopmentEnvironmentVariables(
  token: string,
  project: VercelProjectReference,
): Promise<VercelProjectEnvironmentVariable[]> {
  const envVars = await getVercelProjectEnvironmentVariables(token, project, {
    decrypt: true,
  });

  return selectDevelopmentProjectEnvironmentVariables(envVars);
}

function escapeDotEnvValue(value: string): string {
  return JSON.stringify(value);
}

export function createDotEnvLocalFileContent(
  envVars: VercelProjectEnvironmentVariable[],
): string {
  const lines = [
    "# Generated by Open Harness from Vercel Development environment variables.",
    "# This file is created once when the sandbox starts.",
    "",
    ...envVars.map(
      (envVar) => `${envVar.key}=${escapeDotEnvValue(envVar.value)}`,
    ),
  ];

  return `${lines.join("\n")}\n`;
}
