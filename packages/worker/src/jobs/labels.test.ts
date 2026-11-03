/** How the label job matches a repository's labels to the manifest's. */
import { expect, test } from "bun:test";
import { Change, plan } from "./labels";

const bug = { name: "Bug", color: "d73a4a", description: "Something broke" };

test("an alias renames the label in place rather than creating a new one", () => {
  const changes = plan(
    [{ ...bug, name: "Bug Fix", aliases: ["bugfix"] }],
    [{ ...bug, name: "bugfix" }],
  );

  expect(changes).toEqual([
    Change.Update({ from: "bugfix", label: { ...bug, name: "Bug Fix" } }),
  ]);
});

test("a label that already matches is left alone, ignoring color case", () => {
  expect(plan([bug], [{ ...bug, color: "D73A4A" }])).toEqual([]);
});

test("a name differing only in case is fixed, and unclaimed labels are unknown", () => {
  const changes = plan(
    [bug],
    [
      { ...bug, name: "bug" },
      { ...bug, name: "wontfix" },
    ],
  );

  expect(changes).toEqual([
    Change.Update({ from: "bug", label: bug }),
    Change.Unknown({ name: "wontfix" }),
  ]);
});

test("a kebab-case name is renamed to the manifest's", () => {
  const web = { ...bug, name: "Web UI" };

  expect(plan([web], [{ ...web, name: "web-ui" }])).toEqual([
    Change.Update({ from: "web-ui", label: web }),
  ]);
});

test("a missing label is created", () => {
  expect(plan([bug], [])).toEqual([Change.Create({ label: bug })]);
});

test("a label on the keep list is never unknown", () => {
  expect(
    plan([], [{ ...bug, name: "hacktoberfest" }], ["Hacktoberfest"]),
  ).toEqual([]);
});
