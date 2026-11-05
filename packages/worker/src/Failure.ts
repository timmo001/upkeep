/**
 * Failures in words a person can act on. gh's errors have no message: the
 * reason is in what gh printed, so it's read from there.
 */
import { GhCommandError } from "@timmo001/effect-gh";
import { Cause, Predicate } from "effect";

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");

/** The API's own error message, when gh printed its JSON response. */
const responseMessage = (stdout: string) => {
  try {
    const body: unknown = JSON.parse(stdout);

    return Predicate.hasProperty(body, "message") &&
      Predicate.isString(body.message)
      ? body.message
      : undefined;
  } catch {
    return undefined;
  }
};

/** Why a gh command failed, in one line. */
export const ghReason = (error: GhCommandError) =>
  `gh: ${(
    firstLine(error.stderr) ??
    responseMessage(error.stdout) ??
    firstLine(error.stdout) ??
    `exited with ${error.exitCode}`
  ).replace(/^gh: /, "")}`;

/** The first error in a cause, as one line. */
export const reason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  if (error instanceof GhCommandError) return ghReason(error);

  return Predicate.isError(error) ? error.message : String(error);
};

/** A cause in full, with a gh failure's reason in place of its empty message. */
export const pretty = (cause: Cause.Cause<unknown>) => {
  const text = Cause.pretty(cause);
  const error = Cause.squash(cause);

  if (!(error instanceof GhCommandError)) return text;

  const [, ...stack] = text.split("\n");

  return [`GhCommandError: ${ghReason(error)}`, ...stack].join("\n");
};
