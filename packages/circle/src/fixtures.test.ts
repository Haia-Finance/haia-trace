/**
 * Keeps the shipped fixtures honest: every file in `fixtures/` must be a
 * complete, parseable v2 notification body that the real pipeline accepts.
 * A fixture that drifts from the envelope contract fails here, not in some
 * downstream replay.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseNotificationEnvelope } from "./envelope.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

const files = readdirSync(FIXTURES_DIR).filter((name) =>
  name.endsWith(".json"),
);

describe("fixtures", () => {
  it("ships at least the three documented shapes", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "contracts-eventlog-payment-created.json",
        "transactions-inbound-complete.json",
        "transactions-outbound-failed.json",
      ]),
    );
  });

  it.each(files)("%s parses as a valid v2 envelope", (file) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const envelope = parseNotificationEnvelope(raw, file);
    expect(envelope.notification_id).not.toBe("");
    expect(envelope.version).toBe(2);
  });

  it("fixture notification ids are unique — replaying all files must not self-dedupe", () => {
    const ids = files.map(
      (file) =>
        parseNotificationEnvelope(
          readFileSync(join(FIXTURES_DIR, file), "utf8"),
          file,
        ).notification_id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
