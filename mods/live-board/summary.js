// One-sentence progress notes by Claude Haiku: where an agent got to and what it needs from you. Asked for
// a session only when it has stopped working and has written something new since its last note, one call
// at a time, and kept in localStorage by session id (7 days). A short last reply is its own note: no call.
// Also the day's recap: every Claude session touched today, summed up by Haiku into a Markdown file.
import { exec, home } from "herdr";

const KEY = "summaries";
const KEEP = 7 * 86400000;
const NOTE_MAX = 80;
// A last reply this short is shown as it is.
const SHORT = 150;
// HERDR_TITLE_CHILD keeps the title hook out of this call; stdin closed so claude doesn't wait 3s for it.
const CALL = `HERDR_TITLE_CHILD=1 exec "$0" -p --model haiku --no-session-persistence --strict-mcp-config --max-turns 1 "$1" < /dev/null`;

async function haiku(prompt, timeout) {
  const claude = `${await home()}/.local/bin/claude`;
  const r = await exec("sh", ["-c", CALL, claude, prompt], { timeout });
  const out = (r.stdout ?? "").trim();
  if (r.code !== 0 || !out || /^(error|api error)/i.test(out)) throw new Error((r.stderr || out || `exit ${r.code}`).slice(0, 200));
  return out;
}

function ask(prompt, texts) {
  const replies = texts.map((x, i) => `【回复${i + 1}】\n${x.text}`).join("\n\n");
  return `下面是一个 AI 编程助手会话的末尾。用户最后说的话和助手最后几条回复如下。\n\n【用户最后说】\n${prompt ?? "（未知）"}\n\n${replies}\n\n`
    + `请用一句中文（不超过 60 个字）概括：助手做到哪了、现在需要用户做什么（如果需要的话）。只输出这一句，不要引号、不要前缀。`;
}

