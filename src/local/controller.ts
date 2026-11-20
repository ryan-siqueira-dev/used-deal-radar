import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { HostRuntime } from "./host-runtime.js";

const projectName = "ai-deal-finder-dashboard";
const volumeName = `${projectName}_dashboard_postgres_data`;
const compose = [
  "compose", "--project-name", projectName,
  "--file", "docker-compose.dashboard.yml", "--file", "docker-compose.local.yml",
];
const inspectFormat = '{"id":{{json .Id}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"ports":{{json .NetworkSettings.Ports}}}';

export interface LocalStatus {
  state: "running" | "stopped" | "partial" | "unavailable";
  message: string;
  url: string;
}

interface Container {
  id: string;
  workingDir: string;
  service: "postgres" | "dashboard";
  state: string;
  health: string | null;
  ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | null;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActive(container: Container): boolean {
  return ["running", "restarting", "paused"].includes(container.state);
}

function isHealthy(container: Container): boolean {
  return container.state === "running" && container.health === "healthy";
}

function dashboardUrl(port?: string): string {
  const value = Number(port);
  return `http://127.0.0.1:${Number.isInteger(value) && value >= 1 && value <= 65535 ? value : 3000}`;
}

export class LocalController {
  private readonly projectRoot: string;
  private readonly host: HostRuntime;

