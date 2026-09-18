// Single source of truth for which services get a generated TypeScript client, and where their
// canonical OpenAPI contract lives. Used by generate.mjs, check.mjs, and the test suite -- never
// duplicate this list elsewhere.
export const SERVICES = [
  'gateway', 'notify', 'auth', 'media', 'console', 'audit', 'shortlink',
  'flags', 'scheduler', 'webhook-out', 'search', 'ratelimit', 'geo',
];