const flat = (t) => t.replace(/```[\s\S]*?```/g, " ").split("\n").map((l) => l.replace(/^[#>*\-\s`|]+/, "").replace(/\*\*/g, "").trim()).filter(Boolean).join(" ");

export class Summaries {
  constructor() {
    try { this.map = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch (_e) { this.map = {}; }
    this.queue = [];
    this.running = false;
    this.failed = new Set(); // text ids whose call failed: not retried until the session writes again
    const now = Date.now();
    for (const [k, v] of Object.entries(this.map)) if (!v?.at || now - v.at > KEEP) delete this.map[k];
  }

  // The note for a session, if one was made for its latest reply (or an older one while a new one is coming).
  of(sess) {
    const n = sess && this.map[sess.sid];
    return n ? { text: n.text, fresh: n.id === sess.texts.at(-1)?.id } : null;
  }

  // Queues a note for a stopped session whose last reply has none yet and is too long to read at a glance.
  want(sess, status) {
    if (!sess || status === "working") return;
    const last = sess.texts.at(-1);
    if (!last || flat(last.text).length <= SHORT) return;
    if (this.map[sess.sid]?.id === last.id || this.failed.has(last.id)) return;
    if (this.queue.some((q) => q.sid === sess.sid && q.id === last.id)) return;
    this.queue = this.queue.filter((q) => q.sid !== sess.sid);
    this.queue.push({ sid: sess.sid, id: last.id, prompt: sess.prompt, texts: sess.texts.slice() });
  }

  // Runs the queue one call at a time.
  pump(cx) {
    if (this.running || !this.queue.length) return;
    this.running = true;
    const job = this.queue.shift();
    cx.spawn(async (cx) => {
      try {
        const text = (await haiku(ask(job.prompt, job.texts), 90000)).split("\n").filter(Boolean).pop().replace(/^["“「]|["”」]$/g, "").trim();
        this.map[job.sid] = { id: job.id, text: text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX)}…` : text, at: Date.now() };
        localStorage.setItem(KEY, JSON.stringify(this.map));
      } catch (_e) {
        this.failed.add(job.id);
      } finally {
        this.running = false;
      }
      cx.notify();
      this.pump(cx);
    });
  }
}

// What the card shows without a note: the last reply, flattened, whole when short, else its head.
export function headOf(sess, max = 150) {
  const t = sess?.texts?.at(-1)?.text;
  if (!t) return null;
  const s = flat(t);
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---- the day's recap ----

// Every main-session transcript written to today (local time): its folder, titles, first and last prompt,
// and the head of its last reply. Sub-agent transcripts sit a folder deeper and are left out.
const GATHER = `cd "$HOME/.claude/projects" || exit 0
find . -mindepth 2 -maxdepth 2 -name '*.jsonl' -newermt "$(date +%Y-%m-%d) 00:00" | while read -r f; do
  echo "@@file $f"
  grep -E '^\\{"type":"(custom-title|ai-title)"' "$f" | tail -n 1
  grep -m1 -E '^\\{"type":"last-prompt"' "$f" | sed 's/^{"type":"last-prompt"/{"type":"first-prompt"/'
  tail -c 3000000 "$f" | grep -E '^\\{"type":"last-prompt"' | tail -n 1
  tail -c 3000000 "$f" | grep -E '"type":"assistant"' | grep -v '"isSidechain":true' | grep '"type":"text"' | tail -n 2
done`;

const RECAP_PER = 900;

async function gather() {
  const out = (await exec("sh", ["-c", GATHER], { timeout: 60000 })).stdout;
  const list = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@file ")) {
      const path = line.slice(7);
      cur = { project: path.split("/")[1].replace(/^-Users-[^-]+-?/, "").replace(/-/g, "/") || "~", title: null, first: null, last: null, replies: [] };
      list.push(cur);
      continue;
    }
    if (!cur || !line.startsWith("{")) continue;
    let j;
    try { j = JSON.parse(line); } catch (_e) { continue; }
    if (j.type === "custom-title") cur.title = j.customTitle;
    else if (j.type === "ai-title") cur.title ??= j.aiTitle;
    else if (j.type === "first-prompt") cur.first = j.lastPrompt;
    else if (j.type === "last-prompt") cur.last = j.lastPrompt;
    else if (j.type === "assistant") {
      const t = (j.message?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
      if (t.trim()) cur.replies.push(flat(t).slice(0, 400));
    }
  }
  // Sessions nobody talked to (a hook's or a title call's) say nothing.
  return list.filter((s) => s.first || s.last);
}

// Writes today's recap and returns { path, text }.
export async function recap() {
  const list = await gather();
  if (!list.length) throw new Error("今天还没有 Claude 会话");
  const body = list.map((s, i) => {
    const one = [`## 会话 ${i + 1} · 项目 ${s.project}`, s.title && `标题：${s.title}`, s.first && `开始时用户说：${s.first}`,
      s.last && s.last !== s.first && `最后用户说：${s.last}`, s.replies.length && `助手最后回复：${s.replies.join(" / ")}`].filter(Boolean).join("\n");
    return one.slice(0, RECAP_PER);
  }).join("\n\n");
  const prompt = `下面是我今天在多个 AI 编程会话里做的事情（每个会话的标题、开头和结尾）。请用中文写一份今日回顾，Markdown 格式：\n`
    + `1. 先一段话总结今天的主要进展；\n2. 然后按项目分组，每个会话一行：做了什么、结果如何；\n3. 最后列出「还没收尾 / 明天要跟进」的事项。\n`
    + `要具体，不要客套话，只输出 Markdown 正文。\n\n${body}`;
  const text = await haiku(prompt, 180000);
  const day = new Date();
  const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const path = `${await home()}/Documents/herdr-recap/${name}.md`;
  await exec("sh", ["-c", 'mkdir -p "$(dirname "$0")" && printf "%s\\n" "$1" > "$0"', path, `# ${name} 回顾\n\n${text}\n`]);
  return { path, text: `# ${name} 回顾\n\n${text}` };
}
