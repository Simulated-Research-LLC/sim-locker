// Thin, honest wrapper around the git executable. Every call returns what git said; nothing here retries, guesses or force-pushes.
import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.args = args; this.code = code; this.stderr = stderr;
  }
}

/** Run git in cwd, feeding `input` on stdin if given. Returns trimmed stdout. Throws GitError on a non-zero exit. */
export function git(cwd, args, { input, allowFail = false } = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => (allowFail ? resolveP(null) : reject(new GitError(args, "spawn", String(e)))));
    child.on("close", (code) => {
      if (code === 0) resolveP(out.trimEnd());
      else if (allowFail) resolveP(null);
      else reject(new GitError(args, code, err));
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export const revParse = (cwd, ref) => git(cwd, ["rev-parse", "--verify", "--quiet", ref], { allowFail: true });
export const currentBranch = (cwd) => git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
export const isClean = async (cwd) => (await git(cwd, ["status", "--porcelain"])) === "";
export const changedFiles = async (cwd) => (await git(cwd, ["status", "--porcelain"])).split("\n").filter(Boolean).map((l) => l.slice(3));
export const blobAt = (cwd, ref, path) => git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}:${path}`], { allowFail: true });
export const topLevel = (cwd) => git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });

/** Commits between two refs, oldest first. */
export async function range(cwd, from, to) {
  const out = await git(cwd, ["rev-list", "--reverse", `${from}..${to}`]);
  return out ? out.split("\n") : [];
}

/** How far the local branch is ahead of and behind its remote counterpart. */
export async function aheadBehind(cwd, local, remote) {
  const out = await git(cwd, ["rev-list", "--left-right", "--count", `${local}...${remote}`], { allowFail: true });
  if (out === null) return { ahead: null, behind: null };
  const [ahead, behind] = out.split(/\s+/).map(Number);
  return { ahead, behind };
}

/** The age in seconds of the last fetch, or null if there has never been one. */
export async function lastFetchAge(cwd) {
  const { stat } = await import("node:fs/promises");
  const top = await topLevel(cwd); if (!top) return null;
  const gitDir = await git(cwd, ["rev-parse", "--git-dir"]);
  const { join, isAbsolute } = await import("node:path");
  try { const s = await stat(join(isAbsolute(gitDir) ? gitDir : join(top, gitDir), "FETCH_HEAD")); return (Date.now() - s.mtimeMs) / 1000; } catch { return null; }
}
