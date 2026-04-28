# GitHub Broker Write Boundary Plan

Summary: Move GitHub writes behind a broker-owned boundary where the sandbox only produces local changes or an explicit commit/PR intent. The broker validates that intent, mints a repo-scoped least-permission GitHub App installation token, performs the GitHub write, and revokes or discards the token.

Context: Existing commit writes are partly aligned with this model: `apps/web/lib/github/actions/commit.ts` and `apps/web/lib/chat/auto-commit-direct.ts` already read sandbox changes and write commits via `apps/web/lib/github/commit.ts` using a GitHub App installation Octokit. The remaining gaps are that sandboxes still receive GitHub credential brokering, some paths fall back to user OAuth tokens, PR/merge/close/delete writes still use user OAuth tokens, new repo creation still commits and pushes from inside the sandbox, and there is no validated `CommitIntent`/file bundle abstraction.

System Impact: The source of truth for GitHub authorization moves from sandbox runtime credentials plus user OAuth tokens to broker-owned GitHub App installation tokens. The sandbox remains the source of truth for untrusted filesystem changes, but the broker becomes the source of truth for which repo, branch, files, paths, modes, and GitHub operation are allowed. GitHub write tokens become short-lived implementation details of broker actions instead of sandbox capabilities. Runtime sandbox sessions must not retain GitHub auth after clone/setup.

Approach: Implement this in phases. First introduce a validated commit bundle boundary and scoped installation-token helper. Then remove write-capable GitHub credentials from sandbox runtime. Then migrate every GitHub write path to broker-owned GitHub App operations. Disable in-app repository creation for now because there is no existing repo to scope a one-repo token to before creation. Only support same-repository session branches, not fork PR writes, and do not allow sandbox-originated broker commits directly to the default/base branch.

Changes:
- `apps/web/lib/github/app.ts` - Replace broad `getInstallationOctokit` write usage with scoped token helpers, for example `mintInstallationToken({ installationId, repositoryIds, permissions })`, `withScopedInstallationOctokit(...)`, and `revokeInstallationToken(...)`. Scoped write calls should instantiate `Octokit` with the raw scoped token and revoke in `finally` where GitHub supports it.
- `apps/web/lib/github/access.ts` - Extend `verifyRepoAccess` to return the GitHub repository id along with `installationId`. Authorization should continue to enforce `user access ∩ app installation scope`, but downstream writes should use `repositoryIds: [repositoryId]` and explicit permissions.
- `apps/web/lib/github/commit-intent.ts` - Add a broker-side `CommitIntent` or `CommitBundle` abstraction. It should include owner, repo, repository id, installation id, branch, base branch, expected head SHA, commit message, file entries, modes, old paths for renames, encodings, and co-author metadata.
- `apps/web/lib/github/commit-intent.ts` - Validate repo-relative paths before reading or writing: reject empty paths, absolute paths, NUL bytes, `.`, `..`, `.git` segments, and unsupported Git tree modes. Add file count and per-file/total-size limits.
- `packages/sandbox/interface.ts` and `packages/sandbox/vercel/sandbox.ts` - Add a binary-safe file read primitive, likely `readFileBuffer` or equivalent, backed by Vercel Sandbox `readFileToBuffer`, so binary bundle creation does not shell-interpolate paths.
- `packages/sandbox/git.ts` - Keep low-level git helpers, but make bundle collection safe: preserve file modes via `getFileModes`, validate or return enough metadata for broker validation, and avoid unsafe path interpolation. Harden or replace `syncToRemote` because it currently interpolates branch names.
- `apps/web/lib/github/commit.ts` - Change `createCommit` to consume a validated commit bundle, preserve Git modes instead of hardcoding `100644`, and enforce `expectedHeadSha` before updating refs so remote branch movement cannot silently change what was validated.
- `apps/web/lib/github/actions/commit.ts` - Replace direct staged-file handling with `buildCommitIntentFromSandbox` plus validation, then perform the commit with a repo-scoped installation token using `contents: write` and the single repository id. If the sandbox is on the base/default branch, create or switch to a session branch before committing; never write sandbox changes directly to the default branch.
- `apps/web/lib/chat/auto-commit-direct.ts` - Use the same commit-intent path as manual commits. Add branch validation before any GitHub write or sandbox sync, including the no-default-branch-write invariant.
- `apps/web/lib/github/pulls.ts` - Allow PR, auto-merge, merge, close, and branch-delete helpers to accept broker-provided Octokit instances or scoped-token execution instead of raw user OAuth tokens.
- `apps/web/lib/github/actions/pr.ts` - Migrate PR creation, auto-merge, merge, close, and branch deletion to scoped GitHub App tokens. Use user OAuth only for user identity/access checks, not writes. Disable fork/head-owner writes instead of falling back to user-token writes.
- `apps/web/lib/chat/auto-pr-direct.ts` - Migrate auto-PR creation to the same broker-owned PR writer. Keep existing read operations, but stop creating PRs with user OAuth tokens and skip fork-style PRs.
- `apps/web/app/workflows/chat-post-finish.ts` - Keep workflow orchestration, but ensure auto-commit and auto-PR steps reconnect without write-capable sandbox credentials.
- `apps/web/app/api/sandbox/route.ts` - Stop falling back to user OAuth for sandbox clone/auth. For repo-backed sandboxes, verify access and mint only a repo-scoped `contents: read` token for clone/setup, then discard it. Do not keep runtime sandbox credential brokering enabled after setup.
- `apps/web/app/workflows/chat-sandbox-runtime.ts` - Stop passing the user OAuth token into `connectSandbox`. For private repo setup, use only a repo-scoped read token during clone/resume setup when strictly needed, then clear/discard it before untrusted agent work.
- `apps/web/app/api/chat/_lib/runtime.ts` - Stop refreshing sandbox GitHub credential brokering with user OAuth tokens on chat reconnect.
- `packages/sandbox/factory.ts`, `packages/sandbox/vercel/connect.ts`, `packages/sandbox/vercel/config.ts`, and `packages/sandbox/vercel/sandbox.ts` - Rename `githubToken` semantics to setup-only clone credentialing, or remove runtime credential brokering entirely. Ensure no write-capable token is injected into network policy, and no GitHub auth is retained after clone/setup.
- `packages/sandbox/vercel/sandbox.ts` - Remove or rewrite environment details that tell sandbox agents GitHub API/git HTTPS requests are authenticated automatically. Replace with broker-boundary language: local changes only, GitHub writes are handled outside the sandbox.
- `packages/agent/system-prompt.ts` - Remove cloud-sandbox instructions that tell agents to commit and push. Replace with instructions not to run `git commit`, `git push`, GitHub write APIs, or credential setup inside the sandbox.
- `apps/web/app/api/github/create-repo/route.ts` - Disable in-app repository creation and return a clear unsupported response until a GitHub App owned repo-creation model exists.
- `apps/web/app/api/github/create-repo/_lib/create-repo-workflow.ts` - Remove or leave unreachable the sandbox `git remote add` with token, sandbox `git commit`, and sandbox `git push` workflow. Prefer deleting it if no other callers remain.
- Tests touching `apps/web/app/api/sandbox/route.test.ts`, `packages/sandbox/vercel/sandbox.test.ts`, `apps/web/lib/chat/auto-commit-direct.test.ts`, `apps/web/lib/chat/auto-pr-direct.test.ts`, `apps/web/app/api/github/create-repo/route.test.ts`, and new tests for commit-intent validation and scoped token helpers need to be updated or added.

