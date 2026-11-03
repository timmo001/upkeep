/**
 * The version of this build: the release for the Home Assistant app, the
 * package version for `upkeep-git`, or `dev` when built or run from source.
 * The build inlines `UPKEEP_BUILD_VERSION` through `bun build --env`.
 */
export const version = process.env.UPKEEP_BUILD_VERSION ?? "dev";
