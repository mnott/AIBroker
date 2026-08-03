# Your task manager as the interface to AI

Most AI tools ask you to open something new. This one doesn't. You file a task in
Todoist the way you always have, and an AI picks it up, does the work, and
answers in the comments.

No new app. No new habit. No training.

---

## What it looks like

**You file a task.** From your phone, your watch, or the web — into whichever
project it belongs to.

> *"Check whether the payment reminder job ran last night."*

**It gets picked up.** Within seconds, by the AI session that owns that project.
Not a general assistant — the one that already knows that codebase, that client,
that folder of documents.

**It does the work and answers on the task.**

> *🤖 It ran at 02:14 and processed 41 records. Two failed on a missing VAT
> number — Meier AG and Frei GmbH. Want me to chase those?*

**You reply from the comments,** on your phone, wherever you are. That goes
straight back to the same session.

That's it. The whole interaction happens in a tool you already have open.

---

## Why a task manager rather than a chat window

**Delegation is already a solved interface.** You know how to give someone a
task: write what you want, put it where it belongs, check on it later. Everyone
in your organisation already does this, all day. A chat window throws that away
and asks people to learn a new one.

**A task is a record.** It has an owner, a history, a state, and a place. When
the work happens on a task instead of in a chat, you get the things that
normally cost a separate governance project:

- You can see what it's working on — the task is right there
- You can see what it decided, and why — in the comments
- You can say no before anything happens — nothing completes itself
- Someone else can pick it up — it isn't buried in your private chat history

**Adoption is the hard part, and this side-steps it.** The reason most AI pilots
stall is not model quality. It's that using the thing requires remembering to
open it. A task lands in a list people already check.

---

## What it's good for, honestly

Good fits:

- Work with a **clear owner** — a project, a repo, a client
- Things you'd otherwise write down and get to later
- Anything you want a **record** of
- Questions you'll ask from your phone, away from a desk

Poor fits:

- Rapid back-and-forth. That's what chat is for; use chat.
- Anything needing an instant answer. This is delegation, not conversation.
- Work with no obvious owner — it has to know which context to use.

---

## What it does not do

**It does not complete your tasks.** Ticking the box stays your decision — an
answer nobody has read isn't done, and a completed task takes its comments out
of your list with it.

**It does not act on anything you haven't allowed.** A project has to be
explicitly granted before tasks filed there can reach a session. Adding a
project later does not silently give it that power.

**It does not run without a record.** Every delivery, every refusal, and the
reason for each is written to an audit trail you can read.

---

## The one thing that surprised us

Todoist never notifies you about your **own** account's activity — and the AI
writes as you. So the first version worked perfectly and appeared to do nothing:
every answer was there, on the right task, completely invisible.

Now each answer also files itself into a Comments project, grouped by where it
came from, one tap from the real conversation. You can reply from there too, and
it finds its way back.

It's a good reminder that *"it worked"* and *"it arrived"* are different claims,
and most systems only check the first.

---

## Going deeper

- **[Set it up](./todoist.md)** — the full guide: endpoint, security model,
  routing rules, and the traps that cost a day
- **[The model behind it](./channels.md)** — how every inbound path works, not
  just this one
- **[The audit trail](./audit.md)** — what gets recorded and how to read it

Built on [AIBroker](https://github.com/mnott/AIBroker), which does the same for
WhatsApp, Telegram, a phone app, and any system that can call a webhook.