Verification:
- Unit test commit-intent validation: rejects unsafe paths, invalid modes, oversized bundles, branch movement, unsupported encodings, and unsafe rename old paths.
- Unit test token scoping: commit uses one repository id and only `contents: write`; PR creation uses only the required pull-request/content permissions; tokens are revoked/discarded in `finally` on success and failure.
- Unit test sandbox creation and reconnect: user OAuth tokens are not passed to sandbox credential brokering; no fallback user token is used for clone; network policy never receives a write-capable token.
- Unit test PR actions: create, merge, close, auto-merge, and delete branch no longer call helpers with user OAuth write tokens.
- Unit test create-repo flow: endpoint returns the disabled/unsupported response and no sandbox remote URL contains `x-access-token`; no sandbox `git push` is executed.
- Unit test branch policy: committing from a default/base branch creates or uses a session branch and never updates the default branch ref directly.
- End-to-end manual check: private repo sandbox opens, agent edits files, commit action creates a verified app commit, sandbox does not have GitHub write auth, PR action creates PR, merge action works through broker.
- Run `bun run ci` after implementation.

Acceptance Criteria:
- No sandbox prompt instructs agents to commit or push.
- No sandbox runtime path receives a user OAuth token for GitHub credential brokering.
- No sandbox workflow embeds `x-access-token` in a remote URL for GitHub writes.
- Repo clone/setup may use a repo-scoped `contents: read` installation token, but runtime untrusted work does not retain GitHub auth.
- Existing-repo commits are created only by broker code using repo-scoped GitHub App installation tokens.
- PR create, merge, close, auto-merge, and branch-delete writes are created only by broker code using repo-scoped GitHub App installation tokens.
- In-app repository creation is disabled until it can be implemented without a user-token sandbox push path.
- Fork PR writes are unsupported until they can be represented within the same broker-owned GitHub App boundary.
- Sandbox-originated changes are never committed directly to the repo default branch; they must land on a session branch and reach the default branch through PR merge.
- The broker validates a first-class commit/file bundle before any GitHub write.
- Scoped installation tokens are revoked where possible and otherwise never persisted or exposed to the sandbox.
