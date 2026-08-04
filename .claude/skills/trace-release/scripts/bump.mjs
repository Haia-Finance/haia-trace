#!/usr/bin/env node
// Set the version of the published packages, in lockstep.
//
// Usage: node bump.mjs <patch|minor|major|X.Y.Z>
//
// These manifests are the only place the version lives (see SKILL.md), so this
// rewrites just the top-level "version" field in each and leaves the rest of
// the file byte-for-byte alone — a JSON.parse/stringify round-trip would
// reformat manifests that are otherwise hand-maintained.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/ -> trace-release/ -> skills/ -> .claude/ -> repo root
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

// Every publishable package. The release workflow publishes with `pnpm -r
// publish`, which takes whatever the workspace exposes — so a package missing
// from this list would still be published, at whatever stale version its
// manifest happens to carry.
const MANIFESTS = ["core", "x402", "cli", "circle"].map((pkg) =>
  join(repoRoot, "packages", pkg, "package.json"),
);

// Anchored to the manifest's opening brace, and the run-up to the field excludes
// braces — so the match cannot reach past the start of any nested object, and the
// version it finds is necessarily the top-level one. Key order ahead of "version"
// doesn't matter, which keeps this working if a manifest grows a "$schema" first.
const VERSION_FIELD = /^(\{[^{}]*?"version":\s*")(\d+\.\d+\.\d+)(")/;

// Semver, rejecting leading zeros: npm would refuse "01.2.3" at publish time,
// which is after the tag is pushed and therefore far too late to catch it.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const fail = (message) => {
  console.error(`bump: ${message}`);
  process.exit(1);
};

const arg = process.argv[2];
if (!arg) fail("usage: node bump.mjs <patch|minor|major|X.Y.Z>");

const files = MANIFESTS.map((path) => {
  const text = readFileSync(path, "utf8");
  const match = text.match(VERSION_FIELD);
  // A miss means the shape changed, not that the field is gone: either a nested
  // object now precedes "version", or the version isn't a plain X.Y.Z (a
  // prerelease like 0.1.0-rc.1 lands here). Both want a human, not a rewrite.
  if (!match) {
    fail(
      `no plain X.Y.Z version found before the first nested object in ${path} — check its shape by hand`,
    );
  }
  return { path, text, current: match[2] };
});

// They must already agree. Disagreement means a previous release was only
// half-applied, and overwriting would hide that rather than fix it.
const currents = new Set(files.map((f) => f.current));
if (currents.size !== 1) {
  fail(
    `the packages disagree about the current version — ${files
      .map((f) => `${f.path.replace(`${repoRoot}/`, "")}=${f.current}`)
      .join(
        ", ",
      )}. Nothing is committed yet, so \`git checkout -- packages\` gets you back to clean; look at why before re-running.`,
  );
}

const current = files[0].current;
const [major, minor, patch] = current.split(".").map(Number);

const next =
  arg === "patch"
    ? `${major}.${minor}.${patch + 1}`
    : arg === "minor"
      ? `${major}.${minor + 1}.0`
      : arg === "major"
        ? `${major + 1}.0.0`
        : arg;

if (!SEMVER.test(next)) {
  fail(`"${arg}" is not patch, minor, major, or an X.Y.Z version`);
}
if (next === current) fail(`already at ${current}`);

for (const { path, text } of files) {
  writeFileSync(path, text.replace(VERSION_FIELD, `$1${next}$3`));
}

console.log(`${current} -> ${next}`);
for (const { path } of files) {
  console.log(`  ${path.replace(`${repoRoot}/`, "")}`);
}
console.log(
  `\nNext: review \`git diff\`, then commit "chore: release v${next}"`,
);
