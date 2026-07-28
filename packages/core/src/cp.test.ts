import { describe, expect, it, vi } from "vitest";

import {
  type CpFetch,
  type CpResponse,
  createCpWriter,
  type IngestEvent,
  toIngestEvent,
} from "./cp.js";
import { createRecorder } from "./recorder.js";

const rec = createRecorder({
  adapter: "trace-x402",
  now: () => "2026-07-23T00:00:00.000Z",
  newId: () => "evt-fixed",
});

const URL = "https://ingest.example.com";
const ENDPOINT = `${URL}/v1/events:batch`;

/** A response body the ingest API would return for a clean batch. */
function accepted(count: number): string {
  return JSON.stringify({ accepted: count, duplicates: 0, rejections: [] });
}

function response(init: Partial<CpResponse> & { body?: string }): CpResponse {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => init.body ?? accepted(1),
    ...(init.headers ? { headers: init.headers } : {}),
  };
}

/** A fetch stub that records every call and answers with the queued responses. */
interface StubCall {
  url: string;
  body: string;
  headers: Record<string, string>;
  signal?: unknown;
}

function stubFetch(...queued: CpResponse[]): {
  fetch: CpFetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetch: CpFetch = async (url, init) => {
    calls.push({
      url,
      body: init.body,
      headers: init.headers,
      signal: init.signal,
    });
    return (
      queued[Math.min(calls.length - 1, queued.length - 1)] ?? response({})
    );
  };
  return { fetch, calls };
}

/** The events of the single request `calls[i]` carried. */
function sentEvents(body: string): IngestEvent[] {
  return (JSON.parse(body) as { events: IngestEvent[] }).events;
}

describe("toIngestEvent", () => {
  it("maps the envelope onto the ingest wire shape", () => {
    const event = rec.event({
      event_type: "x402.payment.required",
      payload: { amount: "10000", network: "eip155:8453" },
      role: "client",
      context_id: "op-1",
    });

    expect(
      toIngestEvent(event, { agentId: "agent-1", runId: "run-1" }),
    ).toEqual({
      event_type: "x402.payment.required",
      occurred_at: "2026-07-23T00:00:00.000Z",
      client_event_id: "evt-fixed",
      anonymous_id: "agent-1",
      session_id: "op-1",
      properties: {
        amount: "10000",
        network: "eip155:8453",
        seq: 0,
        adapter: "trace-x402",
        role: "client",
        context_id: "op-1",
      },
      meta: {
        source: "haia-trace",
        trace_schema: "v1",
        run_id: "run-1",
      },
    });
  });

  it("omits absent optional fields rather than sending them empty", () => {
    const event = rec.event({ event_type: "x402.settle.ok", payload: {} });
    const mapped = toIngestEvent(event, { agentId: "agent-1" });

    // No request context, so nothing to group by — and a run is not a session.
    expect(mapped).not.toHaveProperty("session_id");
    expect(mapped).not.toHaveProperty("user_id");
    expect(mapped.properties).not.toHaveProperty("role");
    expect(mapped.properties).not.toHaveProperty("context_id");
  });

  it("groups by the operation, not by the run", () => {
    const first = toIngestEvent(
      rec.event({ event_type: "a", payload: {}, context_id: "op-1" }),
      { agentId: "agent-1", runId: "run-1" },
    );
    const second = toIngestEvent(
      rec.event({ event_type: "b", payload: {}, context_id: "op-2" }),
      { agentId: "agent-1", runId: "run-1" },
    );

    // One run, two operations: the sessions differ, the run id does not.
    expect([first.session_id, second.session_id]).toEqual(["op-1", "op-2"]);
    expect([first.meta.run_id, second.meta.run_id]).toEqual(["run-1", "run-1"]);
  });

  it("drops an over-long context id from session_id but keeps the event", () => {
    const mapped = toIngestEvent(
      rec.event({
        event_type: "x402.settle.ok",
        payload: {},
        context_id: "c".repeat(257),
      }),
      { agentId: "agent-1" },
    );

    expect(mapped).not.toHaveProperty("session_id");
    expect(mapped.properties.context_id).toHaveLength(257);
  });

  it("keeps envelope fields out of a payload key's reach", () => {
    const event = rec.event({
      event_type: "x402.settle.ok",
      payload: { seq: "payload-wins-nothing", adapter: "impostor" },
      role: "server",
    });

    const { properties } = toIngestEvent(event, { agentId: "agent-1" });
    expect(properties.seq).toBe(event.seq);
    expect(properties.adapter).toBe("trace-x402");
  });

  it("drops an over-long event id instead of sending one the API refuses", () => {
    const long = createRecorder({
      adapter: "trace-x402",
      now: () => "2026-07-23T00:00:00.000Z",
      newId: () => "x".repeat(129),
    });
    const mapped = toIngestEvent(
      long.event({ event_type: "x402.settle.ok", payload: {} }),
      { agentId: "agent-1" },
    );

    expect(mapped).not.toHaveProperty("client_event_id");
    expect(mapped.event_type).toBe("x402.settle.ok");
  });
});

