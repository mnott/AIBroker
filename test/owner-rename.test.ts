import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameOwner, formatReport } from "../src/daemon/owner-rename.js";

test("owner rename: route owner rewritten, others and secrets untouched, secret not printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-owner-"));
  const secret = "s3cr3t-token-value";
  const route = (name: string, owner: string) => ({ name, secret, owner, mode: "message", createdAt: "2026-01-01T00:00:00Z" });
  writeFileSync(join(dir, "inbound.json"), JSON.stringify({
    routes: [route("alpha", "Old Name"), route("beta", "Other"), route("gamma", "Old Name Extra")],
  }));
  writeFileSync(join(dir, "session-restore.json"), JSON.stringify({ version: 2, entries: [{ name: "Old Name", cwd: "/x" }, { name: "Other", cwd: "/y" }] }));
  writeFileSync(join(dir, "session-history.json"), JSON.stringify([{ name: "Old Name" }]));

  const dry = renameOwner(dir, "Old Name", "New Name", true);
  assert.equal(JSON.parse(readFileSync(join(dir, "inbound.json"), "utf-8")).routes[0].owner, "Old Name");
  assert.equal(dry.changes.length, 2);

  const rep = renameOwner(dir, "Old Name", "New Name", false);
  const routes = JSON.parse(readFileSync(join(dir, "inbound.json"), "utf-8")).routes;
  assert.deepEqual(routes.map((r: { owner: string }) => r.owner), ["New Name", "Other", "Old Name Extra"]);
  assert.equal(routes[0].secret, secret);
  const restore = JSON.parse(readFileSync(join(dir, "session-restore.json"), "utf-8"));
  assert.deepEqual(restore.entries.map((e: { name: string }) => e.name), ["New Name", "Other"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "session-history.json"), "utf-8"))[0].name, "Old Name");

  const text = formatReport(rep, "Old Name", "New Name", false).join("\n");
  assert.ok(text.includes("alpha"));
  assert.ok(!text.includes(secret));

  const again = renameOwner(dir, "Old Name", "New Name", false);
  assert.equal(again.changes.length, 0);
  assert.match(formatReport(again, "Old Name", "New Name", false)[0], /Nothing to rename/);
});
