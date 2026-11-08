import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; it must be loaded by Node, not bundled.
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static"],
  // ffmpeg-static finds its binary by path at run time, so tracing can't see it: ship it with the
  // API functions, which cut videos and take QC frames on serverless hosts (src/lib/media.ts).
  outputFileTracingIncludes: { "/api/**/*": ["./node_modules/ffmpeg-static/ffmpeg"] },
  images: { unoptimized: true },
};

export default nextConfig;
