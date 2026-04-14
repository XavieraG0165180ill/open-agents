const GITHUB_REPO_PATH_SEGMENT_PATTERN = /^[.\w-]+$/;
const GITHUB_HOSTNAME = "github.com";
const SSH_GITHUB_REPO_URL_PATTERN =
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

export interface GitHubRepoCoordinates {
  owner: string;
  repo: string;
  canonicalUrl: string;
}

export function isValidGitHubRepoOwner(owner: string): boolean {
  return GITHUB_REPO_PATH_SEGMENT_PATTERN.test(owner);
}

export function isValidGitHubRepoName(repoName: string): boolean {
  return GITHUB_REPO_PATH_SEGMENT_PATTERN.test(repoName);
}

function parseGitHubRepoPathname(
  pathname: string,
): Pick<GitHubRepoCoordinates, "owner" | "repo"> | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }

  const owner = segments[0];
  const repoSegment = segments[1];
  if (!owner || !repoSegment) {
    return null;
  }

  const repo = repoSegment.endsWith(".git")
    ? repoSegment.slice(0, -".git".length)
    : repoSegment;

  if (!repo) {
    return null;
  }

  if (!isValidGitHubRepoOwner(owner) || !isValidGitHubRepoName(repo)) {
    return null;
  }

  return { owner, repo };
}

export function buildGitHubRepoUrl(params: {
  owner: string;
  repo: string;
}): string | null {
  const { owner, repo } = params;

  if (!isValidGitHubRepoOwner(owner) || !isValidGitHubRepoName(repo)) {
    return null;
  }

  return `https://${GITHUB_HOSTNAME}/${owner}/${repo}`;
}

export function parseGitHubRepoUrl(
  repoUrl: string,
): GitHubRepoCoordinates | null {
  const trimmedUrl = repoUrl.trim();
  if (!trimmedUrl) {
    return null;
  }

  const sshMatch = trimmedUrl.match(SSH_GITHUB_REPO_URL_PATTERN);
  if (sshMatch?.[1] && sshMatch[2]) {
    const owner = sshMatch[1];
    const repo = sshMatch[2];
    const canonicalUrl = buildGitHubRepoUrl({ owner, repo });
    if (!canonicalUrl) {
      return null;
    }

    return { owner, repo, canonicalUrl };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== "https:" &&
    parsedUrl.protocol !== "http:" &&
    parsedUrl.protocol !== "ssh:"
  ) {
    return null;
  }

  if (parsedUrl.hostname.toLowerCase() !== GITHUB_HOSTNAME) {
    return null;
  }

  const coordinates = parseGitHubRepoPathname(parsedUrl.pathname);
  if (!coordinates) {
    return null;
  }

  const canonicalUrl = buildGitHubRepoUrl(coordinates);
  if (!canonicalUrl) {
    return null;
  }

  return {
    ...coordinates,
    canonicalUrl,
  };
}

export function buildGitHubAuthRemoteUrl(params: {
  token: string;
  owner: string;
  repo: string;
}): string | null {
  const { token, owner, repo } = params;
  const repoUrl = buildGitHubRepoUrl({ owner, repo });

  if (!repoUrl) {
    return null;
  }

  return `${repoUrl.replace(
    "https://",
    `https://x-access-token:${encodeURIComponent(token)}@`,
  )}.git`;
}

export function redactGitHubToken(text: string): string {
  return text.replace(
    /https:\/\/x-access-token:[^@\s]+@github\.com/gi,
    "https://x-access-token:***@github.com",
  );
}
