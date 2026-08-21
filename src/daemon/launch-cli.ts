/**
 * daemon/launch-cli.ts — `aibroker launch <project>`, a session from a shell.
 *
 * Launching already existed over IPC, reachable from a session that has the
 * tool. That is the wrong shape for the one case that matters most: bringing
 * work back after the machine restarted. At that moment there is no session to
 * hold the tool — that is the whole problem — so the capability has to be
 * reachable from a script and from a bare prompt, which means a CLI verb.
 *
 * It prints the iTerm session id because the caller's next move is almost
 * always to manage or arm the thing it just created, and that needs the id.
 */

import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";

export async function runLaunch(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("Usage: aibroker launch <pai-project-name>");
    process.exit(1);
  }

  const client = new WatcherClient(DAEMON_SOCKET_PATH);

  /*
   * Attach before spawning. Launching is not the point — HAVING a session for
   * this project is, and a second pane in the same repository is worse than no
   * pane at all: two agents claiming the same issues, committing over each
   * other, neither aware of the other. The recovery case cannot tell in advance
   * whether the machine restarted or the caller simply asked twice, so the only
   * safe shape is idempotent.
   *
   * Match on paiName, which is the project identity the daemon assigns, rather
   * than on the terminal's title, which carries spinner glyphs and process
   * names and would match a bare shell sitting in the same directory.
   */
  const live = (await client.call_raw("sessions", {})) as
    | Array<{ sessionId: string; paiName: string | null; kind?: string }>
    | { sessions?: Array<{ sessionId: string; paiName: string | null; kind?: string }> };
  const list = Array.isArray(live) ? live : (live?.sessions ?? []);
  const already = list.find((s) => s.paiName && s.paiName.toLowerCase() === name.toLowerCase());
  if (already) {
    console.log(`${already.paiName} is already running — attached, nothing launched.`);
    console.log(`  iterm ${already.sessionId}`);
    return;
  }

  /*
   * call_raw returns the handler's RESULT, not the {ok, result} envelope the
   * handler writes — the client unwraps it and throws on failure. Checking for
   * `ok` here therefore read undefined on every success and reported a launch
   * that had in fact happened as a failure, which is the worst way to be wrong:
   * the caller sees an error and tries again, and now there are two sessions.
   * Success is a session id coming back; anything else is a failure to say out
   * loud.
   */
  let res: { itermSessionId?: string; sessionId?: string; name?: string };
  try {
    res = (await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("pai_launch", { name })) as typeof res;
  } catch (err) {
    console.error(`Could not launch ${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!res?.itermSessionId) {
    console.error(`Could not launch ${name}: the daemon returned no session`);
    process.exit(1);
  }

  console.log(`Launched ${res.name ?? name}`);
  console.log(`  iterm ${res.itermSessionId}`);
}
