import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SKILLS = [
  { dir: "routing", uri: "skill://aibroker/routing/SKILL.md", prompt: "aibroker-routing" },
  { dir: "handover", uri: "skill://aibroker/handover/SKILL.md", prompt: "aibroker-handover" },
  { dir: "setup", uri: "skill://aibroker/setup/SKILL.md", prompt: "aibroker-setup" },
];

test("MCP server serves skills as resources and prompts over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/index.js"], // needs `npm run build` first
    env: { ...process.env, HOME: process.env.HOME ?? "" } as Record<string, string>,
  });
  const client = new Client({ name: "skill-test", version: "0" });
  await client.connect(transport);
  try {
    const caps = client.getServerCapabilities();
    assert.ok(caps?.resources, "resources capability");
    assert.ok(caps?.prompts, "prompts capability");
    assert.ok(caps?.tools, "tools capability");

    const instr = client.getInstructions() ?? "";
    assert.ok(instr.length < 2500, `instructions short (${instr.length})`);
    for (const s of SKILLS) {
      assert.ok(instr.includes(s.uri), `instructions mention ${s.uri}`);
      assert.ok(instr.includes(s.prompt), `instructions mention ${s.prompt}`);
    }

    const resources = (await client.listResources()).resources;
    const prompts = (await client.listPrompts()).prompts;
    for (const s of SKILLS) {
      const file = readFileSync(`skills/${s.dir}/SKILL.md`, "utf8");
      const r = resources.find((x) => x.uri === s.uri);
      assert.ok(r, `resource ${s.uri} listed`);
      assert.equal(r.mimeType, "text/markdown");
      const read = await client.readResource({ uri: s.uri });
      assert.equal((read.contents[0] as { text: string }).text, file);

      assert.ok(prompts.some((p) => p.name === s.prompt), `prompt ${s.prompt} listed`);
      const got = await client.getPrompt({ name: s.prompt });
      assert.equal(got.messages.length, 1);
      assert.equal(got.messages[0].role, "user");
      assert.equal((got.messages[0].content as { text: string }).text, file);
    }

    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((t) => t.name === "aibroker_status"), "tools unchanged");
  } finally {
    await client.close();
  }
});
