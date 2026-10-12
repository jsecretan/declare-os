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
`strata`). Press **⌘J / Ctrl+J**, click ✦ in the dock, or the ✦ in the corner
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
state/               not checked in: os/'s turn-by-turn history (os.git) and
                       app data saved through /api/store
```

**A turn**: the shell POSTs `/api/prompt`; the bridge snapshots `os/` with git
and hands the prompt to pi (working in `os/`, with `os/AGENTS.md` as its system
prompt). pi's events stream back over `/api/events` as small chat operations.
When pi settles, the bridge runs `declare-verify` on the desktop (if any OS file
moved), on each app whose folder moved, and checks `apps.json`. Failures go back
to the agent to fix (twice at most). Then it commits and bumps the revision; the
shell remounts the OS with that revision in its program name, so it is fetched
fresh. If the desktop itself fails to verify, the revision is not bumped — the
last good OS keeps running, and the panel offers Undo.

**Undo** reverts the last agent turn as new commits; **factory reset**
(`POST /api/factory`) restores the tree at the `factory` tag — on a fresh
checkout, whatever `os/` held when the bridge first started (`AGENTS.md` is
kept as it is). To make the OS you have now the new baseline, commit `os/` here
and run `git --git-dir=state/os.git tag -f factory HEAD`.

Environment: `PI_PROVIDER`, `PI_MODEL` (default `strata` /
`qwen3.8-flash-next-iq3_s`), `PI_EXTENSIONS=1` to let pi load your extensions
and MCP servers, `AGENT_PORT`, `STRATA_HEALTH`.

The window chrome, dock and wallpaper are adapted from the Declare distro's
desktop example (`apps/desktop/desktop.declare`, MIT).
