/**
 * daemon/todoist-cli.ts — `aibroker todoist` subcommands.
 *
 * `auth` exists because Todoist does not deliver webhooks to the account that
 * created the app: only a completed OAuth round trip switches delivery on, and
 * the console's install button is not that. This mints the state, prints the
 * URL and hands off to the landing endpoint the daemon serves.
 */

import { loadEnvFile } from "../core/env.js";
import { authorizeUrl, beginAuth, loadToken } from "./todoist-oauth.js";

const DEFAULT_SCOPE = "data:read_write";

function usage(): void {
  console.log("Usage: aibroker todoist <auth|status|ingress>");
  console.log("");
  console.log("  auth [--scope <scopes>]        Authorise this account so webhooks are delivered");
  console.log("  status                         Show whether an authorisation is on file");
  console.log("  ingress list                   Projects allowed to reach a session");
  console.log("  ingress add <id> [=owner]      Grant a project ingress, effective immediately");
  console.log("  ingress remove <id>            Revoke a grant");
  console.log("");
  console.log(`Default scope: ${DEFAULT_SCOPE}. Add data:delete only if the bridge should remove tasks.`);
  console.log("");
  console.log("Ingress is deliberately explicit: a task filed into an allowed project becomes an");
  console.log("instruction a session runs with your full rights. Grants are recorded in the audit.");
}

export async function runTodoist(args: string[]): Promise<void> {
  loadEnvFile();
  const [sub, ...rest] = args;

  switch (sub) {
    case "auth": {
      const clientId = process.env.TODOIST_CLIENT_ID;
      if (!clientId) {
        console.error("TODOIST_CLIENT_ID is not set in ~/.aibroker/env.");
        console.error("Copy it from Todoist → Settings → Integrations → Developer → your app.");
        process.exit(1);
      }
      const scopeIdx = rest.indexOf("--scope");
      const scope = scopeIdx !== -1 ? rest[scopeIdx + 1] : DEFAULT_SCOPE;
      const state = beginAuth();
      const url = authorizeUrl(clientId, scope, state);

      console.log("Open this URL and approve the request:\n");
      console.log(`  ${url}\n`);
      console.log("Todoist will send you back to the redirect URL, which this daemon answers:");
      console.log("it makes the token exchange itself and tells you whether it worked.");
      console.log("\nThe attempt is good for 15 minutes.");
      break;
    }

    case "status": {
      const token = loadToken();
      if (!token) {
        console.log("No Todoist authorisation on file — webhooks will not be delivered.");
        console.log("Run: aibroker todoist auth");
        process.exit(1);
      }
      // Never print the token. What matters is that one exists, what it can do,
      // and — the thing that bit us — whether it is still valid.
      console.log(`Authorised ${token.obtained_at}`);
      console.log(`Scope: ${token.scope ?? "(unreported)"}`);
      if (token.expires_at) {
        const left = Math.round((Date.parse(token.expires_at) - Date.now()) / 60000);
        console.log(`Expires: ${token.expires_at} (${left} min)`);
        console.log(token.refresh_token
          ? "Refresh: automatic — refreshed on demand before it expires"
          : "Refresh: NONE ON FILE — this token will stop working and cannot renew itself");
      } else {
        console.log("Expires: no expiry reported (legacy long-lived token)");
      }
      break;
    }

    case "ingress": {
      const { listGrants, grantIngress, revokeIngress } = await import("./todoist-ingress.js");
      const [action, arg] = rest;

      if (!action || action === "list") {
        const envIds = (process.env.TODOIST_INGRESS_PROJECTS ?? "")
          .split(",").map((s) => s.trim()).filter(Boolean);
        if (envIds.length) {
          console.log("From ~/.aibroker/env (TODOIST_INGRESS_PROJECTS):");
          for (const e of envIds) console.log(`  ${e}`);
        }
        const grants = listGrants();
        console.log(grants.length ? "\nGranted at runtime:" : "\nNo runtime grants.");
        for (const g of grants) {
          console.log(`  ${g.projectId}${g.projectName ? ` (${g.projectName})` : ""} → ${g.owner ?? "(default owner)"}  since ${g.grantedAt.slice(0, 10)}`);
        }
        break;
      }

      if (action === "add") {
        if (!arg) { console.error("Usage: aibroker todoist ingress add <projectId>[=owner] [--name <label>]"); process.exit(1); }
        const [projectId, owner] = arg.split("=").map((s) => s.trim());
        const nameIdx = rest.indexOf("--name");
        const projectName = nameIdx !== -1 ? rest[nameIdx + 1] : undefined;
        const g = grantIngress(projectId, { owner: owner || undefined, projectName });
        console.log(`Granted ${g.projectName ?? g.projectId} → ${g.owner ?? "(default owner)"}. Effective immediately.`);
        break;
      }

      if (action === "remove") {
        if (!arg) { console.error("Usage: aibroker todoist ingress remove <projectId>"); process.exit(1); }
        console.log(revokeIngress(arg) ? `Revoked ${arg}.` : `No runtime grant for ${arg} (an entry in ~/.aibroker/env must be removed there).`);
        break;
      }

      console.error(`Unknown ingress action: ${action}`);
      process.exit(1);
      break;
    }

    default:
      usage();
      if (sub) process.exit(1);
  }
}
