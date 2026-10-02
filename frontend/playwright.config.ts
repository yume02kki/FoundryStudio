import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The e2e suite runs against the offline demo: local git repos standing in for configs,
// foundry-models and the transformer repos, and a workspace with PacketPipeline
// (see backend/foundry_studio/demo.py). No token needed.
const BACKEND_PORT = 8100;
const FRONTEND_PORT = 5199;
const scratch = process.env.STUDIO_E2E_SCRATCH ?? join(tmpdir(), `foundry-studio-e2e-${process.pid}`);
// Workers inherit this, so tests can push to the demo repos (e2e/live.spec.ts).
process.env.STUDIO_E2E_SCRATCH = scratch;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    viewport: { width: 1500, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1500, height: 900 } } }],
  webServer: [
    {
      command: `uv run --project ../backend uvicorn foundry_studio.app:app --app-dir ../backend --host 127.0.0.1 --port ${BACKEND_PORT}`,
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      env: { STUDIO_FAKE_GITLAB: join(scratch, "gitlab") },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${FRONTEND_PORT} --strictPort`,
      url: `http://127.0.0.1:${FRONTEND_PORT}`,
      env: { STUDIO_BACKEND: `http://127.0.0.1:${BACKEND_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
