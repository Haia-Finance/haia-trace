/**
 * Loading sample fixtures — the bridge from a template name to the bundled events
 * that `trace sample` replays.
 *
 * Fixtures are real NDJSON run files (`<template>.ndjson`), one per template,
 * shipped with the CLI and carried into the tarball by the `files` list. They are
 * read through the same `createFileEventReader` a live capture is read with — so a
 * sample runs the identical pipe, not a mock. Adding a template's sample is a data
 * change (a new fixture file), never a code change to the command.
 *
 * This mirrors `templates.ts`: filesystem here, validation and parsing delegated to
 * core, and a bare-slug name guard so a template name can never escape the fixtures
 * directory.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TraceEvent } from "@usehaia/trace-core";
import { createFileEventReader } from "@usehaia/trace-core/file";

import { isErrno } from "./fs.js";

const FIXTURE_EXT = ".ndjson";

/** A fixture is addressed by the bare template slug — letters, digits, `-`, `_`. */
const FIXTURE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The directory of shipped fixtures. Resolved relative to this module so the same
 * path works in dev (`src/`), after build (`dist/`), and once installed — each is
 * one level below the package root, next to a sibling `fixtures/`.
 */
const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

/**
 * Load the sample events for a template. Throws a clear error if the template has
 * no bundled fixtures — a template can ship without a sample, and that must read as
 * "no sample" rather than an empty run.
 */
export function loadFixtureEvents(template: string): TraceEvent[] {
  // Reject anything with path separators or `..` before it reaches the join, so a
  // name cannot escape the fixtures directory. Such a name simply has no fixtures.
  if (!FIXTURE_NAME.test(template))
    throw new Error(`no sample fixtures for template: ${template}`);
  const path = join(FIXTURES_DIR, `${template}${FIXTURE_EXT}`);
  try {
    return createFileEventReader(path).read();
  } catch (err) {
    if (isErrno(err, "ENOENT"))
      throw new Error(`no sample fixtures for template: ${template}`);
    throw new Error(
      `could not read fixtures (${template}): ${(err as Error).message}`,
    );
  }
}
