/**
 * daemon/ota-publish-cli.ts — `aibroker ota publish`: CLI twin of the MCP tool
 * `ota_publish`. Prints only the install URL on stdout; any failure is one line
 * on stderr and a non-zero exit.
 */
import { publishOta } from "../ota/publish.js";

export const OTA_PUBLISH_USAGE =
  "Usage: aibroker ota publish --slug <slug> --name <name> --bundle <bundle id> --version <v> --platform ios|android <file>";

export function runOtaPublish(args: string[]): void {
  const opts: Record<string, string> = {};
  const files: string[] = [];
  const known = new Set(["--slug", "--name", "--bundle", "--version", "--platform"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (known.has(a)) {
      const v = args[i + 1];
      if (v === undefined) return fail(`Missing value for ${a}`);
      opts[a] = v;
      i++;
    } else if (a.startsWith("--")) {
      return fail(`Unknown option ${a}`);
    } else files.push(a);
  }
  for (const k of known) if (!opts[k]) return fail(`Missing ${k}`);
  if (files.length !== 1) return fail(files.length === 0 ? "Missing <file>" : "Only one <file> allowed");

  try {
    const r = publishOta({
      slug: opts["--slug"], name: opts["--name"], bundleId: opts["--bundle"],
      version: opts["--version"], platform: opts["--platform"], filePath: files[0],
    });
    if (!r.installUrl) return fail("Hub response has no installUrl");
    console.log(r.installUrl);
  } catch (e) {
    fail(e instanceof Error ? e.message.split("\n")[0] : String(e));
  }
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}
