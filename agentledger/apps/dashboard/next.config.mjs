/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // shared-types ships compiled ESM; transpile to be safe across Next's bundler.
  transpilePackages: ['@agentledger/shared-types', 'recharts'],
};

export default nextConfig;
