import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runLocalMenu } from "../src/local/menu.js";

type MenuController = Parameters<typeof runLocalMenu>[0];

function session(initialState: "running" | "stopped" = "stopped", initialStatusError?: Error) {
  const input = new PassThrough();
  const output = new PassThrough();
  const actions: string[] = [];
  let state = initialState;
  let screen = "";
  let promptsAnswered = 0;
  output.setEncoding("utf8").on("data", (chunk: string) => { screen += chunk; });

  const controller = {
    status: vi.fn(async () => ({
      state,
      message: state === "running" ? "Aplicação pronta." : "Aplicação desligada.",
      url: "http://localhost:3000",
    })),
    start: vi.fn(async () => {
      actions.push("start");
      state = "running";
    }),
    stop: vi.fn(async () => {
      actions.push("stop");
      state = "stopped";
    }),
    openDashboard: async () => { actions.push("open"); },
    logs: async (signal?: AbortSignal) => {
      actions.push("logs");
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      actions.push("logs-closed");
    },
  } satisfies MenuController;

  if (initialStatusError) controller.status.mockRejectedValueOnce(initialStatusError);
  const completed = runLocalMenu(controller, input, output);

  async function waitForPrompt() {
    await vi.waitFor(() => expect(screen.match(/Opção \(Enter para confirmar\)/g)?.length ?? 0).toBeGreaterThan(promptsAnswered));
  }

  return {
    actions,
    completed,
    controller,
    input,
    screen: () => screen,
    waitForPrompt,
    async enter(choice: string) {
      await waitForPrompt();
      promptsAnswered += 1;
      input.write(`${choice}\n`);
    },
  };
}

describe("TUI local", () => {
  it("shows the current state without starting the application", async () => {
    const tui = session();
    await tui.enter("0");
    await tui.completed;

    expect(tui.screen()).toContain("Parado");
    expect(tui.screen()).toContain("http://localhost:3000");
    expect(tui.actions).toEqual([]);
  });

  it("runs start, open and stop only when explicitly selected", async () => {
    const tui = session();
    await tui.enter("1");
    await tui.enter("2");
    await tui.enter("4");
    await tui.enter("0");
    await tui.completed;

    expect(tui.actions).toEqual(["start", "open", "stop"]);
    const running = tui.screen().indexOf("Em execução");
    expect(running).toBeGreaterThan(tui.screen().indexOf("Iniciando"));
    expect(tui.screen().lastIndexOf("Parado")).toBeGreaterThan(running);
  });

  it("offers a retry after a failed start", async () => {
    const tui = session();
    tui.controller.start.mockRejectedValueOnce(new Error("Porta 3000 ocupada."));

    await tui.enter("1");
    await tui.enter("1");
    await tui.enter("0");
    await tui.completed;

    expect(tui.screen()).toContain("Porta 3000 ocupada.");
    expect(tui.screen()).toContain("Em execução");
    expect(tui.actions).toEqual(["start"]);
  });

  it("keeps the menu usable when the status check fails", async () => {
    const tui = session("stopped", new Error("Docker indisponível."));

    await tui.enter("0");
    await tui.completed;

    expect(tui.screen()).toContain("Docker indisponível.");
    expect(tui.actions).toEqual([]);
  });

  it("ignores invalid choices", async () => {
    const tui = session();
    await tui.enter("12");
    await tui.enter("0");
    await tui.completed;

    expect(tui.screen()).toContain("Opção inválida.");
    expect(tui.actions).toEqual([]);
  });

  it("returns to the menu when Ctrl+C cancels the log follower", async () => {
    const tui = session("running");
    await tui.enter("3");
    await vi.waitFor(() => expect(tui.actions).toEqual(["logs"]));
    tui.input.write("\x03");
    await tui.enter("0");
    await tui.completed;

    expect(tui.actions).toEqual(["logs", "logs-closed"]);
  });

  it.each(["SIGHUP", "SIGTERM"] as const)("exits and cancels the log follower when receiving %s", async (signal) => {
    const tui = session("running");
    await tui.enter("3");
    await vi.waitFor(() => expect(tui.actions).toEqual(["logs"]));
    try {
      process.emit(signal, signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(tui.actions).toEqual(["logs", "logs-closed"]);
      await tui.completed;
    } finally {
      tui.input.end();
      await tui.completed;
    }
  });

  it("Ctrl+C while starting cancels the wait and exits without asking to stop services", async () => {
    const tui = session();
    let finishStart = () => {};
    let canceled = false;
    tui.controller.start.mockImplementationOnce(async (signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        finishStart = resolve;
        signal?.addEventListener("abort", () => {
          canceled = true;
          resolve();
        }, { once: true });
      });
    });

    await tui.enter("1");
    await vi.waitFor(() => expect(tui.controller.start).toHaveBeenCalledOnce());
    try {
      tui.input.write("\x03");
      expect(canceled).toBe(true);
      await tui.completed;
      expect(tui.actions).toEqual([]);
    } finally {
      finishStart();
      await tui.completed;
    }
  });

  it.each([
    ["Ctrl+C", "\x03"],
    ["Ctrl+D", "\x04"],
  ])("leaves running services alone when closing the menu with %s", async (_name, key) => {
    const tui = session("running");
    await tui.waitForPrompt();
    tui.input.write(key);
    await tui.completed;

    expect(tui.screen()).toContain("Em execução");
    expect(tui.actions).toEqual([]);
  });
});
