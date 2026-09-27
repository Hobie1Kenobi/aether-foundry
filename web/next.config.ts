import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin tracing root to web/ so parent aether-foundry lockfile is ignored.
  outputFileTracingRoot: path.join(__dirname),
  // xrpl's ws client breaks when webpack rewrites frame masking.
  serverExternalPackages: ["xrpl"],
};

export default nextConfig;
