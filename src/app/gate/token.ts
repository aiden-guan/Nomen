// The site password gate (see src/proxy.ts). The password itself lives only in the SITE_PASSWORD
// environment variable; browsers keep a hash of it in a cookie, never the password.

export const GATE_COOKIE = "nomen_gate";

/** Thirty days: one entry per browser covers a run of demos. */
export const GATE_MAX_AGE = 60 * 60 * 24 * 30;

/** The cookie value for a password: a SHA-256 hex digest, salted with this app's name. */
export async function gateToken(password: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`nomen-gate:v1:${password}`));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without returning early on the first difference. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Where to go after the gate: a path on this site only (no open redirects). */
export function safeNext(next: string | null | undefined) {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/gate")) return "/";
  return next;
}
