// What the cards show beside the transcript, read every 10s refresh (this computer only):
// - today's cost per Claude session, from the ccline status line's ledger (~/.claude/ccline/state/ledger.json:
//   { date, sessions: { <sessionId>: { total } } }), the same numbers the status line shows;
// - each model's context limit: Claude Code's modelSettings[<model>].autoCompactWindow in
//   ~/.claude/settings.json, so the percentage is the distance to auto-compaction (as the status line has it);
// - per working folder: branch and uncommitted lines (+added −removed), refreshed at most every 30s.
import { exec, home, readTextFile } from "herdr";

const GIT_EVERY = 30000;
const DEFAULT_LIMIT = 200000;
const GIT = `cd "$1" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
echo "@@branch $(git branch --show-current 2>/dev/null)"
git diff HEAD --numstat 2>/dev/null | awk '{a+=$1; d+=$2; n++} END {print "@@diff", a+0, d+0, n+0}'
echo "@@untracked $(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')"`;

export class Extras {
  constructor() {
    this.cost = {};      // sessionId → today's $ (ledger)
    this.costDate = null;
    this.limits = {};    // model (no provider prefix) → tokens
    this.git = new Map(); // folder → { branch, add, del, files, untracked, at }
    this.gitBusy = false;
  }

  async refresh(cwds) {
    const h = await home();
    try {
      const l = JSON.parse((await readTextFile(`${h}/.claude/ccline/state/ledger.json`)) ?? "{}");
      this.costDate = l.date ?? null;
      this.cost = Object.fromEntries(Object.entries(l.sessions ?? {}).map(([k, v]) => [k, Number(v?.total) || 0]));
    } catch (_e) { /* no ccline: no costs */ }
    try {
      const s = JSON.parse((await readTextFile(`${h}/.claude/settings.json`)) ?? "{}");
      this.limits = Object.fromEntries(Object.entries(s.modelSettings ?? {}).filter(([, v]) => v?.autoCompactWindow).map(([k, v]) => [k, v.autoCompactWindow]));
    } catch (_e) { /* keep the last */ }
    if (this.gitBusy) return;
    this.gitBusy = true;
    try {
      const now = Date.now();
      for (const dir of new Set(cwds.filter(Boolean))) {
        if (now - (this.git.get(dir)?.at ?? 0) < GIT_EVERY) continue;
        const out = (await exec("sh", ["-c", GIT, "sh", dir], { timeout: 10000 }).catch(() => ({ stdout: "" }))).stdout;
        const g = { branch: null, add: 0, del: 0, files: 0, untracked: 0, repo: false, at: now };
        for (const line of out.split("\n")) {
          const [tag, ...v] = line.split(" ");
          if (tag === "@@branch") { g.repo = true; g.branch = v.join(" ") || null; }
          else if (tag === "@@diff") [g.add, g.del, g.files] = v.map(Number);
          else if (tag === "@@untracked") g.untracked = Number(v[0]) || 0;
        }
        this.git.set(dir, g);
      }
    } finally {
      this.gitBusy = false;
    }
  }

  // Context used as a share of where Claude Code compacts: { pct, tokens, limit }, or null.
  context(sess) {
    if (!sess?.ctx) return null;
    const model = (sess.model ?? "").replace(/^.*\//, "");
    const limit = this.limits[model] ?? Object.entries(this.limits).find(([k]) => model.includes(k))?.[1] ?? DEFAULT_LIMIT;
    return { pct: Math.round((sess.ctx / limit) * 100), tokens: sess.ctx, limit };
  }

  costOf(sess) { return sess ? this.cost[sess.sid] ?? null : null; }

  today() { return Object.values(this.cost).reduce((a, b) => a + b, 0); }
}

export const money = (n) => (n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
export const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
