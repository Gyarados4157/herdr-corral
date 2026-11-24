// Live Board: every agent as a card, grouped by project (the space-folders folders), most urgent first:
// 需要你 (blocked), 刚做完 (done), 工作中 (working), 空闲 (idle). A card leaves the board
// when its terminal closes. A strip at the top lists every agent waiting on a question; the Dock icon
// counts them. Keys: j/k move, enter goes, r replies, x x ends, / searches, esc goes back.
// Props: none → the board; { role: "pill" } → the live layout's toggle in the top bar.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle, TextView } from "gpui-base";
import { agents, terminals, spaces, panes, theme, run, hc, exec, layout, props, nextCommand, focused, shared, checking, closeOverlay, setBadge } from "herdr";
import { Sessions, warmth, activity } from "./sessions.js";
import { Summaries, headOf, recap } from "./summary.js";
import { Extras, money, kTokens } from "./extras.js";

// Bump on every change: shown in the header, to see which build is running.
const BUILD = "0.1.7-dev.5";
const ICONS = "mods/workspace-chrome";
const STACK = "live-view";
// Waiting on the model this long, or silent this long after writing, while working: maybe stuck.
const STUCK_MODEL = 5 * 60000;
const STUCK_QUIET = 10 * 60000;
// A tool call running this long gets an amber chip (still not "stuck": builds and tests take time).
const LONG_TOOL = 30 * 60000;
// Claude Code stays "working" while a background shell or agent runs and says so in its report: no hang.
const BACKGROUND = /still running|background|后台/i;
// More untracked files than this is build output nobody ignored, not work: left off the chip.
const UNTRACKED_MAX = 200;
// 清理 takes idle agents left this long.
const STALE = 24 * 3600000;
const OTHER = "__other";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

// Flips the live layout's work area between the terminals and the board.
function flip(to, refocus = true) {
  const stack = find(layout(), STACK);
  if (!stack) return;
  const child = to ?? (stack.active === "board" ? "main" : "board");
  run("layout.select", { stack: STACK, child });
  // Back to the terminals: the focused pane gets the keyboard again.
  if (child === "main" && refocus) { const f = focused(); if (f?.pane) run("pane.focus", { pane: f.pane }); }
}

const alpha = (c, a) => (c ?? "#000000").slice(0, 7) + a;
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, f) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * f).toString(16).padStart(2, "0")).join("");
// Full = green, half = amber, none = red, in the theme's own ANSI colors (as Corral Board's cache chip).
const warmthColor = (t, share) => (share >= 0.5 ? mix(t.ansi3, t.ansi2, (share - 0.5) * 2) : mix(t.ansi1, t.ansi3, share * 2));

// A space's tile as Herdr's spaces sidebar draws it: its first letter on its color.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const paint = (t, color) => (color?.startsWith("#") ? color : (MARK[color] ?? t[color] ?? t.muted));
function spaceTile(t, space, size = 14) {
  if (!space) return div();
  return h_flex().size(size).flex_none().rounded(size * 0.28).bg(paint(t, shared("space.colors")?.[space.id] ?? "ansi6")).items_center().justify_center()
    .text_size(size * 0.6).font_bold().text_color("#ffffff").child([...space.name][0]?.toUpperCase() ?? "?");
}

