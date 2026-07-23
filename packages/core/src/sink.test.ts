import { describe, expect, it } from "vitest";

import { createRecorder } from "./recorder.js";
import { decodeEventLine, decodeEventLines, encodeEventLine } from "./sink.js";

const rec = createRecorder({
  adapter: "trace-x402",
  now: () => "2026-07-23T00:00:00.000Z",
  newId: () => "evt-fixed",
});

describe("event line codec", () => {
  it("round-trips an event, preserving optional fields", () => {
    const event = rec.event({
      event_type: "x402.payment.required",
      payload: { amount: "1000" },
      role: "client",
      context_id: "op-1",
    });
    const decoded = decodeEventLine(encodeEventLine(event));
    expect(decoded).toEqual(event);
  });

  it("encodes deterministically and without a trailing newline", () => {
    const event = rec.event({ event_type: "x402.settle.ok", payload: {} });
    const line = encodeEventLine(event);
    expect(encodeEventLine(event)).toBe(line);
    expect(line.endsWith("\n")).toBe(false);
  });
});

describe("decodeEventLines", () => {
  const line = (type: string) =>
    encodeEventLine(rec.event({ event_type: type, payload: {} }));

  it("parses a clean document", () => {
    const text = `${line("a")}\n${line("b")}\n`;
    expect(decodeEventLines(text).map((e) => e.event_type)).toEqual(["a", "b"]);
  });

  it("drops a torn trailing line (no final newline)", () => {
    const text = `${line("a")}\n${line("b")}\n{"event_type":"c","payl`;
    expect(decodeEventLines(text).map((e) => e.event_type)).toEqual(["a", "b"]);
  });

  it("returns nothing for empty input", () => {
    expect(decodeEventLines("")).toEqual([]);
    expect(decodeEventLines("\n")).toEqual([]);
  });

  it("throws on corruption in a non-final line", () => {
    const text = `${line("a")}\nnot json\n${line("c")}\n`;
    expect(() => decodeEventLines(text)).toThrow(/line 2/);
  });
});
