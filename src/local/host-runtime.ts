import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface RuntimeStatus {
  state: "running" | "starting" | "stopped";
  url: string;
  id?: string;
}

function missingSocket(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export class HostRuntime {
  constructor(private readonly root: string) {}

  async status(signal?: AbortSignal): Promise<Omit<RuntimeStatus, "id">> {
    const status = await this.readStatus(signal);
    return { state: status?.state ?? "stopped", url: status?.url ?? "http://127.0.0.1:3000" };
  }

  async start(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const existing = await this.readStatus(signal);
    if (existing?.state === "running") return;
    if (existing?.state === "stopped") throw new Error("O app local ainda está encerrando. Aguarde e tente novamente.");
    const id = randomUUID();
    let exited = false;
    let launched: ChildProcess | undefined;
    if (!existing) {
      await mkdir(join(this.root, ".runtime"), { recursive: true, mode: 0o700 });
      const child = spawn(process.execPath, [join(this.root, "dist/local/host-supervisor.js")], {
        cwd: this.root, env: { ...env, LOCAL_RUNTIME_ID: id }, detached: true, stdio: "ignore",
      });
      launched = child;
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      child.on("exit", () => { exited = true; });
      child.unref();
    }
    const started = Date.now();
    try {
      while (Date.now() - started < 120_000) {
        signal?.throwIfAborted();
        const current = await this.readStatus(signal);
        if (current?.state === "running") return;
        if (!current && exited && Date.now() - started > 1000) {
          throw new Error("O app local encerrou durante a inicialização. Consulte .runtime/host.log.");
        }
        await delay(100, undefined, signal ? { signal } : {});
      }
      throw new Error("O app local não ficou pronto. Consulte .runtime/host.log.");
    } catch (error) {
      // Cancel only a runtime started by this invocation, never a concurrent caller's app.
      const current = await this.readStatus().catch(() => null);
      if (current?.id === id) await this.stop().catch(() => {});
      else if (!current && launched && !exited) launched.kill("SIGTERM");
      throw error;
    }
  }

  async stop(signal?: AbortSignal): Promise<void> {
    const current = await this.readStatus(signal);
    if (!current) return;
    await this.request("stop", signal, 40_000);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      signal?.throwIfAborted();
      if (!await this.readStatus(signal)) return;
      await delay(50, undefined, signal ? { signal } : {});
    }
    throw new Error("O processo local ainda está encerrando.");
  }

  async logs(signal?: AbortSignal): Promise<void> {
    await stat(join(this.root, ".runtime/host.log"));
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tail", ["-n", "60", "-F", join(this.root, ".runtime/host.log")], { stdio: ["ignore", "inherit", "inherit"] });
      const cancel = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      child.once("error", reject);
      child.once("close", (code) => {
        signal?.removeEventListener("abort", cancel);
        if (code === 0 || signal?.aborted) resolve();
        else reject(new Error("Não foi possível acompanhar .runtime/host.log."));
      });
    });
  }

  private async readStatus(signal?: AbortSignal): Promise<RuntimeStatus | null> {
    try { return await this.request("status", signal); }
    catch (error) { if (missingSocket(error)) return null; throw error; }
  }

  private request(command: "status" | "stop", signal?: AbortSignal, timeout = 3000): Promise<RuntimeStatus> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const socket = createConnection(join(this.root, ".runtime/host.sock"));
      let data = "";
      let settled = false;
      const finish = (error?: unknown, status?: RuntimeStatus) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(status!);
      };
      const abort = () => finish(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      socket.setTimeout(timeout, () => finish(new Error("O socket de controle local não respondeu.")));
      socket.once("connect", () => socket.write(`${JSON.stringify({ command })}\n`));
      socket.on("data", (chunk) => {
        data += String(chunk);
        if (data.length > 4096) return finish(new Error("Resposta inválida do socket de controle."));
        if (!data.includes("\n")) return;
        try {
          const status = JSON.parse(data.split("\n")[0]!);
          if (!["running", "starting", "stopped"].includes(status.state) || typeof status.url !== "string") throw new Error();
          finish(undefined, status);
        } catch { finish(new Error("Resposta inválida do socket de controle.")); }
      });
      socket.once("error", finish);
      socket.once("end", () => finish(new Error("O socket de controle local encerrou sem resposta.")));
      socket.once("close", () => finish(new Error("O socket de controle local encerrou sem resposta.")));
    });
  }
}
