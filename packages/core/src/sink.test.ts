import { describe, expect, it } from "vitest";

import type { TraceEvent } from "./event.js";
import { createRecorder } from "./recorder.js";
import {
  createMulticastWriter,
  decodeEventLine,
  decodeEventLines,
  type EventWriter,
  encodeEventLine,
} from "./sink.js";

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

describe("createMulticastWriter", () => {
  /** A writer that records what it was given, optionally failing on write. */
  function spyWriter(options: { throws?: boolean } = {}) {
    const events: TraceEvent[] = [];
    let closed = 0;
    let flushed = 0;
    return {
      events,
      get closed() {
        return closed;
      },
      get flushed() {
        return flushed;
      },
      writer: {
        write(event: TraceEvent): void {
          if (options.throws) throw new Error("this writer is broken");
          events.push(event);
        },
        async flush(): Promise<void> {
          flushed++;
        },
        close(): void {
          closed++;
        },
      } satisfies EventWriter,
    };
  }

  const event = () => rec.event({ event_type: "x402.settle.ok", payload: {} });

  it("offers every event to every writer", () => {
    const a = spyWriter();
    const b = spyWriter();
    const writer = createMulticastWriter(a.writer, b.writer);

    writer.write(event());

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("a throwing writer does not deny the event to the others", () => {
    const broken = spyWriter({ throws: true });
    const healthy = spyWriter();
    const writer = createMulticastWriter(broken.writer, healthy.writer);

    expect(() => {
      writer.write(event());
    }).not.toThrow();
    expect(healthy.events).toHaveLength(1);
  });

  it("flushes and closes every writer", async () => {
    const a = spyWriter();
    const b = spyWriter();
    const writer = createMulticastWriter(a.writer, b.writer);

    await writer.flush?.();
    writer.close();

    expect([a.flushed, b.flushed]).toEqual([1, 1]);
    expect([a.closed, b.closed]).toEqual([1, 1]);
  });

  it("settles even when one writer's flush rejects", async () => {
    const healthy = spyWriter();
    const rejecting: EventWriter = {
      write(): void {},
      flush: () => Promise.reject(new Error("upload failed")),
      close(): void {},
    };
    const writer = createMulticastWriter(rejecting, healthy.writer);

    await expect(writer.flush?.()).resolves.toBeUndefined();
    expect(healthy.flushed).toBe(1);
  });

  it("tolerates a writer with no flush of its own", async () => {
    const plain: EventWriter = { write(): void {}, close(): void {} };
    await expect(
      createMulticastWriter(plain).flush?.(),
    ).resolves.toBeUndefined();
  });
});
