import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/utils/semaphore.js";

describe("Semaphore", () => {
  it("allows up to limit concurrent acquisitions", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    assert.equal(sem.activeCount, 2);
    assert.equal(sem.waitingCount, 0);
  });

  it("blocks when limit is reached", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let acquired = false;
    const pending = sem.acquire().then(() => { acquired = true; });

    // Give the microtask queue a chance to run
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(acquired, false);
    assert.equal(sem.waitingCount, 1);

    sem.release();
    await pending;
    assert.equal(acquired, true);
  });

  it("processes waiters in FIFO order", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    sem.release();
    await p1;
    sem.release();
    await p2;

    assert.deepEqual(order, [1, 2]);
  });

  it("handles release without waiters", () => {
    const sem = new Semaphore(2);
    // Release without acquire should not throw (defensive)
    sem.release();
    assert.equal(sem.activeCount, -1); // Goes negative, but doesn't crash
  });

  it("supports high concurrency", async () => {
    const sem = new Semaphore(5);
    const results: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, i) =>
      (async () => {
        await sem.acquire();
        results.push(i);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 5));
        sem.release();
      })()
    );

    await Promise.all(tasks);
    assert.equal(results.length, 10);
  });
});
