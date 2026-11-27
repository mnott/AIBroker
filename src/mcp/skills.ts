import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Skills served over MCP. Single source: skills/<dir>/SKILL.md (shipped in the
 * package). Resolved relative to this module: dist/mcp/ or src/mcp/ -> ../../skills.
 */
export interface ServedSkill {
  dir: string;
  uri: string;
  prompt: string;
  title: string;
  description: string;
}

export const SKILLS: ServedSkill[] = [
  { dir: "routing", uri: "skill://aibroker/routing/SKILL.md", prompt: "aibroker-routing",
    title: "AIBroker routing skill", description: "Full channel routing, Task, mailbox and session orchestration rules." },
  { dir: "handover", uri: "skill://aibroker/handover/SKILL.md", prompt: "aibroker-handover",
    title: "AIBroker handover skill", description: "Handing a session over to or from AIBroker." },
  { dir: "setup", uri: "skill://aibroker/setup/SKILL.md", prompt: "aibroker-setup",
    title: "AIBroker setup skill", description: "Install, configure and verify AIBroker." },
];

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

export function readSkill(s: ServedSkill): string {
  return readFileSync(join(SKILLS_ROOT, s.dir, "SKILL.md"), "utf8");
}
