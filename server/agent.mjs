// The agent bridge: one long-lived `pi --mode rpc` process working in os/,
// its event stream turned into chat operations the shell applies, and the
// bookkeeping around each turn — a git snapshot before, verification after
// (with automatic repair), a look at each changed app (a picture the model
// checks, and fixes what it sees), a commit, and a revision bump that tells
// the shell to remount the OS.
//
// HTTP surface (proxied from the Declare dev server under /api):
//   GET  /api/events            SSE: {op:"reset"|"push"|"append"|"patch"|"state", …}
//   POST /api/prompt  {text}    start a turn
//   POST /api/abort             stop the running turn
//   POST /api/undo              revert the last agent change
//   POST /api/factory           restore the OS to its first commit
//   POST /api/newchat {app?, title?}  fresh agent session + empty transcript (for an app: scoped to it)
//   POST /api/chats/open {id}   go back to a saved chat (its transcript and its pi session)
//   POST /api/chats/forapp {app, title}  the chat attached to one app's window (its latest, else
//                               a new one); app "" goes back to the latest general chat
//   POST /api/chats/delete {id} forget a saved chat
//   GET|PUT /api/store/<app>/<key>   a tiny JSON store for apps

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

import { look } from "./look.mjs";

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OS = path.join(ROOT, "os");
const STATE = path.join(ROOT, "state");
const STORE = path.join(STATE, "store");
const VERIFY = path.join(ROOT, "node_modules/declarelang/tools/verify.mjs");

const PORT = +(process.env.AGENT_PORT || 8851);
const PROVIDER = process.env.PI_PROVIDER || "strata";
const MODEL = process.env.PI_MODEL || "qwen3.8-flash-next-iq3_s";
const STRATA_HEALTH = process.env.STRATA_HEALTH || "http://127.0.0.1:8080/health";
const MAX_REPAIRS = 2;
// after a clean verify, take pictures of the changed apps and let the model
// check them once (LOOK=0 turns it off; it needs an image-capable model)
const LOOK = process.env.LOOK !== "0";
const MAX_LOOKS = 3;   // apps pictured per turn

const CHATS = path.join(STATE, "chats");
const SESSIONS = path.join(STATE, "sessions");
const UNDO = path.join(STATE, "undo.json");
fs.mkdirSync(STORE, { recursive: true });
fs.mkdirSync(CHATS, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });

// ── git: os/ has its own history; every agent turn is a commit ──────────
// The history lives in state/os.git (outside os/), so os/ stays plain files
// in the project's own repository. A fresh checkout starts it from whatever
// os/ holds, and that first commit is the factory state.

const OS_GIT = path.join(STATE, "os.git");
async function git(...args) {
  const { stdout } = await run("git", ["--git-dir", OS_GIT, "--work-tree", OS, ...args], { cwd: OS, maxBuffer: 16 << 20 });
  return stdout.trim();
}
async function ensureRepo() {
  if (!fs.existsSync(OS_GIT)) {
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Declare OS");
    await git("config", "user.email", "os@localhost");
    await git("add", "-A");
    await git("commit", "-q", "-m", "factory: the base OS");
    await git("tag", "factory");
  }
}
async function dirty() { return (await git("status", "--porcelain")) !== ""; }
async function head() { return git("rev-parse", "HEAD"); }
async function commitAll(msg) {
  if (!(await dirty())) return false;
  await git("add", "-A");
  await git("commit", "-q", "-m", msg.slice(0, 200));
  return true;
}

// ── the transcript and its subscribers ──────────────────────────────────

const state = {
  blocks: [],            // { id, kind: user|assistant|thinking|tool|system, text, name?, status?, output? }
  busy: false,
  rev: 1,                // the shell remounts the OS when this moves
  scope: "os",           // what the last move touched: "os" (reload the page) or "apps" (reopen their windows)
  changed: [],           // with scope "apps": the ids of the apps that changed
  broken: "",            // the desktop's verification failure, "" when it is sound
  model: "unknown",      // ready | asleep | loading | offline
  canUndo: false,
};
let seq = 0;
const clients = new Set();

