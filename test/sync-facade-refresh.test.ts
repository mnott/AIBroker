import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AIBROKER_TRANSPORT = "tmux";

test("stale memo: background refresh starts one enumeration, no recursion", async () => {
  const { TmuxTransport } = await import("../src/transport/tmux.js");
  let calls = 0;
  (TmuxTransport.prototype as any).listSessions = async () => { calls++; return []; };
  const facade = await import("../src/transport/sync-facade.js");
  await facade.snapshotAllSessions({ fresh: true }); // primes the memo
  assert.equal(calls, 1);
  const realNow = Date.now;
  for (const opts of [{}, { fresh: true }]) {
    calls = 0;
    const t0 = realNow();
    Date.now = () => t0 + 5_000; // past MEMO_TTL_MS, inside the stale limit
    try {
      const rows = await facade.snapshotAllSessions(opts); // RangeError before the fix
      assert.deepEqual(rows, []);
      await facade.snapshotAllSessions(opts); // joins the in-flight refresh, no second start
    } finally { Date.now = realNow; }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1);
  }
});
