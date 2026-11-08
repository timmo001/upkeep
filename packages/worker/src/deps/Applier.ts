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

  return within(text, dependency.parents, (part) =>
    edited(
      part.replace(
        pattern,
        `"${update.newName ?? dependency.depName}"$1${value}"`,
      ),
    ),
  );
};

/** Where the JSON string opening at `start` closes. */
const stringEnd = (text: string, start: number) => {
  let index = start + 1;

  while (index < text.length && text[index] !== '"')
    index += text[index] === "\\" ? 2 : 1;

  return index;
};

/** Where the JSON object or array opening at `open` closes. */
const closing = (text: string, open: number) => {
  let depth = 0;

  for (let index = open; index < text.length; index++) {
    const char = text[index];

    if (char === '"') index = stringEnd(text, index);
    else if (char === "{" || char === "[") depth++;
    else if ((char === "}" || char === "]") && --depth === 0) return index;
  }

  return undefined;
};

/**
 * The braces of the object `key` holds in the object between `open` and
 * `close`, counting only its own keys, not ones nested deeper or in strings.
 */
const member = (text: string, open: number, close: number, key: string) => {
  let depth = 0;

  for (let index = open; index < close; index++) {
    const char = text[index];

    if (char === '"') {
      const end = stringEnd(text, index);

      const brace =
        depth === 1 && text.slice(index, end + 1) === JSON.stringify(key)
          ? /^\s*:\s*\{/.exec(text.slice(end + 1, close))
          : null;

      if (brace !== null) {
        const start = end + brace[0].length;
        const finish = closing(text, start);

        return finish === undefined
          ? undefined
          : { open: start, close: finish };
      }

      index = end;
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }

  return undefined;
};

/**
 * Make an edit only inside the object at `path` in a JSON file, such as a
 * nested override, so an entry with the same name elsewhere stays as it is.
 */
const within = (
  text: string,
  path: ReadonlyArray<string> | undefined,
  edit: (part: string) => Edit,
): Edit => {
  if (path === undefined) return edit(text);

  const open = text.indexOf("{");
  const close = open === -1 ? undefined : closing(text, open);
  let span = close === undefined ? undefined : { open, close };

  for (const key of path)
    span =
      span === undefined ? undefined : member(text, span.open, span.close, key);

  if (span === undefined)
    return unsupported(`${path.join(".")} isn't in the file any more`);

  const { open: start, close: end } = span;

  return Edit.$match(edit(text.slice(start, end + 1)), {
    Edited: (part) =>
      edited(`${text.slice(0, start)}${part.text}${text.slice(end + 1)}`),
    Unsupported: (left) => left,
  });
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

  return within(text, dependency.parents, (part) =>
    edited(part.replace(pattern, `$1${value}"`)),
  );
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
 * An image reference, `name:tag@sha256:…`, wherever it stands in the file:
 * a new tag, a moved digest or a pinned one, or a replacement's name and
 * tag. A pinned image keeps its digest through a new tag or name, which
 * needs the new one's.
 */
const editImage = (update: Update, text: string): Edit => {
  const { dependency } = update;

  const name =
    update.updateType === "replacement"
      ? (update.newName ?? dependency.depName)
      : dependency.depName;

  const digestOnly =
    update.updateType === "digest" || update.updateType === "pinDigest";

  const digest = update.digest;

  if (
    digest === undefined &&
    (digestOnly || dependency.currentDigest !== undefined)
  )
    return unsupported(`no digest for ${name}:${update.to}`);

  const reference = (image: string, tag: string, at: string | undefined) =>
    `${image}${tag === "" ? "" : `:${tag}`}${at === undefined ? "" : `@${at}`}`;

  const current = reference(
    dependency.depName,
    dependency.currentValue,
    dependency.currentDigest,
  );

  // Not part of a longer name, tag or digest
  const pattern = new RegExp(
    `(?<![\\w./:@-])${escape(current)}(?![\\w.:@-])`,
    "g",
  );

  if (!pattern.test(text))
    return unsupported(`${current} isn't in the file any more`);

  return edited(
    text.replace(
      pattern,
      reference(name, digestOnly ? dependency.currentValue : update.to, digest),
    ),
  );
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

  if (update.updateType === "pinDigest")
    return unsupported("a regex match has no digest to pin");

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
      dependency.datasource === "docker"
        ? update.to
        : (newValue(dependency.currentValue, update.to) ?? update.to),
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

  if (
    update.updateType === "digest" ||
    update.updateType === "pinDigest" ||
    dependency.currentValue === ""
  )
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
    update.dependency.datasource === "docker" &&
    (update.dependency.manager === "dockerfile" ||
      update.dependency.manager === "docker-compose" ||
      update.dependency.manager === "github-actions")
  )
    return editImage(update, text);

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