describe("createCpWriter configuration", () => {
  it("rejects a numeric option that would disable the bound it sets", () => {
    // NaN is what `Number(process.env.X)` yields for an unset variable, and it
    // would otherwise spin the drain loop forever.
    expect(() =>
      createCpWriter({ url: URL, apiKey: "k", agentId: "a", batchSize: NaN }),
    ).toThrow(/batchSize must be a finite number/);
    expect(() =>
      createCpWriter({ url: URL, apiKey: "k", agentId: "a", maxQueue: NaN }),
    ).toThrow(/maxQueue must be a finite number/);
    expect(() =>
      createCpWriter({ url: URL, apiKey: "k", agentId: "a", batchSize: 0 }),
    ).toThrow(/batchSize/);
  });

  it("rejects a missing api key, not only an empty one", () => {
    expect(() =>
      createCpWriter({
        url: URL,
        apiKey: undefined as unknown as string,
        agentId: "a",
      }),
    ).toThrow(/apiKey is required/);
    expect(() =>
      createCpWriter({ url: URL, apiKey: "  ", agentId: "a" }),
    ).toThrow(/apiKey is required/);
  });

  it("rejects a configuration the ingest API would refuse", () => {
    expect(() =>
      createCpWriter({ url: "ingest.example.com", apiKey: "k", agentId: "a" }),
    ).toThrow(/http\(s\) URL/);
    expect(() =>
      createCpWriter({ url: URL, apiKey: "", agentId: "a" }),
    ).toThrow(/apiKey/);
    expect(() => createCpWriter({ url: URL, apiKey: "k" })).toThrow(/identity/);
    expect(() =>
      createCpWriter({ url: URL, apiKey: "k", agentId: "a".repeat(257) }),
    ).toThrow(/at most 256/);
  });
});

describe("createCpWriter delivery", () => {
  const event = (event_type: string) => rec.event({ event_type, payload: {} });

  it("posts a queued batch to the batch endpoint with the api key", async () => {
    const { fetch, calls } = stubFetch(response({ body: accepted(2) }));
    const writer = createCpWriter({
      url: `${URL}/`,
      apiKey: "pit_test",
      agentId: "agent-1",
      runId: "run-1",
      fetch,
    });

    writer.write(event("x402.payment.required"));
    writer.write(event("x402.settle.ok"));
    await writer.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(calls[0]?.headers["x-haia-api-key"]).toBe("pit_test");
    expect(sentEvents(calls[0]?.body ?? "").map((e) => e.event_type)).toEqual([
      "x402.payment.required",
      "x402.settle.ok",
    ]);
  });

  it("sends as soon as a batch fills, without waiting for a flush", async () => {
    const { fetch, calls } = stubFetch(response({}));
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      batchSize: 2,
      fetch,
    });

    writer.write(event("a"));
    writer.write(event("b"));
    await writer.flush();

    expect(calls).toHaveLength(1);
    expect(sentEvents(calls[0]?.body ?? "")).toHaveLength(2);
  });

  it("splits a queue larger than the batch size into several requests", async () => {
    const { fetch, calls } = stubFetch(response({}));
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      batchSize: 2,
      flushIntervalMs: 60_000,
      fetch,
    });

    for (let i = 0; i < 5; i++) writer.write(event(`e${i}`));
    await writer.flush();

    expect(calls.map((call) => sentEvents(call.body).length)).toEqual([
      2, 2, 1,
    ]);
  });

  it("flushing an empty queue sends nothing", async () => {
    const { fetch, calls } = stubFetch(response({}));
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      fetch,
    });

    await writer.flush();
    expect(calls).toHaveLength(0);
  });
});

