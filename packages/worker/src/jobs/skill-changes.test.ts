/**
 * Which agent changes skip your approval: a patch that only moves pins in
 * skills.yml lands straight away, so anything more must not pass for one.
 */
import { expect, test } from "bun:test";
import { isTagOnly } from "./skill-changes";

const patch = (file: string, lines: ReadonlyArray<string>) =>
  [
    "From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001",
    "Subject: [PATCH] Update skill: gh-stack",
    "",
    "---",
    ` ${file} | 2 +-`,
    "",
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -27,3 +27,3 @@ skills:",
    "       - repo: github/gh-stack",
    ...lines,
    "-- ",
    "2.51.0",
    "",
  ].join("\n");

test("a patch that only moves reviewed tags or pins needs no review", () => {
  expect(
    isTagOnly(
      patch("skills.yml", [
        '-        reviewed: "v1.0.1"',
        '+        reviewed: "v1.1.0"',
      ]),
    ),
  ).toBe(true);
  expect(
    isTagOnly(
      patch("skills.yml", [
        `-      upstreamSha: ${"a".repeat(40)}`,
        `+      upstreamSha: ${"b".repeat(40)}`,
      ]),
    ),
  ).toBe(true);
});

test("a patch that touches anything else waits for you", () => {
  expect(
    isTagOnly(
      patch("skills/gh-stack/SKILL.md", [
        '-        reviewed: "v1.0.1"',
        '+        reviewed: "v1.1.0"',
      ]),
    ),
  ).toBe(false);
  expect(
    isTagOnly(
      patch("skills.yml", [
        '-        reviewed: "v1.0.1"',
        '+        reviewed: "v1.1.0"',
        '+        notes: "something new"',
      ]),
    ),
  ).toBe(false);
  expect(isTagOnly("")).toBe(false);
});
