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
   * This app currently uses server-side BADGERIQ_API_URL (BFF /api/* proxies);
   * NEXT_PUBLIC_BADGERIQ_API_URL is optional and only needed if the browser
   * ever talks to the API origin directly (then it must appear in connect-src).
   *
   * TODO(csp-nonce): Upgrade script-src to a per-request nonce once the App
   * Router layout can read a middleware-injected nonce header on every
   * response (middleware sets `x-nonce` + CSP, root layout.tsx applies
   * nonce={...} on <Script>). Until then script-src is 'self' only — no
   * 'unsafe-inline' / 'unsafe-eval'. style-src keeps 'unsafe-inline' for
   * next/font and Tailwind runtime styles.
   */
  async headers() {
    const apiOrigin =
      process.env.NEXT_PUBLIC_BADGERIQ_API_URL ||
      process.env.BADGERIQ_API_URL ||
      process.env.LEDGERAI_API_URL ||
      process.env.AGENTLEDGER_API_URL ||
      '';

    // Strip trailing slash so connect-src origin matches the browser URL.
    const connectApi = apiOrigin.replace(/\/$/, '');
    const connectSrc = ["'self'", connectApi].filter(Boolean).join(' ');

    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
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
