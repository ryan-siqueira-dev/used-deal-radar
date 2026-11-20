# Local host runtime migration

User approved switching the TUI to host application/browser with only PostgreSQL in Docker after container OLX returned403 while host Chromium returned200.

- Preserve project, database volume, credentials, searches and sessions. Stop the old dashboard container before starting the host app. Existing .env password must remain intact.
- PostgreSQL remains in same Compose project/volume, restart:no, published on loopback POSTGRES_PORT (default5433). Host DATABASE_URL uses deal_finder_dashboard database and current password. Override runtime environment without rewriting user secrets.
- Use system Chromium /usr/bin/chromium where available, OLX_HEADLESS=false for normal desktop session, reuse sessions. Other platform configured executable takes precedence.
- HostRuntime owns detached supervisor, private Unix control socket, readiness IPC from dashboard child and append-only private log. Closing TUI leaves runtime alive. Stop requests graceful child termination, then stops postgres. Never kill an unverified/reused PID. Startup concurrency must create at most one app.
- Controller owns Docker scope guards, migration/build orchestration, provider/runtime environment, host status, menu-compatible start/stop/logs. Logs can combine host file and PostgreSQL streams with cancellation.
- Verify migration from live Docker app using actual existing data. Full tests/types/build, real host source check and cycle exit/reopen/stop. Final state stopped.

Ownership: host-runtime agent src/local/host-runtime.ts and src/local/host-supervisor.ts plus tests/host-runtime.test.ts; controller agent src/local/controller.ts, docker-compose.local.yml and tests/local-controller.test.ts; coordinator src/dashboard/{index,server}.ts readiness/port changes, integration/docs.

HostRuntime(root:string) methods status(signal?) => Promise<{state:'running'|'starting'|'stopped',url:string}>, start(env:NodeJS.ProcessEnv,signal?) => Promise<void>, stop(signal?) => Promise<void>, logs(signal?) => Promise<void>. Supervisor launch via process.execPath dist/local/host-supervisor.js, private socket .runtime/host.sock, log .runtime/host.log. env includes DASHBOARD_PORT and final DATABASE_URL. Supervisor fork dist/dashboard/index.js with IPC. Child sends {type:'dashboard_ready'} only from server.listen callback. status ready only after IPC. Parent start waits bounded120s and distinguishes its launched process from preexisting healthyruntime.
