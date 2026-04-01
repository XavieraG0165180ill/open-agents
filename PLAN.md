Summary: Clean up the web-layer sandbox model so persistent sandboxes and legacy snapshots are handled through one explicit interpretation instead of mixed heuristics. Keep the current DB columns for now, but confine legacy translation to one boundary/helper layer and update lifecycle, APIs, and UI to consume explicit resume/runtime state.

Context: Key findings from exploration -- existing patterns, relevant files, constraints

- The provider layer is mostly in the right place already: `packages/sandbox/vercel/sandbox.ts`, `packages/sandbox/vercel/connect.ts`, and `packages/sandbox/vercel/state.ts` already support persistent named sandboxes and explicit resume behavior.
- The remaining complexity is in the web app, where raw persisted fields are interpreted in multiple ways:
  - `sandboxState.sandboxId` can mean active runtime identity, paused persistent sandbox, or a migration placeholder.
  - `snapshotUrl` now stores a snapshot ID, but its name still suggests URL semantics.
- Those mixed semantics currently leak across routes, lifecycle logic, and UI:
  - `apps/web/lib/sandbox/utils.ts`
  - `apps/web/lib/sandbox/lifecycle.ts`
  - `apps/web/lib/sandbox/archive-session.ts`
  - `apps/web/app/api/sandbox/route.ts`
  - `apps/web/app/api/sandbox/reconnect/route.ts`
  - `apps/web/app/api/sandbox/status/route.ts`
  - `apps/web/app/api/sandbox/snapshot/route.ts`
  - `apps/web/app/api/sessions/[sessionId]/route.ts`
  - `apps/web/app/api/sessions/[sessionId]/diff/route.ts`
  - `apps/web/app/api/sessions/[sessionId]/files/route.ts`
  - `apps/web/app/api/sessions/[sessionId]/files/content/route.ts`
  - `apps/web/app/api/sessions/[sessionId]/skills/route.ts`
  - `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-context.tsx`
  - `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-content.tsx`
- `apps/web/lib/db/sessions.ts` is already the right place to normalize old stored records (`hybrid -> vercel`), so it is the natural boundary for the next round of cleanup too.
- To keep this pass scoped, we should avoid a SQL migration right now. The physical rename from `snapshotUrl` to `snapshotId` can come after behavior is simplified.

Approach: High-level design decision and why

- Introduce one canonical web-layer interpretation of persisted session sandbox data.
- Keep the raw stored fields for now:
  - `sandboxState.sandboxId` = persistent sandbox name once normalized
  - `sandboxState.expiresAt` = active runtime expiry only
  - `snapshotUrl` = legacy snapshot ID only
- Centralize the legacy/migration translation in a single helper that derives explicit capabilities from a session record, for example:
  - `persistentSandboxName`
  - `hasActiveRuntime`
  - `resumeMode: "persistent" | "legacy-snapshot" | "none"`
  - `legacySnapshotId`
- After that helper exists, routes and UI should stop branching on raw `snapshotUrl`, `hasSnapshot`, `sandboxId.startsWith("session_")`, or mixed `canResumeSandbox` heuristics.
- Keep backward compatibility in API responses during rollout by adding explicit fields first (for example `resumeMode`) and only removing old convenience flags after the UI has switched over.

Changes:
- `apps/web/lib/db/sessions.ts` - keep legacy data normalization at the DB boundary, and add/export the small set of predicates needed to recognize normalized persistent sandbox names.
- `apps/web/lib/sandbox/session-state.ts` - new helper module that derives explicit resume/runtime state from a session record and becomes the canonical interpretation layer for the web app.
- `apps/web/lib/sandbox/utils.ts` - reduce this file to low-level sandbox/runtime helpers; remove app-level resume/persistence decisions that belong in the new session-state helper.
- `apps/web/lib/sandbox/lifecycle.ts` - hibernation decisions should use explicit session-state classification instead of raw `snapshotUrl` / prefix heuristics.
- `apps/web/lib/sandbox/archive-session.ts` - same cleanup for archive finalization and legacy migration behavior.
- `apps/web/app/api/sandbox/route.ts` - stop/delete behavior should use explicit resumable state instead of `snapshotUrl || hasSandboxIdentity(...)` style checks.
- `apps/web/app/api/sandbox/reconnect/route.ts` - report runtime availability without collapsing persistent identity and legacy resume paths into the same implicit branch logic.
- `apps/web/app/api/sandbox/status/route.ts` - compute active vs resumable vs missing from explicit derived state; avoid heuristic recovery logic where possible.
- `apps/web/app/api/sandbox/snapshot/route.ts` - keep legacy snapshot restore support, but drive it through explicit `resumeMode` semantics instead of mixed fallback behavior.
- `apps/web/app/api/sessions/[sessionId]/route.ts` - unarchive guard should use explicit resume capability instead of `snapshotUrl` plus runtime checks.
- `apps/web/app/api/sessions/[sessionId]/diff/route.ts` - preserve resumable identity when runtime is unavailable, and return the right resume-needed response from explicit derived state.
- `apps/web/app/api/sessions/[sessionId]/files/route.ts` - same cleanup.
- `apps/web/app/api/sessions/[sessionId]/files/content/route.ts` - same cleanup.
- `apps/web/app/api/sessions/[sessionId]/skills/route.ts` - same cleanup.
- `apps/web/lib/skills-cache.ts` - scope cached skills from the normalized persistent sandbox name first, with legacy snapshot fallback only when truly needed.
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-context.tsx` - consume explicit resume/runtime state from the APIs instead of rebuilding it locally.
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-content.tsx` - replace `canResumeSandbox` / `hasSnapshot` UI heuristics with explicit `resumeMode` and runtime flags.
- Tests to update alongside the implementation:
  - `apps/web/app/api/sandbox/route.test.ts`
  - `apps/web/app/api/sandbox/reconnect/route.test.ts`
  - `apps/web/app/api/sandbox/status/route.test.ts`
  - `apps/web/app/api/sandbox/snapshot/route.test.ts`
  - `apps/web/lib/sandbox/lifecycle-evaluate.test.ts`
  - `apps/web/lib/sandbox/archive-session.test.ts`
  - `apps/web/app/api/sessions/[sessionId]/files/content/route.test.ts`
  - `apps/web/app/api/sessions/[sessionId]/skills/route.test.ts`
  - any affected tests for `files/route.ts`, session unarchive flow, and chat context/UI state handling

Verification:
- Unit/API tests should prove:
  - persistent sandbox identity survives pause/stop/archive
  - legacy snapshot-backed sessions still resume correctly
  - routes no longer infer resumability from mixed raw fields
  - UI shows paused/resumable state from explicit server data, not client heuristics
- After implementation, run:
  - `bun run check`
  - `bun run typecheck`
  - `bun run test:isolated`
  - `bun run --cwd apps/web db:check`
- Targeted regression tests to watch closely during iteration:
  - `bun run test:verbose apps/web/app/api/sandbox/reconnect/route.test.ts`
  - `bun run test:verbose apps/web/app/api/sandbox/status/route.test.ts`
  - `bun run test:verbose apps/web/lib/sandbox/lifecycle-evaluate.test.ts`
  - `bun run test:verbose apps/web/lib/sandbox/archive-session.test.ts`
  - `bun run test:verbose packages/sandbox/vercel/sandbox.test.ts`

Open note:
- In this pass, behavior cleanup comes first. The physical schema/API rename from `snapshotUrl` to `snapshotId` should be a follow-up once the app stops depending on the old overloaded semantics.