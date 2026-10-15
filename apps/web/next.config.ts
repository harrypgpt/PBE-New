import path from 'node:path';
import type { NextConfig } from 'next';

// The monorepo root, so Next.js traces files and resolves workspace packages from the right place.
const repoRoot = path.join(__dirname, '..', '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Next.js 16 otherwise writes apps/web/AGENTS.md (notes for AI coding tools) on every `next dev`,
  // leaving an uncommitted file behind. PBE keeps its rules in docs/architecture instead.
  agentRules: false,
};

export default nextConfig;
