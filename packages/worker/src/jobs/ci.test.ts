/** How the ci job reads a default branch and its failure notifications. */
import { expect, test } from "bun:test";
import type { Workflow } from "@timmo001/effect-gh";
import { failureOf, latest } from "./ci";

const run = (
  workflowName: string,
  conclusion: string | null,
  extra: Partial<Workflow.Run> = {},
): Workflow.Run => ({
  databaseId: 1,
  attempt: 1,
  headBranch: "main",
  headSha: "abc1234",
  status: "completed",
  conclusion,
  url: "https://github.com/owner/name/actions/runs/1",
  workflowName,
  name: workflowName,
  event: "push",
  ...extra,
});

const active = new Set(["Build", "Lint", "Docs"]);

test("only the latest finished run of each workflow counts", () => {
  const { failed, passing } = latest(
    [
      run("Build", "success"),
      run("Build", "failure"),
      run("Lint", "failure"),
      run("Docs", null, { status: "in_progress" }),
      run("Docs", "success"),
    ],
    active,
  );

  expect(failed.map((item) => item.workflowName)).toEqual(["Lint"]);
  expect([...passing].toSorted()).toEqual(["Build", "Docs"]);
});

test("cancelled and pull request runs say nothing about the branch", () => {
  const { failed, passing } = latest(
    [
      run("Build", "cancelled"),
      run("Build", "failure", { event: "pull_request" }),
      run("Build", "failure"),
    ],
    active,
  );

  expect(failed).toHaveLength(1);
  expect(passing.size).toBe(0);
});

test("a workflow since removed or turned off doesn't count", () => {
  const { failed } = latest(
    [run("Build", "success"), run("Tooling drift", "failure")],
    active,
  );

  expect(failed).toHaveLength(0);
});

test("a failure notification names its workflow and branch", () => {
  expect(failureOf("Build workflow run failed for main branch")).toEqual({
    workflow: "Build",
    branch: "main",
  });
  expect(failureOf("Fix the build")).toBeUndefined();
});
