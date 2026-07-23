/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // shared-types ships compiled ESM; transpile to be safe across Next's bundler.
  transpilePackages: ['@agentledger/shared-types', 'recharts'],

  /**
   * Browser security headers for every route.
   *
   * NOTE: next.config does not specially "export" NEXT_PUBLIC_* vars — Next.js
   * inlines NEXT_PUBLIC_* from the environment at build time automatically.
   * This app uses server-side BADGERIQ_API_URL (BFF /api/* proxies). Do NOT put
   * that internal URL in connect-src — it is not reachable from the browser and
   * was baking Docker-compose hosts (e.g. http://api:8094) into prod CSP.
   * Only NEXT_PUBLIC_BADGERIQ_API_URL (a browser-reachable origin) may be added.
   *
   * TODO(csp-nonce): Upgrade script-src to a per-request nonce once the App
   * Router layout can read a middleware-injected nonce on every response
   * (middleware sets `x-nonce` + CSP, root layout applies nonce={...}).
   * Until then Next.js App Router *requires* 'unsafe-inline' for the RSC
   * flight payload scripts (`self.__next_f.push(...)`). Strict 'self' alone
   * blocks hydration and renders a blank page (dark body background only).
   */
  async headers() {
    const publicApiOrigin = (
      process.env.NEXT_PUBLIC_BADGERIQ_API_URL || ''
    ).replace(/\/$/, '');
    const connectSrc = ["'self'", publicApiOrigin].filter(Boolean).join(' ');

    const csp = [
      "default-src 'self'",
      // 'unsafe-inline' required for Next.js App Router inline flight scripts
      // until TODO(csp-nonce) lands. Do not drop without a working nonce path.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      `connect-src ${connectSrc}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
