/**
 * Failures in words a person can act on. gh's errors have no message: the
 * reason is in what gh printed, so it's read from there.
 */
import { GhCommandError, GhTimeoutError } from "@timmo001/effect-gh";
import { Cause, Duration, Predicate } from "effect";

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

/** Why gh exited without saying, from its exit code. */
const exited = (code: number) =>
  code > 128
    ? `was stopped by signal ${code - 128} (exit ${code}), printing nothing`
    : `exited with ${code}, printing nothing`;

/** Why a gh command failed, in one line. */
export const ghReason = (error: GhCommandError) =>
  `gh: ${(
    firstLine(error.stderr) ??
    responseMessage(error.stdout) ??
    firstLine(error.stdout) ??
    exited(error.exitCode)
  ).replace(/^gh: /, "")}`;

/** Why gh failed or timed out, in one line. */
const ghMessage = (error: GhCommandError | GhTimeoutError) =>
  error instanceof GhCommandError
    ? ghReason(error)
    : `gh: timed out after ${Duration.format(Duration.millis(error.timeoutMs))}`;

/**
 * The first error in a cause, as one line: its message, or its tag when it
 * has none, as gh's errors don't.
 */
export const reason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  if (error instanceof GhCommandError || error instanceof GhTimeoutError)
    return ghMessage(error);

  if (!Predicate.isError(error)) return String(error);

  return error.message === "" && Predicate.hasProperty(error, "_tag")
    ? String(error._tag)
    : error.message;
};

/** A cause in full, with a gh failure's reason in place of its empty message. */
export const pretty = (cause: Cause.Cause<unknown>) => {
  const text = Cause.pretty(cause);
  const error = Cause.squash(cause);

  if (!(error instanceof GhCommandError || error instanceof GhTimeoutError))
    return text;

  const [, ...stack] = text.split("\n");

  return [`${error._tag}: ${ghMessage(error)}`, ...stack].join("\n");
};
