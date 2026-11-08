/**
 * The applier: write one planned update into the file its dependency was
 * read from, the way Renovate would edit it, keeping the rest of the file as
 * it was. Lockfiles are left to the job, which runs the package manager.
 */
import { Data } from "effect";
import type { Update } from "./Planner";

export type Edit = Data.TaggedEnum<{
  Edited: { readonly text: string };
  Unsupported: { readonly reason: string };
}>;

export const Edit = Data.taggedEnum<Edit>();

const edited = (text: string) => Edit.Edited({ text });

const unsupported = (reason: string) => Edit.Unsupported({ reason });

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The value an update writes in place of the current one: the new version
 * with the current one's range operator, `v` prefix and precision, such as
 * `^4.1.1` to `^4.1.2` or `22` to `24`. A prerelease such as `0.0.0-alpha.4`
 * takes the new version whole. None for a range it can't carry over.
 */
export const newValue = (current: string, to: string) => {
  const parts =
    /^(?<operator>\^|~|>=|=)?(?<v>v?)(?<version>\d+(?:\.\d+)*)(?<suffix>[-+][\da-z.+-]*)?$/i.exec(
      current,
    )?.groups;

  if (parts?.version === undefined) return undefined;

  const operator = parts.operator ?? "";
  const bare = to.replace(/^v/, "");
  const precision = parts.version.split(".").length;

  const version =
    operator === "" && precision < 3 && parts.suffix === undefined
      ? bare.split(".").slice(0, precision).join(".")
      : bare;

  return `${operator}${parts.v ?? ""}${version}`;
};

/**
 * The value a replacement writes: the current one when it gives no version,
 * otherwise the new version carried over it.
 */
const replacementValue = (update: Update) =>
  update.to === update.dependency.currentValue
    ? update.to
    : newValue(update.dependency.currentValue, update.to);

/** A package.json entry renamed to its replacement, as Renovate's `replace` does. */
const replacePackage = (update: Update, text: string): Edit => {
  const { dependency } = update;

  if (dependency.depType === "packageManager")
    return unsupported("a package manager isn't replaced");

  if (
    dependency.datasource !== "npm" ||
    dependency.depName !== dependency.packageName
  )
    return unsupported("only plain npm entries are replaced");

  const value = replacementValue(update);

  if (value === undefined)
    return unsupported(`can't carry ${dependency.currentValue} over`);

  const pattern = new RegExp(
    `"${escape(dependency.depName)}"(\\s*:\\s*")${escape(dependency.currentValue)}"`,
    "g",
  );

  return edited(
    text.replace(
      pattern,
      `"${update.newName ?? dependency.depName}"$1${value}"`,
    ),
  );
};

/** A package.json entry or `packageManager` field. */
const editPackage = (update: Update, text: string): Edit => {
  const { dependency } = update;

  if (update.updateType === "replacement") return replacePackage(update, text);

  if (dependency.depType === "packageManager") {
    const pattern = new RegExp(
      `("packageManager"\\s*:\\s*"${escape(dependency.depName)}@)${escape(dependency.currentValue)}`,
    );

    return edited(text.replace(pattern, `$1${update.to}`));
  }

  const value =
    update.updateType === "digest"
      ? update.digest?.slice(0, dependency.currentValue.length)
      : dependency.datasource === "npm"
        ? newValue(dependency.currentValue, update.to)
        : update.to;

  if (value === undefined)
    return unsupported(`can't carry ${dependency.currentValue} over`);

  const pattern = new RegExp(
    `("${escape(dependency.depName)}"\\s*:\\s*"[^"]*?)${escape(dependency.currentValue)}"`,
    "g",
  );

  return edited(text.replace(pattern, `$1${value}"`));
};

