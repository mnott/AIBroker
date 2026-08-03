/**
 * daemon/outbound-cli.ts — `aibroker outbound` subcommands.
 *
 * Targets are named here, at the terminal, and nowhere else. A session can call
 * a target; it cannot invent one. That is the same boundary `inbound` draws in
 * the other direction, for the same reason.
 */

import { loadEnvFile } from "../core/env.js";

function usage(): void {
  console.log("Usage: aibroker outbound <list|add|remove>");
  console.log("");
  console.log("  list                           Targets a session may call");
  console.log("  add <name> <https-url>         Register a target");
  console.log("      --header <name>            Send the secret in this header");
  console.log("      --secret <value>           Use this secret rather than generating one");
  console.log("      --note \"...\"               What is on the other end");
  console.log("  remove <name>                  Delete a target");
  console.log("");
  console.log("A target is a webhook an automation platform already exposes. The session");
  console.log("decides WHAT to do; the platform's own actions do it — so we never hold a");
  console.log("vendor credential or maintain a connector. Every call is audited.");
}

export async function runOutbound(args: string[]): Promise<void> {
  loadEnvFile();
  const { listTargets, addTarget, removeTarget } = await import("./outbound.js");
  const [action, name, url] = args;

  if (!action || action === "list") {
    const targets = listTargets();
    if (targets.length === 0) {
      console.log("No outbound targets. Create one with: aibroker outbound add <name> <https-url>");
      return;
    }
    for (const t of targets) {
      console.log(`  ${t.name}${t.enabled === false ? "  [disabled]" : ""}`);
      console.log(`       POST ${t.url}`);
      if (t.header) console.log(`       auth header: ${t.header}`);
      if (t.note) console.log(`       ${t.note}`);
      console.log(`       since ${t.createdAt.slice(0, 10)}`);
    }
    console.log("\nSecrets are shown only when a target is created. Re-add a target to rotate.");
    return;
  }

  if (action === "add") {
    if (!name || !url) {
      console.error("Usage: aibroker outbound add <name> <https-url> [--header <name>] [--secret <value>] [--note \"...\"]");
      process.exit(1);
    }
    const at = (flag: string): string | undefined => {
      const i = args.indexOf(flag);
      return i !== -1 ? args[i + 1] : undefined;
    };
    try {
      const t = addTarget(name, { url, header: at("--header"), secret: at("--secret"), note: at("--note") });
      console.log(`Target created.\n`);
      console.log(`  Name    ${t.name}`);
      console.log(`  POST    ${t.url}`);
      if (t.header && t.secret) {
        console.log(`  Header  ${t.header}: ${t.secret}`);
        console.log(`\nPut that header on the receiving workflow. This is the only time it is shown.`);
      }
      console.log(`\nA session calls it with the aibroker_outbound MCP tool.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    return;
  }

  if (action === "remove") {
    if (!name) { console.error("Usage: aibroker outbound remove <name>"); process.exit(1); }
    console.log(removeTarget(name) ? `Removed ${name}.` : `No target named ${name}.`);
    return;
  }

  console.error(`Unknown outbound action: ${action}`);
  usage();
  process.exit(1);
}