// "<1m", "6m", "2h", "3d".
function dur(ms) {
  const m = Math.floor(ms / 60000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
const ago = (ms, now) => dur(now - ms);

// The conversation's short summary: Claude Code (and others) put it in the terminal title, after a status
// glyph. Null while the title only names the program.
function summary(a) {
  const s = (a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (!s || s === a.program?.name || /^(claude|claude code|codex)$/i.test(s)) return null;
  return s;
}

const cut = (p, n) => (!p ? null : p.length > n ? `${p.slice(0, n)}…` : p);

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Project lanes, from the space-folders mod's folders and rules (the same as its sidebar: where a space was
// dragged, else the folder whose rules reach deepest into the folder the space works in).
function rule(pattern) {
  const p = pattern.trim().replace(/\/+$/, "");
  if (!p) return null;
  const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
    .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root)");
  return new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`);
}
const RULES = new Map();
const ruleOf = (p) => { if (!RULES.has(p)) RULES.set(p, rule(p)); return RULES.get(p); };
const reach = (f, path) => !path ? 0 : Math.max(0, ...(f.match ?? "").split(",").map((p) => {
  const m = ruleOf(p)?.exec(path);
  return m ? 1 + m.index + m[0].replace(/\/$/, "").length : 0;
}));
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
function folderOf(s, { list, of }, ps) {
  const id = of?.[s.id];
  if (id !== undefined) return list.some((f) => f.id === id) ? id : null;
  let best = null, most = 0;
  for (const f of list) { const n = reach(f, place(s, ps)); if (n > most) { best = f; most = n; } }
  return best?.id ?? null;
}

const STATUS = {
  blocked: { name: "需要你", color: (t) => t.blocked },
  done: { name: "刚做完", color: (t) => t.done },
  working: { name: "工作中", color: (t) => t.working },
  idle: { name: "空闲", color: (t) => t.dim },
};
// Most urgent first: on the cards' order in a lane, and in the counts.
const STATUS_ORDER = ["blocked", "done", "working", "idle"];
// Card grid: at least this wide, this far apart, inside this padding.
const CARD_MIN = 330;
const GAP = 12;
const PAD = 16;
const colOf = (s) => (s === "blocked" || s === "done" || s === "working" ? s : "idle");

export default class LiveBoard extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "board";
    if (this.role === "pill") {
      cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "toggle") flip(); cx.notify(); } });
      return;
    }
    this.sessions = new Sessions();
    this.notes = new Summaries();
    this.extras = new Extras();
    // Each agent's last state and when it changed (ms), kept across restarts. Herdr reports no time of
    // its own (status_ms stays null), so the board stamps changes as it sees them, as the agents list does.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}") ?? {}; } catch (_e) { this.changed = {}; }
    try { this.folded = JSON.parse(localStorage.getItem("folded") ?? "{}") ?? {}; } catch (_e) { this.folded = {}; }
    // Keys: the board's own focus; text boxes holding the keyboard turn its keys off.
    this.h = cx.focus_handle();
    this.inputs = new Set();
    this.sel = null;     // the selected card's terminal address
    this.armed = null;   // x pressed once on this card: a second x ends it
    this.order = [];     // the cards' addresses in drawing order, for j/k
    this.laneOf = {};    // address → lane index, to scroll the selection into view
    this.scroll = ScrollHandle.new();
    // The inline reply: one box, shown under the card it is for.
    this.replyTo = null;
    this.replyNote = null;
    this.reply = this.input("回复这个 Agent，回车发送");
    this.reply.on("submit", (_e, cx) => this.send(cx));
    this.filter = this.input("搜索：标题、项目、提示…");
    this.filter.on("change", (_e, cx) => cx.notify());
    this.filter.on("submit", (_e, cx) => { this.focusBoard(); cx.notify(); });
    this.cleanArmed = 0;
    this.recap = null;   // { busy } | { text, path } | { error }
    this.badge = undefined;
    this.shown = false;
    cx.timer.every(30000, (cx) => cx.notify());
    this.busy = false;
    this.lastRefresh = 0;
    // Focus moves only from a task (render can't): render wakes this one when the board comes into view.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((resolve) => { this.wakeFocus = resolve; });
        this.wakeFocus = null;
        if (!this.inputs.size) this.h.focus();
        cx.notify();
      }
    });
    if (checking()) return;
    cx.timer.every(10000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  input(placeholder) {
    const s = InputState.new({ placeholder });
    s.on("focus", (_e, cx) => { this.inputs.add(s); cx.notify(); });
    s.on("blur", (_e, cx) => { this.inputs.delete(s); cx.notify(); });
    return s;
  }

  // Whether a text box has the keyboard. A box that goes away while focused sends no blur: the board
  // holding the keyboard itself overrules the set.
  get typing() {
    if (this.inputs.size && this.h.is_focused()) this.inputs.clear();
    return this.inputs.size > 0;
  }

  focusBoard() { this.inputs.clear(); this.h.focus(); }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    this.lastRefresh = Date.now();
    cx.spawn(async (cx) => {
      try {
        await this.sessions.refresh(terminals(), cx, () => {});
        const ps = new Map(panes().map((p) => [p.pane, p.cwd]));
        await this.extras.refresh(agents().map((a) => ps.get(a.pane)));
      } catch (_e) { /* next tick */ } finally { this.busy = false; }
      cx.notify();
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a finished agent turns
  // done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 7 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Every top-level agent with what its card shows. Sub-agents stay with their parent.
  cards(now) {
    const terms = terminals();
    const byAddr = new Map(terms.map((x) => [x.address, x]));
    const sp = new Map(spaces().map((s) => [s.id, s]));
    const ps = panes();
    const cwd = new Map(ps.map((p) => [p.pane, p.cwd]));
    const status = new Map(agents().map((a) => [a.address, a.status]));
    const folders = shared("space-folders")?.[""] ?? { list: [], of: {} };
    const laneOfSpace = new Map();
    return agents()
      .filter((a) => !byAddr.get(a.address)?.parent)
      .map((a) => {
        const term = byAddr.get(a.address);
        const sess = this.sessions.of(term);
        const space = sp.get(a.space);
        if (space && !laneOfSpace.has(space.id)) laneOfSpace.set(space.id, folderOf(space, folders, ps) ?? OTHER);
        const subs = terms.filter((x) => x.parent === a.address && x.state === "live");
        const act = a.status === "working" ? activity(sess, now) : null;
        // Stuck: waiting on the model too long, or silent too long after writing. A running tool is not.
        const stuck = !act ? 0
          : act.kind === "model" && act.for > STUCK_MODEL ? act.for
          : act.kind === "quiet" && act.for > STUCK_QUIET && now - (sess?.movedAt || 0) > STUCK_QUIET && !BACKGROUND.test(term?.report?.msg ?? "") ? act.for : 0;
        return { a, term, space, sess, act, stuck, subs: subs.length, subsWorking: subs.filter((x) => status.get(x.address) === "working").length,
          lane: space ? laneOfSpace.get(space.id) : OTHER,
          since: this.changed?.[a.address]?.at ?? now, prompt: sess?.prompt ?? null,
          title: sess?.customTitle ?? sess?.aiTitle ?? summary(a) ?? cut(sess?.firstPrompt, 60),
          note: this.notes.of(sess), head: headOf(sess),
          doing: a.status === "working" ? (act?.kind === "tool" ? act.label : term?.report?.msg ?? null) : null,
          ask: a.status === "blocked" ? (term?.report?.msg ?? null) : null,
          cache: warmth(sess, now), ctx: this.extras.context(sess), cost: this.extras.costOf(sess),
          git: this.extras.git.get(cwd.get(a.pane)) ?? null };
      });
  }

  matches(c, q) {
    if (!q) return true;
    const hay = [c.title, c.prompt, c.a.space_name, c.a.tab_name, c.note?.text, c.head, c.ask, c.doing, c.git?.branch].filter(Boolean).join(" ").toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }

  // 完成: ends the agent and closes where it ran. Its tab goes when the agent is all it holds; otherwise only
  // its pane, so the tab's other terminals stay. Confirmed already: the click is the confirmation.
  finish(c) {
    const tab = c.space?.tabs?.find((x) => x.id === c.a.tab);
    if (tab && tab.panes <= 1) run("tab.close", { id: tab.id, confirmed: true });
    else run("pane.close", { pane: c.a.pane });
    if (this.sel === c.a.address) this.sel = null;
  }

  goTo(a) {
    if (props()?.overlay) closeOverlay(props().overlay);
    else flip("main", false);
    run("agent.focus", { terminal: a.address });
  }

  openReply(address) {
    if (this.replyTo === address) { this.replyTo = null; this.focusBoard(); return; }
    this.replyTo = address;
    this.sel = address;
    this.replyNote = null;
    this.reply.set_value("");
    this.reply.focus();
  }

  // Types the reply into the agent's terminal and presses Enter, only while it waits for you: checked again
  // as it is sent, since it may have started working since the box opened. Idle is checked by hc too
  // (--if idle); "done" is the app's word for idle-and-unseen, which hc's --if doesn't take.
  send(cx) {
    const to = this.replyTo;
    const text = this.reply.value().trim();
    if (!to || !text) return;
    const s = agents().find((a) => a.address === to)?.status;
    if (s !== "idle" && s !== "done") { this.replyNote = s === "working" ? "它已经开始工作了，没发出去" : "它在等你回答问题：去终端里回答"; cx.notify(); return; }
    this.replyNote = "发送中…";
    cx.spawn(async (cx) => {
      try {
        await hc(["send", to, text, ...(s === "idle" ? ["--if", "idle"] : [])]);
        this.reply.set_value("");
        this.replyTo = null;
        this.replyNote = null;
        this.focusBoard();
      } catch (e) {
        this.replyNote = `没发出去：${String(e?.message ?? e).slice(0, 80)}`;
      }
      cx.notify();
    });
    cx.notify();
  }

  // ---- keys ----

  key(e, cx) {
    const k = e.keystroke;
    if (this.typing) {
      if (k === "escape") {
        if (this.inputs.has(this.reply)) this.replyTo = null;
        this.focusBoard();
        cx.notify();
      }
      return;
    }
    const armed = this.armed;
    this.armed = null;
    const i = this.order.indexOf(this.sel);
    const c = this.byAddr?.get(this.sel);
    const move = (d) => {
      if (!this.order.length) return;
      const n = i < 0 ? (d > 0 ? 0 : this.order.length - 1) : Math.min(this.order.length - 1, Math.max(0, i + d));
      this.sel = this.order[n];
      const lane = this.laneOf[this.sel];
      if (lane !== undefined) this.scroll.scroll_to_item(lane);
    };
    if (k === "j" || k === "down") move(1);
    else if (k === "k" || k === "up") move(-1);
    else if (k === "enter" && c) this.goTo(c.a);
    else if (k === "r" && c && (c.a.status === "idle" || c.a.status === "done")) this.openReply(c.a.address);
    else if (k === "x" && c && c.a.status !== "working") { if (armed === c.a.address) this.finish(c); else this.armed = c.a.address; }
    else if (k === "/") this.filter.focus();
    else if (k === "escape") {
      if (armed) { /* disarmed above */ } else if (this.filter.value()) this.filter.set_value("");
      else if (props()?.overlay) closeOverlay(props().overlay);
      else flip("main");
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---- drawing ----

  chip(t, id, text, color, tip) {
    return div().id(`chip-${id}`).px(6).h(17).rounded(4).flex().items_center().flex_none().bg(alpha(color, "22")).text_color(color)
      .text_size(10.5).font_medium().when(!!tip, (el) => el.tooltip(tip)).child(text);
  }

  button(t, id, label, tip, color, onClick, strong = false) {
    return h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(5)
      .border(1).border_color(strong ? color : t.input).text_size(11).text_color(strong ? color : t.muted).cursor_pointer()
      .when(strong, (el) => el.bg(alpha(color, "1a")))
      .hover((s) => s.bg(alpha(color, "26")).text_color(color).border_color(color))
      .when(!!tip, (el) => el.tooltip(tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(label);
  }

  // The card's small print, left to right: what costs time or money if left alone. Each { id, text, color, tip }.
  meta(t, c) {
    const a = c.a.address;
    const out = [];
    if (c.subs) out.push({ id: `subs-${a}`, text: c.subsWorking ? `子 agent ${c.subs}（${c.subsWorking} 在跑）` : `子 agent ${c.subs}`, color: t.working, tip: "它用 hc run 启动的子 agent" });
    if (c.cache) out.push({ id: `cache-${a}`, text: c.cache.cold ? "缓存过期" : c.cache.text.replace("缓存剩 ", "缓存 "), color: c.cache.cold ? t.dim : warmthColor(t, c.cache.share),
      tip: c.cache.cold ? "提示缓存已过期：下一条消息要重新读整段上下文，贵一些、慢一些" : `提示缓存（${c.sess?.ttl ?? "1h"}）还剩多久；过期前回复更省` });
    if (c.ctx) out.push({ id: `ctx-${a}`, text: `上下文 ${c.ctx.pct}%`, color: c.ctx.pct >= 85 ? t.ansi1 : c.ctx.pct >= 60 ? t.ansi3 : t.dim,
      tip: `${kTokens(c.ctx.tokens)} / ${kTokens(c.ctx.limit)} tokens（到自动压缩）${c.ctx.pct >= 85 ? "：快压缩了，考虑 /compact 或开新会话" : ""}` });
    if (c.cost) out.push({ id: `cost-${a}`, text: money(c.cost), color: t.dim, tip: "这个会话今天的花费（ccline 账本）" });
    const fresh = c.git?.untracked && c.git.untracked <= UNTRACKED_MAX ? c.git.untracked : 0;
    if (c.git?.repo && (c.git.add || c.git.del || fresh)) {
      out.push({ id: `git-${a}`, text: `+${c.git.add} −${c.git.del}`, color: t.dim,
        tip: `${c.git.branch ?? "detached"}：${c.git.files} 个文件未提交${fresh ? `，${fresh} 个未跟踪文件` : ""}` });
    }
    return out;
  }

  card(t, c, now, width) {
    const { a, space } = c;
    const s = a.status;
    const selected = this.sel === a.address;
    const color = STATUS[colOf(s)].color(t);
    const wait = ago(c.since, now);
    // The one thing to read: the question for a blocked agent, the step for a working one, else Haiku's
    // note, else the last reply.
    const line = c.ask ? { text: c.ask, color: t.foreground, lead: "问：", leadColor: t.blocked }
      : c.doing ? { text: c.act?.kind === "tool" ? `${c.doing} · ${dur(c.act.for)}` : c.doing, color: t.muted, lead: "▸ ", leadColor: t.working }
      : c.note ? { text: c.note.text, color: c.note.fresh ? t.foreground : t.muted }
      : c.head ? { text: c.head, color: t.muted } : null;
    const warn = c.stuck ? (c.act.kind === "model" ? `可能卡住：模型 ${dur(c.stuck)} 没响应` : `可能卡住：${dur(c.stuck)} 没有新输出`)
      : c.act?.kind === "tool" && c.act.for > LONG_TOOL ? `工具已经跑了 ${dur(c.act.for)}` : null;
    const replying = this.replyTo === a.address;
    const canReply = s === "idle" || s === "done";
    const meta = this.meta(t, c);
    const small = (r, txt, col) => r.child(div().flex_none().text_size(11).text_color(col).child(txt));
    return h_flex().id(`card-${a.address}`).w(width).flex_none().items_stretch().rounded(10).overflow_hidden()
      .bg(selected ? alpha(t.accent, "14") : t.surface).border(1).border_color(selected ? t.accent : c.stuck ? alpha(t.ansi1, "aa") : t.border)
      .cursor_pointer().hover((st) => st.border_color(selected ? t.accent : t.input))
      .on_click((_e, cx) => { this.goTo(a); cx.notify(); })
      .child(div().w(3).flex_none().bg(color))
      .child(v_flex().flex_1().min_w(0).px(12).py(10).gap(7)
        // status · space · how long
        .child(h_flex().gap(7).items_center()
          .child(h_flex().h(18).px(6).gap(4).flex_none().items_center().rounded(4).bg(alpha(color, "22"))
            .when(s === "working", (el) => el.child(svg(`${ICONS}/spinner.svg`).size(10).text_color(color).spin(900)))
            .child(div().text_size(10.5).font_semibold().text_color(color).child(STATUS[colOf(s)].name)))
          .child(spaceTile(t, space, 12))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(a.space_name || "?"))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(wait)))
        // title
        .child(div().text_size(13.5).font_semibold().whitespace_normal().text_color(c.title ? t.foreground : t.dim)
          .child(cut(c.title, 48) ?? (c.sess?.path ? "（还没有对话简介）" : "新会话 · 还没发过消息")))
        .when(!!warn, (el) => el.child(div().px(6).py(3).rounded(5).bg(alpha(c.stuck ? t.ansi1 : t.ansi3, "1f")).text_size(11.5)
          .text_color(c.stuck ? t.ansi1 : t.ansi3).child(warn)))
        .when(!!line, (el) => el.child(div().text_size(12.5).whitespace_normal().text_color(line.color)
          .child(`${line.lead ?? ""}${cut(line.text.replace(/[。.]\s*$/, ""), 110)}`)))
        .when(!!c.prompt, (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(`你：${c.prompt}`)))
        // small print and actions, at the bottom of a card as tall as its row
        .child(div().flex_1())
        .child(h_flex().gap(6).items_center().min_h(22).pt(2)
          .children(meta.flatMap((m, i) => [
            ...(i ? [div().flex_none().text_size(11).text_color(alpha(t.dim, "88")).child("·")] : []),
            div().id(`meta-${m.id}`).flex_none().text_size(11).text_color(m.color).tooltip(m.tip).child(m.text)]))
          .child(div().flex_1())
          .when(this.armed === a.address, (r) => small(r, "再按 x 结束", t.done))
          .when(s === "blocked", (r) => r.child(this.button(t, `go-${a.address}`, "去回答", "跳到终端回答它的问题（回车）", t.blocked, () => this.goTo(a), true)))
          .when(canReply, (r) => r.child(this.button(t, `reply-${a.address}`, replying ? "收起" : "回复", "在这里直接给它发一条消息（r）", t.accent, () => this.openReply(a.address))))
          .when(s !== "working", (r) => r.child(this.button(t, `done-${a.address}`, "完成", "结束这个 Agent，关掉它的窗口（x x）", t.done, () => this.finish(c)))))
        .when(replying, (el) => el.child(v_flex().gap(4)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => cx.stop_propagation())
          .child(Input.new(this.reply).h(28).px(8).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground).text_size(12.5))
          .child(div().text_size(11).text_color(t.dim).child(this.replyNote ?? "回车发送 · esc 取消")))));
  }

  // Agents waiting on a question, across every project: who, what it asks, how long it has waited.
  alerts(t, list, now) {
    if (!list.length) return null;
    return v_flex().mx(10).mt(10).p(8).gap(4).flex_none().rounded(8).bg(alpha(t.blocked, "1a")).border(1).border_color(alpha(t.blocked, "66"))
      .child(h_flex().gap(6).items_center().text_size(12).font_semibold().text_color(t.blocked)
        .child(div().size(7).rounded(4).bg(t.blocked)).child(`${list.length} 个 Agent 在等你回答`))
      .children(list.map((c) => h_flex().id(`alert-${c.a.address}`).gap(8).px(6).py(3).rounded(5).items_center().cursor_pointer()
        .hover((s) => s.bg(alpha(t.blocked, "26")))
        .on_click((_e, cx) => { this.goTo(c.a); cx.notify(); })
        .child(spaceTile(t, c.space, 13))
        .child(div().flex_none().max_w(220).truncate().text_size(12).text_color(t.foreground).child(cut(c.title, 40) ?? c.a.space_name ?? "Agent"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(c.ask ?? "需要你处理"))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`已等 ${ago(c.since, now)}`))));
  }

  recapPanel(t) {
    const r = this.recap;
    if (!r) return null;
    const box = v_flex().mx(10).mt(10).p(10).gap(6).flex_none().rounded(8).bg(t.surface).border(1).border_color(t.border);
    const close = this.button(t, "recap-close", "关闭", null, t.muted, () => { this.recap = null; });
    if (r.busy) return box.child(h_flex().gap(8).items_center().text_size(12).text_color(t.muted)
      .child(svg(`${ICONS}/spinner.svg`).size(12).text_color(t.accent).spin(900)).child("Haiku 正在读今天的会话，写回顾…（约半分钟）"));
    if (r.error) return box.child(h_flex().gap(8).items_center().child(div().flex_1().text_size(12).text_color(t.ansi1).child(`回顾没写成：${r.error}`)).child(close));
    return box
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(`已存到 ${r.path.replace(/^\/Users\/[^/]+/, "~")}`))
        .child(this.button(t, "recap-open", "打开文件", null, t.accent, () => { exec("open", [r.path]).catch(() => {}); }))
        .child(close))
      .child(v_flex().id("recap-body").max_h(360).overflow_y_scrollbar().text_size(12.5).text_color(t.foreground)
        .child(TextView.markdown("recap-md", r.text)));
  }

  makeRecap(cx) {
    if (this.recap?.busy) return;
    this.recap = { busy: true };
    cx.spawn(async (cx) => {
      try { this.recap = await recap(); } catch (e) { this.recap = { error: String(e?.message ?? e).slice(0, 160) }; }
      cx.notify();
    });
  }

  // A project: its header (fold, color, name, counts) and its cards, most urgent first, in rows.
  lane(t, id, name, color, items, now, width) {
    const folded = !!this.folded[id];
    const counts = STATUS_ORDER.map((k) => [k, items.filter((c) => colOf(c.a.status) === k).length]).filter(([, n]) => n);
    return v_flex().flex_none().gap(10)
      .child(h_flex().id(`lane-${id}`).h(28).gap(8).flex_none().items_center().cursor_pointer().rounded(6).px(4)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.folded[id] = !folded; localStorage.setItem("folded", JSON.stringify(this.folded)); cx.notify(); })
        .child(div().w(10).text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
        .child(div().size(10).rounded(3).bg(color))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(name))
        .child(h_flex().gap(10).items_center().pl(4)
          .children(counts.map(([k, n]) => h_flex().gap(4).items_center()
            .child(div().size(6).rounded(3).bg(STATUS[k].color(t)))
            .child(div().text_size(11.5).text_color(t.muted).child(`${n} ${STATUS[k].name}`)))))
        .child(div().flex_1().h(1).ml(8).bg(t.border)))
      .when(!folded, (el) => el.child(h_flex().flex_wrap().gap(GAP).items_stretch()
        .children(items.map((c) => this.card(t, c, now, width)))));
  }

  pill(t) {
    const showing = find(layout(), STACK)?.active === "board";
    const subs = new Set(terminals().filter((x) => x.parent).map((x) => x.address));
    const top = agents().filter((a) => !subs.has(a.address));
    const working = top.filter((a) => a.status === "working").length;
    const blocked = top.filter((a) => a.status === "blocked").length;
    const needs = top.length - working - blocked;
    const chip = (n, color, tip) => div().id(`n-${tip}`).px(5).h(16).rounded(4).flex().items_center().bg(alpha(color, "33")).text_color(color)
      .text_size(10.5).font_semibold().tooltip(tip).child(String(n));
    return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("pill").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
        .bg(showing ? t.selected : t.chrome).text_color(showing ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .tooltip("cmd-shift-k")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { flip(); cx.notify(); })
        .child(svg(`${ICONS}/layers.svg`).size(14))
        .child(showing ? "Terminals" : "Board")
        .when(blocked > 0, (el) => el.child(chip(blocked, t.blocked, `${blocked} 个在等你回答`)))
        .when(working > 0, (el) => el.child(chip(working, t.working, `${working} 个在工作`)))
        .when(needs > 0, (el) => el.child(chip(needs, t.done, `${needs} 个做完/空闲`))));
  }

  render(cx) {
    const t = theme();
    if (this.role === "pill") return this.pill(t);
    const now = Date.now();
    const live = !checking();
    if (live) this.track(agents(), now);
    const all = this.cards(now);
    this.byAddr = new Map(all.map((c) => [c.a.address, c]));
    // A new Claude agent: look its session up now rather than at the next 10s tick.
    if (live && !this.busy && now - this.lastRefresh > 2000
      && all.some((c) => c.term?.foreground?.pid && c.a.app === "claude-code" && !c.sess && !this.sessions.byPid.has(c.term.foreground.pid))) this.refresh(cx);
    if (live) {
      for (const c of all) this.notes.want(c.sess, c.a.status);
      this.notes.pump(cx);
    }
    if (this.replyTo && !all.some((c) => c.a.address === this.replyTo && (c.a.status === "idle" || c.a.status === "done"))) this.replyTo = null;
    if (this.sel && !this.byAddr.has(this.sel)) this.sel = null;

    const blocked = all.filter((c) => c.a.status === "blocked").sort((x, y) => x.since - y.since);
    // The Dock icon counts the agents waiting on you, whichever app is in front.
    const badge = blocked.length ? String(blocked.length) : null;
    if (live && badge !== this.badge) { this.badge = badge; setBadge(badge); }

    // The board just came into view (flipped to, or opened): it takes the keyboard.
    const inOverlay = !!props()?.overlay;
    const shown = inOverlay || find(layout(), STACK)?.active === "board";
    if (shown && !this.shown) this.wakeFocus?.();
    this.shown = shown;

    const q = this.filter.value().trim().toLowerCase();
    const visible = all.filter((c) => this.matches(c, q));
    const folders = shared("space-folders")?.[""]?.list ?? [];
    const urgency = (x, y) => STATUS_ORDER.indexOf(colOf(x.a.status)) - STATUS_ORDER.indexOf(colOf(y.a.status)) || x.since - y.since;
    const lanes = [...folders.map((f) => ({ id: f.id, name: f.name, color: paint(t, f.color) })), { id: OTHER, name: "其他", color: t.dim }]
      .map((l) => ({ ...l, items: visible.filter((c) => c.lane === l.id).sort(urgency) }))
      .filter((l) => l.items.length);
    // j/k order: as drawn, lane by lane; folded lanes are skipped.
    this.order = [];
    this.laneOf = {};
    lanes.forEach((l, li) => {
      if (this.folded[l.id]) return;
      for (const c of l.items) { this.order.push(c.a.address); this.laneOf[c.a.address] = li; }
    });
    // Cards in as many columns of at least CARD_MIN px as fit, all the same width.
    const inner = Math.max(CARD_MIN, (this.width ?? 1200) - 2 * PAD - 14);
    const cols = Math.max(1, Math.floor((inner + GAP) / (CARD_MIN + GAP)));
    const cardW = Math.floor((inner - GAP * (cols - 1)) / cols);
    const n = (s) => all.filter((c) => colOf(c.a.status) === s).length;
    const stale = all.filter((c) => c.a.status === "idle" && now - c.since > STALE);
    if (this.cleanArmed && now - this.cleanArmed > 6000) this.cleanArmed = 0;
    const today = this.extras.today();
    return v_flex().id("root").size_full().bg(t.canvas)
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) > 1) { this.width = size.width; cx.notify(); } })
      .track_focus(this.h)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", (_e, cx) => { if (!this.typing) this.h.focus(); })
      .child(h_flex().h(40).px(14).gap(10).flex_none().items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Agents"))
        .child(div().text_size(10.5).text_color(t.dim).child(BUILD))
        .child(div().text_size(12).text_color(t.muted).child(`${n("blocked")} 需要你 · ${n("done")} 刚做完 · ${n("working")} 工作中 · ${n("idle")} 空闲`))
        .when(today > 0, (el) => el.child(div().id("today").text_size(12).text_color(t.muted).tooltip("今天所有 Claude 会话的花费（ccline 账本，和状态栏一致）").child(`· 今日 ${money(today)}`)))
        .when(this.notes.running, (el) => el.child(div().text_size(11).text_color(t.dim).child("Haiku 正在写进度…")))
        .child(div().flex_1())
        .child(div().w(200).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.filter).h(26).px(8).items_center().rounded(6).border(1).border_color(this.inputs.has(this.filter) ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(12)))
        .when(stale.length > 0, (el) => el.child(this.button(t, "clean", this.cleanArmed ? `确认关闭 ${stale.length} 个？` : `清理 ${stale.length}`,
          `关掉空闲超过 1 天的 Agent：${stale.map((c) => cut(c.title, 20) ?? c.a.space_name).join("、")}`, t.ansi1, () => {
            if (!this.cleanArmed) { this.cleanArmed = Date.now(); return; }
            this.cleanArmed = 0;
            for (const c of stale) this.finish(c);
          }, !!this.cleanArmed)))
        .child(this.button(t, "recap", this.recap?.busy ? "回顾生成中…" : "今日回顾", "让 Haiku 读今天所有 Claude 会话，写一份回顾（存到 ~/Documents/herdr-recap）", t.accent, (cx) => this.makeRecap(cx)))
        .child(h_flex().id("back").h(26).px(8).items_center().rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { if (inOverlay) closeOverlay(props().overlay); else flip("main"); cx.notify(); })
          .child(inOverlay ? "Close" : "← Terminals")))
      .child(this.recapPanel(t) ?? div())
      .child(this.alerts(t, blocked, now) ?? div())
      .child(v_flex().id("lanes").flex_1().min_h(0).px(PAD).py(14).gap(22).overflow_y_scrollbar().track_scroll(this.scroll)
        .when(!lanes.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child(q ? `没有匹配「${q}」的 Agent` : "还没有 Agent")))
        .children(lanes.map((l) => this.lane(t, l.id, l.name, l.color, l.items, now, cardW))))
      .child(h_flex().h(22).px(14).gap(14).flex_none().items_center().border_t(1).border_color(t.border).bg(t.chrome).text_size(10.5).text_color(t.dim)
        .child(this.h.is_focused() ? "⌨ 键盘在看板上" : "⌨ 点一下看板用键盘")
        .child("j/k 选择").child("回车 跳过去").child("r 回复").child("x x 完成").child("/ 搜索").child("esc 返回"));
  }
}
