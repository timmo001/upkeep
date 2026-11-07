/**
 * The GitHub App's private key, however it was pasted: the file as it is,
 * flattened onto one line as a password field keeps it, with its newlines
 * escaped, or in base64. Each must read back as the same key and sign a JWT
 * it verifies.
 */
import { expect, test } from "bun:test";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { appJwt, pem } from "./GitHubApp";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const file = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test.each([
  ["as the file", file],
  ["flattened onto one line", file.replaceAll("\n", " ")],
  ["with its newlines escaped", file.replaceAll("\n", "\\n")],
  ["in base64", Buffer.from(file).toString("base64")],
])("reads the key %s", (_, pasted) => {
  const key = createPrivateKey(pem(pasted));

  const [header = "", claims = "", signature = ""] = appJwt(
    "123",
    key,
    1_000_000,
  ).split(".");

  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
    iat: 940,
    exp: 1540,
    iss: "123",
  });
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      createPublicKey(privateKey),
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
});
