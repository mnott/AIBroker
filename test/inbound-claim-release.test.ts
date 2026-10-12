import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaimReleaseEcho } from "../src/daemon/forge-release.js";

const ev = (action: string, n: number, o: { state?: string; labels?: string[]; assignees?: string[] } = {}) => ({
  action,
  repository: { full_name: "o/r" },
  issue: {
    number: n,
    state: o.state ?? "closed",
    labels: (o.labels ?? []).map((name) => ({ name })),
    assignees: (o.assignees ?? []).map((login) => ({ login })),
  },
});
const closeIt = (n: number) => isClaimReleaseEcho(ev("closed", n, { labels: ["in-progress"], assignees: ["claude"] }));

test("the unassigned + label_updated echoes after a close are dropped", () => {
  assert.equal(closeIt(710), false);
  assert.equal(isClaimReleaseEcho(ev("unassigned", 710)), true);
  assert.equal(isClaimReleaseEcho(ev("label_updated", 710)), true);
});

test("an echo with no earlier event falls back to a recent close", () => {
  const e = ev("unassigned", 711);
  assert.equal(isClaimReleaseEcho(e, 1_000_000), false);
});

test("a comment on a closed issue is delivered", () => {
  closeIt(712);
  assert.equal(isClaimReleaseEcho(ev("created", 712)), false);
});

test("a label added on a closed issue is delivered", () => {
  closeIt(713);
  assert.equal(isClaimReleaseEcho(ev("label_updated", 713, { labels: ["bug"] })), false);
});

test("a lone unassign with the label still present is dropped", () => {
  closeIt(716);
  assert.equal(isClaimReleaseEcho(ev("unassigned", 716, { labels: ["in-progress"] })), true);
});

test("a lone label removal with claude still assigned is dropped", () => {
  closeIt(717);
  assert.equal(isClaimReleaseEcho(ev("label_updated", 717, { assignees: ["claude"] })), true);
});

test("removing a non-claim label on a closed issue is delivered", () => {
  isClaimReleaseEcho(ev("closed", 718, { labels: ["bug", "in-progress"], assignees: ["claude"] }));
  assert.equal(isClaimReleaseEcho(ev("label_updated", 718, { labels: ["in-progress"], assignees: ["claude"] })), false);
});

test("reopen is delivered", () => {
  closeIt(714);
  assert.equal(isClaimReleaseEcho(ev("reopened", 714, { state: "open" })), false);
});

test("unassign on an open issue is delivered", () => {
  assert.equal(isClaimReleaseEcho(ev("unassigned", 715, { state: "open" })), false);
});

const T0 = 10_000_000;
const withClosedAt = (e: any, ms: number) => { e.issue.closed_at = new Date(ms).toISOString(); return e; };

test("first unassign after an unseen close is dropped (closed_at 5 s ago)", () => {
  const e = withClosedAt(ev("unassigned", 720, { labels: ["in-progress"] }), T0 - 5_000);
  assert.equal(isClaimReleaseEcho(e, T0), true);
});

test("an event on an issue closed 10 min ago is delivered", () => {
  const e = withClosedAt(ev("unassigned", 721, { labels: ["in-progress"] }), T0 - 600_000);
  assert.equal(isClaimReleaseEcho(e, T0), false);
});

test("a claim-marker removal with a prev snapshot is dropped even long after the close", () => {
  isClaimReleaseEcho(withClosedAt(ev("edited", 722, { labels: ["in-progress"], assignees: ["claude"] }), T0 - 600_000), T0);
  assert.equal(isClaimReleaseEcho(withClosedAt(ev("unassigned", 722, { labels: ["in-progress"] }), T0 - 600_000), T0 + 1), true);
});

test("deliverInbound updates the snapshot even when the sender filter drops the event, and audits ignored/dropped", async () => {
  const { deliverInbound } = await import("../src/daemon/inbound.js");
  const route = { name: "t", secret: "s", owner: "W", mode: "message" as const, ignore: ["sender.login=claude"], createdAt: "" };
  const mk = (action: string, o: any) => ({ ...ev(action, 723, o), sender: { login: "claude" } });
  const a = await deliverInbound(route, mk("closed", { labels: ["in-progress"], assignees: ["claude"] }));
  assert.equal(a.outcome, "ignored");
  // the snapshot came from the dropped close: the unassign is a pure claim removal
  assert.equal(isClaimReleaseEcho(ev("unassigned", 723, { labels: ["in-progress"] })), true);
  const b = await deliverInbound({ ...route, ignore: undefined }, ev("label_updated", 723));
  assert.equal(b.outcome, "dropped");
});