function send(res, msg) { res.write(`data: ${JSON.stringify(msg)}\n\n`); }
function broadcast(msg) { for (const c of clients) send(c, msg); }
function stateMsg() {
  return { op: "state", busy: state.busy, rev: state.rev, scope: state.scope, changed: state.changed,
    broken: state.broken, model: state.model, canUndo: state.canUndo };
}
function pushBlock(b) {
  foldThinking();
  const block = { id: "b" + ++seq, text: "", ...b };
  state.blocks.push(block);
  broadcast({ op: "push", block });
  saveSoon();
  return state.blocks.length - 1;
}
function patchBlock(i, fields) {
  flushAppends();
  Object.assign(state.blocks[i], fields);
  broadcast({ op: "patch", i, fields });
  saveSoon();
}
// a thinking block streams open; anything after it folds it to "Thought"
function foldThinking() {
  const i = state.blocks.length - 1;
  if (i >= 0 && state.blocks[i].kind === "thinking" && state.blocks[i].status !== "done") patchBlock(i, { status: "done" });
}
function system(text) { flushAppends(); return pushBlock({ kind: "system", text }); }
function setState(fields) { Object.assign(state, fields); broadcast(stateMsg()); }

// text deltas arrive per token; coalesce them to ~20 updates a second
const pending = new Map();   // block index → buffered text
let flushTimer = null;
function append(i, text) {
  state.blocks[i].text += text;
  pending.set(i, (pending.get(i) || "") + text);
  if (!flushTimer) flushTimer = setTimeout(flushAppends, 50);
}
function flushAppends() {
  clearTimeout(flushTimer);
  flushTimer = null;
  for (const [i, text] of pending) broadcast({ op: "append", i, text });
  if (pending.size) saveSoon();
  pending.clear();
}

// ── chats: every conversation is kept ───────────────────────────────────
// state/chats/<id>.json holds a chat's transcript and the pi session file it
// belongs to, so going back to a chat brings back the agent's memory of it
// too. state/chats/index.json names the open one; a restart resumes it.
// A chat opened from an app window's ✦ belongs to that app (`app`, its id):
// its prompts tell the agent to stay inside the app, and whatever a turn
// changes outside it is put back.

const chat = { id: "", title: "", created: 0, updated: 0, sessionFile: "", app: "", appTitle: "" };
const chatFile = (id) => path.join(CHATS, id + ".json");
const newChatId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);

function readChat(id) {
  try { return JSON.parse(fs.readFileSync(chatFile(id), "utf8")); } catch { return null; }
}
function saveChat() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!chat.id || state.blocks.length === 0) return;   // an empty chat is not worth keeping
  chat.updated = Date.now();
  fs.writeFileSync(chatFile(chat.id), JSON.stringify({ ...chat, blocks: state.blocks }));
  fs.writeFileSync(path.join(CHATS, "index.json"), JSON.stringify({ current: chat.id }));
}
let saveTimer = null;
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(saveChat, 1000); }

function listChats() {
  const out = [];
  for (const f of fs.readdirSync(CHATS)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    const c = readChat(f.slice(0, -5));
    if (c) out.push({ id: c.id, title: c.title || "Untitled chat", updated: c.updated, count: (c.blocks || []).filter((b) => b.kind === "user").length, app: c.app || "", appTitle: c.appTitle || "" });
  }
  if (chat.id && !out.some((c) => c.id === chat.id) && state.blocks.length) out.push({ id: chat.id, title: chat.title, updated: Date.now(), count: 1, app: chat.app, appTitle: chat.appTitle });
  return out.sort((a, b) => b.updated - a.updated);
}
function chatsMsg() { return { op: "chats", current: chat.id, app: chat.app, appTitle: chat.appTitle, chats: listChats() }; }
function announceChats() { broadcast(chatsMsg()); }

function beginChat(app = "", appTitle = "") {
  Object.assign(chat, { id: newChatId(), title: "", created: Date.now(), updated: Date.now(), sessionFile: "", app, appTitle });
  state.blocks = [];
  seq = 0;
}
// the chat to resume at startup: the last open one, else a fresh one
function resumeChat() {
  let cur = null;
  try { cur = readChat(JSON.parse(fs.readFileSync(path.join(CHATS, "index.json"), "utf8")).current); } catch {}
  if (!cur) { beginChat(); return; }
  Object.assign(chat, { id: cur.id, title: cur.title || "", created: cur.created || Date.now(), updated: cur.updated || Date.now(), sessionFile: cur.sessionFile || "", app: cur.app || "", appTitle: cur.appTitle || "" });
  state.blocks = cur.blocks || [];
  seq = state.blocks.reduce((n, b) => Math.max(n, +String(b.id).slice(1) || 0), 0);
}
// after pi starts or changes session: remember which file this chat lives in
async function noteSession() {
  const r = await command({ type: "get_state" });
  if (r.success && r.data?.sessionFile) chat.sessionFile = r.data.sessionFile;
}

