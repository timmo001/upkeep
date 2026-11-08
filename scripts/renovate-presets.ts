/**
 * Write Renovate's built-in presets and its manager names, at the release
 * pinned below, to packages/worker/src/deps/renovate-presets.json. Upkeep
 * reads Renovate configs without running Renovate, so it needs the presets
 * they extend as data, and the managers so config for one it doesn't read
 * can be left out. Run it with `mise run renovate-presets` after moving the
 * pin.
 */
import { $ } from "bun";

const version = "44.210.0";
const output = new URL(
  "../packages/worker/src/deps/renovate-presets.json",
  import.meta.url,
);

const checkout = (await $`mktemp -d`.text()).trim();

try {
  await $`git -c advice.detachedHead=false clone --quiet --depth 1 --branch ${version} --filter=blob:none --sparse https://github.com/renovatebot/renovate.git ${checkout}`;
  await $`git -C ${checkout} sparse-checkout set --no-cone /lib/config/presets/internal/ /lib/data/ /lib/util/array.ts /lib/config/types.ts`;

  const { groups } = (await import(
    `${checkout}/lib/config/presets/internal/index.ts`
  )) as { groups: Record<string, Record<string, unknown>> };

  // Each manager has its own directory; `custom` holds the custom managers,
  // which configs name under customManagers instead
  const managers = (
    await $`git -C ${checkout} ls-tree -d --name-only HEAD lib/modules/manager/`.text()
  )
    .split("\n")
    .map((path) => path.replace("lib/modules/manager/", ""))
    .filter((name) => name !== "" && name !== "custom");

  await Bun.write(output, `${JSON.stringify({ version, managers, groups })}\n`);
  console.log(
    `Wrote Renovate ${version}'s presets and ${managers.length} managers to ${output.pathname}`,
  );
} finally {
  await $`rm -rf ${checkout}`;
}
