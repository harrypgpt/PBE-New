import path from 'node:path';
import type { NextConfig } from 'next';

// The monorepo root, so Next.js traces files and resolves workspace packages from the right place.
const repoRoot = path.join(__dirname, '..', '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