// ── pi ──────────────────────────────────────────────────────────────────

let pi = null;
let cmdSeq = 0;
const waiting = new Map();   // command id → resolve

function systemPrompt() {
  return fs.readFileSync(path.join(OS, "AGENTS.md"), "utf8");
}

function startPi() {
  const args = [
    "--mode", "rpc", "--session-dir", SESSIONS,
    "--provider", PROVIDER, "--model", MODEL,
    "--no-context-files", "--no-skills", "--no-prompt-templates",
    "--append-system-prompt", systemPrompt(),
  ];
  if (!process.env.PI_EXTENSIONS) args.push("--no-extensions", "--no-mcp");
  // the open chat's session, so the agent remembers it (else pi starts a new one)
  if (chat.sessionFile && fs.existsSync(chat.sessionFile)) args.push("--session", chat.sessionFile);
  pi = spawn("pi", args, { cwd: OS, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  let buf = "";
  pi.stdout.setEncoding("utf8");
  pi.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {   // records split on LF only (never readline)
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      onRecord(rec);
    }
  });
  pi.stderr.setEncoding("utf8");
  pi.stderr.on("data", (d) => process.stderr.write("[pi] " + d));
  pi.on("exit", (code) => {
    pi = null;
    if (state.busy) { system(`The agent process exited (code ${code}).`); finishTurn(true); }
  });
}

function command(cmd) {
  if (!pi) { startPi(); if (cmd.type !== "get_state") noteSession(); }
  const id = "c" + ++cmdSeq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    pi.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
  });
}

// per assistant message: content index → transcript block
let blockOf = new Map();
const toolBlock = new Map();  // toolCallId → transcript block

// ── tool calls, told in the user's terms ─────────────────────────────────
// The person at the panel is using an OS, not reading its source: "Changing
// the Clock app", not `edit apps/clock/clock.declare`.

