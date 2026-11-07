/**
 * The webhook's signature check, and that what the Worker queues decodes on
 * the server with the shared schema.
 */
import { expect, test } from "bun:test";
import { Domain } from "@upkeep/api";
import { Schema } from "effect";
import { slim, verify } from "./delivery";

const sign = async (secret: string, body: string) => {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  );

  return `sha256=${mac.toHex()}`;
};

const repository = { full_name: "timmo001/upkeep", default_branch: "main" };

test("only a signature from the webhook secret passes", async () => {
  const body = '{"zen":"Keep it logically awesome."}';
  const signature = await sign("secret", body);

  expect(await verify("secret", body, signature)).toBe(true);
  expect(await verify("other", body, signature)).toBe(false);
  expect(await verify("secret", `${body} `, signature)).toBe(false);
  expect(await verify("secret", body, null)).toBe(false);
  expect(await verify("secret", body, "sha256=zz")).toBe(false);
  expect(await verify("", body, signature)).toBe(false);
});

test("a push keeps its paths, capped, and decodes with the shared schema", () => {
  const commits = Array.from(
    { length: Domain.maxEventPaths + 5 },
    (_, index) => ({
      added: [`file-${index}`],
      modified: ["mise.toml"],
      removed: [],
    }),
  );

  const message = slim(
    "push",
    "delivery-1",
    JSON.stringify({
      ref: "refs/heads/main",
      commits,
      repository,
      sender: { login: "timmo001" },
    }),
    1,
  );

  expect(message?.paths).toHaveLength(Domain.maxEventPaths);
  expect(message?.paths[1]).toBe("mise.toml");
  expect(message?.truncated).toBe(true);

  const decoded = Schema.decodeUnknownSync(
    Schema.fromJsonString(Domain.GitHubEvent),
  )(JSON.stringify(message));

  expect(decoded.ref).toBe("refs/heads/main");
  expect(decoded.sender).toBe("timmo001");
});

test("a release and a workflow run keep what the server reads", () => {
  const release = slim(
    "release",
    "d",
    JSON.stringify({
      action: "released",
      release: { tag_name: "0.25.0", html_url: "https://example.com" },
      repository,
    }),
    1,
  );

  const run = slim(
    "workflow_run",
    "d",
    JSON.stringify({
      action: "completed",
      workflow_run: { name: "CI", head_branch: "main", conclusion: "failure" },
      repository,
    }),
    1,
  );

  expect(release?.release).toEqual({
    tag: "0.25.0",
    url: "https://example.com",
  });
  expect(run?.workflow).toEqual({
    name: "CI",
    branch: "main",
    conclusion: "failure",
  });
  expect(slim("issues", "d", JSON.stringify({ repository }), 1)).toBeNull();
  expect(slim("push", "d", "{}", 1)).toBeNull();
  expect(slim("push", "d", "not json", 1)).toBeNull();
});
