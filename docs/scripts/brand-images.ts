/**
 * Renders the PNG branding (social preview, logo and Apple touch icon) from
 * `src/assets/logo.svg`. Run it with `bun run brand`.
 *
 * @module
 */
import { writeBrandImages } from "@timmo001/docs-kit";

const written = await writeBrandImages({
  logo: "src/assets/logo.svg",
  title: "Upkeep",
  tagline: ["Keeps my repositories and", "their consumers up to date."],
  site: "upkeep.timmo.dev",
  // Groundwork's Glazing theme, Upkeep's starting point until its own design
  background: "#1b1d29",
  accent: "#749bee",
  outputs: {
    socialPreview: "../.github/social-preview.png",
    logo: "public/logo.png",
    appleTouchIcon: "public/apple-touch-icon.png",
  },
});

for (const file of written) console.log(`Wrote ${file}`);
