export interface VercelProjectSelection {
  projectId: string;
  projectName: string;
  teamId?: string | null;
  teamSlug?: string | null;
}

export interface VercelProjectCandidate extends VercelProjectSelection {
  teamName?: string | null;
  isSavedDefault?: boolean;
}

export interface RepoVercelProjectsResponse {
  projects: VercelProjectCandidate[];
  selectedProjectId: string | null;
}
