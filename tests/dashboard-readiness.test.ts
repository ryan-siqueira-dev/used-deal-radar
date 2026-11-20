import { afterEach, describe, expect, it, vi } from "vitest";
import type { Application } from "../src/app.js";
import { startDashboard } from "../src/dashboard/server.js";

const mocks = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("node:http", () => ({ createServer: () => ({ listen: mocks.listen }) }));
vi.mock("../src/dashboard/repository.js", () => ({ createDashboardRepository: () => ({}) }));
vi.mock("../src/dashboard/api.js", () => ({ createDashboardHandler: () => async () => new Response() }));

const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
afterEach(() => {
  for (const [key, descriptor] of [["connected", originalConnected], ["send", originalSend]] as const) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
    else Reflect.deleteProperty(process, key);
  }
  vi.clearAllMocks();
});

describe("dashboard host readiness", () => {
  it("reports readiness to its supervisor only after the requested loopback port is bound", () => {
    const send = vi.fn();
    Object.defineProperty(process, "connected", { value: true, configurable: true });
    Object.defineProperty(process, "send", { value: send, configurable: true });
    const app = { logger: { info: vi.fn() } } as unknown as Application;
    startDashboard(app, 3217);
    expect(mocks.listen).toHaveBeenCalledWith(3217, "127.0.0.1", expect.any(Function));
    expect(send).not.toHaveBeenCalled();
    mocks.listen.mock.calls[0]![2]();
    expect(send).toHaveBeenCalledWith({ type: "dashboard_ready" }, expect.any(Function));
  });

  it("starts normally without supervisor IPC", () => {
    Object.defineProperty(process, "connected", { value: false, configurable: true });
    const send = vi.fn();
    Object.defineProperty(process, "send", { value: send, configurable: true });
    startDashboard({ logger: { info: vi.fn() } } as unknown as Application, 3000);
    expect(() => mocks.listen.mock.calls[0]![2]()).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
