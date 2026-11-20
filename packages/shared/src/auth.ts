import { timingSafeEqual } from "node:crypto";

import { adminToken, integrationToken } from "@shared/config";

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(request: Request): string {
  return request.headers.get("authorization") ?? "";
}

function cookieValue(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function isAdmin(request: Request): boolean {
  const token = adminToken();
  if (safeEqual(bearer(request), `Bearer ${token}`)) return true;
  return safeEqual(cookieValue(request, "harness_session"), token);
}

export function isIntegration(request: Request): boolean {
  const token = integrationToken();
  return Boolean(token) && safeEqual(bearer(request), `Bearer ${token}`);
}

export function sessionCookie(token: string, maxAge: number): string {
  return `harness_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
