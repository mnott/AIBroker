/**
 * daemon/ingress.ts — who may put text on a Claude session's input line.
 *
 * The operator's own channels (Telex, Whazaa, PAILot — `!`-prefixed or not) are
 * the operator typing: they cannot be typing in parallel at the terminal, so
 * those messages go to the input line. Everything else is machine ingress
 * (Todoist, forge/GitHub events, worker alerts, other sessions, A2A): it is
 * stored in the session's mailbox and nothing is typed, so it can never land in
 * a sentence the operator is writing. An idle session is woken by its
 * `aibroker mailbox wait`; a busy one reads the mailbox at its next prompt.
 *
 * One table, one function. A source that is not listed is machine ingress.
 */

export type Delivery = "type" | "mailboxOnly";

const INGRESS_DELIVERY = {
  // The operator's own channels.
  telex: "type",
  telegram: "type",
  whazaa: "type",
  whatsapp: "type",
  pailot: "type",
  // Machine ingress.
  todoist: "mailboxOnly",
  forge: "mailboxOnly",
  github: "mailboxOnly",
  inbound: "mailboxOnly",
  a2a: "mailboxOnly",
  worker: "mailboxOnly",
  session: "mailboxOnly",
} as const satisfies Record<string, Delivery>;

/** How a message from `source` reaches a session; an unknown source is machine ingress. */
export function deliveryFor(source: string | undefined): Delivery {
  const hit = (INGRESS_DELIVERY as Record<string, Delivery>)[(source ?? "").toLowerCase()];
  return hit ?? "mailboxOnly";
}
