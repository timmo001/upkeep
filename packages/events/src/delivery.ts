/**
 * One GitHub webhook delivery: checking its signature against the webhook
 * secret, and keeping only what Upkeep reads from its payload, since a queue
 * message is capped at 128 KB and a push payload can be far bigger.
 */
import { Domain } from "@upkeep/api";
import { Option, Schema } from "effect";

const Paths = Schema.optional(Schema.Array(Schema.String));

/** The parts of a webhook payload Upkeep reads; the rest is dropped. */
const Payload = Schema.Struct({
  action: Schema.optional(Schema.String),
  repository: Schema.Struct({
    full_name: Domain.RepoName,
    default_branch: Schema.optional(Schema.String),
  }),
  sender: Schema.optional(Schema.Struct({ login: Schema.String })),
  ref: Schema.optional(Schema.String),
  commits: Schema.optional(
    Schema.Array(
      Schema.Struct({ added: Paths, modified: Paths, removed: Paths }),
    ),
  ),
  release: Schema.optional(
    Schema.Struct({ tag_name: Schema.String, html_url: Schema.String }),
  ),
  workflow_run: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      head_branch: Schema.optional(Schema.NullOr(Schema.String)),
      conclusion: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

type Payload = typeof Payload.Type;

const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Payload),
);

const decodeEvent = Schema.decodeUnknownOption(Domain.GitHubEventName);

const SignatureHex = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{2})+$/),
);

const decodeHex = Schema.decodeUnknownOption(SignatureHex);

/**
 * Whether `X-Hub-Signature-256` is the body's HMAC-SHA256 under the secret.
 * `crypto.subtle.verify` compares in constant time. An empty secret never
 * passes, so a Worker deployed without one rejects everything.
 */
export const verify = async (
  secret: string,
  body: string,
  signature: string | null,
) => {
  if (secret === "" || signature === null || !signature.startsWith("sha256="))
    return false;

  const hex = decodeHex(signature.slice("sha256=".length));

  if (Option.isNone(hex)) return false;

  const expected = Uint8Array.from(hex.value.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, expected, encoder.encode(body));
};

/** The paths a push's commits added, changed or removed, in order, once each. */
const changedPaths = (payload: Payload) => [
  ...new Set(
    (payload.commits ?? []).flatMap((commit) => [
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    ]),
  ),
];

/**
 * What Upkeep reads from a delivery, or null for an event it doesn't take or
 * a body that isn't a payload with a repository.
 */
export const slim = (
  eventHeader: string,
  delivery: string,
  body: string,
  at: number,
): Domain.GitHubEvent | null => {
  const event = decodeEvent(eventHeader);
  const payload = decodePayload(body);

  if (Option.isNone(event) || Option.isNone(payload) || delivery === "")
    return null;

  const found = payload.value;
  const paths = event.value === "push" ? changedPaths(found) : [];
  const run = found.workflow_run;

  return {
    delivery,
    event: event.value,
    action: found.action ?? null,
    repo: found.repository.full_name,
    defaultBranch: found.repository.default_branch ?? null,
    sender: found.sender?.login ?? null,
    ref: event.value === "push" ? (found.ref ?? null) : null,
    paths: paths.slice(0, Domain.maxEventPaths),
    truncated: paths.length > Domain.maxEventPaths,
    release:
      event.value === "release" && found.release !== undefined
        ? { tag: found.release.tag_name, url: found.release.html_url }
        : null,
    workflow:
      event.value === "workflow_run" && run !== undefined
        ? {
            name: run.name,
            branch: run.head_branch ?? null,
            conclusion: run.conclusion ?? null,
          }
        : null,
    at,
  };
};
