/** Layout overrides from docs-kit. Blume reads this file without running it, so import components directly. */
import HomeBanner from "@timmo001/docs-kit/blume/home-banner.astro";
import { defineComponents } from "blume";
import HeaderSearch from "./header-search.astro";

export default defineComponents({
  layout: {
    PageHeader: HomeBanner,
    Search: HeaderSearch,
  },
});
