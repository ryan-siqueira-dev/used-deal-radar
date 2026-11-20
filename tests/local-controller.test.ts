import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse } from "dotenv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalController } from "../src/local/controller.js";

const host = vi.hoisted(() => ({
  status: vi.fn<() => Promise<{ state: "stopped" | "starting" | "running"; url: string }>>(),
  start: vi.fn<(env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<void>>(),
  stop: vi.fn<(signal?: AbortSignal) => Promise<void>>(),
  logs: vi.fn<(signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock("../src/local/host-runtime.js", () => ({
  HostRuntime: class {
    status = host.status;
    start = host.start;
    stop = host.stop;
    logs = host.logs;
  },
}));

const hostUrl = "http://127.0.0.1:3210";
const missingHostLog = Object.assign(new Error("Log file not found"), { code: "ENOENT" });
const dashboardCompose = [
  "compose", "--project-name", "ai-deal-finder-dashboard",
  "--file", "docker-compose.dashboard.yml", "--file", "docker-compose.local.yml",
];

const fakeDocker = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeSync } = require("node:fs");
const { basename } = require("node:path");
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
const settings = JSON.parse(readFileSync("docker-settings.json", "utf8"));
const stdout = (line) => writeSync(1, line + "\\n");
const stderr = (line) => writeSync(2, line + "\\n");
appendFileSync("docker-commands.jsonl", JSON.stringify([command, ...args]) + "\\n");

if (command === "xdg-open" || command === "open" || command === "rundll32.exe") process.exit(settings.openFailure ? 1 : 0);
if (command === "npm") {
  if (settings.buildFailure && args[1] === "build") stderr(settings.buildFailure);
  process.exit(settings.buildFailure && args[1] === "build" ? 1 : 0);
}
if (args[0] === "compose" && args[1] === "version") process.exit(settings.noCompose ? 1 : 0);
if (args[0] === "volume" && args[1] === "ls") {
  if (settings.existingVolume) stdout("ai-deal-finder-dashboard_dashboard_postgres_data");
  process.exit(0);
}
if (args[0] === "ps") {
  if (settings.noDaemon) {
    stderr("permission denied while trying to connect to the docker API");
    process.exit(1);
  }
  for (const container of settings.containers || []) stdout(container.id);
  process.exit(0);
}
if (args[0] === "inspect") {
  for (const container of settings.containers || []) stdout(JSON.stringify({ workingDir: process.cwd(), ...container }));
  process.exit(0);
}
if (args.includes("up")) {
  if (settings.waitOnUp) {
    setInterval(() => {}, 1000);
    return;
  }
  if (settings.upFailure) stderr(settings.upFailure);
  process.exit(settings.upFailure ? 1 : 0);
}
if (args[0] === "stop") process.exit(0);
if (args.includes("logs")) {
  if (!args.includes("--follow")) process.exit(0);
  setInterval(() => {}, 1000);
} else {
  stderr("Unexpected command: " + args.join(" "));
  process.exit(1);
}
`;

const postgres = { id: "012345678901", service: "postgres", state: "running", health: "healthy", ports: null };
const dashboard = {
  id: "fedcba654321", service: "dashboard", state: "running", health: "healthy",
  ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3210" }] },
};

describe("LocalController", () => {
  let root: string;
  let controller: LocalController;

  beforeEach(async () => {
    vi.resetAllMocks();
    host.status.mockResolvedValue({ state: "stopped", url: "http://127.0.0.1:3000" });
    host.logs.mockRejectedValue(missingHostLog);
    root = await mkdtemp(join(tmpdir(), "local-controller-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const executable = join(bin, "docker.cjs");
    await writeFile(executable, fakeDocker);
    await chmod(executable, 0o755);
    await Promise.all(["docker", "npm", "xdg-open", "open", "rundll32.exe"].map((name) => symlink(executable, join(bin, name))));
    await settings({});
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
    for (const name of ["DASHBOARD_PORT", "POSTGRES_PORT", "POSTGRES_PASSWORD", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "SCHEDULER_ENABLED"]) {
      vi.stubEnv(name, undefined);
    }
    await writeFile(join(root, ".env.example"), [
      "# Example for local development",
      "DATABASE_URL=postgresql://deal_finder:SUBSTITUA_POR_UMA_SENHA_FORTE@localhost:5433/deal_finder?schema=public",
      "POSTGRES_PASSWORD=SUBSTITUA_POR_UMA_SENHA_FORTE",
      "APP_UID=1000",
      "APP_GID=1000",
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium",
      "FACEBOOK_ENABLED=false",
      "FACEBOOK_STORAGE_STATE_PATH=./data/facebook-session.json",
      "OLX_ENABLED=false",
      "OLX_STORAGE_STATE_PATH=./data/olx-session.json",
      "SCHEDULER_ENABLED=true",
      "",
    ].join("\n"));
    controller = new LocalController(root);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function settings(values: object) {
    await writeFile(join(root, "docker-settings.json"), JSON.stringify(values));
  }

  async function commands(): Promise<string[][]> {
    const output = await readFile(join(root, "docker-commands.jsonl"), "utf8");
    return output.trim().split("\n").map((line) => JSON.parse(line) as string[]);
  }

  it("discovers a stopped project without creating any configuration", async () => {
    expect(await controller.status()).toMatchObject({ state: "stopped", url: "http://127.0.0.1:3000" });
    await expect(stat(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "data"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await commands()).toContainEqual([
      "docker", "ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=ai-deal-finder-dashboard",
      "--filter", "label=com.docker.compose.oneoff=False",
    ]);
  });

  it("uses the host runtime's dashboard port with healthy PostgreSQL", async () => {
    await settings({ containers: [postgres, { ...dashboard, state: "exited" }] });
    host.status.mockResolvedValue({ state: "running", url: hostUrl });

    expect(await controller.status()).toMatchObject({ state: "running", url: hostUrl });
    await expect(stat(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await controller.openDashboard();
    expect((await commands()).at(-1)?.at(-1)).toBe(hostUrl);
  });

  it("reports a host dashboard awaiting readiness as partially running", async () => {
    await settings({ containers: [postgres] });
    host.status.mockResolvedValue({ state: "starting", url: hostUrl });

    expect(await controller.status()).toMatchObject({ state: "partial", url: hostUrl });
  });

  it("reports the legacy dashboard as partially running until migration", async () => {
    await settings({ containers: [postgres, dashboard] });

    expect(await controller.status()).toMatchObject({ state: "partial" });
  });

  it("offers the dashboard URL when the browser opener fails", async () => {
    await settings({ containers: [postgres], openFailure: true });
    host.status.mockResolvedValue({ state: "running", url: hostUrl });

    await expect(controller.openDashboard()).rejects.toThrow("Abra http://127.0.0.1:3210 no navegador.");
  });

  it.each([
    [{ noCompose: true }, /compose/i],
    [{ noDaemon: true }, /docker/i],
  ])("reports an unavailable Docker installation (%o)", async (dockerSettings, message) => {
    await settings(dockerSettings);

    expect(await controller.status()).toMatchObject({ state: "unavailable", message: expect.stringMatching(message) });
    await expect(controller.start()).rejects.toThrow(message);
    await expect(stat(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a private config and enables only the marketplaces with existing default sessions", async () => {
    const dataDir = join(root, "data");
    await mkdir(dataDir);
    const facebookSession = join(dataDir, "facebook-session.json");
    await writeFile(facebookSession, "synthetic session data");
    await mkdir(join(dataDir, "olx-session.json"));

    await controller.prepare();

    const envPath = join(root, ".env");
    const config = parse(await readFile(envPath));
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, ".runtime"))).mode & 0o777).toBe(0o700);
    expect(config).toMatchObject({
      POSTGRES_PASSWORD: expect.stringMatching(/^[a-f0-9]{64}$/),
      APP_UID: String(process.getuid?.() ?? 1000),
      APP_GID: String(process.getgid?.() ?? 1000),
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "",
      FACEBOOK_ENABLED: "true",
      FACEBOOK_STORAGE_STATE_PATH: "./data/facebook-session.json",
      OLX_ENABLED: "false",
      OLX_STORAGE_STATE_PATH: "./data/olx-session.json",
      SCHEDULER_ENABLED: "true",
    });
    expect(new URL(config.DATABASE_URL!).password).toBe(config.POSTGRES_PASSWORD);
    expect(await readFile(facebookSession, "utf8")).toBe("synthetic session data");
  });

  it("preserves existing configuration through repeated preparation", async () => {
    const envPath = join(root, ".env");
    const existingEnv = "# Custom settings\nPOSTGRES_PASSWORD=already-set\nFACEBOOK_ENABLED=false\nDASHBOARD_PORT=3711\n";
    await writeFile(envPath, existingEnv, { mode: 0o640 });

    await Promise.all([controller.prepare(), controller.prepare()]);

    expect(await readFile(envPath, "utf8")).toBe(existingEnv);
    expect((await stat(envPath)).mode & 0o777).toBe(0o640);
    expect(await controller.status()).toMatchObject({ state: "stopped", url: "http://127.0.0.1:3711" });
  });

  it("stops the legacy dashboard and brings up only PostgreSQL before preparing and starting the host", async () => {
    const envPath = join(root, ".env");
    const initialEnv = [
      "POSTGRES_PASSWORD='synthetic@%!:/password'",
      "DATABASE_URL=postgresql://deal_finder:unrelated@localhost:5433/deal_finder",
      "POSTGRES_PORT=5437",
      "DASHBOARD_PORT=3210",
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/configured/chromium",
      "FACEBOOK_ENABLED=true",
      "OLX_HEADLESS=true",
      "SCHEDULER_ENABLED=false",
      "",
    ].join("\n");
    await writeFile(envPath, initialEnv);
    await settings({ containers: [postgres, dashboard], existingVolume: true });
    const start = ["docker", ...dashboardCompose, "up", "--no-build", "-d", "--wait", "--wait-timeout", "120", "postgres"];
    host.start.mockImplementationOnce(async () => {
      expect((await commands()).slice(-6)).toEqual([
        ["docker", "stop", dashboard.id],
        start,
        ["npm", "run", "prisma:generate"],
        ["npm", "run", "build"],
        ["npm", "run", "dashboard:build"],
        ["npm", "run", "prisma:migrate"],
      ]);
    });

    await controller.start();

    expect(host.start).toHaveBeenCalledWith(expect.objectContaining({
      DATABASE_URL: "postgresql://deal_finder:synthetic%40%25!%3A%2Fpassword@127.0.0.1:5437/deal_finder_dashboard?schema=public",
      DASHBOARD_PORT: "3210",
      DASHBOARD_CONTAINER: "false",
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/configured/chromium",
      FACEBOOK_ENABLED: "true",
      OLX_HEADLESS: "false",
      SCHEDULER_ENABLED: "false",
    }), undefined);
    expect(await readFile(envPath, "utf8")).toBe(initialEnv);
  });

  it("keeps a healthy host runtime running without rebuilding it", async () => {
    await controller.prepare();
    await settings({ containers: [postgres] });
    host.status.mockResolvedValue({ state: "running", url: hostUrl });

    await controller.start();

    expect((await commands()).some((command) => command[0] === "npm")).toBe(false);
    expect(host.start).not.toHaveBeenCalled();
  });

  it("includes the startup error and recent service logs when Compose fails", async () => {
    await settings({ upFailure: "bind: address already in use" });

    await expect(controller.start()).rejects.toThrow(/address already in use/);
    expect(await commands()).toContainEqual(["docker", ...dashboardCompose, "logs", "--tail", "60", "postgres"]);
  });

  it("does not launch the host when a prerequisite build fails", async () => {
    await settings({ buildFailure: "simulated build diagnostic" });

    await expect(controller.start()).rejects.toThrow(/build.*simulated build diagnostic/s);

    expect(host.start).not.toHaveBeenCalled();
    expect((await commands()).some((command) => command.includes("prisma:migrate"))).toBe(false);
  });

  it("cancels the start subprocess without issuing any container shutdown", async () => {
    await settings({ waitOnUp: true });
    const cancellation = new AbortController();
    const starting = controller.start(cancellation.signal);
    void starting.catch(() => {});
    try {
      await vi.waitFor(async () => {
        expect((await commands()).some((command) => command.includes("up"))).toBe(true);
      });
    } finally {
      cancellation.abort();
      await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    }

    expect((await commands()).some((command) => command.some((arg) => ["logs", "stop", "down"].includes(arg)))).toBe(false);
  });

  it("leaves containers from another checkout of the Compose project alone", async () => {
    await settings({ containers: [{ ...postgres, workingDir: join(root, "other-checkout") }] });

    expect(await controller.status()).toMatchObject({ state: "unavailable", message: expect.stringMatching(/outro diretório/) });
    await expect(controller.start()).rejects.toThrow(/outro diretório/);
    await expect(controller.stop()).rejects.toThrow(/outro diretório/);
    await expect(controller.logs()).rejects.toThrow(/outro diretório/);
    await expect(stat(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await commands()).some((command) => command.some((arg) => ["up", "logs", "stop"].includes(arg)))).toBe(false);
  });

  it("requires the original configuration when database data already exists", async () => {
    await settings({ existingVolume: true });

    await expect(controller.start()).rejects.toThrow(/Restaure o arquivo \.env/);
    await expect(stat(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await commands()).some((command) => command.includes("up"))).toBe(false);
  });

  it("stops only the matching dashboard and database containers in dependency order", async () => {
    await settings({ containers: [postgres, dashboard, { ...dashboard, service: "extra", id: "abcdef012345" }] });
    await mkdir(join(root, "data"));
    await writeFile(join(root, "data", "local-data"), "existing data");
    host.stop.mockImplementationOnce(async () => {
      expect((await commands().catch(() => [])).some((command) => command[1] === "stop")).toBe(false);
    });

    await controller.stop();
    await settings({ containers: [{ ...postgres, state: "exited" }, { ...dashboard, state: "exited" }] });
    await controller.stop();

    expect((await commands()).filter((command) => command[1] === "stop")).toEqual([
      ["docker", "stop", "fedcba654321"], ["docker", "stop", "012345678901"],
    ]);
    expect((await commands()).some((command) => command.includes("down") || command.includes("rm"))).toBe(false);
    expect(await readFile(join(root, "data", "local-data"), "utf8")).toBe("existing data");
    await expect(stat(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels the host log follower without touching the application or containers", async () => {
    host.logs.mockImplementationOnce(async (signal) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    const cancellation = new AbortController();
    const following = controller.logs(cancellation.signal);
    void following.catch(() => {});
    try {
      await vi.waitFor(() => expect(host.logs).toHaveBeenCalledWith(cancellation.signal));
    } finally {
      cancellation.abort();
      await following;
    }
    expect(host.stop).not.toHaveBeenCalled();
    await expect(stat(join(root, "docker-commands.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels the database log fallback without stopping its container", async () => {
    await controller.prepare();
    await settings({ containers: [postgres, dashboard] });
    const cancellation = new AbortController();
    const following = controller.logs(cancellation.signal);
    void following.catch(() => {});
    try {
      await vi.waitFor(async () => {
        expect(await commands()).toContainEqual(["docker", "logs", "--tail", "60", "--follow", postgres.id]);
      });
    } finally {
      cancellation.abort();
      await following;
    }

    expect((await commands()).some((command) => command[1] === "stop")).toBe(false);
  });
});
