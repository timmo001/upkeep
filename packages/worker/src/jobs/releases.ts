/**
 * The releases job: read the latest release of each repository I own through
 * `gh`, and report them so the server queues the jobs that run on a new one.
 * Forks, archived repositories and ones without a release are skipped.
 */
import { Graphql } from "@timmo001/effect-gh";
import type { Domain } from "@upkeep/api";
import { Effect, Schema } from "effect";
import * as RunLog from "../RunLog";
import { Reporter } from "../Reporter";

const document = `
  query ($after: String) {
    viewer {
      repositories(
        first: 100
        after: $after
        ownerAffiliations: OWNER
        isFork: false
        orderBy: { field: NAME, direction: ASC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          nameWithOwner
          isArchived
          latestRelease { tagName url }
        }
      }
    }
  }
`;

const Page = Schema.Struct({
  viewer: Schema.Struct({
    repositories: Schema.Struct({
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
      nodes: Schema.Array(
        Schema.Struct({
          nameWithOwner: Schema.String,
          isArchived: Schema.Boolean,
          latestRelease: Schema.NullOr(
            Schema.Struct({ tagName: Schema.String, url: Schema.String }),
          ),
        }),
      ),
    }),
  }),
});

/** The latest release of each repository I own, by name. */
const latestReleases = Effect.fnUntraced(function* () {
  const releases: Array<Domain.Release> = [];
  let after: string | null = null;

  do {
    const page: typeof Page.Type = yield* Graphql.query(
      document,
      { after },
      Page,
    );

    const { nodes, pageInfo } = page.viewer.repositories;

    for (const node of nodes) {
      if (node.isArchived || node.latestRelease === null) continue;

      releases.push({
        repo: node.nameWithOwner,
        tag: node.latestRelease.tagName,
        url: node.latestRelease.url,
      });
    }

    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after !== null);

  return releases;
});

export const releases = Effect.fnUntraced(function* () {
  const reporter = yield* Reporter;
  const found = yield* latestReleases();

  yield* RunLog.info(
    `Found the latest release of ${found.length} repositories`,
  );

  const queued = yield* reporter.releases(found);

  for (const run of queued) {
    yield* RunLog.info(
      `Queued ${run.job} for ${run.release?.repo}@${run.release?.tag}`,
    );
  }

  if (queued.length === 0) yield* RunLog.info("Queued nothing");
});
