# Declare OS

A desktop OS in the browser — windows, a magnifying dock, menus, apps — written
entirely in [Declare](https://davidtemkin.github.io/declarelang/), that a local
LLM agent can rewrite while you use it. Ask for an app ("make a pomodoro
timer") or a change to the OS itself ("make the dock icons smaller"); a
[pi](https://github.com/earendil-works/pi) agent running the local Strata model edits the
Declare source, the bridge verifies it, and the OS reloads live.

```
npm install
npm start            # → http://127.0.0.1:8850/shell.declare (bound to 0.0.0.0, so http://<lan-ip>:8850 works too)
```

Needs Strata serving `qwen3.8-flash-next-iq3_s` on 127.0.0.1:8080 (pi provider
`strata`), set up with images on (`--vision gpu`) and `"input": ["text", "image"]`
on its entry in `~/.pi/agent/models.json`, so the agent can see its apps. Press **⌘J / Ctrl+J**, click ✦ in the dock, or the ✦ in the corner
to open the assistant.

## How it is put together

```
shell.declare        the host page (Declare). Never edited by the agent:
                       hosts the OS in an AppIsland, the assistant panel,
                       Undo, and the "last change broke the desktop" notice
os/                  the agent's workspace — one commit per turn, history in
                       state/os.git
  AGENTS.md            the agent's instructions (OS map + Declare cheat sheet)
  desktop.declare      the OS root: wallpaper, menu bar, windows layer, dock
  system/*.declare     window manager + launcher, window chrome, dock
  apps.json            the app registry (dock + Apps menu)
  apps/<id>/<id>.declare   one program per app (calculator, clock, todo, …)
server/agent.mjs     the bridge: pi --mode rpc ↔ chat over SSE, verify,
                       auto-repair, commit, undo, factory reset, app store
server/start.mjs     runs the bridge (8851) + the Declare dev server (8850,
                       proxying /api to the bridge)
state/               not checked in: os/'s turn-by-turn history (os.git), the
                       saved chats (chats/) and their pi sessions (sessions/),
                       the undo stack, and app data saved through /api/store
```

**A turn**: the shell POSTs `/api/prompt`; the bridge snapshots `os/` with git
and hands the prompt to pi (working in `os/`, with `os/AGENTS.md` as its system
prompt). pi's events stream back over `/api/events` as small chat operations.
When pi settles, the bridge runs `declare-verify` on the desktop (if any OS file
moved), on each app whose folder moved, and checks `apps.json`. Failures go back
to the agent to fix (twice at most). Once it verifies, the bridge takes a
picture of each changed app at its window size (`server/look.mjs`, headless
Chrome) and has the agent read it and fix anything visibly wrong — cut off,
blank, overlapping, unreadable — skipping apps the agent already looked at
since its last edit. The agent can take the same pictures itself with
`node ../server/look.mjs <app-id>`. Then it commits and bumps the revision; the
shell remounts the OS with that revision in its program name, so it is fetched
fresh. If the desktop itself fails to verify, the revision is not bumped — the
last good OS keeps running, and the panel offers Undo.

**What reloads**: a change that touched only apps (`apps/…`, `apps.json`)
doesn't reload the page — the OS reopens those apps' open windows in place, at
the same spot and size, on the new code (state inside them starts fresh unless
the app saves it). Any other change reloads the page, and the OS puts back the
windows it had open (it keeps them in the tab's sessionStorage, so a manual
refresh restores them too).

**Chats** are all kept: **History** in the panel lists them, and opening one
brings back its transcript and the agent's own memory of it (its pi session).

**Undo** reverts the last agent turn as new commits; **factory reset**
(`POST /api/factory`) restores the tree at the `factory` tag — on a fresh
checkout, whatever `os/` held when the bridge first started (`AGENTS.md` is
kept as it is). To make the OS you have now the new baseline, commit `os/` here
and run `git --git-dir=state/os.git tag -f factory HEAD`.

Environment: `PI_PROVIDER`, `PI_MODEL` (default `strata` /
`qwen3.8-flash-next-iq3_s`), `PI_EXTENSIONS=1` to let pi load your extensions
and MCP servers, `LOOK=0` to skip the post-turn pictures, `CHROME` (path to
Chrome, if it isn't in `~/.cache/puppeteer`), `DECLARE_URL`, `AGENT_PORT`, `STRATA_HEALTH`.

The window chrome, dock and wallpaper are adapted from the Declare distro's
desktop example (`apps/desktop/desktop.declare`, MIT).
