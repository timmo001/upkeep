/** The upkeep docs site, built on the shared docs-kit defaults. */
import { docsConfig } from "@timmo001/docs-kit/blume";
import { defineConfig } from "blume";

export default defineConfig(
  docsConfig({
    title: "upkeep",
    description:
      "Keeps my repositories and their consumers up to date, and shows what needs doing.",
    site: "upkeep.timmo.dev",
    github: { owner: "timmo001", repo: "upkeep" },
    navigation: {
      sidebar: ["/"],
    },
  }),
);
