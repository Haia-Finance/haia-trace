import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../event.js";
import { createRecorder } from "../recorder.js";
import type { EventWriter } from "./contract.js";
import { createMulticastEventWriter } from "./multicast.js";

const rec = createRecorder({
  adapter: "trace-x402",
  now: () => "2026-07-23T00:00:00.000Z",
  newId: () => "evt-fixed",
});

describe("createMulticastEventWriter", () => {
  /** A writer that records what it was given, optionally failing on write. */
  function spyWriter(options: { throws?: boolean; refuses?: boolean } = {}) {
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
        write(event: TraceEvent): boolean {
          if (options.throws) throw new Error("this writer is broken");
          if (options.refuses) return false;
          events.push(event);
          return true;
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
    const writer = createMulticastEventWriter(a.writer, b.writer);

    writer.write(event());

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("a throwing writer does not deny the event to the others", () => {
    const broken = spyWriter({ throws: true });
    const healthy = spyWriter();
    const writer = createMulticastEventWriter(broken.writer, healthy.writer);

    expect(() => {
      writer.write(event());
    }).not.toThrow();
    expect(healthy.events).toHaveLength(1);
  });

  it("answers true only when every writer accepted", () => {
    const a = spyWriter();
    const b = spyWriter();
    expect(createMulticastEventWriter(a.writer, b.writer).write(event())).toBe(
      true,
    );
  });

  it("answers false when any writer refused, while the others still record", () => {
    // The AND is what lets a caller with delivery semantics — a webhook
    // receiver deciding between 200 and 500 — sit behind a multicast: "all
    // sinks have it" is the only verdict that can be acknowledged.
    const refusing = spyWriter({ refuses: true });
    const healthy = spyWriter();
    const writer = createMulticastEventWriter(refusing.writer, healthy.writer);

    expect(writer.write(event())).toBe(false);
    expect(healthy.events).toHaveLength(1);
  });

  it("counts a throwing writer as a refusal, not an accept", () => {
    const broken = spyWriter({ throws: true });
    const healthy = spyWriter();
    const writer = createMulticastEventWriter(broken.writer, healthy.writer);

    expect(writer.write(event())).toBe(false);
  });

  it("flushes and closes every writer", async () => {
    const a = spyWriter();
    const b = spyWriter();
    const writer = createMulticastEventWriter(a.writer, b.writer);

    await writer.flush?.();
    writer.close();

    expect([a.flushed, b.flushed]).toEqual([1, 1]);
    expect([a.closed, b.closed]).toEqual([1, 1]);
  });

  it("settles even when one writer's flush rejects", async () => {
    const healthy = spyWriter();
    const rejecting: EventWriter = {
      write(): boolean {
        return true;
      },
      flush: () => Promise.reject(new Error("upload failed")),
      close(): void {},
    };
    const writer = createMulticastEventWriter(rejecting, healthy.writer);

    await expect(writer.flush?.()).resolves.toBeUndefined();
    expect(healthy.flushed).toBe(1);
  });

  it("settles when a writer's flush throws before returning a promise", async () => {
    const healthy = spyWriter();
    const throwing: EventWriter = {
      write(): boolean {
        return true;
      },
      flush(): Promise<void> {
        throw new Error("flush failed synchronously");
      },
      close(): void {},
    };
    const writer = createMulticastEventWriter(throwing, healthy.writer);

    await expect(writer.flush?.()).resolves.toBeUndefined();
    expect(healthy.flushed).toBe(1);
  });

  it("tolerates a writer with no flush of its own", async () => {
    const plain: EventWriter = {
      write(): boolean {
        return true;
      },
      close(): void {},
    };
    await expect(
      createMulticastEventWriter(plain).flush?.(),
    ).resolves.toBeUndefined();
  });
});
