# Live Board

Every coding agent in Herdr as a card, grouped by project, most urgent
first: **需要你**, **刚做完**, **工作中**, **空闲**, each card striped in
its status color. Each card says where the agent got to (a one-line Haiku note), how
long its prompt cache stays warm, and whether it looks stuck; idle agents can
be answered right on the card. A red strip on top lists every agent waiting
on a question. Nothing to drag: the board is a view of Herdr's agents.

Built and used on herdr-app 0.1.16 with Claude Code 2.1.330 (build `0.1.7-dev.5`).

## What you see

One full-size view on `canvas`:

- **Header** (40px, `chrome`, bottom `border`): "Agents" (13px semibold), the
  build (10.5px `dim`), "A 需要你 · B 刚做完 · C 工作中 · D 空闲" (12px
  `muted`), "· 今日 $N" (all Claude sessions today), "Haiku 正在写进度…"
  (11px `dim`) while a note is being written; on the right a 200px search
  box, **清理 N** (only when idle agents are over a day old; "确认关闭 N 个？"
  on the first click, red, for 6s), **今日回顾**, then "← Terminals" or "Close".
- **Recap panel** (after 今日回顾): a spinner while Haiku writes, then the
  Markdown (max 360px, scrolls), where it was saved, 打开文件 and 关闭.
- **Footer** (22px, `chrome`): whether the board has the keyboard, and the keys.
- **Alert strip** (only when an agent is `blocked`; 10px in, `blocked` at 10%
  alpha, `blocked` 40% border, 8px radius): "N 个 Agent 在等你回答", then a row
  per blocked agent, longest waiting first: space tile, title (cut at 40),
  its question (the terminal's `report.msg`, else "需要你处理"), "已等 Xm".
- **Projects** (scrolling together, 16px in, 22px apart): one per
  space-folders folder that has agents, in the folders' order, then "其他"
  for spaces in no folder. Header (28px): ▾/▸, the folder's color square,
  its name (14px semibold), a dot and "N 需要你 / 刚做完 / 工作中 / 空闲" per
  non-empty status (11.5px `muted`), then a 1px `border` line to the right
  edge. A click folds it to the header (kept in `localStorage` `folded`).
  Its cards flow in rows, 12px apart, most urgent first (需要你, 刚做完,
  工作中, 空闲; longest waiting first in each), each row as tall as its
  tallest card. Columns: as many of at least 330px as fit the board's width
  (`on_size_change`), all one width.
- **Card** (`surface`, 10px radius, 1px `border`, `input` on hover, `accent`
  and a 8% `accent` fill when selected, faded `ansi1` when maybe stuck), a
  3px stripe on the left in the status color (`blocked`, `done`, `working`,
  `dim`), then 12px in:
  1. A status badge (the status name, 10.5px semibold, on its color at 13%;
     a spinner while working), the space's tile and name (11px `dim`), and
     on the right how long it has been in this state (`<1m`, `6m`, `2h`).
  2. The title (13.5px semibold, cut at 48).
  3. A warning, when there is one: "可能卡住：模型 Xm 没响应" / "可能卡住：Xm
     没有新输出" (`ansi1` on 12%), or "工具已经跑了 Xm" (`ansi3`).
  4. One line to read (12.5px, cut at 110, a trailing 。 dropped): "问：" +
     the question (blocked), "▸ " + the running tool and how long, else the
     report message (working), Haiku's note (`muted` while a newer reply
     waits for its note), else the last reply.
  5. "你：" + your last prompt, one line, `dim`.
  6. At the bottom: small print separated by "·" (11px, tooltips): "子 agent
     N（M 在跑）", "缓存 Nm" (green → amber → red) or "缓存过期", "上下文 N%"
     (`dim`, amber from 60, red from 85), today's "$N", "+A −D" (uncommitted
     lines; branch and files in the tooltip; untracked over 200 left off);
     then on the right "再按 x 结束", and the buttons: **去回答** (blocked,
     filled), **回复** (idle or done; "收起" while open), **完成** (not
     working).
  7. While replying: a text box ("回复这个 Agent，回车发送", `accent` border)
     and a line under it ("回车发送 · esc 取消", "发送中…", or why it failed).
