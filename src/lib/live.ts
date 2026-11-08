/**
 * Whether this deployment can run real campaigns on `/` (the demo at /demo works everywhere).
 *
 * - NOMEN_DEMO_ONLY=1 forces the demo, whatever else is set.
 * - A machine with a disk (not Vercel) runs them with SQLite.
 * - On Vercel they need Convex (docs/convex.md): once Convex is connected, `/` goes live by itself.
 */
export function liveEnabled() {
  if (process.env.NOMEN_DEMO_ONLY === "1") return false;
  if (!process.env.VERCEL) return true;
  if (process.env.NOMEN_STORE === "convex") return true;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL;
  const secret = process.env.NOMEN_SERVER_SECRET || process.env.CONVEX_DEPLOY_KEY;
  return Boolean(url && secret);
}
