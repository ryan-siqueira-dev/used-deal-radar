import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Application } from "../app.js";
import { createDashboardHandler } from "./api.js";
import { createDashboardRepository } from "./repository.js";

export function startDashboard(app: Application, port = 3000, container = false): Server {
  const handler = createDashboardHandler(createDashboardRepository(app));
  const staticRoot = resolve("dashboard/dist");
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) { res.writeHead(403).end(); return; }
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname.startsWith("/api/")) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const data = Buffer.from(chunk as Uint8Array); size += data.length;
          if (size > 65_536) { res.writeHead(413).end(); return; }
          chunks.push(data);
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const body = Buffer.concat(chunks);
        const response = await handler(new Request(url, { method: req.method ?? "GET", headers, ...(body.length ? { body } : {}) }));
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      const filename = resolve(staticRoot, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
      if (!filename.startsWith(staticRoot + sep)) { res.writeHead(403).end(); return; }
      const file = await readFile(filename);
      const contentType: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
      res.writeHead(200, { "content-type": contentType[extname(filename)] ?? "application/octet-stream", "x-content-type-options": "nosniff" });
      res.end(file);
    } catch { res.writeHead(404).end(); }
  });
  server.listen(port, container ? "0.0.0.0" : "127.0.0.1", () => {
    app.logger.info({ event: "dashboard_started", port }, "Dashboard listening on localhost");
    if (process.connected) process.send?.({ type: "dashboard_ready" }, () => {});
  });
  return server;
}
