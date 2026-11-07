import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; it must be loaded by Node, not bundled.
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static"],
  images: { unoptimized: true },
};

export default nextConfig;
