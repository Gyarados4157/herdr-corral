// What a Claude Code conversation is about and where it stands: foreground pid → ~/.claude/sessions/<pid>.json
// → sessionId → the transcript. Read once from its tail, then only the bytes added since (a long session's
// transcript passes 100 MB). Kept per session:
// - titles and prompts: "custom-title" (/rename), "ai-title" (Claude Code 2.1.316+ stopped writing it),
//   "last-prompt" (your last message, cut at about 200 chars), the first prompt;
// - the main thread's last replies (texts), when it last wrote, its cache TTL ("api-request"), its model and
//   context size (the last reply's usage), and what it is doing now: running a tool (and which), waiting on
//   the model, or done writing;
// - the file's mtime. This computer only.
import { exec, home, readTextFile, watchFolder } from "herdr";

// Looked for once in the whole file, since they can sit before the tail: the newest titles, then the
// first prompt (marked so take() keeps it apart from the last one).
const READ_START = `grep -E '^\\{"type":"(ai-title|custom-title)"' "$1" | tail -n 4; grep -m1 -E '^\\{"type":"last-prompt"' "$1" | sed 's/^{"type":"last-prompt"/{"type":"first-prompt"/'`;
// The records added since byte $2 (at most the last 4 MB), up to the last complete line: a line still being
// written is left for the next read. Prints "@@stat <end> <mtime>" first; <end> is where the next read starts.
const READ_NEW = `f="$1"; from="$2"
s=$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f"); m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")
if [ "$(tail -c 1 "$f" | od -An -tx1 | tr -d ' ')" = "0a" ]; then end=$s; else end=$((s - $(tail -c 1000000 "$f" | LC_ALL=C awk '{n=length($0)} END{print n+0}'))); fi
if [ "$from" -gt "$end" ] || [ $((end - from)) -gt 4000000 ]; then from=$((end - 4000000)); [ "$from" -lt 0 ] && from=0; fi
echo "@@stat $end $m $from"
[ "$end" -gt "$from" ] && tail -c +$((from + 1)) "$f" | head -c $((end - from)) | grep -E '^\\{"type":"(last-prompt|ai-title|custom-title)"|"type":"(assistant|api-request|user)"' | grep -v '"isSidechain":true'
exit 0`;

const TTL = { "1h": 3600000, "5m": 300000 };
const TEXTS = 3; // replies kept for the summary
const TEXT_MAX = 2500;

// A tool call in a few words: "Bash: npm test", "Edit: main.js".
function toolLabel(c) {
  const i = c.input ?? {};
  const what = i.description ?? i.command ?? (i.file_path ? i.file_path.split("/").pop() : null) ?? i.pattern ?? i.url ?? i.prompt ?? "";
  const s = String(what).replace(/\s+/g, " ").trim();
  return s ? `${c.name}: ${s.length > 60 ? `${s.slice(0, 60)}…` : s}` : c.name;
}

export class Sessions {
  constructor() {
    // pid → session entry (see fresh())
    this.byPid = new Map();
    this.watched = new Set();
    this.reading = new Set();
  }

  static fresh(sid) {
    return { sid, path: null, offset: 0, prompt: null, firstPrompt: null, aiTitle: null, customTitle: null,
      texts: [], lastAt: 0, ttl: null, movedAt: 0, model: null, ctx: 0,
      // now: "tool" (a tool call without its result yet), "model" (a prompt or result sent, no reply yet),
      // "reply" (it last wrote text); since: when that began; tools: the open calls, id → label.
      now: null, since: 0, tools: new Map() };
  }

  // The session behind a terminal (from terminals()), or null.
  of(term) {
    const pid = term?.foreground?.pid;
    return pid ? this.byPid.get(pid) ?? null : null;
  }

  // Looks up every local Claude terminal; reads a transcript when its session is new to us.
  async refresh(terms, cx, onChange) {
    const claude = terms.filter((t) => t.state === "live" && !t.address.includes("/") && t.foreground?.pid && t.report?.app === "claude-code");
    const live = new Set(claude.map((t) => t.foreground.pid));
    for (const pid of [...this.byPid.keys()]) if (!live.has(pid)) this.byPid.delete(pid);
    const h = await home();
    for (const t of claude) {
      try { await this.one(h, t.foreground.pid, cx, onChange); } catch (_e) { /* a session that just ended: next time */ }
    }
    onChange();
  }

  async one(h, pid, cx, onChange) {
    const raw = await readTextFile(`${h}/.claude/sessions/${pid}.json`);
    if (!raw) return;
    const s = JSON.parse(raw);
    let e = this.byPid.get(pid);
    // /clear and --resume give the same process another session.
    if (!e || e.sid !== s.sessionId) {
      e = Sessions.fresh(s.sessionId);
      this.byPid.set(pid, e);
    }
    if (!e.path) {
      const r = await exec("find", [`${h}/.claude/projects`, "-maxdepth", "2", "-name", `${s.sessionId}.jsonl`]);
      e.path = r.stdout.trim().split("\n")[0] || null;
      if (!e.path) return;
      this.take(e, (await exec("sh", ["-c", READ_START, "sh", e.path])).stdout);
    }
    // Cheap when nothing changed: only the new bytes are read.
    await this.read(e);
    this.watch(e.path.slice(0, e.path.lastIndexOf("/")), cx, onChange);
  }

