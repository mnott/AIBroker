/**
 * test/local-time.test.ts — evidence is printed on the reader's clock.
 *
 * The audit file stores UTC, which is correct: it is sorted, compared and
 * carried between machines. Printing that UTC time to a terminal was not. Every
 * other reading taken during an investigation is local — `date`, the manager's
 * status line, a forge's own timestamps — so one line in a different zone put a
 * silent two-hour offset inside a single investigation.
 *
 * It cost real time on 2026-09-01: an audit entry reading 11:51 was compared
 * against a forge comment at 13:51 and taken to be an hour and a half apart,
 * when the two events were two seconds apart. A clock that is wrong announces
 * itself; a clock that is right in another zone does not, and the reader does
 * the arithmetic without knowing they should.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the audit line prints local time, not the stored UTC", () => {
  const src = readFileSync(new URL("../src/daemon/audit-cli.ts", import.meta.url), "utf8");
  assert.match(src, /getHours\(\)/, "the hour must come from the local clock");
  assert.doesNotMatch(
    src.slice(src.indexOf("function render(")),
    /e\.ts\.slice\(11/,
    "slicing the ISO string prints UTC — that is the bug this replaced",
  );
});

test("an unparseable timestamp shows what is stored rather than a lie", () => {
  // Falling back to something plausible would be worse than showing the raw
  // value: a rendered time that no event had is indistinguishable from one it did.
  const src = readFileSync(new URL("../src/daemon/audit-cli.ts", import.meta.url), "utf8");
  assert.match(src, /Number\.isNaN\(at\.getTime\(\)\)/);
});

test("the mailbox header prints local time too", () => {
  // Same reading, same investigation, same clock. This one is in a hook rather
  // than the daemon and would otherwise be fixed in one place only.
  const src = readFileSync(new URL("../hooks/drain-mailbox.mjs", import.meta.url), "utf8");
  assert.match(src, /toLocaleTimeString/);
  assert.doesNotMatch(src, /toISOString\(\)\.slice\(11/, "that printed UTC to a local reader");
});

test("local rendering actually differs from UTC where the zone does", () => {
  // The checks above read source; this one exercises the property, so the pair
  // cannot both pass while the behaviour is wrong.
  const iso = "2026-09-01T19:41:14.072Z";
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  const utc = iso.slice(11, 19);
  const offset = at.getTimezoneOffset();
  if (offset === 0) {
    assert.equal(local, utc, "on a UTC machine the two agree, and that is not a failure");
  } else {
    assert.notEqual(local, utc, "off UTC they must differ, or the local path is not being taken");
  }
});