  constructor(projectRoot = fileURLToPath(new URL("../../", import.meta.url))) {
    this.projectRoot = resolve(projectRoot);
    this.host = new HostRuntime(this.projectRoot);
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await Promise.all(["data", ".runtime"].map((directory) => mkdir(join(this.projectRoot, directory), {
      recursive: true, mode: 0o700,
    })));

    if (await this.hasConfig()) return;

    const password = randomBytes(32).toString("hex");
    const example = await readFile(join(this.projectRoot, ".env.example"), "utf8");
    const values = new Map([
      ["POSTGRES_PASSWORD", password],
      ["APP_UID", String(process.getuid?.() ?? 1000)],
      ["APP_GID", String(process.getgid?.() ?? 1000)],
      ["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", ""],
    ]);
    for (const provider of ["FACEBOOK", "OLX"]) {
      const sessionPath = `./data/${provider.toLowerCase()}-session.json`;
      const session = await stat(join(this.projectRoot, sessionPath)).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
      values.set(`${provider}_ENABLED`, String(session?.isFile() ?? false));
      values.set(`${provider}_STORAGE_STATE_PATH`, sessionPath);
    }

    let contents = example.replaceAll("SUBSTITUA_POR_UMA_SENHA_FORTE", password);
    for (const [key, value] of values) {
      const line = new RegExp(`^${key}=.*$`, "m");
      const assignment = `${key}=${value}`;
      contents = line.test(contents) ? contents.replace(line, assignment) : `${contents.trimEnd()}\n${assignment}\n`;
    }

    // Publish a complete file atomically without replacing one from another process.
    signal?.throwIfAborted();
    const temporary = await mkdtemp(join(this.projectRoot, ".env.local-"));
    try {
      const source = join(temporary, "config");
      await writeFile(source, contents, { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      await link(source, join(this.projectRoot, ".env")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async status(signal?: AbortSignal): Promise<LocalStatus> {
    const env = await readFile(join(this.projectRoot, ".env")).then(parse, () => ({} as Record<string, string>));
    let url = dashboardUrl(process.env.DASHBOARD_PORT || env.DASHBOARD_PORT);
    try {
      await this.checkCompose(signal);
      const containers = await this.findContainers(signal);
      const local = await this.host.status(signal);
      if (local.state !== "stopped") url = local.url;
      if (local.state === "running" && containers.some((container) => container.service === "postgres" && isHealthy(container))) {
        return { state: "running", message: "Aplicação local em execução.", url };
      }
      if (local.state !== "stopped" || containers.some(isActive)) {
        return { state: "partial", message: "O app local ou o banco ainda está indisponível. Consulte os logs ou escolha Iniciar.", url };
      }
      return { state: "stopped", message: "Aplicação parada.", url };
    } catch (error) {
      signal?.throwIfAborted();
      return { state: "unavailable", message: describeError(error), url };
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.checkCompose(signal);
    const containers = await this.findContainers(signal);
    if (!await this.hasConfig()) {
      const volumes = await this.dockerQuery(["volume", "ls", "--quiet", "--filter", `name=^${volumeName}$`], signal);
      if (containers.length > 0 || volumes.split(/\s+/).includes(volumeName)) {
        throw new Error("Restaure o arquivo .env original para usar o banco local existente.");
      }
    }
    await this.prepare(signal);
    const local = await this.host.status(signal);
    if (local.state === "running" && containers.some((container) => container.service === "postgres" && isHealthy(container))) return;
    for (const old of containers.filter((container) => container.service === "dashboard" && isActive(container))) {
      await this.runDocker(["stop", old.id], signal, true);
    }
    try {
      await this.runDocker([...compose, "up", "--no-build", "-d", "--wait", "--wait-timeout", "120", "postgres"], signal, true);
    } catch (error) {
      signal?.throwIfAborted();
      await this.runDocker([...compose, "logs", "--tail", "60", "postgres"], signal, true).catch(() => {});
      throw new Error(`Falha ao iniciar o banco. ${describeError(error)}`);
    }
    const env = await this.hostEnvironment();
    for (const task of ["prisma:generate", "build", "dashboard:build", "prisma:migrate"]) {
      try { await this.runCommand("npm", ["run", task], signal, true, env); }
      catch (error) {
        signal?.throwIfAborted();
        throw new Error(`Falha em ${task}. ${describeError(error)}`);
      }
    }
    await this.host.start(env, signal);
  }

  private async hostEnvironment(): Promise<NodeJS.ProcessEnv> {
    const config = parse(await readFile(join(this.projectRoot, ".env")));
    const env = { ...config, ...process.env };
    const port = env.POSTGRES_PORT ?? "5433";
    const dashboardPort = env.DASHBOARD_PORT ?? "3000";
    for (const value of [port, dashboardPort]) {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("Porta local inválida.");
    }
    if (!env.POSTGRES_PASSWORD) throw new Error("POSTGRES_PASSWORD ausente no arquivo .env.");
    const browser = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      || (await stat("/usr/bin/chromium").catch(() => null) ? "/usr/bin/chromium" : "");
    return {
      ...env,
      DATABASE_URL: `postgresql://deal_finder:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:${port}/deal_finder_dashboard?schema=public`,
      DASHBOARD_PORT: dashboardPort,
      DASHBOARD_CONTAINER: "false",
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: browser,
      OLX_HEADLESS: "false",
      MERCADOLIVRE_WEB_HEADLESS: "false",
    };
  }

  async stop(signal?: AbortSignal): Promise<void> {
    const containers = (await this.findContainers(signal)).filter(isActive);
    await this.host.stop(signal);
    for (const service of ["dashboard", "postgres"] as const) {
      const ids = containers.filter((container) => container.service === service).map((container) => container.id);
      if (ids.length > 0) await this.runDocker(["stop", ...ids], signal, true);
    }
  }

  async openDashboard(signal?: AbortSignal): Promise<void> {
    const status = await this.status(signal);
    signal?.throwIfAborted();
    if (status.state !== "running") throw new Error(status.message);

    let command = "xdg-open";
    let args = [status.url];
    if (process.platform === "darwin") command = "open";
    if (process.platform === "win32") {
      command = "rundll32.exe";
      args = ["url.dll,FileProtocolHandler", status.url];
    }
    await new Promise<void>((resolve, reject) => {
      const browser = spawn(command, args, { cwd: this.projectRoot, detached: true, stdio: "ignore" });
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", interrupt);
        browser.unref();
        if (signal?.aborted) reject(signal.reason);
        else if (error) reject(error);
        else resolve();
      };
      const failure = new Error(`Abra ${status.url} no navegador.`);
      const interrupt = () => finish();
      // Some launchers remain open for the lifetime of the browser.
      const timeout = setTimeout(finish, 500);
      signal?.addEventListener("abort", interrupt, { once: true });
      browser.once("error", () => finish(failure));
      browser.once("exit", (code) => {
        finish(code === 0 ? undefined : failure);
      });
    });
  }

  async logs(signal?: AbortSignal): Promise<void> {
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    if (!signal) process.once("SIGINT", interrupt);
    const logSignal = signal ?? cancellation.signal;
    try {
      try { await this.host.logs(logSignal); }
      catch (error) {
        if (!isMissingFile(error)) throw error;
        await this.checkCompose(logSignal);
        const database = (await this.findContainers(logSignal)).find((container) => container.service === "postgres");
        if (!database) throw new Error("Inicie a aplicação para ver os logs.");
        await this.runDocker(["logs", "--tail", "60", "--follow", database.id], logSignal, true);
      }
    } catch (error) {
      if (!logSignal.aborted) throw error;
    } finally {
      if (!signal) process.removeListener("SIGINT", interrupt);
    }
  }

  private async hasConfig(): Promise<boolean> {
    try {
      await lstat(join(this.projectRoot, ".env"));
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private async checkCompose(signal?: AbortSignal): Promise<void> {
    try {
      await this.dockerQuery(["compose", "version", "--short"], signal);
    } catch {
      signal?.throwIfAborted();
      throw new Error("Docker Compose indisponível. Verifique o Docker e o plugin Compose.");
    }
  }

  private async findContainers(signal?: AbortSignal): Promise<Container[]> {
    // Reading the project by label also works before .env has been created.
    const output = await this.dockerQuery([
      "ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`,
      "--filter", "label=com.docker.compose.oneoff=False",
    ], signal);
    if (!output) return [];

    const details = await this.dockerQuery(["inspect", "--type", "container", "--format", inspectFormat, ...output.split(/\s+/)], signal);
    const containers = details.split("\n").map((line) => JSON.parse(line) as Container);
    const actualRoot = await realpath(this.projectRoot);
    if (containers.some(({ workingDir }) => workingDir !== this.projectRoot && workingDir !== actualRoot)) {
      throw new Error(`Já existem containers do projeto ${projectName} em outro diretório.`);
    }
    return containers.filter((container) => (
      /^[a-f0-9]{12,64}$/.test(container.id) && (container.service === "dashboard" || container.service === "postgres")
    ));
  }

  private async dockerQuery(args: string[], signal?: AbortSignal): Promise<string> {
    try {
      return await this.runDocker(args, signal, false);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Docker indisponível. ${describeError(error)}`);
    }
  }

  private async runDocker(args: string[], signal: AbortSignal | undefined, stream: boolean): Promise<string> {
    return this.runCommand("docker", args, signal, stream);
  }

  private async runCommand(command: string, args: string[], signal: AbortSignal | undefined, stream: boolean, env = process.env): Promise<string> {
    signal?.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      const separateGroup = process.platform !== "win32";
      const child = spawn(command, args, {
        env,
        cwd: this.projectRoot,
        stdio: ["ignore", stream ? "inherit" : "pipe", "pipe"],
        detached: separateGroup,
      });
      // Docker may launch Compose or Buildx as subprocesses. End the client group
      // directly so cancellation never asks Compose to shut down containers.
      const interrupt = () => {
        if (child.pid === undefined) return;
        if (separateGroup) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch { child.kill("SIGKILL"); }
        } else {
          child.kill("SIGKILL");
        }
      };
      signal?.addEventListener("abort", interrupt, { once: true });
      let timedOut = false;
      const timeout = stream ? undefined : setTimeout(() => {
        timedOut = true;
        interrupt();
      }, 10000);

      let error: Error | undefined;
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        if (stream) process.stderr.write(chunk);
        stderr = (stderr + chunk).slice(-2000);
      });
      child.once("error", (cause) => { error = cause; });
      child.once("close", (code, childSignal) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", interrupt);
        if (signal?.aborted) reject(signal.reason);
        else if (timedOut) reject(new Error("O Docker não respondeu no tempo esperado."));
        else if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || error?.message || `O Docker encerrou com ${childSignal ?? `código ${code}`}.`));
      });
    });
  }
}
