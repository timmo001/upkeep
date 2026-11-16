/**
 * Which GitHub releases' notes an update takes in, and that runs on one
 * worker share their lookups.
 */
import { Gh } from "@timmo001/effect-gh";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Datasources, Lookups, notesBetween } from "./Datasources";
import type { Dependency, Release } from "./Policy";

test("runs on a worker share what one of them looked up", async () => {
  let fetched = 0;

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      fetched += 1;

      return HttpClientResponse.fromWeb(request, new Response("1.0.0\n1.1.0"));
    }),
  );

  const unused = Effect.die("gh isn't read for a custom datasource");

  const gh = Gh.of({
    execute: () => unused,
    json: () => unused,
    stream: () => Stream.die("unused"),
    interactive: () => unused,
  });

  const dependency: Dependency = {
    manager: "regex",
    file: "versions.txt",
    depName: "thing",
    packageName: "thing",
    datasource: "custom.things",
    depType: "dependencies",
    currentValue: "1.0.0",
  };

  const custom = {
    things: {
      registryUrlTemplate: "https://example.test/{{packageName}}",
      format: "plain",
      transformTemplates: [],
    },
  };

  // Each run builds its own datasources, as a deps run does
  const run = Datasources.use((datasources) =>
    datasources.lookup(dependency, custom),
  ).pipe(Effect.provide(Datasources.layer));

  const [first, second] = await Effect.runPromise(
    Effect.all([run, run]).pipe(
      Effect.provide(Lookups.layer),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Gh, gh),
          Layer.succeed(HttpClient.HttpClient, http),
          // Kept reads and writes nothing, so the real cache is left alone
          FileSystem.layerNoop({
            readFileString: () => Effect.succeed("{}"),
            makeDirectory: () => Effect.void,
            writeFileString: () => Effect.void,
            rename: () => Effect.void,
          }),
          Path.layer,
        ),
      ),
    ),
  );

  expect(first?.releases.map((release) => release.version)).toEqual([
    "1.0.0",
    "1.1.0",
  ]);
  expect(second).toEqual(first);
  expect(fetched).toBe(1);
});

const release = (version: string, notes: string): Release => ({
  version,
  notes,
  url: `https://github.com/owner/name/releases/tag/${version}`,
});

test("the notes of each release after the version in use, up to the new one", () => {
  const releases = [
    release("v1.6.0", "Too new"),
    release("v1.5.0", "- Add a colour option"),
    release("v1.4.1", ""),
    release("v1.4.0", "- Removed `foo`"),
    release("v1.3.0", "Already in use"),
  ];

  expect(
    notesBetween("owner/name", releases, "name", "1.3.0", "1.5.0"),
  ).toEqual({
    text: "- Add a colour option\n\n- Removed `foo`",
    url: "https://github.com/owner/name/releases/tag/v1.5.0",
    compare: "https://github.com/owner/name/compare/v1.3.0...v1.5.0",
  });
});

test("a monorepo's releases are matched by the package's name", () => {
  const releases = [
    release("@scope/other@2.1.0", "Breaking: not this one"),
    release("@scope/pkg@2.1.0", "- Fixes"),
  ];

  expect(
    notesBetween("owner/name", releases, "@scope/pkg", "^2.0.0", "2.1.0")?.text,
  ).toBe("- Fixes");
});

test("no release for the new version means the notes couldn't be read", () => {
  expect(
    notesBetween(
      "owner/name",
      [release("v1.4.0", "")],
      "name",
      "1.3.0",
      "1.5.0",
    ),
  ).toBeUndefined();
  expect(
    notesBetween(
      "owner/name",
      [release("v1.5.0", "")],
      "name",
      "1.3.0",
      "1.5.0",
    )?.text,
  ).toBe("");
});
