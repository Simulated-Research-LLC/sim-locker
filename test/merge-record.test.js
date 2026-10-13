import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { mergeKeys, mergeJson, mergeFrontmatter } from "../src/merge-record.js";

test("keys only one side changed are taken; both changed the same way is fine; both changed differently is a conflict with both kept", () => {
  const base = { a: 1, b: 2, c: 3, d: 4 }, ours = { a: 10, b: 2, c: 30, d: 4, e: 5 }, theirs = { a: 1, c: 31, d: 4, f: 6 };
  const { merged, conflicts } = mergeKeys(base, ours, theirs);
  assert.deepEqual(conflicts, ["c"]);
  assert.equal(merged.a, 10); assert.equal("b" in merged, false); assert.equal(merged.e, 5); assert.equal(merged.f, 6);
  assert.deepEqual(merged.c, { "<<<<<<< ours": 30, ">>>>>>> theirs": 31 });
  assert.deepEqual(mergeKeys({ x: 1 }, { x: 2 }, { x: 2 }).conflicts, []);
});

test("json records merge and refuse non-objects", () => {
  const r = mergeJson('{"a":1}', '{"a":1,"b":2}', '{"a":3}');
  assert.deepEqual(JSON.parse(r.text), { a: 3, b: 2 }); assert.deepEqual(r.conflicts, []);
  assert.throws(() => mergeJson("[]", "{}", "{}"));
  assert.throws(() => mergeJson("{", "{}", "{}"));
});

test("yaml frontmatter merges per key and the body as a whole", () => {
  const base = "---\ntitle: A\ntags:\n  - x\nstatus: open\n---\nbody\n";
  const ours = "---\ntitle: A\ntags:\n  - x\n  - y\nstatus: open\n---\nbody\n";
  const theirs = "---\ntitle: B\ntags:\n  - x\nstatus: done\n---\nbody changed\n";
  const r = mergeFrontmatter(base, ours, theirs);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.text, "---\ntitle: B\ntags:\n  - x\n  - y\nstatus: done\n---\nbody changed\n");
  const c = mergeFrontmatter(base, ours.replace("title: A", "title: C"), theirs);
  assert.deepEqual(c.conflicts, ["title"]); assert.match(c.text, /<<<<<<< ours\ntitle: C\n=======\ntitle: B\n>>>>>>> theirs/);
  const bodyConflict = mergeFrontmatter(base, base.replace("body", "ours body"), theirs);
  assert.ok(bodyConflict.conflicts.includes("(body)"));
  // a key inserted at the top on one side is not a conflict with a value change on the other
  const reordered = mergeFrontmatter(base, "---\nnew: 1\n" + base.slice(4), theirs);
  assert.deepEqual(reordered.conflicts, []); assert.match(reordered.text, /^---\nnew: 1\ntitle: B\n/);
  // CRLF input is normalised instead of hiding keys
  const crlf = mergeFrontmatter(base.replace(/\n/g, "\r\n"), ours.replace(/\n/g, "\r\n"), theirs.replace(/\n/g, "\r\n"));
  assert.deepEqual(crlf.conflicts, []); assert.match(crlf.text, /status: done/);
});

test("git uses the driver through .gitattributes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "slmerge-"));
  const sh = (...a) => execFileSync("git", a, { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  sh("init", "--quiet", "-b", "main");
  sh("config", "merge.locker-record.driver", `${process.execPath} ${resolve("bin/sl.js")} merge-record %O %A %B %P`);
  await writeFile(join(tmp, ".gitattributes"), "*.record.json merge=locker-record\n");
  await writeFile(join(tmp, "x.record.json"), JSON.stringify({ a: 1, b: 2 }));
  sh("add", "-A"); sh("commit", "--quiet", "-m", "base");
  sh("checkout", "--quiet", "-b", "other");
  await writeFile(join(tmp, "x.record.json"), JSON.stringify({ a: 1, b: 3 })); sh("commit", "--quiet", "-am", "theirs");
  sh("checkout", "--quiet", "main");
  await writeFile(join(tmp, "x.record.json"), JSON.stringify({ a: 9, b: 2 })); sh("commit", "--quiet", "-am", "ours");
  sh("merge", "--quiet", "--no-edit", "other");
  assert.deepEqual(JSON.parse(await readFile(join(tmp, "x.record.json"), "utf8")), { a: 9, b: 3 });
  await rm(tmp, { recursive: true, force: true });
});
