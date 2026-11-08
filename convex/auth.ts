// Every function here serves the Nomen server only. It proves itself with NOMEN_SERVER_SECRET,
// set on both sides by scripts/vercel-build.sh; browsers never call Convex directly.

export function guard(secret: string) {
  const expected = process.env.NOMEN_SERVER_SECRET ?? "";
  let diff = expected.length === secret.length && expected.length >= 32 ? 0 : 1;
  for (let i = 0; i < Math.min(expected.length, secret.length); i++) diff |= expected.charCodeAt(i) ^ secret.charCodeAt(i);
  if (diff !== 0) throw new Error("Forbidden");
}
