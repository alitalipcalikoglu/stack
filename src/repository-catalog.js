/**
 * The repositories installed next to stack. Runtime topology remains in manifest.js; this list
 * includes service-core as a source/dependency repository and deliberately excludes stack itself.
 */
export const REPOSITORIES = Object.freeze([
  'service-core',
  'gateway',
  'notify',
  'auth',
  'media',
  'console',
  'audit',
  'shortlink',
  'flags',
  'scheduler',
  'webhook-out',
  'search',
  'ratelimit',
  'geo',
].map((id) => Object.freeze({ id, remote: `https://github.com/alitalipcalikoglu/${id}.git` })));

