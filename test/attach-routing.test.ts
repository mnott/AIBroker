import "./home-guard.js";
/**
 * A Claude background session runs behind a `claude attach` pane; the pane id
 * its environment announces is dead. Names and PAILot routing must follow the
 * live attach pane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-attach-routing-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { resolveCallerPane } = await import("../src/daemon/core-handlers.js");
const { moveStaleNamesToAttachPanes } = await import("../src/adapters/iterm/sessions.js");
const { liveSessionFor, rememberIdSession } = await import("../src/core/state.js");
const { resolveCallerSession } = await import("../src/core/session-match.js");
const { setAppDir, setPersistentSessionName, getPersistentSessionName } = await import("../src/core/persistence.js");
import type { SessionSnapshot } from "../src/adapters/iterm/core.js";
import type { IpcRequest } from "../src/types/ipc.js";

setAppDir(scratch);

const UUID = "cdd93e8d-1111-2222-3333-444455556666";
const snap = (over: Record<string, unknown>) => ({ name: "", isClaude: true, ...over }) as unknown as SessionSnapshot;
const attachPane = snap({ id: "LIVE-PANE", attachUuid: "cdd93e8d" });
const shell = snap({ id: "SHELL", isClaude: false });

test("rename from a dead id plus uuid binds the attach pane (tty cannot)", () => {
  const live = [shell, attachPane];
  const req = { itermSessionId: "w0t0p0:DEAD-ID", claudeSessionId: UUID, callerTty: "/dev/ttys099" } as IpcRequest;
  assert.equal(resolveCallerSession("DEAD-ID", "/dev/ttys099", live as never), "DEAD-ID", "tty fallback alone keeps the dead id");
  assert.equal(resolveCallerPane(req, live)?.id, "LIVE-PANE");
});

test("an env-claimed live pane loses to the pane attached to the caller's claude session", () => {
  // The daemon case: claude daemon run was spawned in tab A, so a session
  // hosted on its spare announces A's ITERM_SESSION_ID while tab B observably
  // attaches the caller's claude uuid. The viewer wins.
  const a = snap({ id: "A" });
  const b = snap({ id: "B", attachUuid: "bbbbbbbb" });
  assert.equal(
    resolveCallerPane({ itermSessionId: "A", claudeSessionId: "bbbbbbbb-1111-2222-3333-444455556666" } as IpcRequest, [a, b])?.id,
    "B",
  );
  // No pane attaches the claimed uuid: the env-claimed live pane is kept.
  assert.equal(
    resolveCallerPane({ itermSessionId: "A", claudeSessionId: "cccccccc-1111-2222-3333-444455556666" } as IpcRequest, [a, b])?.id,
    "A",
  );
});

test("a dead-id PAILot target resolves to the live attach pane", () => {
  rememberIdSession("DEAD-1", UUID);
  assert.equal(liveSessionFor("DEAD-1", [shell, attachPane]), "LIVE-PANE");
});

test("a live Claude pane and an unknown id are returned unchanged", () => {
  rememberIdSession("OWN-1", UUID);
  assert.equal(liveSessionFor("OWN-1", [snap({ id: "OWN-1" }), attachPane]), "OWN-1");
  assert.equal(liveSessionFor("NEVER-SEEN", [attachPane]), "NEVER-SEEN");
});

test("name authority moves a stale name to the attach pane", () => {
  rememberIdSession("DEAD-2", UUID);
  setPersistentSessionName("DEAD-2", "CaseLeaf");
  assert.equal(moveStaleNamesToAttachPanes([shell, attachPane]), 1);
  assert.equal(getPersistentSessionName("LIVE-PANE"), "CaseLeaf");
  assert.equal(getPersistentSessionName("DEAD-2"), undefined);
});

test("name authority leaves a live holder and an already-named attach pane alone", () => {
  rememberIdSession("DEAD-3", UUID);
  setPersistentSessionName("DEAD-3", "Other");
  assert.equal(moveStaleNamesToAttachPanes([shell, attachPane]), 0, "attach pane already named CaseLeaf");
  assert.equal(getPersistentSessionName("DEAD-3"), "Other");
  assert.equal(moveStaleNamesToAttachPanes([snap({ id: "DEAD-3" }), attachPane]), 0, "live id is not stale");
});
