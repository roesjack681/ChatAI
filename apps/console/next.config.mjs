/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep this project isolated from a concurrently running root-level Next app.
  distDir: process.env.HARNESS_NEXT_DIST_DIR || ".next-harness",
  serverExternalPackages: ["node:sqlite", "sharp"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals ?? [];
      config.externals.push(({ request }, callback) => {
        if (request?.startsWith("node:")) {
          callback(null, `commonjs ${request}`);
          return;
        }
        callback();
      });
    }
    return config;
  },
};

export default nextConfig;
