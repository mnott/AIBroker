/**
 * daemon/inbound-cli.ts — `aibroker inbound` subcommands.
 *
 * Top-level, not nested under `todoist`, because an inbound route has nothing
 * to do with Todoist. It lived there for one afternoon only because that is the
 * file the endpoint was written next to, and a command's place in the tree is a
 * claim about what a thing IS — `aibroker todoist inbound` says the endpoint
 * belongs to the Todoist integration, which is exactly the confusion the
 * two-hop design exists to avoid.
 */

import { loadEnvFile } from "../core/env.js";

function usage(): void {
  console.log("Usage: aibroker inbound <list|add|remove>");
  console.log("");
  console.log("  list                           Routes and where they deliver");
  console.log("  add <name> <owner>             Create a route and print its secret ONCE");
  console.log("      --mode message|task        message → the session's mailbox; task → Todoist (default)");
  console.log("      --fields a,b.c             Lift only these payload fields into the message");
  console.log("      --note \"...\"               What sends here, for the next reader");
  console.log("  fields <name> <a,b.c>          Change which fields are lifted; the secret is untouched");
  console.log("  remove <name>                  Delete a route");
  console.log("");
  console.log("A route names WHERE events go, never what they mean — the receiving session");
  console.log("decides that. Name routes after their SOURCE (monster, glidr), not a topic.");
  console.log("");
  console.log("POST https://<public-host>/hook/<name>   header: x-aibroker-token: <secret>");
  console.log("See docs/inbound.md for the security model.");
}

export async function runInbound(args: string[]): Promise<void> {
  loadEnvFile();
  const rest = args;
  const [action, name, owner] = rest;


  const { listRoutes, addRoute, removeRoute, setRouteFields } = await import("./inbound.js");
  

  if (!action || action === "list") {
    const routes = listRoutes();
    if (routes.length === 0) {
      console.log("No inbound routes. Create one with: aibroker inbound add <name> <session>");
      return;
    }
    const host = process.env.AIBROKER_PUBLIC_HOST ?? "<your-public-host>";
    for (const r of routes) {
      console.log(`  POST https://${host}/hook/${r.name}`);
      console.log(`       → ${r.owner} (${r.mode})${r.enabled === false ? "  [disabled]" : ""}`);
      if (r.fields?.length) console.log(`       fields: ${r.fields.join(", ")}`);
      if (r.note) console.log(`       ${r.note}`);
      console.log(`       since ${r.createdAt.slice(0, 10)}`);
    }
    // The secret is never printed again. Printing it on `list` would put
    // every route's credential into whatever scrollback, screen share or
    // terminal recording happens to be running.
    console.log("\nSecrets are shown only when a route is created. Recreate a route to rotate it.");
    return;
  }

  if (action === "add") {
    if (!name || !owner) {
      console.error("Usage: aibroker inbound add <name> <session> [--mode message|task] [--fields a,b] [--note \"...\"]");
      process.exit(1);
    }
    const modeIdx = rest.indexOf("--mode");
    const fieldsIdx = rest.indexOf("--fields");
    const noteIdx = rest.indexOf("--note");
    const mode = modeIdx !== -1 ? rest[modeIdx + 1] : undefined;
    if (mode && mode !== "message" && mode !== "task") {
      console.error(`Unknown mode "${mode}" — use message or task.`);
      process.exit(1);
    }
    const r = addRoute(name, {
      owner,
      mode: mode as "message" | "task" | undefined,
      fields: fieldsIdx !== -1 ? rest[fieldsIdx + 1].split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      note: noteIdx !== -1 ? rest[noteIdx + 1] : undefined,
    });
    const host = process.env.AIBROKER_PUBLIC_HOST ?? "<your-public-host>";
    console.log(`Route created.\n`);
    console.log(`  URL     POST https://${host}/hook/${r.name}`);
    console.log(`  Header  x-aibroker-token: ${r.secret}`);
    console.log(`  Owner   ${r.owner} (${r.mode})`);
    console.log(`\nThis is the only time the secret is shown. Anything holding it can reach`);
    console.log(`${r.owner} — treat it like a password, and recreate the route to rotate it.`);
    return;
  }

  /*
   * Changing what a route SHOWS must not rotate what it TRUSTS. Recreating was
   * the only way to add a field, and that hands you a new secret to go and
   * paste into the sending system — so a route with a wrong field list tended
   * to keep it.
   */
  if (action === "fields") {
    if (!name || !owner) {
      console.error('Usage: aibroker inbound fields <name> <a,b.c>   ("-" to lift the whole payload)');
      process.exit(1);
    }
    const list = owner === "-" ? [] : owner.split(",").map((x) => x.trim()).filter(Boolean);
    const r = setRouteFields(name, list);
    if (!r) {
      console.error(`No route named ${name}.`);
      process.exit(1);
    }
    console.log(`/hook/${name} now lifts: ${r.fields ? r.fields.join(", ") : "the whole payload"}`);
    console.log("The secret is unchanged — nothing to re-paste at the sender.");
    return;
  }

  if (action === "remove") {
    if (!name) { console.error("Usage: aibroker inbound remove <name>"); process.exit(1); }
    console.log(removeRoute(name) ? `Removed /hook/${name}.` : `No route named ${name}.`);
    return;
  }

  console.error(`Unknown inbound action: ${action}`);
  process.exit(1);
  return;

  usage();
  if (action) process.exit(1);
}
