/** Which update pull requests the stalled-updates job takes over. */
import { expect, test } from "bun:test";
import { checksOf, leftBecause, type PullRequest } from "./stalled-updates";

const pr: PullRequest = {
  number: 12,
  title: "Update dependency effect to v4.2.0",
  html_url: "https://github.com/owner/name/pull/12",
  draft: false,
  mergeable: true,
  user: { login: "renovate[bot]" },
  head: {
    ref: "deps/effect",
    sha: "abc",
    repo: { full_name: "owner/name" },
  },
  base: {
    ref: "main",
    repo: {
      full_name: "owner/name",
      default_branch: "main",
      archived: false,
      fork: false,
    },
  },
};

const run = (status: string, conclusion: string | null) => ({
  status,
  conclusion,
});

test("checks fail only once every run has finished and one didn't pass", () => {
  expect(checksOf([])).toBe("none");
  expect(
    checksOf([run("completed", "failure"), run("in_progress", null)]),
  ).toBe("pending");
  expect(
    checksOf([run("completed", "success"), run("completed", "skipped")]),
  ).toBe("passed");
  expect(
    checksOf([run("completed", "success"), run("completed", "failure")]),
  ).toBe("failed");
});

test("an update into the default branch with failed checks is taken over, whatever its branch prefix", () => {
  expect(leftBecause(pr, "failed")).toBeUndefined();
  expect(
    leftBecause(
      { ...pr, mergeable: null, user: { login: "dependabot[bot]" } },
      "failed",
    ),
  ).toBeUndefined();
});

test("anything its updater can still merge or rebase, or isn't a plain update, is left", () => {
  expect(leftBecause(pr, "passed")).toBeDefined();
  expect(leftBecause(pr, "pending")).toBeDefined();
  expect(leftBecause(pr, "none")).toBeDefined();
  expect(leftBecause({ ...pr, draft: true }, "failed")).toBeDefined();
  expect(leftBecause({ ...pr, mergeable: false }, "failed")).toBeDefined();
  expect(
    leftBecause({ ...pr, title: `${pr.title} - abandoned` }, "failed"),
  ).toBeDefined();
  expect(
    leftBecause({ ...pr, title: "Configure Renovate" }, "failed"),
  ).toBeDefined();
  expect(
    leftBecause(
      { ...pr, head: { ...pr.head, ref: "renovate/configure" } },
      "failed",
    ),
  ).toBeDefined();
  expect(
    leftBecause(
      { ...pr, head: { ...pr.head, repo: { full_name: "fork/name" } } },
      "failed",
    ),
  ).toBeDefined();
  expect(
    leftBecause({ ...pr, base: { ...pr.base, ref: "next" } }, "failed"),
  ).toBeDefined();
});
