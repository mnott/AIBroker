/**
 * test/todoist-webhook.test.ts — the Todoist inbound channel.
 *
 * This endpoint turns a task filed from a phone into an instruction a session
 * executes with the user's full rights, so `route()` is not a convenience — it
 * is the security boundary. Todoist's payload documents that `initiator` may be
 * "a collaborator from a shared project", which is exactly the exposure these
 * tests pin down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifySignature,
  route,
  eventKey,
  AGENT_MARK,
  type TodoistEvent,
  type WebhookConfig,
} from "../src/daemon/todoist-webhook.js";

const SECRET = "s3cret";
const INGRESS = "proj-ingress";
const INBOX = "proj-inbox";
const OWNED = "proj-whazaa";

const cfg: WebhookConfig = {
  secret: SECRET, port: 8766, bind: "127.0.0.1", path: "/todoist",
  ingressProjectIds: new Set([INGRESS, INBOX, OWNED]),
  projectOwners: new Map([[OWNED, "whazaa"]]),
  defaultOwner: "broker",
};

const task = (over: Record<string, unknown> = {}): TodoistEvent => ({
  event_name: "item:added",
  triggered_at: "2026-08-01T16:00:00.0Z",
  initiator: { email: "owner@example.com", id: "1" },
  event_data: {
    id: "task-1",
    content: "Run the job sweep",
    description: "",
    project_id: INGRESS,
    labels: ["pai:whazaa"],
    ...over,
  },
});

// ── signature ───────────────────────────────────────────────────────────────

test("a correctly signed body verifies", () => {
  const raw = Buffer.from(JSON.stringify(task()));
  const sig = createHmac("sha256", SECRET).update(raw).digest("base64");
  assert.equal(verifySignature(raw, sig, SECRET), true);
});

test("a tampered body does not verify", () => {
  const raw = Buffer.from(JSON.stringify(task()));
  const sig = createHmac("sha256", SECRET).update(raw).digest("base64");
  const tampered = Buffer.from(JSON.stringify(task({ content: "rm -rf /" })));
  assert.equal(verifySignature(tampered, sig, SECRET), false);
});

test("a missing signature is rejected", () => {
  assert.equal(verifySignature(Buffer.from("{}"), undefined, SECRET), false);
});

test("a signature from the wrong secret is rejected", () => {
  const raw = Buffer.from(JSON.stringify(task()));
  const sig = createHmac("sha256", "wrong").update(raw).digest("base64");
  assert.equal(verifySignature(raw, sig, SECRET), false);
});

test("garbage in the signature header does not throw", () => {
  assert.doesNotThrow(() => verifySignature(Buffer.from("{}"), "!!!not base64!!!", SECRET));
  assert.equal(verifySignature(Buffer.from("{}"), "!!!not base64!!!", SECRET), false);
});

// ── the boundary ────────────────────────────────────────────────────────────

test("a task in the ingress project with an owner label is acted on", () => {
  const d = route(task(), cfg);
  assert.equal(d.act, true);
  assert.equal(d.act && d.project, "whazaa");
  assert.equal(d.act && d.body, "Run the job sweep");
});

test("a task in ANY OTHER project is refused", () => {
  // The shared-project exposure: a collaborator filing into a project they
  // share with the user must not reach this machine.
  const d = route(task({ project_id: "some-shared-project" }), cfg);
  assert.equal(d.act, false);
  assert.match(d.act === false ? d.reason : "", /not an ingress project/);
});

test("a label cannot smuggle a task in from outside the allowlist", () => {
  // The boundary is the project, not the label. Otherwise anyone able to file
  // into a shared project could route work by adding a label.
  const d = route(task({ project_id: "some-shared-project", labels: ["pai:whazaa"] }), cfg);
  assert.equal(d.act, false);
});

test("a task filed into an owned project routes there without a label", () => {
  // "Put it in the Whazaa list" — the project IS the routing instruction.
  const d = route(task({ labels: [], project_id: OWNED }), cfg);
  assert.equal(d.act, true);
  assert.equal(d.act && d.project, "whazaa");
});

test("an Inbox task with no label goes to the default owner — the watch case", () => {
  // Captured from a watch there is no project and no label. This must work, or
  // the most common way of filing something is the one that fails.
  const d = route(task({ labels: [], project_id: INBOX }), cfg);
  assert.equal(d.act, true);
  assert.equal(d.act && d.project, "broker");
});

test("a label overrides the project it was filed in", () => {
  const d = route(task({ labels: ["pai:telex"], project_id: OWNED }), cfg);
  assert.equal(d.act && d.project, "telex");
});

test("with no default owner, an unroutable task is dropped rather than guessed", () => {
  const strict: WebhookConfig = { ...cfg, defaultOwner: undefined };
  const d = route(task({ labels: [], project_id: INBOX }), strict);
  assert.equal(d.act, false);
  assert.match(d.act === false ? d.reason : "", /no default owner/);
});

test("completing a task never starts work", () => {
  // Completion is the human saying "done". Acting on it would run the task
  // again at the moment it was declared finished.
  const e = { ...task(), event_name: "item:completed" };
  const d = route(e, cfg);
  assert.equal(d.act, false);
  assert.match(d.act === false ? d.reason : "", /no action taken/);
});

test("a fired reminder IS actionable — this is how scheduling works", () => {
  // Due dates do not push; reminders do. This event is the whole reason the
  // design needs no timer.
  const e = { ...task(), event_name: "reminder:fired" };
  const d = route(e, cfg);
  assert.equal(d.act, true);
});

test("unrelated event types are ignored", () => {
  for (const name of ["project:added", "label:deleted", "note:updated", "item:deleted"]) {
    const d = route({ ...task(), event_name: name }, cfg);
    assert.equal(d.act, false, `${name} must not be actionable`);
  }
});

// ── echo loops ──────────────────────────────────────────────────────────────

test("agent-authored content is ignored, so comments cannot loop", () => {
  // An agent writing back to Todoist fires an event; without this the reply
  // becomes an instruction to an agent, forever.
  const d = route(task({ content: `${AGENT_MARK} done: archived 40 mails` }), cfg);
  assert.equal(d.act, false);
  assert.match(d.act === false ? d.reason : "", /echo loop/);
});

test("the loop guard also covers the description", () => {
  const d = route(task({ description: `${AGENT_MARK} progress note` }), cfg);
  assert.equal(d.act, false);
});

test("initiator alone cannot break a loop, which is why marking is used", () => {
  // Agents act AS the user, so the initiator on an agent-written event is the
  // user. Documented here because it is the reason for the marker.
  const asUser = task({ content: `${AGENT_MARK} x` });
  assert.deepEqual(asUser.initiator, { email: "owner@example.com", id: "1" });
  assert.equal(route(asUser, cfg).act, false, "must be caught by the mark, not the initiator");
});

// ── content ─────────────────────────────────────────────────────────────────

test("the description is appended to the title as the body", () => {
  const d = route(task({ description: "Only the last 7 days." }), cfg);
  assert.equal(d.act && d.body, "Run the job sweep\n\nOnly the last 7 days.");
});

test("an empty task is not dispatched", () => {
  const d = route(task({ content: "   " }), cfg);
  assert.equal(d.act, false);
});

test("the owner label is case-insensitive on the prefix", () => {
  assert.equal(route(task({ labels: ["PAI:whazaa"] }), cfg).act, true);
});

// ── replay ──────────────────────────────────────────────────────────────────

test("the same delivery twice has the same key, a different one does not", () => {
  // Todoist retries. A retry must not run the work again.
  assert.equal(eventKey(task()), eventKey(task()));
  assert.notEqual(eventKey(task()), eventKey({ ...task(), triggered_at: "2026-08-01T16:00:01.0Z" }));
});

// ── configuration safety ────────────────────────────────────────────────────

test("an empty allowlist accepts NOTHING — it fails closed", () => {
  // The opposite of the earlier design, where an unset ingress meant "allow
  // everything". An empty allowlist must be the safest state, not the most
  // permissive, because that is what a misconfiguration produces.
  const empty: WebhookConfig = {
    secret: SECRET, port: 1, bind: "127.0.0.1", path: "/todoist",
    ingressProjectIds: new Set(), projectOwners: new Map(), defaultOwner: "broker",
  };
  assert.equal(route(task({ project_id: INBOX }), empty).act, false);
  assert.equal(route(task({ project_id: "anything" }), empty).act, false);
});

// ── addressing by text ──────────────────────────────────────────────────────
//
// Typing a label is several taps on a phone and worse on a watch. The cheapest
// address is the first word of what you were going to type anyway, so these
// tests pin down when a first word IS an address and — more importantly — when
// it is not, because reading "Home improvements" as a work order for the Home
// session would be worse than not having the feature.

const KNOWN = ["pai", "home", "clickr"];

test("a leading known name addresses the task and is stripped from the body", () => {
  const d = route(task({ content: "pai send a whatsapp message", labels: [] }), cfg, KNOWN);
  assert.equal(d.act, true);
  if (!d.act) return;
  assert.equal(d.project, "pai");
  assert.equal(d.rule, "address");
  assert.equal(d.body, "send a whatsapp message");
});

test("the name may be followed by a colon or comma", () => {
  for (const c of ["pai: do xyz", "pai, do xyz"]) {
    const d = route(task({ content: c, labels: [] }), cfg, KNOWN);
    assert.equal(d.act && d.project, "pai", c);
    assert.equal(d.act && d.body, "do xyz", c);
  }
});

test("an unknown first word is left alone — it is prose, not an address", () => {
  const d = route(task({ content: "Buy milk on the way home", labels: [] }), cfg, KNOWN);
  assert.equal(d.act, true);
  if (!d.act) return;
  assert.equal(d.project, "broker", "falls through to the default owner");
  assert.equal(d.rule, "default");
  assert.equal(d.body, "Buy milk on the way home", "nothing is eaten off the front");
});

test("a known name only counts at the front", () => {
  const d = route(task({ content: "ask pai about the sweep", labels: [] }), cfg, KNOWN);
  assert.equal(d.act && d.body, "ask pai about the sweep");
  assert.equal(d.act && d.rule, "default");
});

test("a one-word task is never an address — there would be nothing left to do", () => {
  const d = route(task({ content: "pai", labels: [] }), cfg, KNOWN);
  assert.equal(d.act && d.rule, "default");
  assert.equal(d.act && d.body, "pai");
});

test("a label still beats a name in the text", () => {
  const d = route(task({ content: "pai do xyz", labels: ["pai:whazaa"] }), cfg, KNOWN);
  assert.equal(d.act && d.project, "whazaa");
  assert.equal(d.act && d.rule, "label");
  assert.equal(d.act && d.body, "pai do xyz", "only the address rule edits the text");
});

test("a name in the text beats the project it was filed in", () => {
  // What you wrote is more deliberate than where quick-capture put it.
  const d = route(task({ content: "pai do xyz", project_id: OWNED, labels: [] }), cfg, KNOWN);
  assert.equal(d.act && d.project, "pai");
  assert.equal(d.act && d.rule, "address");
});

test("a configured owner is addressable even when its session is not running", () => {
  // Otherwise "clickr do xyz" is read as prose and silently does the wrong
  // thing; better to route it and let delivery report that nobody is home.
  const d = route(task({ content: "whazaa do xyz", labels: [] }), cfg, []);
  assert.equal(d.act && d.project, "whazaa");
  assert.equal(d.act && d.rule, "address");
});

// ── near misses ─────────────────────────────────────────────────────────────
//
// Three attempts in a row failed silently in real use: "@pai" as plain text,
// then a "PAI" label, then a "pai" label. Each looked like an instruction about
// where the task should go, none parsed, and every one landed on the default
// owner with nothing said. An unhonoured request must be recorded.

test("a bare label naming a known owner routes — one tap is the point", () => {
  // @pai in Todoist's picker is one tap; pai:pai is several. Both must work,
  // in a project that has no owner of its own to disagree with.
  for (const l of ["pai", "PAI"]) {
    const d = route(task({ content: "do xyz", labels: [l], project_id: INGRESS }), cfg, KNOWN);
    assert.equal(d.act && d.project, "pai", l);
    assert.equal(d.act && d.rule, "bare-label", l);
    assert.equal(d.nearMiss, undefined, l);
  }
});

// ── a label survives a move; a project mapping is a standing decision ───────
//
// Live on 2026-08-02: a task was moved from Clickr into the AIBroker project
// and kept its old bare `clickr` label. The label won, and a comment meant for
// AIBroker was delivered to Clickr. Nothing reported a conflict — it arrived in
// the wrong terminal and was found by someone reading it there.

test("a stale bare label loses to the project it was moved into", () => {
  const d = route(task({ content: "check the config pattern", labels: ["clickr"], project_id: OWNED }), cfg, ["clickr", "whazaa"]);
  assert.equal(d.act && d.project, "whazaa", "the project mapping, not the leftover label");
  assert.equal(d.act && d.rule, "project");
});

test("the disagreement is recorded, not just resolved", () => {
  // Picking a side silently is how this stayed invisible.
  const d = route(task({ content: "x", labels: ["clickr"], project_id: OWNED }), cfg, ["clickr", "whazaa"]);
  assert.match(d.nearMiss ?? "", /disagree/);
  assert.match(d.nearMiss ?? "", /probably left over/);
});

test("pai:<name> still overrides the project — the prefix is deliberate", () => {
  // Typing the prefix is an act; a bare label may be years old.
  const d = route(task({ content: "x", labels: ["pai:clickr"], project_id: OWNED }), cfg, ["clickr", "whazaa"]);
  assert.equal(d.act && d.project, "clickr");
  assert.equal(d.act && d.rule, "label");
  assert.equal(d.nearMiss, undefined, "an explicit override is not a conflict");
});

test("a bare label agreeing with its project raises nothing", () => {
  const d = route(task({ content: "x", labels: ["whazaa"], project_id: OWNED }), cfg, ["whazaa"]);
  assert.equal(d.act && d.project, "whazaa");
  assert.equal(d.nearMiss, undefined);
});

test("a label that names nobody is still a near miss", () => {
  const d = route(task({ content: "do xyz", labels: ["paix"] }), cfg, KNOWN);
  assert.match(d.nearMiss ?? "", /names nobody/);
});

test("an ordinary label is left alone", () => {
  // "urgent" must not be read as an attempt to address a session.
  const d = route(task({ content: "do xyz", labels: ["urgent"] }), cfg, KNOWN);
  assert.equal(d.nearMiss, undefined);
  assert.equal(d.act && d.rule, "default");
});

test("addressing an unknown name explicitly is a near miss", () => {
  const d = route(task({ content: "nosuchsession: do xyz", labels: [] }), cfg, KNOWN);
  assert.match(d.nearMiss ?? "", /no session by that name/);
  assert.equal(d.act && d.project, "broker", "still delivered, so the task is not lost");
});

test("ordinary prose produces no near miss", () => {
  const d = route(task({ content: "Buy milk", labels: [] }), cfg, KNOWN);
  assert.equal(d.nearMiss, undefined);
});

test("a correct label produces no near miss", () => {
  const d = route(task({ content: "do xyz", labels: ["pai:home"] }), cfg, KNOWN);
  assert.equal(d.nearMiss, undefined);
  assert.equal(d.act && d.project, "home");
});

test("the description still rides along when the address is stripped", () => {
  const d = route(task({ content: "pai do xyz", description: "context here", labels: [] }), cfg, KNOWN);
  assert.equal(d.act && d.body, "do xyz\n\ncontext here");
});

// ── the checkbox as a Run Now button ────────────────────────────────────────
//
// Ticking a RECURRING task does not close it: Todoist advances the due date and
// the task stays open. That is the click-to-run pattern — a checkbox used as a
// trigger. Everything else about completion is unchanged, because "done" must
// never start work: get this wrong and ticking something off starts the thing
// you thought you were finishing.

const recurringTrigger = (over: Record<string, unknown> = {}): TodoistEvent => ({
  event_name: "item:completed",
  triggered_at: "2026-08-01T20:00:00.0Z",
  initiator: { email: "owner@example.com", id: "1" },
  event_data: {
    id: "task-run", content: "Job sweep — run it and mail me the list",
    description: "", project_id: INGRESS,
    labels: ["pai:whazaa"], due: { is_recurring: true },
    ...over,
  },
});

test("completing a recurring, addressed task dispatches it", () => {
  const d = route(recurringTrigger(), cfg, ["whazaa"]);
  assert.equal(d.act, true);
  assert.equal(d.act && d.project, "whazaa");
});

test("completing a one-off task still starts nothing", () => {
  // The default and the important case: finishing work must not restart it.
  const d = route(recurringTrigger({ due: { is_recurring: false } }), cfg, ["whazaa"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /no action taken/);
});

test("a task with no due date at all still starts nothing", () => {
  const d = route(recurringTrigger({ due: undefined }), cfg, ["whazaa"]);
  assert.equal(d.act, false);
});

test("a recurring task without a routing label is not a trigger", () => {
  // A recurring shopping list in an ingress project must not become a work
  // order because someone ticked it. The label is the opt-in.
  const d = route(recurringTrigger({ labels: [] }), cfg, ["whazaa"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /no action taken/);
});

test("a task already claimed by a runner is not dispatched again", () => {
  // PAI's poller sets pai-running before anything else. Two mechanisms
  // watching one checkbox must not both fire for the same tick.
  const d = route(recurringTrigger({ labels: ["pai:whazaa", "pai-running"] }), cfg, ["whazaa"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /already in flight/);
});

test("the running label blocks even a plain completion", () => {
  const d = route(recurringTrigger({ due: { is_recurring: false }, labels: ["pai-running"] }), cfg, ["whazaa"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /already in flight/);
});

// ── defining a trigger is not pulling it ────────────────────────────────────
//
// Found live on 2026-08-01: creating a click-to-run task with a pai: label
// dispatched it on item:added, and ticking it dispatched it again half a second
// later. One intent, two runs. Adding a crontab line does not run the job.

test("creating a recurring, addressed task does NOT run it", () => {
  const d = route(task({ due: { is_recurring: true } }), cfg, ["whazaa"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /will run when fired or ticked, not now/);
});

test("creating an ordinary task still runs it", () => {
  // Only a RECURRING labelled task is a trigger definition. Everything filed
  // from a watch must still dispatch on creation.
  assert.equal(route(task(), cfg, ["whazaa"]).act, true);
});

test("creating a recurring task with no routing label still runs it", () => {
  // "water the plants, every monday" filed into an ingress project is work,
  // not a trigger: it has no label saying where it should go.
  const d = route(task({ due: { is_recurring: true }, labels: [], project_id: OWNED }), cfg, ["whazaa"]);
  assert.equal(d.act, true);
});

test("a fired reminder on a trigger still dispatches", () => {
  // The whole point of defining one.
  const e = { ...task({ due: { is_recurring: true } }), event_name: "reminder:fired" };
  assert.equal(route(e, cfg, ["whazaa"]).act, true);
});

// ── create, then classify ───────────────────────────────────────────────────
//
// The habitual workflow is to file a task first and label it second. At
// item:added it is not yet routable and is correctly ignored — and the event
// that MAKES it routable is an item:updated, which is not actionable. The event
// that matters was precisely the one nothing subscribed to.
//
// Subscribing to item:updated wholesale would be worse than the gap: every edit
// would dispatch. Only the STATE TRANSITION is safe.

const updated = (
  oldItem: Record<string, unknown>,
  newItem: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): TodoistEvent => ({
  event_name: "item:updated",
  triggered_at: "2026-08-02T09:00:00.0Z",
  initiator: { email: "owner@example.com", id: "1" },
  event_data: { id: "t-1", content: "Do the thing", description: "", ...newItem },
  event_data_extra: { old_item: { id: "t-1", content: "Do the thing", ...oldItem }, ...extra },
});

test("labelling an unlabelled task in an ingress project dispatches it", () => {
  const strict: WebhookConfig = { ...cfg, defaultOwner: undefined };
  const d = route(
    updated({ project_id: INGRESS, labels: [] }, { project_id: INGRESS, labels: ["pai:whazaa"] }),
    strict, ["whazaa"],
  );
  assert.equal(d.act, true);
  assert.equal(d.act && d.project, "whazaa");
});

test("moving a labelled task INTO an ingress project dispatches it", () => {
  // The other half of the same transition: the address was there, the boundary
  // was not.
  const d = route(
    updated({ project_id: "somewhere-else", labels: ["pai:whazaa"] }, { project_id: INGRESS, labels: ["pai:whazaa"] }),
    cfg, ["whazaa"],
  );
  assert.equal(d.act, true);
});

test("renaming an already-routable task does NOT dispatch", () => {
  // The failure mode of the naive fix: every edit becomes a work order.
  const d = route(
    updated({ project_id: INGRESS, labels: ["pai:whazaa"] }, { project_id: INGRESS, labels: ["pai:whazaa"] }),
    cfg, ["whazaa"],
  );
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /already routable/);
});

test("an edit that leaves a task unroutable does NOT dispatch", () => {
  const strict: WebhookConfig = { ...cfg, defaultOwner: undefined };
  const d = route(
    updated({ project_id: "outside", labels: [] }, { project_id: "outside", labels: ["urgent"] }),
    strict, ["whazaa"],
  );
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /still not routable/);
});

test("an update reporting a completion is not read as a routing change", () => {
  const strict: WebhookConfig = { ...cfg, defaultOwner: undefined };
  const d = route(
    updated({ project_id: INGRESS, labels: [] }, { project_id: INGRESS, labels: ["pai:whazaa"] },
      { update_intent: "item_completed" }),
    strict, ["whazaa"],
  );
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /item_completed/);
});

test("an update with no previous state is ignored", () => {
  // Nothing to compare, so nothing can be characterised — and acting would mean
  // dispatching on an edit of unknown shape.
  const e: TodoistEvent = { ...task(), event_name: "item:updated", event_data_extra: undefined };
  const d = route(e, cfg, ["whazaa"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /no previous state/);
});

test("our own pai-running write does not look like a routing change", () => {
  // Claiming a task fires item:updated. pai-running is not a routing label, so
  // routability is unchanged and the echo stays ignored.
  const d = route(
    updated(
      { project_id: INGRESS, labels: ["pai:whazaa"] },
      { project_id: INGRESS, labels: ["pai:whazaa", "pai-running"] },
    ),
    cfg, ["whazaa"],
  );
  assert.equal(d.act, false);
});

// ---------------------------------------------------------------------------
// Regression — 2026-08-04: the scheduler's own progress marker came back as work
// ---------------------------------------------------------------------------

/** A comment event, as Todoist delivers `note:added`. */
const noteAdded = (text: string): TodoistEvent => ({
  event_name: "note:added",
  triggered_at: "2026-08-04T07:42:38.0Z",
  initiator: { email: "owner@example.com", id: "1" },
  event_data: {
    id: "note-1",
    item_id: "task-1",
    content: text,
    project_id: OWNED,
  },
} as TodoistEvent);

test("the task bus progress marker is not a work order", () => {
  // Exactly what PAI's poller posted at 07:42:19, which AIBroker mirrored back
  // at 07:42:38 and dispatched — spawning a second session for a task that was
  // already running.
  const d = route(
    noteAdded("**RUNNING** — started 2026-08-04 07:41 UTC, jobs-grazyna. Disappears when it finishes."),
    cfg,
  );
  assert.equal(d.act, false);
});

test("the progress marker is ignored once it carries the agent mark too", () => {
  const d = route(
    noteAdded(`${AGENT_MARK} **RUNNING** — started 2026-08-04 07:41 UTC, jobs-grazyna.`),
    cfg,
  );
  assert.equal(d.act, false);
});

test("a human comment mentioning RUNNING is still mirrored", () => {
  // Mirroring human comments is the feature. The guard anchors at the start of
  // the comment precisely so it cannot eat one.
  const d = route(noteAdded("is this still **RUNNING**? I need the list today"), cfg);
  assert.equal(d.act, true);
});

test("an ordinary human comment is still mirrored", () => {
  const d = route(noteAdded("please include the Zurich postings too"), cfg);
  assert.equal(d.act, true);
});