- The title is, first found: the name given with `/rename`; Claude's
  `ai-title`; the terminal title when it says more than the program's name;
  the first prompt cut at 60. Without one: "（还没有对话简介）" (a transcript
  exists) or "新会话 · 还没发过消息".
- **Pill** (`{ role: "pill" }`, the live layout's top bar): "Board" or
  "Terminals" with counts: blocked (`blocked`), working (`working`), done or
  idle (`done`).

## How it behaves

- A click on a card or an alert row shows that agent: closes the window, or
  flips the live layout back to the terminals, then `agent.focus`.
- **完成** ends the agent without asking: `tab.close {confirmed: true}` when
  the agent's tab holds only its pane, else `pane.close`.
- **Keys** (when the board has the keyboard: it takes it when it comes into
  view, or on a click): j/k or ↓/↑ select through the cards as drawn, project
  by project (accent outline; the project scrolls into view), enter goes
  to it, r opens the reply box, x then x again ends it ("再按 x 结束它"), /
  focuses search, esc leaves a text box, clears search, else goes back.
- **Search** keeps the cards whose title, prompt, space, tab, note, reply,
  question or branch hold every word.
- **Dock badge**: `setBadge` with the number of blocked agents (none: cleared).
- **清理** ends every agent idle for over 24h, as 完成 does, after a second click.
- **今日回顾**: every main transcript written to today (`find -newermt`), its
  title, first and last prompt and last two reply texts (900 chars each),
  to Haiku for a Markdown recap (summary, per project, open items), saved
  to `~/Documents/herdr-recap/YYYY-MM-DD.md`.
- **回复** opens the box under that card (one at a time) and focuses it;
  Enter runs `hc send <terminal> <text>` (pasted, then Enter). The box
  closes on success, or when the agent stops being idle/done. The status is
  checked again on Enter (working or blocked: not sent), and idle is passed
  as `--if idle` (hc's `--if` doesn't take done). **去回答** jumps
  to a blocked agent: its dialog is answered in the terminal.
- **Lanes**: a space goes to the folder it was dragged into in space-folders
  (`shared("space-folders")[""].of[spaceId]`), else the folder whose rules
  reach deepest into where the space works (its first tab pane's `cwd`, else
  `folder`), as the space-folders sidebar decides.
- **Haiku notes**: when a Claude agent is not working and its last
  main-thread reply has no note yet and is over 150 characters (shorter ones
  are shown whole), it is queued; one call runs at a time:
  `claude -p --model haiku --no-session-persistence --strict-mcp-config
  --max-turns 1` with your last prompt and its last 3 replies (2500
  characters each), asking for one Chinese sentence (≤ 60 characters): where
  it got to and what you need to do. Notes are kept in `localStorage`
  (`summaries`, by session id with the reply's uuid) for 7 days. A failed
  call isn't retried until the session writes again.
- **Cache countdown**: the main thread's last reply time + its TTL (`1h` or
  `5m` from the last `repl_main_thread` api-request's `cacheControl`; `1h`
  until known).
- **What it's doing** (from the transcript): a tool call without its result
  is "running a tool" (never stuck), a prompt or result without a reply is
  "waiting on the model" (stuck after 5m), text with nothing after is
  "quiet" (stuck after 10m, unless the report says something still runs in
  the background: "still running", "background").
- **Context**: the last main reply's usage (input + cache read + cache
  creation + output) over `modelSettings[<model>].autoCompactWindow` in
  `~/.claude/settings.json` (200k if unset), as the ccline status line counts.
