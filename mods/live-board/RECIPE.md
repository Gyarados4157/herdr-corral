# Live Board

Every coding agent in Herdr as a card that moves by itself: **In Progress**
while it works, **Review** while it waits for you, gone when its terminal
closes. Nothing to drag and nothing stored but timestamps: the board is a view
of Herdr's agents, so it shows at a glance how many agents are working and how
many need you.

Built and used on herdr-app 0.1.16 with Claude Code 2.1.325 (build `0.1.6`).

## What you see

One full-size view on `canvas`:

- **Header** (40px, `chrome`, bottom `border`): "Agents" (13px semibold), the
  build (10.5px `dim`), "N 个在工作 · M 个等你" (12px `muted`), then on the
  right "← Terminals" (live layout) or "Close" (window).
- **Two columns**, side by side, each half the width, 10px apart, each
  scrolling on its own:
  - **In Progress** (dot `working`): agents whose status is `working`,
    longest working first. Empty: "没有 Agent 在工作".
  - **Review** (dot `blocked`): every other agent, blocked first, then done,
    then idle; longest waiting first within each. Empty: "没有需要你处理的
    Agent".
  - Column header (36px): dot, name (12.5px semibold), count pill.
- **Card** (`surface`, 8px radius; outline `blocked` / `done` / half-alpha
  `working` / `border` by status):
  1. The program's icon, the title, the status and, on Review cards only, a
     **完成** button (outlined, `done` on hover, tooltip "结束这个 Agent，关掉它的窗口").
     Status: spinner + "工作中", a "需要你" pill, a dot + "刚做完", or a ring
     + "等你回复".
  2. The space's tile, "Space / Tab" (an automatic tab name reads "Tab N"),
     and "· 已工作 Xm" or "· 已等 Xm" (`<1m`, `6m`, `2h`, `3d`).
  3. While working, "正在：…" with the agent's own report message, if any.
  4. "你" and your last prompt to it (cut at 180 characters), when known.
- The title is, first found: the name given with `/rename`; Claude's
  `ai-title`; the terminal title when it says more than the program's name;
  the first prompt cut at 60 characters. Without one: "（还没有对话简介）"
  (a transcript exists) or "新会话 · 还没发过消息".
- **Pill** (`{ role: "pill" }`, the live layout's top bar): "Board" or
  "Terminals" with a working count (`working`) and a needs-you count
  (`blocked`).

## How it behaves

- A click on a card shows that agent: closes the window, or flips the live
  layout back to the terminals, then `agent.focus`.
- **完成** ends the agent without asking: `tab.close {confirmed: true}` when
  the agent's tab holds only its pane, else `pane.close` for its pane, so the
  tab's other terminals stay. The card leaves with the terminal. A Claude
  session can come back with `claude --resume`.
- `cmd-shift-k` in the live layout flips between the terminals and the board
  (`live-board.toggle` → `layout.select` on the `live-view` stack); back on
  the terminals, the focused pane gets the keyboard again.
- Sub-agents (terminals with a `parent`) get no card of their own.
- Waiting time: the board stamps each agent's status change in its
  `localStorage` (`changed`), done and idle counting as one state. Stamps of
  agents gone for 7 days are dropped.
- Claude data (this computer only): every 10s, and at once when a new Claude
  pid appears, the foreground pid → `~/.claude/sessions/<pid>.json` →
  `sessionId` → `~/.claude/projects/*/<sessionId>.jsonl`. The transcript's
  folder is watched, so a new prompt shows within a moment.

## Built from

- `agents()`, `terminals()` (foreground pid, `report`, `parent`),
  `spaces()` (tab ids and pane counts), `layout()`, `props()`, `theme()`,
  `shared("space.colors")`.
- `run`: `layout.select`, `pane.focus`, `agent.focus`, `tab.close`,
  `pane.close`. `exec` runs `find`, `sh`, `tail`, `grep`, `sed`;
  `readTextFile`, `watchFolder`, `home()`.
- `layouts/live.json`: `layouts/corral.json` with corral-board → live-board,
  corral-view → live-view, corral-toggle → live-toggle; the `live-view`
  stack opens on the board.

## Watch out

- Herdr's terminal title for Claude Code is just "Claude Code", and
  `status_ms` is null: stamp status changes yourself, as Herdr's agents list
  does.
- Claude Code 2.1.316 and later no longer write `ai-title` records; keep the
  fallbacks.
- Match transcript records anchored at the line's start
  (`^\{"type":"last-prompt"`): a message or a tool's output (a grep of a
  transcript) can hold the same words.
- `last-prompt` holds about the first 200 characters of the prompt.
- The first `last-prompt` can sit before the 4 MB tail that is read on every
  change: read the titles and the first prompt once from the whole file.
- `/clear` and `--resume` give the same pid another session id: start that
  pid's entry over.
- The 完成 button stops propagation on mouse down and click, or the card
  under it takes the click and focuses the agent it just closed.

## Done when

- A new Claude agent started anywhere in Herdr shows in Review, moves to In
  Progress when it starts working and back to Review when it stops, and
  leaves when its terminal closes.
- Each card shows Space / Tab, a title and your last prompt.
- 完成 closes the agent's tab (alone in it) or its pane (sharing the tab).