function appLabels() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(OS, "apps.json"), "utf8"));
    return Object.fromEntries((reg.apps || []).map((a) => [a.id, a.label || a.title || a.id]));
  } catch { return {}; }
}
function rel(p) {
  if (!p) return "";
  p = String(p).replace(/^["']|["']$/g, "");
  if (path.isAbsolute(p)) p = path.relative(OS, p);
  return p.replace(/^\.\//, "");
}
const SYSTEM_PARTS = {
  "desktop.declare": "the desktop",
  "system/dock.declare": "the dock",
  "system/windows.declare": "the windows",
  "system/model.declare": "the app launcher",
  "apps.json": "the app list",
  "AGENTS.md": "its notes",
};
// what a file is, to the person using the OS
function thing(p) {
  p = rel(p);
  const m = p.match(/^apps\/([^/]+)/);
  if (m) {
    const label = appLabels()[m[1]] || m[1].replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
    return `the ${label} app`;
  }
  if (SYSTEM_PARTS[p]) return SYSTEM_PARTS[p];
  if (p.startsWith("..") || p.includes("node_modules/declarelang")) return "the Declare guide";
  if (p === "" || p === "." || p === "apps") return "the system";
  return "the system";
}
function bashTarget(cmd) {
  const f = cmd.match(/(?:\.\.\/|\/)?[\w./-]*\.(?:declare|json|md)\b/);
  return f ? thing(f[0]) : /\bapps\b/.test(cmd) ? "the apps" : "the system";
}
function pictureOf(s) {
  const m = String(s || "").match(/looks\/(\w[\w-]*)\.png|look\.mjs\s+(\w[\w-]*)/);
  return m ? thing(`apps/${m[1] || m[2]}/`) : null;
}
function describe(name, a = {}) {
  if (name === "read" && pictureOf(a.path)) return "Checking how " + pictureOf(a.path) + " looks";
  if (name === "bash" && /look\.mjs/.test(a.command || "")) return "Taking a picture of " + (pictureOf(a.command) || "the app");
  if (name === "read") return "Looking at " + thing(a.path);
  if (name === "edit") return "Changing " + thing(a.path);
  if (name === "write") {
    const exists = a.path && fs.existsSync(path.resolve(OS, rel(a.path)));
    return (exists ? "Rewriting " : "Creating ") + thing(a.path);
  }
  if (name === "bash") {
    const c = a.command || "";
    if (/declare-verify|verify\.mjs/.test(c)) return "Testing " + bashTarget(c);
    if (/declare-help/.test(c)) return "Looking something up in the Declare guide";
    if (/^\s*(ls|cat|head|tail|grep|rg|find|sed -n|wc|tree)\b/.test(c)) return "Looking through " + bashTarget(c);
    if (/^\s*(mkdir|cp|mv)\b/.test(c)) return "Setting up files";
    return "Running a quick task";
  }
  if (name === "grep" || name === "find" || name === "ls") return "Looking through " + (a.path ? thing(a.path) : "the system");
  return "Working";
}
function summaryOf(files) {
  const names = [...new Set(files.map(thing))];
  if (names.length <= 1) return names[0] || "the system";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function onRecord(r) {
  if (r.type === "response") {
    const done = waiting.get(r.id);
    if (done) { waiting.delete(r.id); done(r); }
    return;
  }
  switch (r.type) {
    case "message_start":
      if (r.message?.role === "assistant") blockOf = new Map();
      break;
    case "message_update": {
      const e = r.assistantMessageEvent || {};
      const ci = e.contentIndex;
      if (e.type === "text_start") blockOf.set(ci, pushBlock({ kind: "assistant" }));
      else if (e.type === "thinking_start") blockOf.set(ci, pushBlock({ kind: "thinking" }));
      else if (e.type === "thinking_end") { if (blockOf.has(ci)) patchBlock(blockOf.get(ci), { status: "done" }); }
      else if (e.type === "text_delta" || e.type === "thinking_delta") {
        if (!blockOf.has(ci)) blockOf.set(ci, pushBlock({ kind: e.type === "text_delta" ? "assistant" : "thinking" }));
        append(blockOf.get(ci), e.delta || "");
      }
      break;
    }
    case "message_end": {
      const m = r.message || {};
      if (m.role === "assistant" && m.stopReason === "aborted") break;
      if (m.role === "assistant" && (m.stopReason === "error" || m.errorMessage))
        system("Model error: " + (m.errorMessage || "unknown"));
      flushAppends();
      break;
    }
    case "tool_execution_start": {
      if (turn) noteLook(r.toolName, r.args || {});
      const text = describe(r.toolName, r.args);
      // the same step again right after itself ("Looking at the dock", twice) is one line
      const last = state.blocks.length - 1;
      const prev = state.blocks[last];
      if (prev && prev.kind === "tool" && prev.text === text && prev.status !== "running") {
        patchBlock(last, { status: "running" });
        toolBlock.set(r.toolCallId, last);
      } else toolBlock.set(r.toolCallId, pushBlock({ kind: "tool", name: r.toolName, text, status: "running" }));
      break;
    }
    case "tool_execution_end": {
      const i = toolBlock.get(r.toolCallId);
      toolBlock.delete(r.toolCallId);
      if (i == null) break;
      const b = state.blocks[i];
      // only a failed test is news to the person; a search that found nothing isn't
      if (r.isError && b.text.startsWith("Testing ")) patchBlock(i, { status: "error", text: b.text + " — found something to fix" });
      else patchBlock(i, { status: r.isError && r.toolName !== "bash" ? "error" : "ok" });
      break;
    }
    case "auto_retry_start":
      system(`Retrying (attempt ${r.attempt}/${r.maxAttempts}): ${r.errorMessage || ""}`);
      break;
    case "compaction_start":
      system("Compacting the conversation to fit the model's context…");
      break;
    case "agent_settled":
      flushAppends();
      afterTurn(r.aborted).catch((e) => { system("Post-turn check failed: " + e.message); finishTurn(false); });
      break;
    case "extension_ui_request":
      // no UI to answer with: decline so the agent never blocks
      if (pi) pi.stdin.write(JSON.stringify({ type: "extension_ui_response", id: r.id, cancelled: true }) + "\n");
      break;
  }
}

// ── a turn ──────────────────────────────────────────────────────────────

let turn = null;   // { prompt, before, repairs }
const undoStack = [];

async function startTurn(text) {
  if (state.busy) return { ok: false, error: "busy" };
  setState({ busy: true });
  if (!chat.title) { chat.title = text.length > 60 ? text.slice(0, 57).trimEnd() + "…" : text; }
  pushBlock({ kind: "user", text });
  saveChat();
  announceChats();
  try {
    if (await commitAll("manual edits")) system("Saved your manual edits as a snapshot first.");
    turn = { prompt: text, before: await head(), repairs: 0, looked: false, seen: new Set() };
    const r = await command({ type: "prompt", message: chat.app ? scopeNote() + text : text });
    if (!r.success) { system("The agent refused the prompt: " + r.error); finishTurn(false); }
    else if (r.data?.disposition === "handled") finishTurn(false);
  } catch (e) {
    system("Could not start the agent: " + e.message);
    finishTurn(false);
  }
  return { ok: true };
}

// what to check: the desktop when anything of the OS moved, each app whose
// folder moved, and the registry
async function verifyChanged(before) {
  const changed = (await git("diff", "--name-only", before)).split("\n")
    .concat((await git("ls-files", "--others", "--exclude-standard")).split("\n"))
    .filter(Boolean);
  const problems = [];
  let desktopBad = "";
  const targets = new Set();
  for (const f of changed) {
    const m = f.match(/^apps\/([^/]+)\//);
    if (m) { const main = `apps/${m[1]}/${m[1]}.declare`; if (fs.existsSync(path.join(OS, main))) targets.add(main); }
    else if (f.endsWith(".declare")) targets.add("desktop.declare");
  }
  if (changed.includes("apps.json")) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(OS, "apps.json"), "utf8"));
      const ids = new Set();
      for (const a of reg.apps || []) {
        if (!a.id || !a.label || !a.title || !a.kind) problems.push(`apps.json: app ${JSON.stringify(a.id)} needs id, label, title and kind`);
        if (ids.has(a.id)) problems.push(`apps.json: duplicate id "${a.id}"`);
        ids.add(a.id);
        if (a.kind === "program") {
          const main = (a.program || "") + ".declare";
          if (!a.program || !fs.existsSync(path.join(OS, main))) problems.push(`apps.json: app "${a.id}" names program "${a.program}", but ${main} does not exist`);
          else targets.add(main);
        }
      }
    } catch (e) { problems.push("apps.json is not valid JSON: " + e.message); }
  }
  for (const t of targets) {
    let out;
    try { out = (await run("node", [VERIFY, t], { cwd: OS, timeout: 120000, maxBuffer: 8 << 20 })).stdout; }
    catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
    if (!/clean through R4/.test(out)) {
      const lines = out.split("\n").filter((l) => /✗|DECLARE|hint|FAILED|line \d|:\d+:\d+/.test(l)).join("\n");
      problems.push(`${t}:\n${lines || out.slice(-1500)}`);
      if (t === "desktop.declare") desktopBad = lines || "the desktop does not compile";
    }
  }
  return { changed, problems, desktopBad, checked: [...targets] };
}

// what the agent reads ahead of each prompt in an app's chat (the person
// sees only their own words)
function scopeNote() {
  return `[This chat is attached to the ${chat.appTitle || chat.app} app's window. Change only that app: the files in apps/${chat.app}/ ` +
    `and its own entry in apps.json. Don't change the OS or any other app — if the request needs that, say so instead.]\n\n`;
}

// An app's chat changes only that app: anything else the turn touched is
// put back as it was before the turn (for apps.json: every entry but the
// app's own). Returns the files it put back.
async function confine(before, id) {
  const changed = (await git("diff", "--name-only", before)).split("\n")
    .concat((await git("ls-files", "--others", "--exclude-standard")).split("\n"))
    .filter(Boolean);
  const back = [];
  for (const f of changed) {
    if (f.startsWith(`apps/${id}/`)) continue;
    if (f === "apps.json") {
      let was, now;
      try { was = JSON.parse(await git("show", `${before}:apps.json`)); now = JSON.parse(fs.readFileSync(path.join(OS, f), "utf8")); }
      catch { await git("checkout", before, "--", f); back.push(f); continue; }
      const mine = (now.apps || []).find((a) => a.id === id);
      const kept = { ...was, apps: (was.apps || []).map((a) => (a.id === id && mine ? mine : a)) };
      if (JSON.stringify(kept) !== JSON.stringify(now)) {
        fs.writeFileSync(path.join(OS, f), JSON.stringify(kept, null, 2) + "\n");
        back.push(f);
      }
      continue;
    }
    let existed = true;
    try { await git("cat-file", "-e", `${before}:${f}`); } catch { existed = false; }
    if (existed) await git("checkout", before, "--", f);
    else fs.rmSync(path.join(OS, f), { force: true });
    back.push(f);
  }
  return back;
}

async function afterTurn(aborted) {
  if (!turn) { finishTurn(false); return; }
  if (!(await dirty())) { finishTurn(false); return; }
  if (chat.app) {
    const back = await confine(turn.before, chat.app);
    if (back.length) {
      console.log(`[scope] ${chat.app}: put back ${back.join(", ")}`);
      system(`This chat only changes the ${chat.appTitle || chat.app} app, so I put back the change to ${summaryOf(back)}.`);
      if (!(await dirty())) { finishTurn(false); return; }
    }
  }
  const v = await verifyChanged(turn.before);
  if (v.problems.length && !aborted && turn.repairs < MAX_REPAIRS) {
    turn.repairs++;
    system(`The change to ${summaryOf(v.changed)} doesn't work yet — fixing it (try ${turn.repairs} of ${MAX_REPAIRS}).`);
    const msg = "The OS verifier found these problems with your change. Fix them, then run `npx declare-verify` on each file again until it reports \"clean through R4\":\n\n" + v.problems.join("\n\n");
    const r = await command({ type: "prompt", message: msg });
    if (!r.success) { system("Repair prompt refused: " + r.error); await commitTurn(v); }
    return;
  }
  if (LOOK && !aborted && !turn.looked && !v.problems.length) {
    turn.looked = true;
    if (await lookAt(v)) return;
  }
  await commitTurn(v, aborted);
}

// which apps the agent has already seen a picture of since it last changed
// them — the post-turn look skips those
function noteLook(name, a) {
  const pic = String(a.path || "").match(/looks\/([\w-]+)\.png$/);
  if (name === "read" && pic) { turn.seen.add(pic[1]); return; }
  const f = rel(a.path || "").match(/^apps\/([^/]+)\//);
  if ((name === "edit" || name === "write") && f) turn.seen.delete(f[1]);
  // a shell command that could have changed files (not a look, a test or a read)
  else if (name === "bash" && !/look\.mjs|declare-verify|verify\.mjs|declare-help|^\s*(ls|cat|head|tail|grep|rg|find|sed -n|wc|tree)\b/.test(a.command || "")) turn.seen.clear();
}

// The program apps a change touched (new ones included), pictured at their
// window size; the model reads the pictures and fixes what it can see.
// Returns false when there is nothing to look at (or no way to), and the
// turn commits as it is.
async function lookAt(v) {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(path.join(OS, "apps.json"), "utf8")); } catch {}
  const programs = new Set((reg.apps || []).filter((a) => a.kind === "program").map((a) => a.id));
  const ids = [...new Set(v.changed.map((f) => (f.match(/^apps\/([^/]+)\//) || [])[1]).filter((id) => programs.has(id) && !turn.seen.has(id)))].slice(0, MAX_LOOKS);
  if (!ids.length) return false;
  const i = pushBlock({ kind: "tool", name: "look", text: "Checking how " + summaryOf(ids.map((id) => `apps/${id}/`)) + " looks", status: "running" });
  const shots = [];
  for (const id of ids) {
    try { shots.push(await look(id)); }
    catch (e) { console.log(`[look] ${id}: ${e.message}`); }
  }
  patchBlock(i, { status: "ok" });
  if (!shots.length) return false;
  const msg = "Your change verifies. Now check how it looks. Use the read tool on each picture below — each is the app exactly as it shows in its window — and look at it the way the person who asked would:\n" +
    "- is anything cut off, outside the window, or overlapping?\n- is any text unreadable (too small, too little contrast)?\n" +
    "- is anything blank or missing that the app should show, or misaligned?\n- does it look like what was asked for?\n\n" +
    shots.map((s) => `- ${s.title} (${s.width}×${s.height}): ${s.file}` + (s.errors.length ? `\n  errors while it loaded:\n  ${s.errors.join("\n  ")}` : "")).join("\n") +
    "\n\nFix only problems you can clearly see; matters of taste are not problems. After a fix, run declare-verify again, and you can take a new picture with `node ../server/look.mjs <app-id>` and read it. " +
    "End with one short sentence for the person about how it looks now.";
  const r = await command({ type: "prompt", message: msg });
  if (!r.success) { console.log("[look] prompt refused: " + r.error); return false; }
  return true;
}

// What a set of changed files means for the page: apps only (their open
// windows reopen in place) or the OS itself (the page reloads).
function scopeOf(files) {
  const ids = new Set();
  for (const f of files) {
    const m = f.match(/^apps\/([^/]+)\//);
    if (m) ids.add(m[1]);
    else if (f !== "apps.json" && f !== "AGENTS.md") return { scope: "os", changed: [] };
  }
  return { scope: "apps", changed: [...ids] };
}

function saveUndo() { try { fs.writeFileSync(UNDO, JSON.stringify(undoStack)); } catch {} }

async function commitTurn(v, aborted = false) {
  const label = (aborted ? "agent (stopped): " : "agent: ") + turn.prompt;
  await commitAll(label);
  undoStack.push({ before: turn.before, after: await head(), prompt: turn.prompt });
  saveUndo();
  console.log(`[turn] ${label} → ${v.changed.join(", ")}${v.problems.length ? "\n" + v.problems.join("\n") : ""}`);
  if (v.problems.length) system(`The change to ${summaryOf(v.changed)} still has a problem I couldn't fix. It's kept so you can try it — Undo takes it back.`);
  else system(`Done — updated ${summaryOf(v.changed)}.`);
  // a broken desktop is not remounted: the shell keeps the last good OS running
  if (v.desktopBad) finishTurn(false, { broken: v.desktopBad });
  else finishTurn(false, { rev: state.rev + 1, broken: "", ...scopeOf(v.changed) });
}

function finishTurn(_crashed, extra = {}) {
  turn = null;
  flushAppends();
  foldThinking();
  setState({ busy: false, canUndo: undoStack.length > 0, ...extra });
  saveChat();
}

async function undo() {
  if (state.busy) return { ok: false, error: "busy" };
  const last = undoStack.pop();
  if (!last) return { ok: false, error: "nothing to undo" };
  saveUndo();
  await commitAll("manual edits");
  const files = (await git("diff", "--name-only", last.before, last.after)).split("\n").filter(Boolean);
  await git("revert", "--no-edit", `${last.before}..${last.after}`);
  system(`Undid: “${last.prompt}”`);
  setState({ rev: state.rev + 1, broken: "", canUndo: undoStack.length > 0, ...scopeOf(files) });
  return { ok: true };
}

async function factory() {
  if (state.busy) return { ok: false, error: "busy" };
  // the `factory` tag marks the shipped OS (move it to adopt a new baseline)
  let root;
  try { root = await git("rev-parse", "-q", "--verify", "refs/tags/factory"); }
  catch { root = (await git("rev-list", "--max-parents=0", "HEAD")).split("\n")[0]; }
  await commitAll("manual edits");
  // AGENTS.md is the agent's instructions, not part of the OS: it survives a reset
  const notes = fs.readFileSync(path.join(OS, "AGENTS.md"), "utf8");
  await git("read-tree", "-u", "--reset", root);
  await git("clean", "-fdq");
  fs.writeFileSync(path.join(OS, "AGENTS.md"), notes);
  await commitAll("factory reset");
  undoStack.length = 0;
  saveUndo();
  system("Restored the OS to its factory state.");
  setState({ rev: state.rev + 1, broken: "", canUndo: false, scope: "os", changed: [] });
  return { ok: true };
}

async function newChat(app = chat.app, appTitle = chat.appTitle) {
  if (state.busy) return { ok: false, error: "busy" };
  if (state.blocks.length === 0) {                       // already a fresh one: just (re)scope it
    Object.assign(chat, { app, appTitle });
    announceChats();
    return { ok: true };
  }
  saveChat();
  if (pi) await command({ type: "new_session" });
  beginChat(app, appTitle);
  if (pi) await noteSession();
  broadcast({ op: "reset", blocks: [] });
  announceChats();
  return { ok: true };
}

async function openChat(id) {
  if (state.busy) return { ok: false, error: "busy" };
  if (id === chat.id) return { ok: true };
  const c = readChat(String(id));
  if (!c) return { ok: false, error: "no such chat" };
  saveChat();
  Object.assign(chat, { id: c.id, title: c.title || "", created: c.created, updated: c.updated, sessionFile: c.sessionFile || "", app: c.app || "", appTitle: c.appTitle || "" });
  state.blocks = c.blocks || [];
  seq = state.blocks.reduce((n, b) => Math.max(n, +String(b.id).slice(1) || 0), 0);
  if (pi) {
    if (chat.sessionFile && fs.existsSync(chat.sessionFile)) await command({ type: "switch_session", sessionPath: chat.sessionFile });
    else { await command({ type: "new_session" }); await noteSession(); }
  }
  fs.writeFileSync(path.join(CHATS, "index.json"), JSON.stringify({ current: chat.id }));
  broadcast({ op: "reset", blocks: state.blocks });
  announceChats();
  return { ok: true };
}

// the chat for one app's window: the one open if it is that app's, else its
// latest, else a new one; app "" is the general assistant
async function chatForApp(app, appTitle) {
  app = String(app || ""); appTitle = String(appTitle || "");
  if (app && !/^[\w-]+$/.test(app)) return { ok: false, error: "bad app id" };
  if (chat.app === app) {
    if (app && appTitle && chat.appTitle !== appTitle) { chat.appTitle = appTitle; announceChats(); }
    return { ok: true };
  }
  if (state.busy) return { ok: false, error: "busy" };
  const latest = listChats().find((c) => c.app === app && c.id !== chat.id);
  if (latest) return openChat(latest.id);
  return newChat(app, appTitle);
}

async function deleteChat(id) {
  id = String(id);
  if (!/^[\w-]+$/.test(id)) return { ok: false, error: "bad id" };
  if (id === chat.id) {
    if (state.busy) return { ok: false, error: "busy" };
    const sf = chat.sessionFile;
    try { fs.unlinkSync(chatFile(id)); } catch {}
    if (sf) try { fs.unlinkSync(sf); } catch {}
    state.blocks = [];
    await newChatAfterDelete();
  } else {
    const c = readChat(id);
    try { fs.unlinkSync(chatFile(id)); } catch {}
    if (c?.sessionFile && c.sessionFile.startsWith(SESSIONS)) try { fs.unlinkSync(c.sessionFile); } catch {}
  }
  announceChats();
  return { ok: true };
}
async function newChatAfterDelete() {
  if (pi) await command({ type: "new_session" });
  beginChat(chat.app, chat.appTitle);
  if (pi) await noteSession();
  broadcast({ op: "reset", blocks: [] });
}

// ── the model's health, for the panel's status dot ──────────────────────

async function pollModel() {
  let model = "offline";
  try {
    const r = await fetch(STRATA_HEALTH, { signal: AbortSignal.timeout(2500) });
    const h = await r.json();
    // Strata idles its engine down; the first request wakes it (1–3 min)
    model = h.status !== "ok" ? "loading" : h.loaded ? "ready" : (state.busy ? "loading" : "asleep");
  } catch {}
  if (model !== state.model) setState({ model });
}

// ── HTTP ────────────────────────────────────────────────────────────────

function body(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
const safe = (s) => /^[A-Za-z0-9_.-]{1,80}$/.test(s) && !s.startsWith(".");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write("retry: 1500\n\n");
      send(res, { op: "reset", blocks: state.blocks });
      send(res, stateMsg());
      send(res, chatsMsg());
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === "POST" && p === "/api/prompt") {
      const { text } = await body(req);
      if (!text || !String(text).trim()) return json(res, 400, { ok: false, error: "empty" });
      return json(res, 200, await startTurn(String(text).trim()));
    }
    if (req.method === "POST" && p === "/api/abort") { if (pi && state.busy) await command({ type: "abort" }); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/undo") return json(res, 200, await undo());
    if (req.method === "POST" && p === "/api/factory") return json(res, 200, await factory());
    if (req.method === "POST" && p === "/api/newchat") { const b = await body(req); return json(res, 200, await newChat(b.app ?? chat.app, b.title ?? chat.appTitle)); }
    if (req.method === "POST" && p === "/api/chats/forapp") { const b = await body(req); return json(res, 200, await chatForApp(b.app, b.title)); }
    if (req.method === "POST" && p === "/api/chats/open") return json(res, 200, await openChat((await body(req)).id));
    if (req.method === "POST" && p === "/api/chats/delete") return json(res, 200, await deleteChat((await body(req)).id));
    const m = p.match(/^\/api\/store\/([^/]+)\/([^/]+)$/);
    if (m && safe(m[1]) && safe(m[2])) {
      const file = path.join(STORE, m[1], m[2] + ".json");
      if (req.method === "GET") {
        if (!fs.existsSync(file)) return json(res, 200, null);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "PUT" || req.method === "POST") {
        const v = await body(req);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(v));
        return json(res, 200, v);
      }
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

await ensureRepo();
resumeChat();
try { undoStack.push(...JSON.parse(fs.readFileSync(UNDO, "utf8"))); state.canUndo = undoStack.length > 0; } catch {}
await pollModel();
setInterval(pollModel, 10000);
server.listen(PORT, "127.0.0.1", () => console.log(`agent bridge → http://127.0.0.1:${PORT}/api  (pi: ${PROVIDER}/${MODEL}, workspace: ${OS})`));
