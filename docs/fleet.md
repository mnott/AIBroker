# Running agents across several machines

Each machine runs its own hub. The hubs pair with each other, and after that a
session on another machine is addressed as `machine/session` and behaves like a
local one: it appears in listings, takes messages, and can be given a standing
objective.

The model is a development team rather than a distributed system. Each machine
is a developer with its own checkout and its own branch; git is already the
protocol for merging their work and nothing here tries to improve on it. What
this adds is the part git has no opinion about: dispatch, checking in, and
redirecting.

## Setting up a second machine

**1. Install AIBroker on it and start the daemon.** It needs no peering
configuration to run; peering is off until somebody switches it on.

**2. Get the two machines on a network they both trust.** A Tailscale network,
or the host-only network of a virtual machine. Note the address the *other*
machine will dial — that is the one you need next, and it is not `localhost`.

**3. On the machine that will be reached, issue an invite.**

```
aibroker peer invite <the-address-others-reach-me-on> --as host
```

The address is required and has no default, deliberately: guessing one means
opening a port somewhere nobody chose. It prints a single line to copy.

**4. Restart that daemon.** The listener starts at boot, so an invite issued
against a running daemon takes effect on its next start. The invite message says
so; it is the step most likely to be skipped.

**5. On the other machine, paste the line.**

```
aibroker peer join <the line>
```

This does not merely record the pairing — it calls the other hub and refuses if
it cannot reach it. A pairing that is only discovered to be broken when
something depends on it is worse than one that fails while somebody is watching.

**6. Check.**

```
aibroker peer list      # who is paired, and reachable right now
aibroker fleet          # what each machine can do
```

## Using it

```
aibroker manage guest/Worker <objective>     # give a remote session a standing objective
aibroker manage guest/Worker status          # what is it doing
aibroker peer standup <repo>                 # what moved, what is moving, what is blocked
```

A remote objective is delegated, not proxied: it lives on that machine's hub, so
the work continues when this machine is closed. That is the point of giving a
developer their own computer.

## What travels, and what does not

**Session knowledge belongs in the repository.** The manager writes each
session's objective and recent history to `.aibroker/session-<name>.md` inside
the checkout. On one machine that is tidiness; across machines it is the whole
synchronisation mechanism, because git already moves work between developers and
anything committed travels with the branch and arrives everywhere for free.
Knowledge in a home directory reaches exactly one machine.

`~/.aibroker` stays per-machine: sockets, tokens, timers. Those describe a
machine, so they belong to it. An objective describes the work, so it belongs
where the work is.

## Security

The peer port accepts commands that type into terminals and drive screens, so:

- It is **off** unless configured. There is no default port and no default
  address.
- It **refuses to bind a wildcard address** outright rather than warning, because
  a warning nobody reads is not a control.
- **Every request carries a shared secret**, checked before the method is even
  looked up. Reaching the port proves nothing.
- The secret is generated, never chosen, and stored readable only by its owner.
- An invite line **is** the secret. Anyone holding it can type into that machine.

The intended network is a private overlay. Nothing here is hardened against a
hostile network, and the wildcard refusal is what keeps that from becoming a
matter of memory.

## How this broke

Read this before changing it.

**A cleanup that only cleans when there was something to restore is not a
cleanup.** A test wrote a peering config, backed up the previous one, and
restored it at the end — except there was no previous one, so it restored
nothing and left its own port behind. The next invite silently inherited a test
port. Restore to a known state, not to "whatever was there".

**A refusal is not an outage.** The CLI reported every failure as "the local
daemon did not answer", so a deliberate refusal to bind a wildcard address was
presented as the daemon being down. That sends the reader to check whether a
service is running when the service is working correctly and telling them
something important.

**Machine facts were written macOS-only and would have made a Linux peer report
nonsense** — no screen, no toolchains, on a machine with both. Screen detection
now asks the right question per platform, and toolchains are probed by name
rather than by hardcoded path, because a path is a guess about somebody's
package manager.

**Two hubs had never actually talked** until an end-to-end test stood up a real
listener on a real port. Every primitive passed before that and proved nothing
about the integration. The test provokes each refusal deliberately — wrong
secret, empty secret, short secret, unreachable host — because a door that has
only been opened by the person holding the key has not been shown to be locked.

## Not done yet

**Agent types.** A machine advertises what it can do; a session does not yet
advertise what it is *for* — builder, verifier, integrator, adviser. Dispatch
would then match work to both the machine and the role, and "ask the large agent
on the big machine" would be addressable rather than a convention someone has to
remember.

**Linux.** The session transport is already portable — tmux implements the whole
interface with no platform gate — so agents on Linux are close. What remains
macOS-only is screen control and the iTerm-specific discovery paths. The natural
split is Macs for anything that must be *looked at*, Linux for anything that only
has to be built and tested.
