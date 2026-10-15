'use strict';

// Local ESLint plugin enforcing the module layering in docs/architecture/MODULE_BOUNDARIES.md.
const path = require('node:path');
const boundaries = require('../module-boundaries.json');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODULES_ROOT = path.join(REPO_ROOT, boundaries.modulesRoot);

const tierOf = new Map();
for (const [tier, modules] of Object.entries(boundaries.tiers)) {
  for (const name of modules) tierOf.set(name, Number(tier));
}

/** Returns the module key ('identity', 'insights/virtual-be') for a file inside the modules root. */
function moduleKeyFor(absPath) {
  const rel = path.relative(MODULES_ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep);
  if (parts.length < 2) return undefined; // a file directly in modules/, e.g. README
  if (parts[0] === 'insights') return parts.length >= 3 ? `insights/${parts[1]}` : undefined;
  return parts[0];
}

function isAllowed(from, to) {
  if (from === to) return true;
  const fromTier = tierOf.get(from);
  const toTier = tierOf.get(to);
  if (toTier < fromTier) return true;
  if (toTier === fromTier) return (boundaries.allowedSameTier[from] || []).includes(to);
  return (boundaries.upwardExceptions[from] || []).includes(to);
}

const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce PBE module tiers (MODULE_BOUNDARIES.md).' },
    schema: [],
    messages: {
      forbidden:
        "Module '{{from}}' (tier {{fromTier}}) may not import module '{{to}}' (tier {{toTier}}). See docs/architecture/MODULE_BOUNDARIES.md.",
      unregistered:
        "Module '{{name}}' is not registered in tooling/module-boundaries.json. Add it there and in MODULE_BOUNDARIES.md first.",
      nonRelative:
        'Import modules through relative paths only; deep imports into apps/api/src/modules are not allowed here.',
    },
  },
  create(context) {
    const filename = context.filename;
    const from = moduleKeyFor(path.resolve(filename));
    if (!from) return {};

    function check(node, source) {
      if (typeof source !== 'string') return;
      if (!source.startsWith('.')) {
        if (/(^|\/)apps\/api\/src\/modules\//.test(source)) {
          context.report({ node, messageId: 'nonRelative' });
        }
        return;
      }
      const to = moduleKeyFor(path.resolve(path.dirname(filename), source));
      if (!to) return;
      for (const name of [from, to]) {
        if (!tierOf.has(name)) {
          context.report({ node, messageId: 'unregistered', data: { name } });
          return;
        }
      }
      if (!isAllowed(from, to)) {
        context.report({
          node,
          messageId: 'forbidden',
          data: { from, to, fromTier: tierOf.get(from), toTier: tierOf.get(to) },
        });
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => node.source.type === 'Literal' && check(node, node.source.value),
    };
  },
};

/** Which top-level area a path belongs to: 'apps/api', 'apps/web', 'packages/<name>' or undefined. */
function areaOf(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const [top, name] = rel.split(path.sep);
  return (top === 'apps' || top === 'packages') && name ? `${top}/${name}` : undefined;
}

/** Areas each area may NOT reach through a relative import. */
function isForbiddenArea(from, to) {
  if (!from || !to || from === to) return false;
  if (from.startsWith('packages/')) return to.startsWith('apps/');
  if (from === 'apps/web') return to === 'apps/api';
  if (from === 'apps/api') return to === 'apps/web';
  return false;
}

const noCrossAppImports = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid relative imports between the web app, the API and packages.' },
    schema: [],
    messages: {
      forbidden:
        "'{{from}}' may not import from '{{to}}'. Share code through packages/contracts instead.",
    },
  },
  create(context) {
    const filename = path.resolve(context.filename);
    const from = areaOf(filename);
    if (!from) return {};
    function check(node, source) {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const to = areaOf(path.resolve(path.dirname(filename), source));
      if (isForbiddenArea(from, to))
        context.report({ node, messageId: 'forbidden', data: { from, to } });
    }
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => node.source.type === 'Literal' && check(node, node.source.value),
    };
  },
};

module.exports = {
  meta: { name: 'eslint-plugin-pbe' },
  rules: { 'module-boundaries': moduleBoundaries, 'no-cross-app-imports': noCrossAppImports },
  _internals: { moduleKeyFor, isAllowed },
};
