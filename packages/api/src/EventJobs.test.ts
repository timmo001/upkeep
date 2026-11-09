/** Which jobs each GitHub event asks for. */
import { expect, test } from "bun:test";
import type { GitHubEvent } from "./Domain";
import { runsFor } from "./EventJobs";

const push = (
  repo: string,
  paths: ReadonlyArray<string>,
  overrides: Partial<GitHubEvent> = {},
): GitHubEvent => ({
  delivery: "d",
  event: "push",
  action: null,
  repo,
  defaultBranch: "main",
  sender: "timmo001",
  ref: "refs/heads/main",
  paths,
  truncated: false,
  release: null,
  workflow: null,
  at: 1,
  ...overrides,
});

const jobs = (event: GitHubEvent) =>
  runsFor(event).map(({ job, repo }) => `${job}:${repo ?? "all"}`);

test("a push to the default branch watches and syncs the repository", () => {
  expect(jobs(push("timmo001/app", ["src/a.ts"]))).toEqual([
    "watch:timmo001/app",
    "sync:timmo001/app",
  ]);
});

test("a push that changes the dependency config or tooling.yml runs deps or drift", () => {
  expect(jobs(push("timmo001/app", [".github/renovate.json5"]))).toContain(
    "deps:timmo001/app",
  );
  expect(jobs(push("timmo001/app", ["tooling.yml"]))).toContain(
    "drift:timmo001/app",
  );
  // Past the paths an event carries, either could have changed
  expect(jobs(push("timmo001/app", [], { truncated: true }))).toEqual([
    "watch:timmo001/app",
    "sync:timmo001/app",
    "deps:timmo001/app",
    "drift:timmo001/app",
  ]);
});

test("groundwork syncs every app, and the skills repository syncs its consumers", () => {
  expect(jobs(push("timmo001/groundwork", []))).toContain("sync:all");
  expect(jobs(push("timmo001/skills", []))).toContain("skill-consumers:all");
});

test("a push to another branch asks for nothing", () => {
  expect(jobs(push("timmo001/app", [], { ref: "refs/heads/fix" }))).toEqual([]);
});

test("a workflow run reads CI only once it completes on the default branch", () => {
  const run = (branch: string, action: string) =>
    jobs(
      push("timmo001/app", [], {
        event: "workflow_run",
        action,
        ref: null,
        workflow: { name: "CI", branch, conclusion: "failure" },
      }),
    );

  expect(run("main", "completed")).toEqual(["ci:timmo001/app"]);
  expect(run("main", "requested")).toEqual([]);
  expect(run("fix", "completed")).toEqual([]);
});

test("a successful package publish upgrades every worker's first-party packages", () => {
  const publish = (name: string, conclusion: string) =>
    jobs(
      push("timmo001/arch-repo", [], {
        event: "workflow_run",
        action: "completed",
        ref: null,
        workflow: { name, branch: "main", conclusion },
      }),
    );

  // The event carries the run's name, which names the package
  expect(publish("Publish system-bridge-git", "success")).toEqual([
    "ci:timmo001/arch-repo",
    "up-first-party:all",
  ]);
  expect(publish("Publish package", "success")).toEqual([
    "ci:timmo001/arch-repo",
    "up-first-party:all",
  ]);
  expect(publish("Publish upkeep-git", "failure")).toEqual([
    "ci:timmo001/arch-repo",
  ]);
  expect(publish("Lint", "success")).toEqual(["ci:timmo001/arch-repo"]);
  expect(publish("Purge package cache", "success")).toEqual([
    "ci:timmo001/arch-repo",
  ]);
});
