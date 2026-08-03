# What 0.22.0 actually contained

`6b45eda` is titled for the Todoist label-precedence fix and also carries an
unrelated persistence fix that was in the working tree at the time, written in
another session. Both changes are correct and tested; the commit message named
only one of them, and the npm release notes for 0.22.0 mention only one.

Recorded here rather than rewritten, because 0.22.0 is published and the
history is what it is. The point of an audit trail is that you do not edit it
to look tidy.

## The unnamed half

`src/core/persistence.ts` (+52) and `test/persistence.test.ts` (+160).

`persistence.ts` carried its own `safeReadJson` / `safeWriteJson` pair and
bypassed `core/json-store.ts`. Two consequences:

- A corrupt file read as `null`, exactly like an absent one. An unparseable
  `sessions.json` therefore produced an empty registry, which the next rename
  made permanent.
- The write was a plain, non-atomic `writeFileSync`, so an unparseable
  `voice-config.json` was replaced by `DEFAULT_VOICE_CONFIG` on the next toggle.

Both now go through `loadJson` / `saveJson`, with a per-file sticky
`blockedFiles` set — cleared by a good read or by `setAppDir` — and atomic
writes with a `.bak`.

Not academic: `~/.whazaa/sessions.json` and `~/.telex/sessions.json` are live,
and both consumers symlink `node_modules/aibroker` to this working copy.

## Why it happened

`git add -A` in a working copy that more than one session edits. The `cpp`
rule says to stage everything so the version bump and its code land in one
commit; applied literally in a shared tree it also stages whatever anyone else
has open. The rule is about not splitting a change, not about sweeping the
directory.
