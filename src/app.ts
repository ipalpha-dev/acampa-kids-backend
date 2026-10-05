import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config";
import { onAppError } from "./services/coreErrors";
import { campWriteGuard } from "./middleware/camp";
import peopleRoutes from "./routes/people";
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

/**
 * The HTTP app (every route + the core error handler), without the boot side
 * effects of index.ts — so feature tests mount exactly what production serves.
 */
export function createApp(opts: { logRequests?: boolean } = {}): Hono {
  const app = new Hono();

  if (opts.logRequests) app.use(logger());
  app.use(
    cors({
      origin: config.corsOrigin,
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  // core refused / revoked a role token mid-request → the session ends gracefully (services/coreErrors.ts)
  app.onError(onAppError);

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
  // person data at use: names (paged), data kinds via the acting role token, health lists (services/people.ts)
  app.route("/api/people", peopleRoutes);

  return app;
}
