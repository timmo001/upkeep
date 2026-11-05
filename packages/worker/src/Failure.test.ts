/** How a failed gh command reads in a run's error and log. */
import { GhCommandError } from "@timmo001/effect-gh";
import { expect, test } from "bun:test";
import { Cause } from "effect";
import { pretty, reason } from "./Failure";

const failure = (output: { stdout?: string; stderr?: string }) =>
  new GhCommandError({
    executable: "gh",
    exitCode: 1,
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

  expect(reason(Cause.fail(failure({})))).toBe("gh: exited with 1");
});

test("a run's error names gh's reason on its first line", () => {
  const text = pretty(Cause.fail(failure({ stderr: "gh: Bad credentials" })));

  expect(text.split("\n")[0]).toBe("GhCommandError: gh: Bad credentials");
});
