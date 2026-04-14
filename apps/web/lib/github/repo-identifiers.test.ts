import { describe, expect, test } from "bun:test";

import {
  buildGitHubAuthRemoteUrl,
  buildGitHubRepoUrl,
  isValidGitHubRepoName,
  isValidGitHubRepoOwner,
  parseGitHubRepoUrl,
  redactGitHubToken,
} from "./repo-identifiers";

describe("repo-identifiers", () => {
  test("accepts safe GitHub owner and repo segments", () => {
    expect(isValidGitHubRepoOwner("vercel")).toBe(true);
    expect(isValidGitHubRepoOwner("vercel-labs")).toBe(true);
    expect(isValidGitHubRepoName("open-harness")).toBe(true);
    expect(isValidGitHubRepoName("open_harness.v2")).toBe(true);
  });

  test("rejects unsafe GitHub owner and repo segments", () => {
    expect(isValidGitHubRepoOwner('vercel" && echo nope && "')).toBe(false);
    expect(isValidGitHubRepoName("open harness")).toBe(false);
  });

  test("builds a canonical repo url for valid coordinates", () => {
    expect(buildGitHubRepoUrl({ owner: "vercel", repo: "open-harness" })).toBe(
      "https://github.com/vercel/open-harness",
    );
  });

  test("parses https and ssh GitHub repo urls into canonical coordinates", () => {
    expect(
      parseGitHubRepoUrl("https://github.com/vercel/open-harness.git"),
    ).toEqual({
      owner: "vercel",
      repo: "open-harness",
      canonicalUrl: "https://github.com/vercel/open-harness",
    });

    expect(
      parseGitHubRepoUrl("git@github.com:vercel/open-harness.git"),
    ).toEqual({
      owner: "vercel",
      repo: "open-harness",
      canonicalUrl: "https://github.com/vercel/open-harness",
    });
  });

  test("rejects non-GitHub or nested GitHub repo urls", () => {
    expect(
      parseGitHubRepoUrl("https://github.com.evil.com/vercel/open-harness"),
    ).toBeNull();
    expect(
      parseGitHubRepoUrl("https://github.com/vercel/open-harness/tree/main"),
    ).toBeNull();
  });

  test("builds an encoded auth remote url for valid coordinates", () => {
    expect(
      buildGitHubAuthRemoteUrl({
        token: "ghp token/with?chars",
        owner: "vercel",
        repo: "open-harness",
      }),
    ).toBe(
      "https://x-access-token:ghp%20token%2Fwith%3Fchars@github.com/vercel/open-harness.git",
    );
  });

  test("returns null when the owner or repo is unsafe", () => {
    expect(
      buildGitHubAuthRemoteUrl({
        token: "ghp_test",
        owner: 'vercel" && echo nope && "',
        repo: "open-harness",
      }),
    ).toBeNull();
  });

  test("redacts authenticated GitHub urls in text", () => {
    expect(
      redactGitHubToken(
        "fatal: unable to access https://x-access-token:ghp_secret@github.com/vercel/open-harness.git",
      ),
    ).toContain(
      "https://x-access-token:***@github.com/vercel/open-harness.git",
    );
  });
});