describe("createCpWriter failure handling", () => {
  const event = () => rec.event({ event_type: "x402.settle.ok", payload: {} });

  it("never throws into the producer when delivery fails", async () => {
    const onError = vi.fn();
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      maxRetries: 0,
      onError,
      fetch: async () => {
        throw new Error("network is down");
      },
    });

    expect(() => {
      writer.write(event());
    }).not.toThrow();
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("retries a 5xx and reports the drop once retries run out", async () => {
    const { fetch, calls } = stubFetch(
      response({ ok: false, status: 503, headers: { get: () => "0" } }),
    );
    const onError = vi.fn();
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      maxRetries: 2,
      onError,
      fetch,
    });

    writer.write(event());
    await writer.flush();

    expect(calls).toHaveLength(3); // the attempt plus two retries
    expect(String(onError.mock.calls.at(-1)?.[0])).toMatch(
      /dropped 1 event\(s\) after 3 attempt/,
    );
  });

  it("does not retry a 4xx that a retry cannot fix", async () => {
    const { fetch, calls } = stubFetch(response({ ok: false, status: 401 }));
    const onError = vi.fn();
    const writer = createCpWriter({
      url: URL,
      apiKey: "bad",
      agentId: "agent-1",
      onError,
      fetch,
    });

    writer.write(event());
    await writer.flush();

    expect(calls).toHaveLength(1);
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/answered 401/);
  });

  it("retries a 429 and honours Retry-After", async () => {
    const { fetch, calls } = stubFetch(
      response({
        ok: false,
        status: 429,
        headers: { get: () => "0" },
      }),
      response({}),
    );
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      maxRetries: 1,
      fetch,
    });

    writer.write(event());
    await writer.flush();

    expect(calls).toHaveLength(2);
  });

  it("reports the events the ingest API refused to store", async () => {
    const onError = vi.fn();
    const { fetch } = stubFetch(
      response({
        body: JSON.stringify({
          accepted: 0,
          duplicates: 0,
          rejections: [
            {
              index: 0,
              issues: [{ code: "occurred_at_out_of_window" }],
            },
          ],
        }),
      }),
    );
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      onError,
      fetch,
    });

    writer.write(event());
    await writer.flush();

    expect(String(onError.mock.calls[0]?.[0])).toMatch(
      /rejected 1 of 1 event\(s\).*occurred_at_out_of_window/,
    );
  });

  it("stays quiet about duplicates — deduplication is not a loss", async () => {
    const onError = vi.fn();
    const { fetch } = stubFetch(
      response({
        body: JSON.stringify({ accepted: 0, duplicates: 1, rejections: [] }),
      }),
    );
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      onError,
      fetch,
    });

    writer.write(event());
    await writer.flush();

    expect(onError).not.toHaveBeenCalled();
  });

  it("screens out an event that would fail the whole batch", async () => {
    const onError = vi.fn();
    const { fetch, calls } = stubFetch(response({}));
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      onError,
      fetch,
    });

    writer.write(rec.event({ event_type: "x402/payment", payload: {} }));
    writer.write(rec.event({ event_type: "x402.settle.ok", payload: {} }));
    await writer.flush();

    expect(String(onError.mock.calls[0]?.[0])).toMatch(/event_type may only/);
    expect(sentEvents(calls[0]?.body ?? "").map((e) => e.event_type)).toEqual([
      "x402.settle.ok",
    ]);
  });

  it("drops events past the queue ceiling and says so", async () => {
    const onError = vi.fn();
    const { fetch } = stubFetch(response({}));
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      batchSize: 500,
      flushIntervalMs: 60_000,
      maxQueue: 2,
      onError,
      fetch,
    });

    writer.write(event());
    writer.write(event());
    writer.write(event());

    expect(String(onError.mock.calls[0]?.[0])).toMatch(/queue is full/);
  });

  it("refuses events after close instead of silently accepting them", async () => {
    const onError = vi.fn();
    const { fetch } = stubFetch(response({}));
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      onError,
      fetch,
    });

    writer.close();
    writer.close(); // safe to call more than once
    writer.write(event());

    expect(String(onError.mock.calls[0]?.[0])).toMatch(/closed/);
  });

  it("gives every retry its own deadline", async () => {
    const { fetch, calls } = stubFetch(
      response({ ok: false, status: 503, headers: { get: () => "0" } }),
    );
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      maxRetries: 2,
      timeoutMs: 50,
      fetch,
    });

    writer.write(event());
    await writer.flush();

    // A signal hoisted out of the retry loop would already be aborted by the
    // second attempt, so the retries would return instantly without ever
    // reaching the network.
    expect(calls).toHaveLength(3);
    const signals = calls.map((call) => call.signal);
    expect(new Set(signals).size).toBe(3);
    expect(
      signals.every((signal) => !(signal as AbortSignal | undefined)?.aborted),
    ).toBe(true);
  });

  it("counts events already handed to a stalled delivery against the ceiling", async () => {
    const onError = vi.fn();
    // A delivery that never finishes: the events leave the queue but are not
    // delivered, which is exactly the state the ceiling has to notice.
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      batchSize: 2,
      maxQueue: 4,
      onError,
      fetch: () => new Promise<CpResponse>(() => {}),
    });

    for (let i = 0; i < 20; i++) writer.write(event());

    expect(String(onError.mock.calls[0]?.[0])).toMatch(/queue is full/);
  });

  it("does not re-send an accepted batch over a malformed rejections body", async () => {
    const onError = vi.fn();
    const { fetch, calls } = stubFetch(
      response({
        // `issues` absent — a shape the reader must survive rather than throw on.
        body: JSON.stringify({
          accepted: 1,
          duplicates: 0,
          rejections: [{ index: 0 }],
        }),
      }),
    );
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      onError,
      fetch,
    });

    writer.write(event());
    await writer.flush();

    expect(calls).toHaveLength(1);
    expect(
      onError.mock.calls.map((call) => String(call[0])).join(" "),
    ).not.toMatch(/dropped/);
  });

  it("survives a runtime with no fetch", async () => {
    const onError = vi.fn();
    const writer = createCpWriter({
      url: URL,
      apiKey: "k",
      agentId: "agent-1",
      onError,
    });

    const original = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      writer.write(event());
      await writer.flush();
    } finally {
      globalThis.fetch = original;
    }

    expect(String(onError.mock.calls[0]?.[0])).toMatch(/no fetch available/);
  });
});
