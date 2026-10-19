import type { NextConfig } from 'next';
import { apiOrigin } from './src/config/api-origin';
import { STATIC_SECURITY_HEADERS } from './src/security/headers';

/**
 * Same-origin routing (ADR-025): the browser only talks to this server, which forwards
 * /api/v1/* to the API on the local machine. CORS stays closed on the API.
 */
const config: NextConfig = {
  poweredByHeader: false,
  // Do not let `next dev` write an AGENTS.md file into the project.
  agentRules: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // Image optimisation is off, so the optional image library is never loaded (R-009).
  images: { unoptimized: true },
  async headers() {
    return [{ source: '/:path*', headers: [...STATIC_SECURITY_HEADERS] }];
  },
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiOrigin()}/api/v1/:path*` }];
  },
};

export default config;
