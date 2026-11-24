#!/usr/bin/python3
"""Names a Claude Code session in its terminal's title, so Herdr's agents list shows a name per pane.

Claude Code (2.1.316 and later) leaves the title at "Claude Code". On the first prompt this sets a
stand-in (the prompt's start) at once, then asks Haiku for a short title in the background. A name
given with /rename wins. Each prompt and each start (resume) writes the title again.

Hooks: UserPromptSubmit and SessionStart in ~/.claude/settings.json. Prints nothing: a
UserPromptSubmit hook's output would reach the model.
"""
import json
import os
import re
import subprocess
import sys
import time

CLAUDE = os.path.expanduser("~/.local/bin/claude")
TITLES = os.path.expanduser("~/.claude/herdr-titles")
MAX = 24
ASK = "给下面这条消息起一个不超过12个字的标题，用消息的语言，只输出标题本身，不要引号和标点：\n\n"


def tty_of_claude():
    """The terminal Claude runs in. A hook has no terminal of its own; its parents do."""
    pid = os.getppid()
    for _ in range(6):
        out = subprocess.run(["ps", "-o", "ppid=,tty=", "-p", str(pid)], capture_output=True, text=True).stdout.split()
        if len(out) < 2:
            return None
        if out[1] not in ("??", "?", "-"):
            return "/dev/" + out[1]
        pid = int(out[0])
    return None


def clean(s, cap=MAX):
    s = re.sub(r"[\x00-\x1f\x7f]", " ", s or "")
    s = " ".join(s.split()).strip(" \"'“”‘’「」.。")
    return s[:cap] + "…" if len(s) > cap else s


def put(tty, title):
    if not tty or not title:
        return
    try:
        with open(tty, "w") as f:
            f.write("\033]2;%s\007" % title)
    except OSError:
        pass


def custom_title(transcript):
    """The newest /rename name in the transcript, if any. Anchored: tool output can hold the same words."""
    if not transcript or not os.path.exists(transcript):
        return None
    out = subprocess.run(["grep", "-E", '^\\{"type":"custom-title"', transcript], capture_output=True, text=True).stdout
    for line in reversed(out.splitlines()):
        try:
            return clean(json.loads(line).get("customTitle"))
        except ValueError:
            continue
    return None


def generate(tty, path, prompt):
    """In a detached child: ask Haiku, keep and show its title. The stand-in stays if it fails."""
    if os.fork():
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    try:
        env = dict(os.environ, HERDR_TITLE_CHILD="1")
        r = subprocess.run([CLAUDE, "-p", "--model", "haiku", "--no-session-persistence", "--strict-mcp-config",
                            "--max-turns", "1", ASK + prompt[:2000]],
                           capture_output=True, text=True, timeout=60, env=env, cwd="/tmp")
        title = clean((r.stdout.strip().splitlines() or [""])[0])
        if r.returncode == 0 and title:
            with open(path, "w") as f:
                f.write(title)
            put(tty, title)
    except Exception:
        pass
    finally:
        try:
            os.remove(path + ".pending")
        except OSError:
            pass
    os._exit(0)


def main():
    if os.environ.get("HERDR_TITLE_CHILD"):
        return
    data = json.load(sys.stdin)
    sid = data.get("session_id")
    tty = tty_of_claude()
    if not sid or not tty:
        return
    os.makedirs(TITLES, exist_ok=True)
    path = os.path.join(TITLES, sid)

    named = custom_title(data.get("transcript_path"))
    if named:
        put(tty, named)
        return
    if os.path.exists(path):
        with open(path) as f:
            put(tty, f.read().strip())
        return
    if data.get("hook_event_name") != "UserPromptSubmit":
        return

    # Messages from another terminal (hc send) arrive wrapped: <hc from="t8">…</hc>.
    prompt = re.sub(r"</?hc\b[^>]*>", "", data.get("prompt") or "").strip()
    if not prompt or prompt.startswith("/"):
        return
    put(tty, clean(prompt, 20))
    lock = path + ".pending"
    try:
        os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        # Another prompt is asking already, unless that ask died long ago.
        if time.time() - os.path.getmtime(lock) < 120:
            return
        os.utime(lock)
    generate(tty, path, prompt)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
