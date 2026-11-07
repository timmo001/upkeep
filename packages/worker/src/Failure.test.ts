/** How a failed gh command reads in a run's error and log. */
import { GhCommandError, GhTimeoutError } from "@timmo001/effect-gh";
import { expect, test } from "bun:test";
import { Cause } from "effect";
import { pretty, reason } from "./Failure";

const failure = (output: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) =>
  new GhCommandError({
    executable: "gh",
    exitCode: output.exitCode ?? 1,
    stdout: output.stdout ?? "",
    stdoutTruncated: false,
    stderr: output.stderr ?? "",
    stderrTruncated: false,
  });

test("a gh failure reads as what gh printed", () => {
  expect(
    reason(
      Cause.fail(
        failure({
          stderr:
            "\ngh: API rate limit exceeded for user ID 1. (HTTP 403)\nmore\n",
        }),
      ),
    ),
  ).toBe("gh: API rate limit exceeded for user ID 1. (HTTP 403)");

  expect(
    reason(Cause.fail(failure({ stdout: '{"message":"Not Found"}' }))),
  ).toBe("gh: Not Found");

  expect(reason(Cause.fail(failure({})))).toBe(
    "gh: exited with 1, printing nothing",
  );
});

test("a gh failure that printed nothing says how it ended", () => {
  expect(reason(Cause.fail(failure({ exitCode: 143 })))).toBe(
    "gh: was stopped by signal 15 (exit 143), printing nothing",
  );

  expect(
    reason(
      Cause.fail(new GhTimeoutError({ executable: "gh", timeoutMs: 120_000 })),
    ),
  ).toBe("gh: timed out after 2m");
});

test("a run's error names gh's reason on its first line", () => {
  const text = pretty(Cause.fail(failure({ stderr: "gh: Bad credentials" })));

  expect(text.split("\n")[0]).toBe("GhCommandError: gh: Bad credentials");
});
