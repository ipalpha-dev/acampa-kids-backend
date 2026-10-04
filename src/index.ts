import { Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config";
import { getDb } from "./db";
import { ensureIndexes, ensureLoginAccount, ensureRosterLogins, loadAdminPhones } from "./models/users";
import { ensureCategoryIndexes } from "./models/categories";
import { ensureTransportIndexes } from "./models/transports";
import { ensureBedroomIndexes } from "./models/bedrooms";
import { ensureStaffIndexes } from "./models/staff";
import { ensureScheduleIndexes } from "./models/schedule";
import { backfillParentEditedAt, ensureCamperIndexes } from "./models/campers";
import { ensurePrepIndexes } from "./models/preparation";
import { ensureInstructionIndexes } from "./models/instructions";
import { ensureOccurrenceIndexes } from "./models/occurrences";
import { ensureMedicationIndexes } from "./models/medications";
import { ensureFileIndexes } from "./models/files";
import { ensureSmsUsageIndex } from "./models/smsUsage";
import { ensureTeamIndexes } from "./models/teams";
import { ensureScoreIndexes } from "./models/scores";
import { ensureCamperLookupIndexes } from "./models/camperLookups";
import { ensureCamperImportIndexes } from "./models/camperImports";
import { ensureGalleryIndexes } from "./models/gallery";
import { ensureLoginStateIndexes } from "./models/ipalphaLoginStates";
import { logIpalphaStatus } from "./services/ipalpha";
import teamRoutes from "./routes/teams";
import scoreRoutes from "./routes/scores";
import galleryRoutes from "./routes/gallery";
import authRoutes from "./routes/auth";
import adminsRoutes from "./routes/admins";
import categoryRoutes from "./routes/categories";
import transportRoutes from "./routes/transports";
import staffRoutes from "./routes/staff";
import bedroomRoutes from "./routes/bedrooms";
import scheduleRoutes from "./routes/schedule";
import camperRoutes from "./routes/campers";
import realtimeRoutes from "./routes/realtime";
import settingsRoutes from "./routes/settings";
import preparationRoutes from "./routes/preparation";
import instructionRoutes from "./routes/instructions";
import occurrenceRoutes from "./routes/occurrences";
import medicationRoutes from "./routes/medications";
import fileRoutes from "./routes/files";
import aiRoutes from "./routes/ai";
import assistantRoutes from "./routes/assistant";
import cleanupRoutes from "./routes/cleanup";
import seedsRoutes from "./routes/seeds";
import wizardRoutes from "./routes/wizard";
import camperImportRoutes from "./routes/camperImports";
import staffImportRoutes from "./routes/staffImports";
import workerRoutes from "./routes/worker";
import campRoutes from "./routes/camps";
import superRoutes from "./routes/super";
import { comteleEnabled } from "./services/comtele";
import { mailEnabled } from "./services/mail";
import { publish, rearmActiveCampTimers } from "./services/realtime";
import { sendBirthdayNotices, sendCheckinReminder, syncParentWelcomes, syncWelcomes } from "./services/notify";
import { backfillGalleryFaces } from "./services/galleryFaces";
import { ensureProbableGenderOnCampers, ensureProbablyGenreOnStaff } from "./services/camperSex";
import { normalizeBrazilPhone } from "./utils";
import { migrateToCamps } from "./services/campMigration";
import { ensureCampsCollection } from "./models/camps";
import { activeCamp, activeCampId, withCamp } from "./services/campContext";
import { campWriteGuard } from "./middleware/camp";

const app = new Hono();

app.use(logger());
app.use(
  cors({
    origin: config.corsOrigin,
    allowHeaders: ["content-type", "authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);

app.get("/health", (c) =>
  c.json({ status: "ok", smsProvider: comteleEnabled() ? "comtele" : "mock", mailProvider: mailEnabled() ? "sendgrid" : "mock" }),
);

// a history session (an archived year) may only read — every write, except /api/auth/* and the super admin, is refused here
app.use("/api/*", campWriteGuard);

app.route("/api/auth", authRoutes);
app.route("/api/admins", adminsRoutes);
app.route("/api/categories", categoryRoutes);
app.route("/api/transports", transportRoutes);
app.route("/api/staff", staffRoutes);
app.route("/api/bedrooms", bedroomRoutes);
app.route("/api/schedule", scheduleRoutes);
app.route("/api/campers", camperRoutes);
app.route("/api/camper-imports", camperImportRoutes);
app.route("/api/staff-imports", staffImportRoutes);
// background import worker callbacks (shared WORKER_SECRET, not a user session)
app.route("/api/worker", workerRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/cleanup", cleanupRoutes);
app.route("/api/seeds", seedsRoutes);
app.route("/api/wizard", wizardRoutes);
app.route("/api/preparation", preparationRoutes);
app.route("/api/instructions", instructionRoutes);
app.route("/api/occurrences", occurrenceRoutes);
// the medical team's daily medication checklist (admin / organizer / medical team)
app.route("/api/medications", medicationRoutes);
// camp teams (admin-managed) + the games scoreboard (admin / game organizers)
app.route("/api/teams", teamRoutes);
app.route("/api/scores", scoreRoutes);
// images for the WYSIWYG editor (upload: admin / organizer / medical; read: public, unguessable ids)
app.route("/api/files", fileRoutes);
// the camp's photo album (upload / edit / publish: admin + photographers; viewing: published photos for everyone)
app.route("/api/gallery", galleryRoutes);
// AI helper for the WYSIWYG editor (proxies the OpenAI-compatible gateway; AI_API_KEY)
app.route("/api/ai", aiRoutes);
// Read-only camp data assistant for admins and organizers.
app.route("/api/assistant", assistantRoutes);
// WebSocket: full snapshot on connect + live updates after every write (see services/realtime.ts)
app.route("/api/realtime", realtimeRoutes);
// the camps registry (multi-year): GET /active is public, the rest admin / organizer
app.route("/api/camps", campRoutes);
app.route("/api/super", superRoutes);

const { port } = config;

console.log("Connecting to MongoDB…");
const db = await getDb();
await ensureCampsCollection();
await migrateToCamps();
console.log(`🏕️  active camp: "${activeCamp().label}" (${activeCampId()})`);
await ensureIndexes();
await ensureLoginStateIndexes(); // IPAlpha sign-ins in flight (TTL 10 min)
await ensureCamperLookupIndexes();
await ensureCamperImportIndexes();
await ensureCategoryIndexes();
await ensureTransportIndexes();
await ensureStaffIndexes();
await ensureBedroomIndexes();
await ensureScheduleIndexes();
await ensureCamperIndexes();
{
  const n = await backfillParentEditedAt(); // one-off: older parent edits get the stamp
  if (n > 0) console.log(`🕓 parentEditedAt backfilled on ${n} camper(s)`);
}
await ensurePrepIndexes();
await ensureInstructionIndexes();
await ensureOccurrenceIndexes();
await ensureMedicationIndexes();
await ensureFileIndexes();
await ensureSmsUsageIndex(); // the SMS cost counter on the "Sobre" page
await ensureTeamIndexes(); // also migrates the legacy "equipe" category into teams
await ensureScoreIndexes();
await ensureGalleryIndexes();
void backfillGalleryFaces();
// The deployment owner is always able to recover the top-level admin profile.
// $addToSet preserves any parent/staff roles already held by the same phone.
if (config.superAdminPhone) {
  const phone = normalizeBrazilPhone(config.superAdminPhone);
  if (!phone) throw new Error("SUPER_ADMIN_PHONE must be a valid Brazilian mobile number with DDD.");
  const { created } = await ensureLoginAccount("Administrador", phone, "admin");
  if (created) console.log("🔑 super-admin login created from SUPER_ADMIN_PHONE");
}
await loadAdminPhones();
{
  const n = await ensureRosterLogins();
  console.log(
    `👤 roster logins: staff ${n.staffCreated} created / ${n.staffPhones} phones, parents ${n.parentsCreated} created / ${n.guardianPhones} phones`,
  );
}
void ensureProbablyGenreOnStaff()
  .then((r) => {
    if (r.updated > 0) publish("staff");
  })
  .catch((err) => console.error("staff sex backfill failed", err));
void ensureProbableGenderOnCampers()
  .then((r) => {
    if (r.updated > 0) publish("campers");
  })
  .catch((err) => console.error("camper gender backfill failed", err));
console.log(`MongoDB connected → ${config.dbName}`);
// re-arm the check-in window timers (they live in memory) — the ACTIVE camp only
await rearmActiveCampTimers(); // check-in, team access and parents' windows + the check-in reminder + the daily birthday timer
void withCamp(activeCampId(), async () => {
  await syncWelcomes(); // the team window may have opened while the server was down
  await syncParentWelcomes();
  await sendCheckinReminder(); // the reminder instant may have passed while the server was down
  await sendBirthdayNotices(); // 07:45 may have passed while the server was down
});

console.log(
  comteleEnabled()
    ? "Comtele SMS enabled (real OTP via SMS)."
    : "⚠️  COMTELE_API_KEY not set — running in MOCK mode: OTP codes are printed in this console.",
);
logIpalphaStatus();
console.log(
  mailEnabled()
    ? "SendGrid mail enabled (notification emails)."
    : "⚠️  SENDGRID_API_KEY / MAIL_FROM / PUBLIC_ORIGIN not set — notification emails are refused until they are.",
);

export default {
  port,
  fetch: app.fetch,
  websocket,
  // Bun drops idle connections after 10s by default; reasoning models (AI helper) can stay silent longer
  idleTimeout: 255,
};

console.log(`🏕️  Camping backend listening on http://localhost:${port}`);