- **Cost**: `~/.claude/ccline/state/ledger.json` `sessions[<id>].total`.
- **Git**: per agent pane's `cwd`, at most every 30s: branch, `git diff HEAD
  --numstat` sums, untracked count.
- **Transcripts are read incrementally**: the tail (4 MB) once, then only
  the bytes after the last complete line read; a watch wake waits 800ms to
  gather a burst into one read.
- `cmd-shift-k` in the live layout flips between the terminals and the board.
- Sub-agents (terminals with a `parent`) get no card of their own.
- Waiting time: status changes are stamped in `localStorage` (`changed`),
  done and idle counting as one state; stamps gone for 7 days are dropped.
- Claude data (this computer only): every 10s, and at once when a new Claude
  pid appears, foreground pid → `~/.claude/sessions/<pid>.json` →
  `sessionId` → `~/.claude/projects/*/<sessionId>.jsonl`. The transcript's
  folder is watched, so changes show within a moment.

## Built from

- `agents()`, `terminals()` (foreground pid, `report`, `parent`),
  `spaces()`, `panes()` (cwd), `layout()`, `props()`, `theme()`,
  `shared("space.colors")`, `shared("space-folders")`.
- `run`: `layout.select`, `pane.focus`, `agent.focus`, `tab.close`,
  `pane.close`. `hc send`. `exec` runs `find`, `sh`, `tail`, `grep`, `sed`,
  `stat`, and `~/.local/bin/claude -p` (Haiku); `readTextFile`,
  `watchFolder`, `home()`. `InputState` + `Input` from `gpui-base`.
- Files: `main.js` (view, keys), `sessions.js` (incremental transcript
  reading, `warmth`, `activity`), `summary.js` (Haiku notes and recap),
  `extras.js` (ledger cost, context limits, git).
- `setBadge`, `ScrollHandle`, `TextView.markdown`, `cx.focus_handle()`.
- `layouts/live.json`: `layouts/corral.json` with corral-board → live-board,
  corral-view → live-view, corral-toggle → live-toggle.

## Watch out

- Herdr's terminal title for Claude Code is just "Claude Code", and
  `status_ms` is null: stamp status changes yourself.
- Claude Code 2.1.316 and later no longer write `ai-title` records; keep the
  fallbacks.
- Match `last-prompt`/title records anchored at the line's start: a message
  or a tool's output can hold the same words. Assistant and api-request
  records start with `{"parentUuid"`, not `{"type"`: grep their type
  anywhere, drop `"isSidechain":true`, and JSON-parse to be sure.
- Assistant records split one reply into several lines (text, tool_use,
  thinking): keep only those with a text block.
- `last-prompt` holds about the first 200 characters of the prompt.
- The first `last-prompt` can sit before the 4 MB tail: read the titles and
  the first prompt once from the whole file.
- `/clear` and `--resume` give the same pid another session id.
- The Haiku call needs `< /dev/null` (else claude waits 3s for stdin) and
  `HERDR_TITLE_CHILD=1` (else the herdr-title hook renames a tab after it).
  It costs a call per stopped turn; nothing is sent while an agent works.
- "Stuck" is a guess: a long build or a background shell with no output looks
  the same.
- Buttons and the reply box stop propagation on mouse down and click, or the
  card under them takes the click and focuses the agent.
- The reply box is one `InputState` made in `init`, moved between cards.
- `panes()` items are keyed by `pane`, not `id`.
- Focus moves only from a task: render wakes a waiting one when the board
  comes into view. A text box that disappears while focused sends no blur:
  the board holding the keyboard clears the typing set.
- `hc` reports "done" as its own status; `hc send --if` takes only idle or working.
- A read can catch a line half written: stop at the last newline and start
  there next time, or the record is lost.
- Claude Code stays "working" while a background shell runs, with nothing
  written for an hour: don't call that stuck.
- A repo with thousands of untracked files (unignored build output) would
  shout on every card.

## Done when

- A Claude agent shows in its project's lane, moves 空闲 → 工作中 → 刚做完 /
  需要你 by itself, and leaves when its terminal closes.
- A blocked agent shows in the alert strip with its question; a click jumps to it.
- A stopped agent gets a "进度" note within a minute; the cache chip counts down.
- 回复 on an idle card sends the text to that terminal and closes the box.
- Folding a lane survives a restart.
- 完成 closes the agent's tab (alone in it) or its pane (sharing the tab).
