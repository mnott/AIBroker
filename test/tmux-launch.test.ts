import "./home-guard.js";
/**
 * test/tmux-launch.test.ts — TmuxTransport.launch against an injected tmux.
 * No real tmux is spawned: `exec` records the argv and answers from a script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TmuxTransport } from "../src/transport/tmux.js";

function fake(answers: Record<string, string | null>) {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    return args[0] in answers ? answers[args[0]] : "";
  };
  return { calls, exec };
}
const opts = { dir: "/work/api", name: "api" };
const claudeBin = "/bin/claude";

test("inside tmux: new window in the current session, titled and tagged", () => {
  const f = fake({ "new-window": "%7\n" });
  const r = new TmuxTransport().launch(opts, { exec: f.exec, env: { TMUX: "/tmp/x,1,0" }, claudeBin });
  assert.equal(f.calls[0][0], "new-window");
  assert.deepEqual(f.calls[0].slice(1, 7), ["-c", "/work/api", "-n", "api", "-P", "-F"]);
  assert.deepEqual(f.calls[0].slice(-3), ["#{pane_id}", "--", claudeBin]);
  assert.ok(!f.calls.some((c) => c[0] === "new-session" || c[0] === "has-session"));
  assert.ok(f.calls.some((c) => c[0] === "select-pane" && c.includes("-T") && c.includes("api") && c.includes("%7")));
  const tag = f.calls.find((c) => c[0] === "set-option" && c.includes("@aibroker_id"))!;
  assert.equal(tag[tag.length - 1], r!.id, "the returned id is the @aibroker_id set on the pane");
  assert.equal(r!.transport, "tmux");
  assert.equal(r!.attach, undefined, "inside tmux there is nothing to attach to");
});

test("outside tmux, no aibroker session yet: creates it detached and says how to attach", () => {
  const f = fake({ "has-session": null, "new-session": "%0\n" });
  const r = new TmuxTransport().launch(opts, { exec: f.exec, env: {}, claudeBin });
  const ns = f.calls.find((c) => c[0] === "new-session")!;
  assert.deepEqual(ns.slice(0, 4), ["new-session", "-d", "-s", "aibroker"]);
  assert.ok(ns.includes("-n") && ns.includes("api") && ns.includes("/work/api"));
  assert.equal(r!.attach, "tmux attach -t aibroker");
});

test("outside tmux, session exists: adds a window to it", () => {
  const f = fake({ "has-session": "", "new-window": "%3\n" });
  new TmuxTransport().launch(opts, { exec: f.exec, env: {}, claudeBin });
  const nw = f.calls.find((c) => c[0] === "new-window")!;
  assert.deepEqual(nw.slice(0, 3), ["new-window", "-t", "aibroker:"]);
  assert.ok(!f.calls.some((c) => c[0] === "new-session"));
});

test("a stale $TMUX falls back to the aibroker session", () => {
  const f = fake({ "new-window": null, "has-session": null, "new-session": "%1\n" });
  // first new-window (inside) fails; the fallback must not reuse it
  let n = 0;
  const exec = (a: string[]) => { const r = f.exec(a); return a[0] === "new-window" && ++n === 1 ? null : r; };
  const r = new TmuxTransport().launch(opts, { exec, env: { TMUX: "/gone,1,0" }, claudeBin });
  assert.ok(r, "fell back instead of failing");
  assert.ok(f.calls.some((c) => c[0] === "new-session"));
});

test("tmux refusing the window returns null and tags nothing", () => {
  const f = fake({ "has-session": null, "new-session": null });
  assert.equal(new TmuxTransport().launch(opts, { exec: f.exec, env: {}, claudeBin }), null);
  assert.ok(!f.calls.some((c) => c[0] === "set-option"));
});

test("resume launches with --name, skip-permissions and the /Name prompt as separate argv", () => {
  const f = fake({ "has-session": null, "new-session": "%0\n" });
  new TmuxTransport().launch({ ...opts, resume: true }, { exec: f.exec, env: {}, claudeBin });
  const ns = f.calls.find((c) => c[0] === "new-session")!;
  const tail = ns.slice(ns.indexOf("--") + 1);
  assert.deepEqual(tail, [claudeBin, "--name", "api", "--dangerously-skip-permissions", "/Name api"]);
});
