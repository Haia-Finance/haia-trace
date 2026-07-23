/**
 * Stamp every publishable workspace package with a canary prerelease version:
 *   <current base version>-next.<id>
 *
 * Run in CI before a canary publish from `main`. The id — a CI run number — makes
 * each canary a unique, monotonically increasing version, so `main` can publish to
 * the `next` dist-tag on every push without version collisions. Interdependencies
 * stay `workspace:*` and are resolved to this version at publish time by pnpm.
 *
 * This only rewrites version fields for the ephemeral CI publish; it is never
 * committed. Stable releases come from a git tag, whose committed version is
 * published as-is to `latest`.
 *
 * Usage: node scripts/set-canary-version.mjs <id>
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const id = process.argv[2];
if (!id) {
  console.error("usage: set-canary-version.mjs <id>");
  process.exit(1);
}

const packagesDir = "packages";
for (const name of readdirSync(packagesDir)) {
  const path = join(packagesDir, name, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Not a package directory (no readable package.json) — skip it.
    continue;
  }
  if (pkg.private) continue;
  const base = String(pkg.version).split("-")[0];
  pkg.version = `${base}-next.${id}`;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name} -> ${pkg.version}`);
}
