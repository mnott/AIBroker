/**
 * daemon/create-adapter.ts — Adapter scaffold generator.
 *
 * Copies the templates/adapter/ directory to an output location, replacing
 * {{ADAPTER_NAME}} and {{DISPLAY_NAME}} placeholders and stripping .tmpl
 * extensions.
 *
 * Template source resolution order:
 *   1. Alongside the running dist/daemon/cli.js  →  ../../templates/adapter/
 *      (works for: npm link, local dev, global install via npm pack)
 *   2. Alongside package root (fallback for non-standard setups)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface CreateAdapterOptions {
  adapterName: string;
  displayName?: string;
  outputDir?: string;
}

/**
 * Scaffold a new adapter from the built-in template.
 */
export async function createAdapter(options: CreateAdapterOptions): Promise<void> {
  const { adapterName } = options;

  // Derive display name from adapter name if not provided
  // "my-signal" -> "My Signal"
  const displayName = options.displayName
    ?? adapterName
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");

  // Resolve output directory
  const outputDir = options.outputDir
    ? resolvePath(options.outputDir)
    : resolve(process.cwd(), adapterName);

  // Locate template directory
  const templateDir = findTemplateDir();
  if (!templateDir) {
    console.error("Error: Could not find the templates/adapter/ directory.");
    console.error("This is a bug in the aibroker package. Please report it.");
    process.exit(1);
  }

  console.log(`Creating adapter "${adapterName}" (display name: "${displayName}")`);
  console.log(`  Template: ${templateDir}`);
  console.log(`  Output:   ${outputDir}`);
  console.log();

  // Collect all template files
  const templateFiles = walkDir(templateDir);

  // Process each file
  for (const absTemplatePath of templateFiles) {
    const relPath = relative(templateDir, absTemplatePath);

    // Strip .tmpl extension for the output path, but also apply name substitution
    // to the path itself (no placeholders in paths currently, but future-safe)
    const relOutputPath = relPath
      .replace(/\.tmpl$/, "")
      .replace(/\{\{ADAPTER_NAME\}\}/g, adapterName)
      .replace(/\{\{DISPLAY_NAME\}\}/g, displayName);

    const outputPath = join(outputDir, relOutputPath);

    // Read, substitute, write
    const raw = readFileSync(absTemplatePath, "utf8");
    const processed = raw
      .replace(/\{\{ADAPTER_NAME\}\}/g, adapterName)
      .replace(/\{\{DISPLAY_NAME\}\}/g, displayName);

    // Ensure parent directory exists
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, processed, "utf8");

    console.log(`  + ${relOutputPath}`);
  }

  console.log();
  printNextSteps(adapterName, displayName, outputDir);
}

// ── Template directory resolution ─────────────────────────────────────────────

/**
 * Find the templates/adapter/ directory relative to the running script.
 *
 * The compiled CLI lives at dist/daemon/cli.js.
 * The templates live at templates/adapter/ (two levels up from dist/daemon/).
 *
 * For a globally installed npm package the layout is:
 *   node_modules/aibroker/dist/daemon/cli.js
 *   node_modules/aibroker/templates/adapter/
 *
 * This function walks up from __dirname until it finds the templates/ dir.
 */
function findTemplateDir(): string | null {
  // Walk up from __dirname to find a directory containing templates/adapter/
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "templates", "adapter");
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // Not found at this level, keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Recursively collect all file paths within a directory.
 */
function walkDir(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Resolve a path that may start with ~ (home directory).
 */
function resolvePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  return resolve(p);
}

// ── Next-steps instructions ───────────────────────────────────────────────────

function printNextSteps(adapterName: string, displayName: string, outputDir: string): void {
  console.log("Done! Next steps:");
  console.log();
  console.log(`  1. cd ${outputDir}`);
  console.log(`  2. npm install`);
  console.log();
  console.log(`  3. Implement the upstream connection:`);
  console.log(`     src/watcher/connection.ts  —  connectWatcher()`);
  console.log();
  console.log(`  4. Implement outbound delivery:`);
  console.log(`     src/watcher/send.ts  —  sendText(), sendVoice(), sendFile()`);
  console.log();
  console.log(`  5. Build and run:`);
  console.log(`     npm run build`);
  console.log(`     npm run watch`);
  console.log();
  console.log(`  The adapter will auto-detect the AIBroker hub if it is running.`);
  console.log(`  IPC socket: /tmp/${adapterName}-watcher.sock`);
  console.log();
}
