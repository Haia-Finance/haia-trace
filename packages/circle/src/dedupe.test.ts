import { describe, expect, it } from "vitest";

import { createMemoryDedupeStore } from "./dedupe.js";

describe("createMemoryDedupeStore", () => {
  it("reports an id new once and a retry thereafter", () => {
    const store = createMemoryDedupeStore();
    expect(store.firstSeen("n-1")).toBe(true);
    expect(store.firstSeen("n-1")).toBe(false);
    expect(store.firstSeen("n-2")).toBe(true);
  });

  it("evicts the oldest id past capacity", () => {
    const store = createMemoryDedupeStore({ capacity: 2 });
    store.firstSeen("a");
    store.firstSeen("b");
    store.firstSeen("c"); // evicts "a"
    expect(store.firstSeen("a")).toBe(true); // forgotten, looks new again
    expect(store.firstSeen("c")).toBe(false); // still remembered
  });

  it("forgets a claimed id, so a failed delivery's retry looks new again", () => {
    const store = createMemoryDedupeStore();
    expect(store.firstSeen("n-1")).toBe(true);
    store.forget("n-1");
    expect(store.firstSeen("n-1")).toBe(true);
  });

  it("refreshes recency on a retry, so actively-retried ids survive eviction", () => {
    const store = createMemoryDedupeStore({ capacity: 2 });
    store.firstSeen("a");
    store.firstSeen("b");
    store.firstSeen("a"); // retry refreshes "a"; "b" is now oldest
    store.firstSeen("c"); // evicts "b", not "a"
    expect(store.firstSeen("a")).toBe(false);
    expect(store.firstSeen("b")).toBe(true);
  });
});
