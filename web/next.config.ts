import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin tracing root to web/ so parent aether-foundry lockfile is ignored.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
