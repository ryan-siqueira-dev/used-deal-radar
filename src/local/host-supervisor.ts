import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";

const root = await realpath(process.cwd());
const directory = join(root, ".runtime");
const path = join(directory, "host.sock");
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);

// Abstract sockets release ownership on process exit, even after SIGKILL.
// Only the lock owner can replace a stale filesystem control socket.
const lock = createServer((socket) => socket.destroy());
const lockName = `\0ai-deal-finder-${createHash("sha256").update(root).digest("hex")}`;
const owned = await new Promise<boolean>((resolve, reject) => {
  lock.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
  lock.listen(lockName, () => resolve(true));
});
if (!owned) process.exit(0);

await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
const log = await open(join(directory, "host.log"), "a", 0o600);
await log.chmod(0o600);
let ready = false;
let stopping = false;
const waiters = new Set<Socket>();
const status = () => ({
  state: stopping ? "stopped" : ready ? "running" : "starting",
  url: `http://127.0.0.1:${process.env.DASHBOARD_PORT ?? 3000}`,
  id: process.env.LOCAL_RUNTIME_ID,
});
let child: ChildProcess | undefined;
let forced: ReturnType<typeof setTimeout> | undefined;
function stop(): void {
  if (stopping) return;
  stopping = true;
  child?.kill("SIGTERM");
  forced = setTimeout(() => child?.kill("SIGKILL"), 30_000);
  forced.unref();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("SIGHUP", stop);
const server = createServer((socket) => {
  let input = "";
  socket.setTimeout(5000, () => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    input += String(chunk);
    if (input.length > 4096) return socket.destroy();
    if (!input.includes("\n")) return;
    try {
      const { command } = JSON.parse(input.split("\n")[0]!);
      if (command === "status") socket.end(`${JSON.stringify(status())}\n`);
      else if (command === "stop") { socket.setTimeout(0); waiters.add(socket); stop(); }
      else socket.destroy();
    } catch { socket.destroy(); }
  });
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
await chmod(path, 0o600);

child = fork(join(root, "dist/dashboard/index.js"), [], {
  cwd: root, env: process.env, stdio: ["ignore", log.fd, log.fd, "ipc"],
});
if (stopping) child.kill("SIGTERM");
child.on("message", (message) => {
  if (message && typeof message === "object" && "type" in message && message.type === "dashboard_ready") ready = true;
});
child.on("error", (error) => { void log.appendFile(`${error.message}\n`); });
child.once("exit", async () => {
  clearTimeout(forced);
  stopping = true;
  await unlink(path).catch(() => {});
  for (const socket of waiters) socket.end(`${JSON.stringify(status())}\n`);
  server.close();
  lock.close();
  await log.close();
});
