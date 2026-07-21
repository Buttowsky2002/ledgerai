/**
 * MVP single-container supervisor for Google Cloud Run.
 *
 * Runs both processes in one container:
 *   - control-plane API  (NestJS)  → 127.0.0.1:8094 (internal only)
 *   - dashboard          (Next.js) → 0.0.0.0:$PORT  (Cloud Run ingress)
 *
 * The dashboard is the public surface: it serves the UI at /, proxies API
 * calls through its BFF routes at /api/*, and exposes /health, /ready and
 * /version. If either child exits, the supervisor exits with the same code so
 * Cloud Run replaces the instance (fail fast, never half-alive).
 *
 * No shell involved: children are spawned via the node binary directly, so
 * SIGTERM from Cloud Run is forwarded for graceful shutdown.
 */
'use strict';

const { spawn } = require('node:child_process');

const PORT = process.env.PORT || '8080';
const API_PORT = process.env.BADGERIQ_INTERNAL_API_PORT || '8094';
const API_URL = `http://127.0.0.1:${API_PORT}`;

function launch(name, cwd, script, extraEnv) {
  const child = spawn(process.execPath, [script], {
    cwd, // each app reads its runtime assets (pricing/, .next/) relative to its own root
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  child.on('exit', (code, signal) => {
    console.error(`[supervisor] ${name} exited (code=${code} signal=${signal}); shutting down`);
    shutdown(code ?? 1);
  });
  return child;
}

let exiting = false;
const children = [];

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const c of children) {
    if (c.exitCode === null) c.kill('SIGTERM');
  }
  // Give children a moment to flush, then exit.
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

console.log(`[supervisor] starting api on :${API_PORT} (internal) and dashboard on :${PORT}`);

children.push(
  launch('api', '/app/api', 'dist/main.js', {
    BADGERIQ_API_ADDR: `:${API_PORT}`,
    // Never inherit Cloud Run's PORT into the API — that port belongs to the dashboard.
    PORT: API_PORT,
  }),
);

children.push(
  launch('dashboard', '/app/dashboard', 'server.js', {
    PORT,
    HOSTNAME: '0.0.0.0',
    BADGERIQ_API_URL: API_URL,
  }),
);
