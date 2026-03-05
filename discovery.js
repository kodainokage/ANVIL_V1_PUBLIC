'use strict';
/**
 * ANVIL Discovery Module — STUB FOR PUBLIC REPOSITORY
 *
 * This file is a placeholder. The real discovery.js scans public data sources
 * (BLS, Federal Register, Regulations.gov, O*NET, NVD) for niche candidates.
 *
 * TO DEPLOY: Replace this file with your real discovery.js implementation.
 *
 * Required exports:
 *   scan(sources, stmts) → Promise<{results, logs}>
 *   getAvailableSources() → string[]
 */

module.exports = {
  scan: async (sources, stmts) => {
    console.warn('[DISCOVERY] discovery.js is a stub — no real scanning performed.');
    return { results: [], logs: ['Discovery module not implemented.'] };
  },
  getAvailableSources: () => ['bls', 'federal_register', 'regulations_gov', 'onet', 'onet_keyword', 'nvd'],
};
