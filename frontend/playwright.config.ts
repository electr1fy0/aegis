import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const frontendDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(frontendDirectory, "..");
const isolatedDatabaseDirectory = mkdtempSync(join(tmpdir(), "aegis-playwright-"));
const isolatedDatabasePath = join(isolatedDatabaseDirectory, "exercise-testdb.sqlite3");

process.once("exit", () => {
  rmSync(isolatedDatabaseDirectory, { force: true, recursive: true });
});

const apiHealthUrl = "http://127.0.0.1:8000/api/health";
const appUrl = "http://127.0.0.1:3000/dashboard";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "./.venv/bin/python -m backend.aegis",
      cwd: repositoryRoot,
      url: apiHealthUrl,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        AEGIS_DB_PATH: isolatedDatabasePath,
        AEGIS_HOST: "127.0.0.1",
        AEGIS_PORT: "8000",
        PYTHONUNBUFFERED: "1",
      },
    },
    {
      command: "bun run dev -- --host 127.0.0.1 --port 3000 --strictPort",
      cwd: frontendDirectory,
      url: appUrl,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
