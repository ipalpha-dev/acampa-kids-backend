import { websocket } from "hono/bun";
import { config } from "./config";
import { createApp } from "./app";
import { getDb } from "./db";
import { ensureCategoryIndexes } from "./models/categories";
import { ensureTransportIndexes } from "./models/transports";
import { ensureBedroomIndexes } from "./models/bedrooms";
import { ensureStaffIndexes } from "./models/staff";
import { ensureScheduleIndexes } from "./models/schedule";
import { ensureCamperIndexes } from "./models/campers";
import { ensureParticipantIndexes } from "./models/participants";
import { ensureUserCampStateIndexes } from "./models/userCampState";
import { ensureSessionIndexes } from "./services/session";
import { ensurePrepIndexes } from "./models/preparation";
import { ensureInstructionIndexes } from "./models/instructions";
import { ensureOccurrenceIndexes } from "./models/occurrences";
import { ensureMedicationIndexes } from "./models/medications";
import { ensureFileIndexes } from "./models/files";
import { ensureSmsUsageIndex } from "./models/smsUsage";
import { ensureTeamIndexes } from "./models/teams";
import { ensureScoreIndexes } from "./models/scores";
import { ensureCamperLookupIndexes } from "./models/camperLookups";
import { ensureGalleryIndexes } from "./models/gallery";
import { ensureLoginStateIndexes } from "./models/ipalphaLoginStates";
import { logIpalphaStatus } from "./services/ipalpha";
import { rearmActiveCampTimers } from "./services/realtime";
import { sendCheckinReminder, syncParentWelcomes, syncWelcomes } from "./services/notify";
import { backfillGalleryFaces } from "./services/galleryFaces";
import { ensureFirstCamp } from "./services/campMigration";
import { ensureCampsCollection } from "./models/camps";
import { activeCamp, activeCampId, withCamp } from "./services/campContext";
import { clearIndexFailures, markBootError, markBooted, registerInfo } from "./services/readiness";
import { dispatchState, startDispatchChannel } from "./services/dispatchChannel";
import { ensureDispatchDeliveryIndexes } from "./models/dispatchDeliveries";
import { ensureImportJobIndexes, pruneImportJobs } from "./models/importJobs";
import { ensureImportConflictIndexes } from "./models/importConflicts";
import { catchUpUnfinished } from "./services/personImports";

const app = createApp({ logRequests: true, bootGate: true });

const { port } = config;
// the dispatch app channel is a peer: shown on /ready as info, never a readiness gate
registerInfo("dispatch", dispatchState);

// listen FIRST: /live answers at once, /ready (and /api/*) wait for our own infra — boot never waits on a peer
Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
  // Bun drops idle connections after 10s by default; reasoning models (AI helper) can stay silent longer
  idleTimeout: 255,
});
console.log(`🏕️  Camping backend listening on http://localhost:${port} (booting…)`);

/**
 * Mongo + indexes + the active camp; retried with backoff until Mongo answers (the pod stays live, not ready).
 * Indexes never block it (decision 91): an index Mongo refuses is logged by name + code, `/ready` reports
 * `indexes: "degraded"` (still 200) and the app serves without it — see services/indexes.ts.
 */
async function boot(): Promise<void> {
  clearIndexFailures();
  console.log("Connecting to MongoDB…");
  await getDb();
  await ensureCampsCollection();
  await ensureFirstCamp();
  console.log(`🏕️  active camp: "${activeCamp().label}" (${activeCampId()})`);
  await ensureSessionIndexes();
  await ensureUserCampStateIndexes();
  await ensureParticipantIndexes();
  await ensureLoginStateIndexes(); // IPAlpha sign-ins in flight (TTL 10 min)
  await ensureDispatchDeliveryIndexes(); // webhook delivery ids (TTL 7 days, ids only)
  await ensureImportJobIndexes(); // imports Acampa started (ids only, decision 77)
  await ensureImportConflictIndexes(); // import values waiting for a decision (decision 78)
  await ensureCamperLookupIndexes();
  await ensureCategoryIndexes();
  await ensureTransportIndexes();
  await ensureStaffIndexes();
  await ensureBedroomIndexes();
  await ensureScheduleIndexes();
  await ensureCamperIndexes();
  await ensurePrepIndexes();
  await ensureInstructionIndexes();
  await ensureOccurrenceIndexes();
  await ensureMedicationIndexes();
  await ensureFileIndexes();
  await ensureSmsUsageIndex(); // the SMS cost counter on the "Sobre" page
  await ensureTeamIndexes();
  await ensureScoreIndexes();
  await ensureGalleryIndexes();
  console.log(`MongoDB connected → ${config.dbName}`);
}

async function bootWithRetry(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await boot();
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : "boot failed";
      markBootError(message);
      const wait = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      console.error(`boot: ${message} — retrying in ${wait / 1000}s`);
      await Bun.sleep(wait);
    }
  }
  markBooted();
  void backfillGalleryFaces();
  // re-arm the check-in window timers (they live in memory) — the ACTIVE camp only
  await rearmActiveCampTimers(); // check-in, team access and parents' windows + the check-in reminder + the daily birthday timer
  void withCamp(activeCampId(), async () => {
    await syncWelcomes(); // the team window may have opened while the server was down
    await syncParentWelcomes();
    await sendCheckinReminder(); // the reminder instant may have passed while the server was down
  });
  logIpalphaStatus();
  // decision 77: imports that were running while this process was down are caught up from persons-api (never awaited)
  void pruneImportJobs()
    .then(() => catchUpUnfinished())
    .then((n) => n && console.log(`[imports] caught up ${n} import(s) at boot`))
    .catch(() => console.warn("[imports] boot catch-up failed — the app channel connect / the importer's next read tries again"));
  // the ONE app-channel socket (§21): started now, never awaited — reconnects on its own (and catches up on every connect)
  startDispatchChannel();
  console.log("🏕️  ready");
}

void bootWithRetry();
