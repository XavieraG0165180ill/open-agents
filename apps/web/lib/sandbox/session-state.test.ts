import { describe, expect, test } from "bun:test";
import {
  buildSessionSandboxName,
  getSessionSandboxState,
} from "./session-state";

describe("getSessionSandboxState", () => {
  test("classifies active legacy runtime without a resume source", () => {
    expect(
      getSessionSandboxState({
        id: "session-1",
        sandboxState: {
          type: "vercel",
          sandboxId: "sbx-legacy-1",
          expiresAt: 123,
        },
        snapshotUrl: null,
      }),
    ).toMatchObject({
      hasSandboxIdentity: true,
      hasActiveRuntime: true,
      hasPersistentSandbox: false,
      hasLegacySnapshot: false,
      resumeMode: "none",
      canResume: false,
    });
  });

  test("classifies a paused persistent sandbox as resumable", () => {
    expect(
      getSessionSandboxState({
        id: "session-1",
        sandboxState: {
          type: "vercel",
          sandboxId: buildSessionSandboxName("session-1"),
        },
        snapshotUrl: null,
      }),
    ).toMatchObject({
      persistentSandboxName: "session_session-1",
      resumeTargetSandboxName: "session_session-1",
      hasActiveRuntime: false,
      hasPersistentSandbox: true,
      resumeMode: "persistent",
      canResume: true,
    });
  });

  test("classifies a legacy snapshot without persistent identity", () => {
    expect(
      getSessionSandboxState({
        id: "session-1",
        sandboxState: { type: "vercel" },
        snapshotUrl: "snap-legacy-1",
      }),
    ).toMatchObject({
      persistentSandboxName: null,
      resumeTargetSandboxName: "session_session-1",
      legacySnapshotId: "snap-legacy-1",
      hasLegacySnapshot: true,
      resumeMode: "legacy-snapshot",
      canResume: true,
    });
  });

  test("prefers persistent resume mode when both persistent identity and legacy snapshot exist", () => {
    expect(
      getSessionSandboxState({
        id: "session-1",
        sandboxState: {
          type: "vercel",
          sandboxId: "session_session-1",
        },
        snapshotUrl: "snap-legacy-1",
      }),
    ).toMatchObject({
      persistentSandboxName: "session_session-1",
      legacySnapshotId: "snap-legacy-1",
      resumeMode: "persistent",
      canResume: true,
    });
  });
});
