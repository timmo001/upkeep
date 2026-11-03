/**
 * Turns a manifest tool's JSON Schema into OpenCode tool input that rejects
 * keys the tool doesn't take. OpenCode strips unknown keys by default, so a
 * misspelt option would be dropped and the call run without it. Lifted from
 * the dotfiles cli-tools plugin.
 */
import type { Tool } from "@opencode/schema/tool";
import {
  JsonSchema,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  SchemaRepresentation,
  type StandardSchema,
} from "effect";

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

const isJsonSchema = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const safeIntegerBounds = new Map([
  ["minimum", Number.MIN_SAFE_INTEGER],
  ["maximum", Number.MAX_SAFE_INTEGER],
]);

// Effect adds the safe-integer range to every Schema.Int; drop it as OpenCode
// does, so the catalogue's signatures stay short.
const dropSafeIntegerBounds = (
  schema: JsonSchema.JsonSchema,
): JsonSchema.JsonSchema => {
  const integer = schema.type === "integer";

  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns
  const nested = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(nested)
      : isJsonSchema(value)
        ? dropSafeIntegerBounds(value)
        : value;

  return Object.fromEntries(
    Object.entries(schema)
      .filter(
        ([key, value]) => !integer || safeIntegerBounds.get(key) !== value,
      )
      .map(([key, value]) => [key, nested(value)]),
  );
};

/** Wrap a JSON Schema as a Standard Schema that decodes strictly and passes the input on unchanged. */
export const strictInput = (input: JsonSchema.JsonSchema): Tool.ValueSchema => {
  const json = dropSafeIntegerBounds(input);

  const codec: Schema.Codec<unknown> = Schema.make(
    SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft2020_12(input),
      { patterns: "apply" },
    ).ast,
  );

  const decode = SchemaParser.decodeUnknownResult(codec, {
    onExcessProperty: "error",
    errors: "all",
  });

  const schema: StandardSchema.StandardSchemaV1 &
    StandardSchema.StandardJSONSchemaV1 = {
    "~standard": {
      version: 1,
      vendor: "upkeep",
      validate: (value) =>
        Result.match(decode(value), {
          onFailure: formatIssue,
          onSuccess: () => ({ value }),
        }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };

  return schema;
};
