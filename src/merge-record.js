// Merge driver for record files: *.record.json and locker/**/*.json, plus YAML frontmatter in Markdown.
// Ghidra's rule for change sets, applied to top-level keys: a key only one side changed is taken from that side; a key both
// sides changed to different values is a conflict, and the file is written with both values kept and marked. No guessing.
// Called by git as: sl merge-record %O %A %B %P  (ancestor, ours, theirs, path). Writes the result to %A. Exit 0 clean, 1 conflict.
import { readFile, writeFile } from "node:fs/promises";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Merge three maps key by key. Returns { merged, conflicts }. A missing key is a deletion. */
export function mergeKeys(base, ours, theirs) {
  const merged = {}, conflicts = [];
  for (const k of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = base[k], o = ours[k], t = theirs[k];
    const oursChanged = !same(b, o), theirsChanged = !same(b, t);
    if (!oursChanged && !theirsChanged) { if (k in base) merged[k] = b; }
    else if (oursChanged && !theirsChanged) { if (k in ours) merged[k] = o; }
    else if (!oursChanged && theirsChanged) { if (k in theirs) merged[k] = t; }
    else if (same(o, t)) { if (k in ours) merged[k] = o; }
    else { conflicts.push(k); merged[k] = { "<<<<<<< ours": k in ours ? o : null, ">>>>>>> theirs": k in theirs ? t : null }; }
  }
  return { merged, conflicts };
}

export function mergeJson(baseText, oursText, theirsText) {
  const parse = (t, who) => { try { return JSON.parse(t || "{}"); } catch (e) { throw new Error(`${who} is not valid JSON: ${e.message}`); } };
  const base = parse(baseText, "ancestor"), ours = parse(oursText, "ours"), theirs = parse(theirsText, "theirs");
  if ([base, ours, theirs].some((v) => v === null || typeof v !== "object" || Array.isArray(v))) throw new Error("record files must be JSON objects at the top level");
  const { merged, conflicts } = mergeKeys(base, ours, theirs);
  return { text: JSON.stringify(merged, null, 1) + "\n", conflicts };
}

// ---------- YAML frontmatter, without a YAML parser: groups of lines per top-level key ----------

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return m ? { front: m[1], body: m[2] } : { front: null, body: text };
}

/** Group frontmatter lines by their top-level key. Continuation lines (indented, or "- " items) belong to the key above. */
export function frontmatterKeys(front) {
  const out = {}; let cur = null, i = 0;
  for (const line of front.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$/.exec(line);
    if (m) { cur = m[1]; out[cur] = line; i++; }
    else if (cur !== null) out[cur] += "\n" + line;
    else out[`#${i++}`] = line;
  }
  return out;
}

export function mergeFrontmatter(baseText, oursText, theirsText) {
  const b = splitFrontmatter(baseText.replace(/\r\n/g, "\n")), o = splitFrontmatter(oursText.replace(/\r\n/g, "\n")), t = splitFrontmatter(theirsText.replace(/\r\n/g, "\n"));
  const conflicts = [];
  // body: plain three-way at whole-body granularity; anything finer is out of scope for 0.1
  let body;
  if (o.body === b.body) body = t.body; else if (t.body === b.body || o.body === t.body) body = o.body;
  else { conflicts.push("(body)"); body = `<<<<<<< ours\n${o.body}=======\n${t.body}>>>>>>> theirs\n`; }
  const bk = frontmatterKeys(b.front ?? ""), ok = frontmatterKeys(o.front ?? ""), tk = frontmatterKeys(t.front ?? "");
  const { merged, conflicts: kc } = mergeKeys(bk, ok, tk);
  conflicts.push(...kc);
  // key order: ours first, then anything only theirs has, in their order; order is layout, never a conflict
  const order = [...Object.keys(ok), ...Object.keys(tk).filter((k) => !(k in ok)), ...Object.keys(bk)].filter((k, i, a) => a.indexOf(k) === i);
  const lines = order.filter((k) => k in merged)
    .map((k) => { const v = merged[k]; return typeof v === "string" ? v : `<<<<<<< ours\n${v["<<<<<<< ours"] ?? `# ${k}: deleted`}\n=======\n${v[">>>>>>> theirs"] ?? `# ${k}: deleted`}\n>>>>>>> theirs`; });
  const hasFront = o.front !== null || t.front !== null || b.front !== null;
  return { text: hasFront ? `---\n${lines.join("\n")}\n---\n${body}` : body, conflicts };
}

/** The git entry point. Returns the exit code. */
export async function mergeRecordFiles(ancestor, ours, theirs, path) {
  const [a, o, t] = await Promise.all([ancestor, ours, theirs].map((p) => readFile(p, "utf8").catch(() => "")));
  const result = path.endsWith(".json") ? mergeJson(a, o, t) : mergeFrontmatter(a, o, t);
  await writeFile(ours, result.text);
  if (result.conflicts.length) { process.stderr.write(`sim-locker: ${path}: conflict in ${result.conflicts.join(", ")}; both sides kept, marked in the file\n`); return 1; }
  return 0;
}
