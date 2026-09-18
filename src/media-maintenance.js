import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvFile } from './env-file.js';

/**
 * Post-production Phase 4: an operator-triggered, one-shot run of media's real production
 * `Maintenance`/`MediaService#purge()` — never a second purge implementation.
 *
 * Trigger mechanism decision (see `stack/docs/POST_PRODUCTION_PLAN.md` Phase 4 and the Phase 4
 * report): media's own HTTP API has no admin/operator auth tier distinct from its flat, roleless
 * `MEDIA_API_KEYS` (every configured key can already upload/download/delete — see
 * `media/src/http/api-key-auth.js`), so an HTTP endpoint here would either blur that public
 * upload/download boundary with an operator action, or require inventing a whole new auth tier
 * for one operation — both explicitly out of scope. This reuses `stack`'s own existing operational
 * control plane instead (the same trust boundary `stack backup`/`stack restore` already assume: an
 * operator who can run `stack` commands against this workspace already has full filesystem and
 * database access to every service) — no new runtime role, no new auth system, no new coupling.
 *
 * Constructs the exact dependency graph `media/src/application.js#start` does — same `Config`,
 * `Database`, `LocalStorage`, `FileStore`, `TicketStore`, `MediaService`, `Maintenance` classes,
 * same real `.env` — minus the Fastify app/HTTP listener, which this never needs and never starts.
 * `LocalStorage#check()`, never `#prepare()`: a real, currently-running media process may hold
 * in-flight uploads under `tmp/`; `prepare()` is destructive and reserved for a process's OWN
 * startup only (see `LocalStorage#prepare`'s own doc).
 *
 * Safe to run concurrently with a live media process's own startup/timer maintenance, or with
 * another `stack maintenance media` invocation — `Maintenance.run()`'s in-process coalescing
 * doesn't apply across separate processes, but correctness there was never `Maintenance`'s job: the
 * DB compare-and-swap (`FileStore#finalizeOrphanBlobs`) and storage's atomic detach
 * (`LocalStorage#detachForDelete`) are what make two independent purges of the same content safe,
 * regardless of which processes they run in — see `media/test/maintenance-concurrency.test.js`.
 * @param {string} root @param {string} serviceId
 * @returns {Promise<import('../../media/src/maintenance.js').MaintenanceResult>}
 */
export async function runMaintenance(root, serviceId) {
  if (serviceId !== 'media') throw new Error(`no maintenance mechanism is wired for "${serviceId}" — only "media" has one today`);
  const serviceDir = join(root, serviceId);
  const envPath = join(serviceDir, '.env');
  const env = existsSync(envPath) ? EnvFile.load(envPath).toObject() : {};

  const mod = (/** @type {string} */ rel) => import(pathToFileURL(join(serviceDir, rel)).href);
  const { Config } = await mod('src/config.js');
  const { Database } = await mod('src/db.js');
  const { FileStore } = await mod('src/store/file-store.js');
  const { TicketStore } = await mod('src/store/ticket-store.js');
  const { LocalStorage } = await mod('src/storage/local-storage.js');
  const { ImageProcessor } = await mod('src/domain/image-processor.js');
  const { MediaService } = await mod('src/domain/media-service.js');
  const { UrlSigner } = await mod('src/url-signer.js');
  const { Maintenance } = await mod('src/maintenance.js');

  const config = Config.fromEnv(env);
  const db = new Database(resolve(serviceDir, config.dbPath), { backupDir: config.dbBackupDir ? resolve(serviceDir, config.dbBackupDir) : undefined });
  try {
    const storage = await new LocalStorage(resolve(serviceDir, config.dataDir)).check();
    const service = new MediaService({
      files: new FileStore(db), tickets: new TicketStore(db), storage,
      images: new ImageProcessor({ maxPixels: config.maxImagePixels, quality: config.variantQuality }),
      signer: new UrlSigner(config.signingSecret, config.signingSecretPrevious),
      log: console,
      options: {
        publicBaseUrl: config.publicBaseUrl, maxUploadBytes: config.maxUploadBytes, allowedTypes: config.allowedTypes, variants: config.variants,
        stripImageMetadata: config.stripImageMetadata, signedUrlTtlSec: config.signedUrlTtlSec, uploadTicketTtlSec: config.uploadTicketTtlSec,
        deleteGraceMs: config.deleteGraceDays * 86_400_000,
        maxConcurrentVariants: config.maxConcurrentVariants, variantWaitTimeoutMs: config.variantWaitTimeoutMs,
        trashGraceMs: config.trashGraceMs, trashMaxEntries: config.trashMaxEntries,
      },
    });
    return await new Maintenance({ service, log: console }).run('manual');
  } finally {
    db.close();
  }
}
