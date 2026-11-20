import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

export function projectRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, "apps")) && existsSync(path.join(dir, "packages"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function loadEnvFile() {
  if (loaded) return;
  loaded = true;
  const file = path.join(projectRoot(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function read(name: string, fallback = ""): string {
  loadEnvFile();
  return process.env[name] ?? fallback;
}

export function adminToken(): string {
  return read("HARNESS_ADMIN_TOKEN", "dev-admin");
}

export function integrationToken(): string {
  return read("HARNESS_INTEGRATION_TOKEN");
}

export function deepseek() {
  return {
    apiKey: read("DEEPSEEK_API_KEY"),
    baseUrl: read("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    model: read("DEEPSEEK_MODEL", "deepseek-chat"),
  };
}

export function databasePath(): string {
  loadEnvFile();
  const root = projectRoot();
  const dataDir = process.env.HARNESS_DATA_DIR || path.join(root, "data");
  return process.env.HARNESS_DB_PATH || path.join(dataDir, "harness.sqlite3");
}

export function workerId(): string {
  return read("HARNESS_WORKER_ID", "worker-1");
}

export function workerPollMs(): number {
  const seconds = Number(read("HARNESS_WORKER_POLL_SECONDS", "1"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
}

export function assertProductionToken(): void {
  if (process.env.NODE_ENV === "production" && adminToken() === "dev-admin") {
    throw new Error("Set a strong HARNESS_ADMIN_TOKEN before starting in production");
  }
}
