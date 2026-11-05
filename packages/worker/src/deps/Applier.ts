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
 * `^4.1.1` to `^4.1.2` or `22` to `24`. None for a range it can't carry over.
 */
export const newValue = (current: string, to: string) => {
  const parts =
    /^(?<operator>\^|~|>=|=)?(?<v>v?)(?<version>\d+(?:\.\d+)*)$/.exec(
      current,
    )?.groups;

  if (parts?.version === undefined) return undefined;

  const operator = parts.operator ?? "";
  const bare = to.replace(/^v/, "");
  const precision = parts.version.split(".").length;

  const version =
    operator === "" && precision < 3
      ? bare.split(".").slice(0, precision).join(".")
      : bare;

  return `${operator}${parts.v ?? ""}${version}`;
};

/** A package.json entry or `packageManager` field. */
const editPackage = (update: Update, text: string): Edit => {
  const { dependency } = update;

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

  const quoted = new RegExp(`(["'])${escape(dependency.currentValue)}\\1`);

  return edited(
    text
      .split("\n")
      .map((line) =>
        key.test(line) ? line.replace(quoted, `$1${value}$1`) : line,
      )
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

/** Write an update into its dependency's file. */
export const apply = (update: Update, text: string): Edit => {
  if (update.lockfile)
    return unsupported("lockfile-only updates aren't applied yet");

  switch (update.dependency.manager) {
    case "npm":
    case "bun":
      return editPackage(update, text);
    case "mise":
      return editMise(update, text);
    case "github-actions":
      return editAction(update, text);
    default:
      return unsupported(
        `${update.dependency.manager} updates aren't applied yet`,
      );
  }
};
