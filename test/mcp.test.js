// The MCP server over an in-memory transport: the same tools as the CLI, the same JSON, the actor from the environment only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let tmp, A, client, server;
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const call = (name, args = {}) => client.callTool({ name, arguments: args });

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "simlocker-mcp-"));
  process.env.HOME = join(tmp, "home"); await mkdir(process.env.HOME);
  const L = await import("../src/locker.js"), M = await import("../src/mcp.js");
  const remote = join(tmp, "remote.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", remote);
  A = join(tmp, "A"); sh(tmp, "clone", "--quiet", remote, A); sh(A, "checkout", "--quiet", "-b", "main");
  await writeFile(join(A, "README.md"), "# demo\n"); sh(A, "add", "-A"); sh(A, "commit", "--quiet", "-m", "first"); sh(A, "push", "--quiet", "-u", "origin", "main");
  await L.init(A, { project: "demo" });
  const repo = await L.openRepo(A); const rick = await L.actorFromEnv(repo, { SL_ACTOR: "rick", SL_SESSION: "r" });
  await L.save(repo, rick, { message: "manage" }); await L.backup(repo);
  process.env.SL_ACTOR = "claude"; process.env.SL_SESSION = "mcp-1";
  server = M.buildServer(A); client = new Client({ name: "test", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s); await client.connect(c);
});
after(async () => { delete process.env.SL_ACTOR; delete process.env.SL_SESSION; await client?.close(); await rm(tmp, { recursive: true, force: true }); });

test("the server offers the nine tools and status carries the same next steps as the CLI", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["accept", "backup", "drill", "find", "lease", "review", "save", "status", "update"]);
  const st = await call("status", { fetch: false });
  assert.equal(st.isError, undefined); assert.equal(st.structuredContent.project, "demo");
  assert.ok(Array.isArray(st.structuredContent.next)); assert.equal(st.structuredContent.next.length, st.structuredContent.problems.length + 1);
  assert.match(st.structuredContent.next.find((n) => n.code === "NOT FETCHED").fix, /status with fetch true/);
  assert.equal(JSON.parse(st.content[0].text).project, "demo", "the text and the structured content are the same JSON");
});

test("a refusal is an error result with code, message, details and next; the actor is the environment's, never an argument", async () => {
  await writeFile(join(A, "x.js"), "1\n");
  const r = await call("save", { message: "on main as an agent", actor: "rick" });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "AGENT_ON_TRUTH"); assert.match(r.structuredContent.next, /--slice <name>/);
  assert.equal(r.structuredContent.error, r.structuredContent.code); assert.ok("details" in r.structuredContent);
  const ok = await call("save", { message: "x", slice: "slice/x" });
  assert.equal(ok.structuredContent.saved, true); assert.equal(ok.structuredContent.actor, "claude");
  assert.match(sh(A, "log", "-1", "--format=%B"), /Locker-Actor: claude \(agent\)\nLocker-Session: mcp-1/);
  const up = await call("update", {}); assert.equal(up.structuredContent.updated, false);
  const bk = await call("backup", {}); assert.equal(bk.structuredContent.backedUp, true);
  const ls = await call("lease", { action: "acquire" }); assert.equal(ls.structuredContent.lease.owner, "claude");
  const rv = await call("review", { from: "main", to: "slice/x", verdict: "pass", findings: "fine" });
  assert.match(rv.structuredContent.id, /^rev_[0-9a-f]{12}$/);
  await call("save", { message: "record" }); await call("backup", {});
  const self = await call("accept", { slice: "slice/x", reviewId: rv.structuredContent.id });
  assert.equal(self.isError, true); assert.equal(self.structuredContent.code, "REVIEW_SELF", "a slice is not accepted by its own reviewer, over MCP as on the CLI");
  await call("lease", { action: "release" });
});
