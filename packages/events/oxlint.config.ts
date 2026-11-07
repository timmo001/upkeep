/** Oxlint config: the shared Effect preset with type-aware rules and type checking. */
import recommendedEffect from "@timmo001/oxlint-rules/configs/recommended-effect";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [recommendedEffect],
  options: {
    typeAware: true,
    typeCheck: true,
    maxWarnings: 0,
  },
  ignorePatterns: [".agents/**", ".opencode/**", ".wrangler/**", "dist/**"],
});
