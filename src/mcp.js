// The MCP server: the same ten verbs agents need, over stdio. The actor comes from SL_ACTOR in the server's environment, never
// from a tool argument. Each result is JSON text plus structuredContent; a refusal is an error result with the code and the reason.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as L from "./locker.js";

export function buildServer(cwd = process.cwd()) {
  const server = new McpServer({ name: "sim-locker", version: "0.2.11" });
  const wrap = (fn) => async (args) => {
    try {
      const repo = await L.openRepo(cwd);
      const result = await fn(repo, args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result };
    } catch (e) {
      const code = e instanceof L.LockerError ? e.code : "GIT";
      const err = { error: code, code, message: e.message, details: e.details ?? null, next: e.next ?? null };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(err, null, 1) }], structuredContent: err };
    }
  };
  const actor = (repo) => L.actorFromEnv(repo);
  const ro = { readOnlyHint: true }, rw = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };

  server.registerTool("status", { description: "Where this folder stands: problems first (UNMANAGED, STALE, NOT FETCHED, TWO CLONES, LEASE HELD BY, STALE REVIEW), then saved / backed up / accepted / live for the current slice, the lease, and the reviews. `next` holds the fix for each problem and the next step, the same words a person sees.", inputSchema: { fetch: z.boolean().optional().describe("fetch first if the last fetch is old (default true)") }, annotations: ro },
    wrap((repo, a) => L.status(repo, { fetch: a.fetch ?? true })));
  server.registerTool("save", { description: "saved: commit the work on the current slice branch, stamped with this actor. Refuses a STALE folder and refuses an agent on the truth branch.", inputSchema: { message: z.string().describe("what changed and why"), paths: z.array(z.string()).optional(), slice: z.string().optional().describe("slice branch to save on; created from the truth branch if new") }, annotations: rw },
    wrap(async (repo, a) => L.save(repo, await actor(repo), a)));
  server.registerTool("backup", { description: "backed up: push the current branch, then fetch and prove the remote has the same commit. Never forces.", inputSchema: {}, annotations: rw },
    wrap((repo) => L.backup(repo)));
  server.registerTool("review", { description: "Write a review record for an exact commit range: reviewer, verdict (pass, fix, block), findings, and the blob hash of every file in the range. accept needs one for base..head of the slice.", inputSchema: { from: z.string(), to: z.string(), verdict: z.enum(["pass", "fix", "block"]), findings: z.string() }, annotations: rw },
    wrap(async (repo, a) => L.review(repo, await actor(repo), a)));
  server.registerTool("accept", { description: "accepted: squash the reviewed slice onto the truth branch, under the lease. Two steps: the first call returns a confirm token, the second call with that token does it.", inputSchema: { slice: z.string(), reviewId: z.string(), message: z.string().optional(), confirm: z.string().optional() }, annotations: { ...rw, destructiveHint: true } },
    wrap(async (repo, a) => L.accept(repo, await actor(repo), a)));
  server.registerTool("lease", { description: "The one-writer lease on the truth branch: status, acquire, renew, release. 30 minutes by default; an expired lease can be taken by anyone.", inputSchema: { action: z.enum(["status", "acquire", "renew", "release"]) }, annotations: rw },
    wrap(async (repo, a) => L.lease(repo, await actor(repo), a.action)));
  server.registerTool("update", { description: "Bring the truth branch's changes into the current slice as a save stamped with this actor, so the slice can be accepted after the truth branch moved. Lines both sides changed are left in the files with git's marks (UPDATE_CONFLICT names them); settle them, then save.", inputSchema: { message: z.string().optional() }, annotations: rw },
    wrap(async (repo, a) => L.update(repo, await actor(repo), a)));
  server.registerTool("history", { description: "The truth branch's last saves, newest first: who made each (from the Locker-Actor trailer), and for an acceptance the slice, the review id, its reviewer and verdict. A save with no trailer was made outside the tool.", inputSchema: { count: z.number().int().min(1).max(500).optional() }, annotations: ro },
    wrap((repo, a) => L.history(repo, { count: a.count ?? 20 })));
  server.registerTool("find", { description: "Search the review and live records for words.", inputSchema: { query: z.string() }, annotations: ro },
    wrap((repo, a) => L.find(repo, a.query)));
  server.registerTool("drill", { description: "Restore drill: fetch, push the remote truth branch to a fresh bare repository under the temp folder, clone it back with plain git and no Sim Locker, check the commit and locker.json came along, and run drill.test from the truth branch's locker.json in that clone. Changes nothing in the working tree or on the remote. DRILL_FAILED keeps the folders for a look.", inputSchema: { keep: z.boolean().optional().describe("keep the two folders") }, annotations: rw },
    wrap((repo, a) => L.drill(repo, { keep: a.keep })));
  return server;
}

export async function serve(cwd) {
  const server = buildServer(cwd);
  await server.connect(new StdioServerTransport());
}
