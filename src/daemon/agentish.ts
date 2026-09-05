/**
 * daemon/agentish.ts — re-export shim.
 *
 * The validator itself is dependency-free (no daemon or Node-specific
 * imports beyond what TypeScript's lib already covers), so it lives at
 * `src/agentish/index.ts` where it can be lifted into its own package with a
 * directory move, not a rewrite, once AG2 stops changing shape every day.
 * This file exists only so code written against `./agentish.js` — inside
 * this daemon, and in anything else already importing that path — keeps
 * working without edits.
 */
export * from "../agentish/index.js";
