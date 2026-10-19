'use strict';
// Jest stand-in for CSS Modules: every class name maps to itself, so tests can see which
// pattern a component applied without loading CSS.
module.exports = new Proxy({}, { get: (_target, key) => (key === '__esModule' ? false : key) });
