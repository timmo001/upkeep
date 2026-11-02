/** The upkeep CLI: every command lives in this tree so help and completions come from one place. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import packageJson from "../package.json" with { type: "json" };

const upkeep = Command.make("upkeep", {}, () =>
  Console.log(
    "upkeep keeps repositories and their consumers up to date. Run upkeep --help for commands.",
  ),
).pipe(
  Command.withDescription("Keep repositories and their consumers up to date"),
);

upkeep.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
