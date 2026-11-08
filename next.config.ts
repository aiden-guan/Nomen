import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; it must be loaded by Node, not bundled.
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static"],
  // ffmpeg-static finds its binary by path at run time, so tracing can't see it: ship it with the
  // API functions, which cut videos and take QC frames on serverless hosts (src/lib/media.ts). The
  // edit burns captions in with the bundled font (assets/fonts, src/lib/creative/edit.ts).
  outputFileTracingIncludes: { "/api/**/*": ["./node_modules/ffmpeg-static/ffmpeg", "./assets/fonts/**"] },
  // Paths built at run time (join(dir, `${id}.mp4`) and the like) make the tracer match every file
  // with that name pattern in the repo, so each API function picked up the demo videos (public/demo),
  // samples/ and tests/ and passed Vercel's 250 MB function limit. No server code reads those from
  // disk (public/ is served by the CDN), so keep them out of every function.
  outputFileTracingExcludes: { "**": ["./public/**", "./samples/**", "./tests/**"] },
  // Inlined at build time so src/instrumentation.ts can drop the worker import on Vercel, where the
  // worker never starts (src/lib/worker.ts). Next doesn't apply the excludes above to the
  // instrumentation trace, and Vercel ships that trace with the proxy function.
  env: { NOMEN_VERCEL_BUILD: process.env.VERCEL ? "1" : "" },
  images: { unoptimized: true },
};

export default nextConfig;
