// Starts both halves: the agent bridge (pi ↔ chat, port 8851) and the
// Declare dev server (compiles the shell, the OS and its apps on request,
// port 8850, proxying /api to the bridge). Ctrl+C stops both.

import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const kids = [
  spawn("node", [path.join(ROOT, "server/agent.mjs")], { cwd: ROOT, stdio: "inherit" }),
  spawn("node", [path.join(ROOT, "node_modules/declarelang/server/index.mjs")], { cwd: ROOT, stdio: "inherit" }),
];
const stop = () => { for (const k of kids) k.kill("SIGTERM"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const k of kids) k.on("exit", (code) => { console.error(`a server exited (${code}); stopping`); stop(); });
setTimeout(() => console.log("\n  Declare OS → http://127.0.0.1:8850/shell.declare  (also on your LAN address)\n"), 1500);
