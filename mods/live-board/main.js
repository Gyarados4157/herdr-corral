// Live Board: every agent as a card that moves by itself, In Progress while it works and Review while it
// waits for you, and leaves the board when its terminal closes. Nothing is stored.
// Props: none → the board; { role: "pill" } → the live layout's toggle in the top bar.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, theme, run, layout, props, nextCommand, focused, shared, checking, closeOverlay } from "herdr";
import { Sessions } from "./sessions.js";

// Bump on every change: shown in the header, to see which build is running.
const BUILD = "0.1.6";
const ICONS = "mods/workspace-chrome";
const STACK = "live-view";
const PROMPT_MAX = 180;

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

// A space's tile as Herdr's spaces sidebar draws it: its first letter on its color.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function spaceTile(t, space, size = 14) {
  if (!space) return div();
  const color = shared("space.colors")?.[space.id] ?? "ansi6";
  const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  return h_flex().size(size).flex_none().rounded(size * 0.28).bg(fill).items_center().justify_center()
    .text_size(size * 0.6).font_bold().text_color("#ffffff").child([...space.name][0]?.toUpperCase() ?? "?");
}

// "<1m", "6m", "2h", "3d".
function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

// The conversation's short summary: Claude Code (and others) put it in the terminal title, after a status
// glyph. Null while the title only names the program.
function summary(a) {
  const s = (a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (!s || s === a.program?.name || /^(claude|claude code|codex)$/i.test(s)) return null;
  return s;
}

// A first prompt shortened to stand in for a title.
const short = (p) => (!p ? null : p.length > 60 ? `${p.slice(0, 60)}…` : p);

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Review order: needs you, then finished and not looked at, then seen; longest waiting first in each.
const RANK = { blocked: 0, done: 1, idle: 2 };

export default class LiveBoard extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "board";
    if (this.role === "pill") {
      cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "toggle") flip(); cx.notify(); } });
      return;
    }
    this.sessions = new Sessions();
    // Each agent's last state and when it changed (ms), kept across restarts. Herdr reports no time of
    // its own (status_ms stays null), so the board stamps changes as it sees them, as the agents list does.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}") ?? {}; } catch (_e) { this.changed = {}; }
    cx.timer.every(30000, (cx) => cx.notify());
    this.busy = false;
    this.lastRefresh = 0;
    if (checking()) return;
    cx.timer.every(10000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    this.lastRefresh = Date.now();
    cx.spawn(async (cx) => {
      try { await this.sessions.refresh(terminals(), cx, () => {}); } catch (_e) { /* next tick */ } finally { this.busy = false; }
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
  cards() {
    const terms = new Map(terminals().map((x) => [x.address, x]));
    const sp = new Map(spaces().map((s) => [s.id, s]));
    return agents()
      .filter((a) => !terms.get(a.address)?.parent)
      .map((a) => {
        const term = terms.get(a.address);
        const sess = this.sessions.of(term);
        return { a, term, space: sp.get(a.space), since: this.changed?.[a.address]?.at ?? Date.now(), sess, prompt: sess?.prompt ?? null,
          title: sess?.customTitle ?? sess?.aiTitle ?? summary(a) ?? short(sess?.firstPrompt), doing: a.status === "working" ? (term?.report?.msg ?? null) : null };
      });
  }

  // 完成: ends the agent and closes where it ran. Its tab goes when the agent is all it holds; otherwise only
  // its pane, so the tab's other terminals stay. Confirmed already: the click is the confirmation.
  finish(c) {
    const tab = c.space?.tabs?.find((x) => x.id === c.a.tab);
    if (tab && tab.panes <= 1) run("tab.close", { id: tab.id, confirmed: true });
    else run("pane.close", { pane: c.a.pane });
  }

  goTo(a) {
    if (props()?.overlay) closeOverlay(props().overlay);
    else flip("main", false);
    run("agent.focus", { terminal: a.address });
  }

  status(t, s) {
    const row = (...kids) => h_flex().gap(5).items_center().flex_none().text_size(11).children(kids);
    if (s === "working") return row(svg(`${ICONS}/spinner.svg`).size(12).text_color(t.working).spin(900), div().text_color(t.working).child("工作中"));
    if (s === "blocked") return div().px(6).h(18).rounded(9).flex().items_center().flex_none().bg(alpha(t.blocked, "26")).text_color(t.blocked).text_size(11).font_semibold().child("需要你");
    if (s === "done") return row(div().size(7).rounded(4).bg(t.done), div().text_color(t.done).child("刚做完"));
    if (s === "idle") return row(div().size(7).rounded(4).border(1).border_color(t.idle), div().text_color(t.dim).child("等你回复"));
    return row(div().text_color(t.dim).child(s ?? "?"));
  }

  card(t, c, now) {
    const { a, space, prompt } = c;
    const title = c.title;
    const tab = a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : `Tab ${a.tab_index}`;
    const outline = a.status === "blocked" ? t.blocked : a.status === "done" ? t.done : a.status === "working" ? alpha(t.working, "80") : t.border;
    const wait = a.status === "working" ? `已工作 ${ago(c.since, now)}` : `已等 ${ago(c.since, now)}`;
    const shown = prompt && prompt.length > PROMPT_MAX ? `${prompt.slice(0, PROMPT_MAX)}…` : prompt;
    return v_flex().id(`card-${a.address}`).gap(6).p(10).rounded(8).bg(t.surface).border(1).border_color(outline)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.goTo(a); cx.notify(); })
      .child(h_flex().gap(8).items_start()
        .child(icon(a.program, 15, t.muted) ?? div().size(15))
        .child(div().flex_1().min_w(0).text_size(13).font_medium().whitespace_normal()
          .text_color(title ? t.foreground : t.dim).child(title ?? (c.sess?.path ? "（还没有对话简介）" : "新会话 · 还没发过消息")))
        .child(this.status(t, a.status))
        .when(a.status !== "working", (el) => el.child(h_flex().id(`done-${a.address}`).h(20).px(8).flex_none().items_center().rounded(5)
          .border(1).border_color(t.input).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(alpha(t.done, "26")).text_color(t.done).border_color(t.done))
          .tooltip("结束这个 Agent，关掉它的窗口")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.finish(c); cx.notify(); })
          .child("完成"))))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(spaceTile(t, space, 13))
        .child(div().truncate().child(`${a.space_name || "?"} / ${tab}`))
        .child(div().flex_none().child(`· ${wait}`)))
      .when(!!c.doing, (el) => el.child(div().text_size(11.5).text_color(t.working).truncate().child(`正在：${c.doing}`)))
      .when(!!shown, (el) => el.child(h_flex().gap(6).items_start().px(8).py(6).rounded(6).bg(alpha(t.background, "80"))
        .child(div().flex_none().text_size(11).text_color(t.accent).child("你"))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).whitespace_normal().child(shown))));
  }

  column(t, id, name, color, items, empty, now) {
    return v_flex().flex_1().min_w(0).h_full().rounded(10).bg(alpha(t.chrome, "cc")).border(1).border_color(t.border)
      .child(h_flex().h(36).px(12).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
        .child(div().size(8).rounded(4).bg(color))
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(name))
        .child(div().px(6).h(18).rounded(9).flex().items_center().bg(alpha(color, "26")).text_color(color).text_size(11).font_semibold().child(String(items.length))))
      .child(v_flex().id(`col-${id}`).flex_1().min_h(0).p(10).gap(8).overflow_y_scrollbar()
        .when(!items.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child(empty)))
        .children(items.map((c) => this.card(t, c, now))));
  }

  pill(t) {
    const showing = find(layout(), STACK)?.active === "board";
    const subs = new Set(terminals().filter((x) => x.parent).map((x) => x.address));
    const top = agents().filter((a) => !subs.has(a.address));
    const working = top.filter((a) => a.status === "working").length;
    const needs = top.length - working;
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
        .when(working > 0, (el) => el.child(chip(working, t.working, `${working} 个在工作`)))
        .when(needs > 0, (el) => el.child(chip(needs, t.blocked, `${needs} 个需要你`))));
  }

  render(cx) {
    const t = theme();
    if (this.role === "pill") return this.pill(t);
    const now = Date.now();
    if (!checking()) this.track(agents(), now);
    const all = this.cards();
    // A new Claude agent: look its session up now rather than at the next 10s tick.
    if (!checking() && !this.busy && now - this.lastRefresh > 2000
      && all.some((c) => c.term?.foreground?.pid && c.a.app === "claude-code" && !c.sess && !this.sessions.byPid.has(c.term.foreground.pid))) this.refresh(cx);
    const progress = all.filter((c) => c.a.status === "working").sort((x, y) => x.since - y.since);
    const review = all.filter((c) => c.a.status !== "working")
      .sort((x, y) => (RANK[x.a.status] ?? 3) - (RANK[y.a.status] ?? 3) || x.since - y.since);
    const inOverlay = !!props()?.overlay;
    return v_flex().id("root").size_full().bg(t.canvas)
      .child(h_flex().h(40).px(14).gap(10).flex_none().items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Agents"))
        .child(div().text_size(10.5).text_color(t.dim).child(BUILD))
        .child(div().text_size(12).text_color(t.muted).child(`${progress.length} 个在工作 · ${review.length} 个等你`))
        .child(div().flex_1())
        .child(h_flex().id("back").h(26).px(8).items_center().rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { if (inOverlay) closeOverlay(props().overlay); else flip("main"); cx.notify(); })
          .child(inOverlay ? "Close" : "← Terminals")))
      .child(h_flex().flex_1().min_h(0).p(10).gap(10)
        .child(this.column(t, "progress", "In Progress", t.working, progress, "没有 Agent 在工作", now))
        .child(this.column(t, "review", "Review", t.blocked, review, "没有需要你处理的 Agent", now)));
  }
}
