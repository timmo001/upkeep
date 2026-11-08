/**
 * Where a job's decisions are made, from `heal.decisions` in the settings: a
 * decision model's layer, or an LLM through OpenCode answering in one line of
 * JSON. Shared by the heal and regression checks, with how much text the
 * model reads and how a decision names the model, so its use can be counted.
 */
import {
  CloudflareClient,
  CloudflareDecisionModel,
} from "@effect/ai-cloudflare";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { tmpdir } from "node:os";
import { Config, Effect, Layer, Schema } from "effect";
import { run as exec } from "./Command";
import * as Settings from "./settings";

/** The longest line the model reads, such as a log line or an error. */
export const maxMessage = 300;

/** How many lines of a log or release notes the model reads. */
export const maxLines = 40;

export type ModelDecisions = Exclude<
  Settings.DecisionModel,
  { readonly provider: "opencode" }
>;

/** The decision model's layer for a provider other than OpenCode. */
export const layer = (options: ModelDecisions) =>
  options.provider === "cloudflare"
    ? CloudflareDecisionModel.layer({ model: options.model }).pipe(
        Layer.provide(CloudflareClient.layerConfig()),
      )
    : TypeSafeDecisionModel.layer({ model: options.model }).pipe(
        Layer.provide(
          TypeSafeClient.layerConfig({
            apiUrl: Config.succeed(options.url),
            apiKey: Config.Redacted("UPKEEP_DECISION_API_KEY").pipe(
              Config.withDefault(undefined),
            ),
          }),
        ),
      );

/** How a decision names the model that made it, to count its use. */
export const by = (model: Settings.DecisionModel) =>
  `by ${Settings.deciderName(model)}`;

/**
 * Ask an LLM through OpenCode instead of a decision model, for a worker that
 * has neither a local model nor free-tier room. The prompt asks for one line
 * of JSON, and the last one in the output is decoded as `answer`.
 */
export const decideByAgent = <A>(options: {
  readonly answer: Schema.Decoder<A>;
  readonly prompt: string;
  readonly title: string;
  readonly model: Settings.DecisionModel;
  readonly opencode: string;
}) =>
  exec(
    options.opencode,
    [
      "run",
      "--model",
      options.model.model,
      "--title",
      options.title,
      options.prompt,
    ],
    { cwd: tmpdir(), trusted: tmpdir() },
  ).pipe(
    Effect.flatMap((output) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(options.answer))(
        output.match(/\{[^\n]*\}/g)?.at(-1) ?? output,
      ),
    ),
  );
