import type { NextConfig } from "next";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSecurityHeaders, resolveDeploymentSecurity } from "./src/lib/security-headers";

const require = createRequire(import.meta.url);
const rootPkg = require("../../package.json") as { version: string };

const nextConfig: NextConfig = {
  output: "standalone",
  // Do not advertise the framework to clients; the version is not exposed, but
  // the header still names the stack for fingerprinting.
  poweredByHeader: false,
  transpilePackages: ["@nocoo/basalt"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  distDir: process.env.NEXT_DIST_DIR || ".next",
  allowedDevOrigins: ["pew.dev.hexly.ai"],
  images: {
    imageSizes: [16, 32, 48, 64, 80, 96, 128, 160, 256, 384],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "s.zhe.to",
        pathname: "/apps/pew/**",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
        pathname: "/**",
      },
    ],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: rootPkg.version,
  },
  async redirects() {
    return [
      {
        source: "/leaderboard/agents",
        destination: "/leaderboard/harness",
        permanent: true,
      },
      {
        source: "/projects",
        destination: "/dashboard",
        permanent: true,
      },
      {
        source: "/manage-projects",
        destination: "/dashboard",
        permanent: true,
      },
      {
        source: "/leaderboard/achievements",
        destination: "/leaderboard",
        permanent: true,
      },
      {
        source: "/leaderboard/showcases",
        destination: "/leaderboard",
        permanent: true,
      },
      {
        source: "/settings/showcases",
        destination: "/dashboard",
        permanent: true,
      },
      {
        source: "/admin/showcases",
        destination: "/dashboard",
        permanent: true,
      },
      {
        // Model Prices moved out of /admin to a user-facing route.
        source: "/admin/model-prices",
        destination: "/model-prices",
        permanent: true,
      },
    ];
  },
  async headers() {
    // HSTS only means anything over HTTPS: browsers ignore it on plain http,
    // and carrying it on an intranet http deployment becomes wrong the day the
    // hostname enters the preload list. The decision is shared with
    // shouldUseSecureCookies() (src/auth.ts) through resolveDeploymentSecurity
    // so a build memo can never disagree with the runtime cookie choice.
    // NOTE: this runs at BUILD time; changing USE_SECURE_COOKIES requires a
    // rebuild, not just a compose restart.
    const { isHttpsDeployment, isDev } = resolveDeploymentSecurity(process.env);
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders({ isHttpsDeployment, isDev }),
      },
    ];
  },
};

export default nextConfig;