  async read(e) {
    if (this.reading.has(e)) return;
    this.reading.add(e);
    try {
      const out = (await exec("sh", ["-c", READ_NEW, "sh", e.path, String(e.offset)])).stdout;
      this.take(e, out);
      this.replies(e, out);
    } finally {
      this.reading.delete(e);
    }
  }

  // Keeps the newest value of each title/prompt record in some transcript lines.
  take(e, out) {
    const clean = (x) => (typeof x === "string" && x.trim() ? x.replace(/\s+/g, " ").trim() : null);
    for (const line of out.split("\n")) {
      if (!line.startsWith('{"type":"')) continue;
      let r;
      try { r = JSON.parse(line); } catch (_e) { continue; }
      if (r.type === "first-prompt") e.firstPrompt = clean(r.lastPrompt) ?? e.firstPrompt;
      else if (r.type === "last-prompt") { e.prompt = clean(r.lastPrompt) ?? e.prompt; e.firstPrompt ??= e.prompt; }
      else if (r.type === "ai-title") e.aiTitle = clean(r.aiTitle) ?? e.aiTitle;
      else if (r.type === "custom-title") e.customTitle = clean(r.customTitle) ?? e.customTitle;
    }
  }

  // The main thread's replies, requests and results, in order.
  replies(e, out) {
    let texts = e.texts.slice();
    for (const line of out.split("\n")) {
      if (line.startsWith("@@stat ")) {
        const [end, m] = line.slice(7).split(" ").map(Number);
        if (end >= 0) e.offset = end;
        if (m) e.movedAt = m * 1000;
        continue;
      }
      if (!line.startsWith("{")) continue;
      let j;
      try { j = JSON.parse(line); } catch (_e) { continue; }
      if (j.isSidechain) continue;
      const at = Date.parse(j.timestamp) || 0;
      if (j.type === "api-request") {
        if (/^repl_main_thread(:|$)/.test(j.querySource ?? "")) e.ttl = (j.cacheControl ?? []).some((c) => c?.value?.ttl === "1h") ? "1h" : "5m";
        continue;
      }
      const content = Array.isArray(j.message?.content) ? j.message.content : [];
      if (j.type === "user") {
        // A prompt, or tool results: either way the model has the turn now. Results close their calls.
        for (const c of content) if (c?.type === "tool_result") e.tools.delete(c.tool_use_id);
        if (!e.tools.size) { e.now = "model"; e.since = at || e.since; }
        continue;
      }
      if (j.type !== "assistant") continue;
      if (at > e.lastAt) e.lastAt = at;
      e.model = j.message?.model ?? e.model;
      const u = j.message?.usage;
      if (u) e.ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      const text = content.filter((c) => c?.type === "text" && c.text?.trim()).map((c) => c.text.trim()).join("\n");
      if (text) texts.push({ id: j.uuid ?? j.message?.id ?? String(at), text: text.slice(0, TEXT_MAX), at });
      const calls = content.filter((c) => c?.type === "tool_use");
      for (const c of calls) e.tools.set(c.id, toolLabel(c));
      if (calls.length) { e.now = "tool"; e.since = at; }
      else if (text) { e.now = "reply"; e.since = at; }
    }
    e.texts = texts.slice(-TEXTS);
  }

  // Re-reads a transcript whenever it changes. Changes come in bursts while an agent works: the wait after
  // each wake gathers a burst into one read.
  watch(dir, cx, onChange) {
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const changed = await watchFolder(dir);
          await cx.sleep(800);
          for (const e of this.byPid.values()) if (e.path && (changed.includes(e.path) || changed.includes(dir))) await this.read(e);
          onChange();
          cx.notify();
        }
      } catch (_e) {
        // Too many watched folders, or a reclaimed watch: the 10s refresh picks it up again.
        this.watched.delete(dir);
      }
    });
  }
}

// The prompt cache's time left: { text, share 0..1, cold }, or null when unknown. A 1h TTL is assumed until
// an api-request record says otherwise, since that is what this setup asks for.
export function warmth(e, now) {
  if (!e?.lastAt) return null;
  const ttl = TTL[e.ttl ?? "1h"];
  const left = e.lastAt + ttl - now;
  if (left <= 0) return { text: "缓存已过期", share: 0, cold: true };
  const m = Math.floor(left / 60000);
  return { text: `缓存剩 ${m < 1 ? "<1" : m}m`, share: Math.min(1, left / ttl), cold: false };
}

// Where a working session is, for the card: { kind: "tool" | "model" | "quiet", label, for: ms }.
// "tool": a call is running (a long build is no hang); "model": waiting on the model; "quiet": text
// written, nothing since.
export function activity(e, now) {
  if (!e?.now || !e.since) return null;
  const label = e.now === "tool" ? [...e.tools.values()].at(-1) ?? "工具" : null;
  return { kind: e.now === "tool" ? "tool" : e.now === "model" ? "model" : "quiet", label, for: now - e.since };
}
