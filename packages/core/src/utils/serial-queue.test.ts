import { describe, it, expect } from "vitest";
import { createSerialQueue } from "./serial-queue";

describe("createSerialQueue (F5 single-flight)", () => {
  it("runs tasks strictly in order with no interleaving", async () => {
    const enqueue = createSerialQueue();
    const log: string[] = [];
    // Each task does an async read-modify-write on shared state; without
    // serialization the awaits would interleave and the order would scramble.
    const task = (label: string) => async () => {
      log.push(`start-${label}`);
      await Promise.resolve();
      await Promise.resolve();
      log.push(`end-${label}`);
    };
    await Promise.all([enqueue(task("a")), enqueue(task("b")), enqueue(task("c"))]);
    expect(log).toEqual([
      "start-a",
      "end-a",
      "start-b",
      "end-b",
      "start-c",
      "end-c",
    ]);
  });

  it("simulates the lost-update fix: serialized read-modify-write keeps every edit", async () => {
    const enqueue = createSerialQueue();
    // Shared 'store' whose value must reflect BOTH edits (a race would drop one).
    const store = { value: 0 };
    const edit = () => async () => {
      const base = store.value; // read
      await Promise.resolve(); // async work (execute)
      store.value = base + 1; // write
    };
    await Promise.all([enqueue(edit()), enqueue(edit())]);
    expect(store.value).toBe(2); // not 1 (which a clone-stale-base race would give)
  });

  it("a rejecting task does not wedge the queue; later tasks still run", async () => {
    const enqueue = createSerialQueue();
    const ran: string[] = [];
    const ok = enqueue(async () => {
      ran.push("first");
    });
    const bad = enqueue(async () => {
      ran.push("boom");
      throw new Error("nope");
    });
    const after = enqueue(async () => {
      ran.push("third");
    });

    await ok;
    await expect(bad).rejects.toThrow("nope");
    await after;
    expect(ran).toEqual(["first", "boom", "third"]);
  });
});
