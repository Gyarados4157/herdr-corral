// What a Claude Code conversation is about and what it was last asked: foreground pid →
// ~/.claude/sessions/<pid>.json → sessionId → the transcript's newest records of these types:
// "custom-title" (a name you gave it with /rename), "ai-title" (Claude's own short title; Claude Code
// 2.1.316 and later stopped writing it) and "last-prompt" (your last message, cut at about 200 chars).
// The first last-prompt stands in for a title when there is none. This computer only.
import { exec, home, readTextFile, watchFolder } from "herdr";

// The newest records of these types in the transcript's tail. Anchored at the line's start: the same
// words inside a message or a tool's output (a grep of a transcript, say) are not records.
const READ = `tail -c 4000000 "$1" | grep -E '^\\{"type":"(last-prompt|ai-title|custom-title)"' | tail -n 20`;
// Looked for once in the whole file, since they can sit before the tail: the newest titles, then the
// first prompt (marked so take() keeps it apart from the last one).
const READ_START = `grep -E '^\\{"type":"(ai-title|custom-title)"' "$1" | tail -n 4; grep -m1 -E '^\\{"type":"last-prompt"' "$1" | sed 's/^{"type":"last-prompt"/{"type":"first-prompt"/'`;

export class Sessions {
  constructor() {
    this.byPid = new Map(); // pid → { sid, path, prompt, firstPrompt, aiTitle, customTitle }
    this.watched = new Set();
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
      e = { sid: s.sessionId, path: null, prompt: null, firstPrompt: null, aiTitle: null, customTitle: null };
      this.byPid.set(pid, e);
    }
    if (!e.path) {
      const r = await exec("find", [`${h}/.claude/projects`, "-maxdepth", "2", "-name", `${s.sessionId}.jsonl`]);
      e.path = r.stdout.trim().split("\n")[0] || null;
      if (!e.path) return;
      this.take(e, (await exec("sh", ["-c", READ_START, "sh", e.path])).stdout);
      await this.read(e);
    }
    const dir = e.path.slice(0, e.path.lastIndexOf("/"));
    // Without a live watch on its folder, this refresh is what keeps the prompt current.
    if (!this.watched.has(dir)) await this.read(e);
    this.watch(dir, cx, onChange);
  }

  async read(e) {
    this.take(e, (await exec("sh", ["-c", READ, "sh", e.path])).stdout);
  }

  // Keeps the newest value of each record type in some transcript lines.
  take(e, out) {
    const clean = (x) => (typeof x === "string" && x.trim() ? x.replace(/\s+/g, " ").trim() : null);
    for (const line of out.split("\n")) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch (_e) { continue; } // a line still being written
      if (r.type === "first-prompt") e.firstPrompt = clean(r.lastPrompt) ?? e.firstPrompt;
      else if (r.type === "last-prompt") { e.prompt = clean(r.lastPrompt) ?? e.prompt; e.firstPrompt ??= e.prompt; }
      else if (r.type === "ai-title") e.aiTitle = clean(r.aiTitle) ?? e.aiTitle;
      else if (r.type === "custom-title") e.customTitle = clean(r.customTitle) ?? e.customTitle;
    }
  }

  // Re-reads a transcript whenever it changes, so a new prompt shows within a moment.
  watch(dir, cx, onChange) {
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const changed = await watchFolder(dir);
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
