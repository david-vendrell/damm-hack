/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      '@prisma/client',
      'prisma',
      '@duckdb/node-api',
      '@duckdb/node-bindings',
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // The duckdb native binding pulls platform-specific .node modules at
      // runtime; tell webpack to leave them alone so it doesn't try to bundle
      // every platform variant.
      config.externals = config.externals || [];
      config.externals.push(
        '@duckdb/node-api',
        '@duckdb/node-bindings',
        '@duckdb/node-bindings-darwin-arm64',
        '@duckdb/node-bindings-darwin-x64',
        '@duckdb/node-bindings-linux-arm64',
        '@duckdb/node-bindings-linux-x64',
        '@duckdb/node-bindings-linux-arm64-musl',
        '@duckdb/node-bindings-linux-x64-musl',
        '@duckdb/node-bindings-win32-arm64',
        '@duckdb/node-bindings-win32-x64',
      );
    }
    return config;
  },
};

export default nextConfig;
