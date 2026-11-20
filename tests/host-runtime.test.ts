import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRuntime } from "../src/local/host-runtime.js";

const dashboard = `
  import { existsSync } from "node:fs";
  if (process.env.TEST_FAIL === "1") throw new Error("fixture failed before listen");
  console.log("fixture started with local database:", process.env.DATABASE_URL === "test-database");
  const ready = setInterval(() => {
    if (process.env.TEST_READY && !existsSync(process.env.TEST_READY)) return;
    clearInterval(ready);
    process.send({type: "dashboard_ready"});
  }, 20);
  const alive = setInterval(() => {
    if (process.env.TEST_EXIT && existsSync(process.env.TEST_EXIT)) process.exit(2);
  }, 20);
  process.on("disconnect", () => process.exit(3));
  process.on("SIGTERM", () => {
    clearInterval(ready);
    clearInterval(alive);
    setTimeout(() => {
      console.log("fixture shut down");
      process.exit(0);
    }, 50);
  });
`;

const runtimeEnv = { ...process.env, DASHBOARD_PORT: "3245", DATABASE_URL: "test-database" };

describe("HostRuntime", () => {
  let root: string;
  let runtime: HostRuntime;
  let logPath: string;
  let socketPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "adf-host-"));
    runtime = new HostRuntime(root);
    logPath = join(root, ".runtime/host.log");
    socketPath = join(root, ".runtime/host.sock");
    await Promise.all([
      mkdir(join(root, "dist/local"), { recursive: true }),
      mkdir(join(root, "dist/dashboard"), { recursive: true }),
      writeFile(join(root, "package.json"), '{"type":"module"}'),
    ]);
    await Promise.all([
      ...["host-runtime", "host-supervisor"].map(async (name) => {
        const source = await readFile(new URL(`../src/local/${name}.ts`, import.meta.url), "utf8");
        const { outputText } = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        });
        await writeFile(join(root, "dist/local", `${name}.js`), outputText);
      }),
      writeFile(join(root, "dist/dashboard/index.js"), dashboard),
    ]);
  });

  afterEach(async () => {
    try { await runtime.stop(); }
    finally { await rm(root, { force: true, recursive: true }); }
  });

  it("waits for dashboard IPC readiness and acknowledges a graceful stop", async () => {
    expect((await runtime.status()).state).toBe("stopped");
    const readyFile = join(root, "ready");
    let started = false;
    const start = runtime.start({ ...runtimeEnv, TEST_READY: readyFile }).then(() => { started = true; });
    await vi.waitFor(async () => {
      expect(await runtime.status()).toEqual({ state: "starting", url: "http://127.0.0.1:3245" });
      expect(await readFile(logPath, "utf8")).toContain("fixture started with local database: true");
    });
    expect(started).toBe(false);
    await writeFile(readyFile, "");
    await start;
    expect(await runtime.status()).toEqual({ state: "running", url: "http://127.0.0.1:3245" });
    expect((await stat(join(root, ".runtime"))).mode & 0o777).toBe(0o700);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await runtime.stop();
    expect(await readFile(logPath, "utf8")).toContain("fixture shut down");
    expect((await runtime.status()).state).toBe("stopped");
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps one dashboard after concurrent controllers close", async () => {
    const caller = `import { HostRuntime } from "./dist/local/host-runtime.js";
      await new HostRuntime(process.cwd()).start(process.env);`;
    const controllers = [1, 2].map(() => spawn(process.execPath, ["--input-type=module", "-e", caller], {
      cwd: root, env: runtimeEnv, stdio: "inherit",
    }));
    const exits = await Promise.all(controllers.map((child) => once(child, "exit")));
    expect(exits).toEqual([[0, null], [0, null]]);
    expect((await runtime.status()).state).toBe("running");
    await runtime.start(runtimeEnv);
    expect((await readFile(logPath, "utf8")).match(/fixture started/g)).toHaveLength(1);
  });

  it.skipIf(process.platform !== "linux")("recovers a stale socket with competing starts", async () => {
    await mkdir(join(root, ".runtime"), { mode: 0o700 });
    const crash = spawn(process.execPath, ["--input-type=module", "-e", `
      import { chmodSync } from "node:fs";
      import { createServer } from "node:net";
      const path = process.argv[1];
      createServer().listen(path, () => {
        chmodSync(path, 0o600);
        console.log("created");
      });
    `, socketPath], { stdio: ["ignore", "pipe", "inherit"] });
    await once(crash.stdout!, "data");
    const exited = once(crash, "exit");
    crash.kill("SIGKILL");
    await exited;
    expect((await stat(socketPath)).isSocket()).toBe(true);
    expect((await runtime.status()).state).toBe("stopped");
    await Promise.all([runtime.start(runtimeEnv), new HostRuntime(root).start(runtimeEnv)]);
    expect((await runtime.status()).state).toBe("running");
    expect((await readFile(logPath, "utf8")).match(/fixture started/g)).toHaveLength(1);
  });

  it("reports a closed control connection without launching a dashboard", async () => {
    await mkdir(join(root, ".runtime"), { mode: 0o700 });
    const server = createServer((socket) => { socket.resume(); socket.end(); });
    try {
      server.listen(socketPath);
      await once(server, "listening");
      await chmod(socketPath, 0o600);
      await expect(runtime.start(runtimeEnv)).rejects.toThrow(/socket de controle/i);
      await expect(stat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a startup failure with its log and permits a retry", async () => {
    await expect(runtime.start({ ...runtimeEnv, TEST_FAIL: "1" })).rejects.toThrow(/host\.log/);
    expect((await runtime.status()).state).toBe("stopped");
    expect(await readFile(logPath, "utf8")).toContain("fixture failed before listen");
    await runtime.start(runtimeEnv);
    expect((await runtime.status()).state).toBe("running");
  });

  it("releases its control socket after the dashboard exits unexpectedly", async () => {
    const exitFile = join(root, "exit");
    await runtime.start({ ...runtimeEnv, TEST_EXIT: exitFile });
    await writeFile(exitFile, "");
    await vi.waitFor(async () => expect((await runtime.status()).state).toBe("stopped"));
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.start(runtimeEnv);
    expect((await runtime.status()).state).toBe("running");
  });

  it("ends a canceled startup without leaving a supervisor or dashboard behind", async () => {
    const cancellation = new AbortController();
    const start = runtime.start({ ...runtimeEnv, TEST_READY: join(root, "ready") }, cancellation.signal);
    const result = expect(start).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(async () => expect((await runtime.status()).state).toBe("starting"));
    cancellation.abort();
    await result;
    expect((await runtime.status()).state).toBe("stopped");
  });

  it("ends log following on cancellation while the dashboard stays running", async () => {
    await runtime.start(runtimeEnv);
    const cancellation = new AbortController();
    const follow = runtime.logs(cancellation.signal);
    await delay(50);
    cancellation.abort();
    await follow;
    expect((await runtime.status()).state).toBe("running");
  });
});