/** A tool's pin in a mise config, as `name = "1.2.3"` or `{ version = ... }`. */
const editMise = (update: Update, text: string): Edit => {
  const { dependency } = update;
  const value = newValue(dependency.currentValue, update.to);

  if (value === undefined)
    return unsupported(`can't carry ${dependency.currentValue} over`);

  const key = new RegExp(
    `^\\s*(?:"${escape(dependency.depName)}"|'${escape(dependency.depName)}'|${escape(dependency.depName)})\\s*=`,
  );

  // Or its own table, `[tools."name"]` with a `version = ...` line
  const table = new RegExp(
    `^\\s*\\[\\s*tools\\.(?:"${escape(dependency.depName)}"|'${escape(dependency.depName)}'|${escape(dependency.depName)})\\s*\\]`,
  );

  const quoted = new RegExp(`(["'])${escape(dependency.currentValue)}\\1`);
  let inTable = false;

  return edited(
    text
      .split("\n")
      .map((line) => {
        if (/^\s*\[/.test(line)) inTable = table.test(line);

        return key.test(line) || (inTable && /^\s*version\s*=/.test(line))
          ? line.replace(quoted, `$1${value}$1`)
          : line;
      })
      .join("\n"),
  );
};

/**
 * A `uses:` reference: the tag, or the pinned commit and the version comment
 * after it, such as `actions/checkout@<sha> # v7.0.1`.
 */
const editAction = (update: Update, text: string): Edit => {
  const { dependency } = update;
  const pinned = dependency.currentDigest;

  if (update.updateType === "replacement") {
    if (pinned !== undefined)
      return unsupported("a pinned action's replacement needs its own commit");

    const value = replacementValue(update);

    if (value === undefined)
      return unsupported(`can't carry ${dependency.currentValue} over`);

    const pattern = new RegExp(
      `(uses:\\s*["']?)${escape(dependency.depName)}((?:/[^@\\s"']*)?@)${escape(dependency.currentValue)}(?=["']?(?:\\s|$))`,
      "gm",
    );

    return edited(
      text.replace(
        pattern,
        `$1${update.newName ?? dependency.depName}$2${value}`,
      ),
    );
  }

  if (
    (pinned !== undefined || update.updateType === "pinDigest") &&
    update.digest === undefined
  )
    return unsupported("no commit to pin to");

  const uses = `(uses:\\s*["']?${escape(dependency.depName)}(?:/[^@\\s"']*)?@)`;

  if (pinned === undefined) {
    const pattern = new RegExp(
      `${uses}${escape(dependency.currentValue)}(?=["']?(?:\\s|$))`,
      "gm",
    );

    return edited(
      text.replace(
        pattern,
        update.updateType === "pinDigest"
          ? `$1${update.digest} # ${dependency.currentValue}`
          : `$1${update.to}`,
      ),
    );
  }

  const comment =
    update.updateType === "digest" ? dependency.currentValue : update.to;

  const pattern = new RegExp(
    `${uses}${escape(pinned)}(["']?\\s*#\\s*(?:tag=)?)${escape(dependency.currentValue)}(?=\\s|$)`,
    "gm",
  );

  return edited(text.replace(pattern, `$1${update.digest}$2${comment}`));
};

/**
 * A custom regex match, rewritten in place as Renovate does: the digest and
 * the value are swapped within the matched text where they were captured.
 */
const editRegex = (update: Update, text: string): Edit => {
  const { dependency } = update;
  const matched = dependency.replaceString;

  if (matched === undefined || !text.includes(matched))
    return unsupported("the matched text isn't in the file any more");

  let replacement = matched;

  if (dependency.currentDigest !== undefined) {
    if (update.digest === undefined) return unsupported("no commit to pin to");

    replacement = replacement.replaceAll(
      dependency.currentDigest,
      update.digest.slice(0, dependency.currentDigest.length),
    );
  }

  if (
    update.updateType !== "digest" &&
    dependency.currentValue !== "" &&
    replacement.includes(dependency.currentValue)
  )
    replacement = replacement.replaceAll(
      dependency.currentValue,
      newValue(dependency.currentValue, update.to) ?? update.to,
    );

  if (replacement === matched)
    return unsupported("nothing in the match to update");

  return edited(text.replaceAll(matched, replacement));
};

/**
 * A jsonata result, which has no matched text to rewrite: the current value
 * is swapped where it stands, as long as it appears once in the file as a
 * whole value, so a version elsewhere that happens to match isn't touched.
 */
const editJsonata = (update: Update, text: string): Edit => {
  const { dependency } = update;

  if (update.updateType === "digest" || dependency.currentValue === "")
    return unsupported("only versions are updated from a jsonata result");

  const pattern = new RegExp(
    `(?<![\\w.-])${escape(dependency.currentValue)}(?![\\w.-])`,
    "g",
  );

  const found = text.match(pattern)?.length ?? 0;

  if (found !== 1)
    return unsupported(
      `${dependency.currentValue} appears ${found} times in the file`,
    );

  return edited(
    text.replace(
      pattern,
      newValue(dependency.currentValue, update.to) ?? update.to,
    ),
  );
};

/**
 * Write an update into its dependency's file. A lockfile-only update leaves
 * the file as it is, for its package manager to move the lockfile.
 */
export const apply = (update: Update, text: string): Edit => {
  if (update.lockfile) return edited(text);

  if (
    update.updateType === "replacement" &&
    update.dependency.manager !== "npm" &&
    update.dependency.manager !== "bun" &&
    update.dependency.manager !== "github-actions" &&
    (update.dependency.manager !== "mise" ||
      update.newName !== update.dependency.packageName)
  )
    return unsupported(
      `${update.dependency.manager} replacements aren't applied yet`,
    );

  switch (update.dependency.manager) {
    case "npm":
    case "bun":
      return editPackage(update, text);
    case "mise":
      return editMise(update, text);
    case "github-actions":
      return editAction(update, text);
    case "custom.regex":
      return editRegex(update, text);
    case "custom.jsonata":
      return editJsonata(update, text);
    default:
      return unsupported(
        `${update.dependency.manager} updates aren't applied yet`,
      );
  }
};
