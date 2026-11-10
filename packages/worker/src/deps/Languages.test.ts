/**
 * The go.mod, Gradle and requirements managers: what they read, how their
 * edits land, and how PEP 440 versions compare.
 */
import { expect, test } from "bun:test";
import { apply, Edit } from "./Applier";
import { extractGoMod, extractGradle, extractRequirements } from "./Managers";
import { compareVersions, parseVersion, type Update } from "./Planner";
import type { Dependency } from "./Policy";

const update = (dependency: Dependency, to: string): Update => ({
  dependency,
  updateType: "minor",
  from: dependency.currentValue,
  to,
  settings: {},
  branch: "branch",
  lockfile: false,
});

const text = (edit: Edit) =>
  Edit.$match(edit, {
    Edited: ({ text }) => text,
    Unsupported: ({ reason }) => `unsupported: ${reason}`,
  });

const goMod = `module example.com/app

go 1.26.0

toolchain go1.27.3

require (
\tgithub.com/google/uuid v1.6.0
\tgithub.com/pkg/browser v0.0.0-20240102092130-5ac0b6a4141c
\tgithub.com/local/fork v1.0.0
\tgolang.org/x/net v0.62.0 // indirect
)

require github.com/gorilla/websocket v1.5.3

replace github.com/local/fork => ../fork
`;

test("go.mod gives direct releases and the toolchain, not indirect, pseudo or replaced modules", () => {
  const { dependencies } = extractGoMod("go.mod", goMod);

  expect(
    dependencies.map((dependency) => [
      dependency.depName,
      dependency.currentValue,
    ]),
  ).toEqual([
    ["go", "1.27.3"],
    ["github.com/google/uuid", "v1.6.0"],
    ["github.com/gorilla/websocket", "v1.5.3"],
  ]);
});

test("a go.mod edit moves only its own module and the toolchain line", () => {
  const [toolchain, uuid, websocket] = extractGoMod(
    "go.mod",
    goMod,
  ).dependencies;

  const moved = [
    toolchain && update(toolchain, "1.28.0"),
    uuid && update(uuid, "v1.7.0"),
    websocket && update(websocket, "v1.6.0"),
  ].reduce(
    (current, next) =>
      next === undefined ? current : text(apply(next, current)),
    goMod,
  );

  expect(moved).toContain("toolchain go1.28.0");
  expect(moved).toContain("\tgithub.com/google/uuid v1.7.0");
  expect(moved).toContain("require github.com/gorilla/websocket v1.6.0");
  expect(moved).toContain("go 1.26.0");
  expect(moved).toContain("golang.org/x/net v0.62.0 // indirect");
});

const gradle = `plugins {
  id("com.android.application") version "9.5.1" apply false
  id 'com.android.library' version '9.5.1' apply false
}

dependencies {
  classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
  implementation("androidx.core:core:1.19.1")
  implementation("androidx.core:core:1.19.1")
  implementation("com.example:dynamic:1.+")
  implementation("com.example:variable:$version")
}
`;

test("Gradle scripts give their artifacts and plugins, once each, with literal versions only", () => {
  const { dependencies } = extractGradle("build.gradle.kts", gradle);

  expect(
    dependencies.map((dependency) => [
      dependency.depName,
      dependency.datasource,
      dependency.currentValue,
    ]),
  ).toEqual([
    ["org.jetbrains.kotlin:kotlin-gradle-plugin", "maven", "2.4.21"],
    ["androidx.core:core", "maven", "1.19.1"],
    ["com.android.application", "gradle-plugin", "9.5.1"],
    ["com.android.library", "gradle-plugin", "9.5.1"],
  ]);
});

test("a Gradle edit moves every copy of its artifact and only its own plugin", () => {
  const dependencies = extractGradle("build.gradle.kts", gradle).dependencies;

  const core = dependencies.find(
    ({ depName }) => depName === "androidx.core:core",
  );

  const library = dependencies.find(
    ({ depName }) => depName === "com.android.library",
  );

  if (core === undefined || library === undefined) throw new Error("not read");

  const moved = text(
    apply(
      update(library, "9.6.0"),
      text(apply(update(core, "1.20.0"), gradle)),
    ),
  );

  expect(moved.match(/androidx\.core:core:1\.20\.0/g)?.length).toBe(2);
  expect(moved).toContain(`id 'com.android.library' version '9.6.0'`);
  expect(moved).toContain(`id("com.android.application") version "9.5.1"`);
});

test("requirements give exact pins, and an edit moves only its own", () => {
  const requirements =
    "-r base.txt\npytest==9.2.0\npytest-asyncio==1.4.1.post1\nruff>=0.17\nuvicorn[standard]==0.30.0 ; python_version >= '3.12'\n";

  const dependencies = extractRequirements(
    "requirements_test.txt",
    requirements,
  ).dependencies;

  expect(
    dependencies.map((dependency) => [
      dependency.depName,
      dependency.currentValue,
    ]),
  ).toEqual([
    ["pytest", "9.2.0"],
    ["pytest-asyncio", "1.4.1.post1"],
    ["uvicorn", "0.30.0"],
  ]);

  const [pytest] = dependencies;

  if (pytest === undefined) throw new Error("not read");

  const moved = text(apply(update(pytest, "9.3.0"), requirements));

  expect(moved).toContain("pytest==9.3.0\n");
  expect(moved).toContain("pytest-asyncio==1.4.1.post1\n");
});

test("PEP 440 orders post releases after theirs and reads rc and dev as prereleases", () => {
  const read = (version: string) => {
    const parsed = parseVersion(version, "pep440");

    if (parsed === undefined) throw new Error(`can't read ${version}`);

    return parsed;
  };

  expect(compareVersions(read("1.4.1.post1"), read("1.4.1"))).toBeGreaterThan(
    0,
  );
  expect(compareVersions(read("1.5.0"), read("1.4.1.post1"))).toBeGreaterThan(
    0,
  );
  expect(read("2.0.0rc1").prerelease).toBe("rc1");
  expect(read("2.0.0.dev3").prerelease).toBe("dev3");
  expect(read("2.0").parts).toEqual([2, 0, 0]);
});
