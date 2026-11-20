import { assertProductionToken } from "@shared/config";
import { ready } from "@infra/db";
import { ensureDailySkeleton } from "@world/daily-life";

export function boot(): void {
  assertProductionToken();
  ready();
  ensureDailySkeleton();
}
