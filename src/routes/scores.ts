import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireRole } from "../middleware/roles";
import { findCamperById, logCheckin, setCamperCheckin } from "../models/campers";
import { findEventById } from "../models/schedule";
import { deleteScore, eventScanPoints, findScoreById, insertScore, listScores, repointEventScans, scannedForEvent, teamTotal } from "../models/scores";
import { getSettings, updateSettings } from "../models/settings";
import { findTeamById } from "../models/teams";
import { campInProgress, campPeriod } from "../services/camp";
import { publish, rearmWindows } from "../services/realtime";
import { canKeepScore, canLaunchScore, canSeeCamper, canSeeScores, resolveScope } from "../services/scope";
import { parseWindow } from "./settings";
import type { ScoreEntry } from "../types";
import { firstName, namesOf } from "../services/people";

type Env = { Variables: AuthVariables };

const scores = new Hono<Env>();

const NOTE_MAX = 200;
const POINTS_MAX = 100_000;
/** note stamped on a church check-in the SYSTEM made because the kid's wristband scored points before anyone checked them in */
export const AUTO_CHECKIN_NOTE = "Check-in feito pelo sistema ao pontuar o crachá";

/** the ledger note of a scan line: the event it belongs to */
function scanNote(e: { emoji: string; title: string }): string {
  return `${e.emoji} ${e.title}`.trim().slice(0, NOTE_MAX);
}

function parseScanPoints(v: unknown): number | null {
  const points = Number(v);
  return Number.isInteger(points) && points > 0 && points <= POINTS_MAX ? points : null;
}

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeScore(e: ScoreEntry) {
  return {
    id: e._id,
    teamId: e.teamId,
    points: e.points,
    kind: e.kind,
    note: e.note,
    /** the scanned kid (person id) */
    camperId: e.camperId,
    eventId: e.eventId,
    byPersonId: e.byPersonId,
    createdAt: e.createdAt,
  };
}

/** admin, or a GAME organizer (Settings → Placar) */
const requireScorekeeper = createMiddleware<Env>(async (c, next) => {
  if (!canKeepScore(await resolveScope(c.get("user")))) {
    return c.json({ error: { code: "FORBIDDEN", message: "Só a organização dos jogos altera o placar." } }, 403);
  }
  await next();
});

/** admin, GAME organizer or SCORE helper: may run the QR scan (bulk points by event) */
const requireScanner = createMiddleware<Env>(async (c, next) => {
  if (!canLaunchScore(await resolveScope(c.get("user")))) {
    return c.json({ error: { code: "FORBIDDEN", message: "Só a organização dos jogos e os ajudantes do placar lançam pontos." } }, 403);
  }
  await next();
});

/** Is the scoreboard open for writes right now? (a camp day, or Settings → Geral → "Placar em rascunho" on) */
async function scoreOpen(): Promise<boolean> {
  const [settings, period] = await Promise.all([getSettings(), campPeriod()]);
  return settings.scoreDraft || campInProgress(period);
}

/** every write is refused outside the camp days unless the draft (rehearsal) mode is on */
const requireScoreOpen = createMiddleware<Env>(async (c, next) => {
  if (!(await scoreOpen())) {
    return c.json({ error: { code: "SCORE_CLOSED", message: "O placar só recebe pontos nos dias do acampamento (ou com o rascunho do placar ligado em Configurações → Geral)." } }, 409);
  }
  await next();
});

scores.use("*", requireAuth);

/** GET /api/scores — the whole ledger, newest first (any team member / admin: the scoreboard is public inside the app — except during the suspense window, when only whoever launches points gets it). */
scores.get("/", requireRole("admin", "staff"), async (c) => {
  const visible = canSeeScores(await resolveScope(c.get("user")), await getSettings());
  return c.json({ scores: visible ? (await listScores()).map(serializeScore) : [] });
});

/**
 * PUT /api/scores/suspense  { from, until }
 * The SUSPENSE window: between `from` and `until` the ledger is withheld from
 * everyone who does not launch points (the ordinary team sees the Placar with
 * the totals hidden); points keep being written normally and the board comes
 * back by itself at `until`. Both null clears it. Admin, organizer or game
 * organizer — it lives in the settings but game organizers may not touch
 * those, hence this route.
 */
scores.put("/suspense", requireRole("admin", "staff"), requireScorekeeper, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const w = parseWindow(body);
  if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
  if ((w.from === null) !== (w.until === null)) return fail(c, "WINDOW_INVALID", "Informe o início e o fim do suspense (ou limpe os dois).");
  await updateSettings({ scoreHideWindow: w });
  publish("settings", "scores");
  void rearmWindows();
  return c.json({ scoreHideWindow: { from: w.from?.toISOString() ?? null, until: w.until?.toISOString() ?? null } });
});

/**
 * POST /api/scores  { teamId, points, note? }
 * `points` > 0 gives, < 0 takes. Written by the admin or a game organizer (score helpers only scan).
 */
scores.post("/", requireRole("admin", "staff"), requireScorekeeper, requireScoreOpen, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const team = typeof body.teamId === "string" ? await findTeamById(body.teamId) : null;
  if (!team) return fail(c, "TEAM_NOT_FOUND", "Time não encontrado.", 404);
  const points = Number(body.points);
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > POINTS_MAX) return fail(c, "POINTS_INVALID", "Informe uma quantidade inteira de pontos (diferente de zero).");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";
  const user = c.get("user");
  const entry = await insertScore({ teamId: team._id, points, kind: points > 0 ? "add" : "remove", note, camperId: null, eventId: null, byPersonId: user.id });
  publish("scores");
  return c.json({ score: serializeScore(entry) }, 201);
});

/**
 * POST /api/scores/scan  { camperId, eventId, points }
 * Bulk giving at a door: the kid's QR was scanned, their TEAM gets `points`
 * (> 0) for the programme EVENT. The event is the unit of the round, shared
 * across every device: a kid counts only once per event (409
 * ALREADY_SCANNED), and every scan of an event carries the same points —
 * sending a different value re-points the earlier scans of that event.
 * Admin, game organizer or score helper.
 *
 * A kid who scores is obviously at the camp: if they still have no church
 * check-in, the system checks them in now (stamped with the scanner's name
 * and a note saying the system did it) and the audit line says so.
 */
scores.post("/scan", requireRole("admin", "staff"), requireScanner, requireScoreOpen, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const event = typeof body.eventId === "string" ? await findEventById(body.eventId) : null;
  if (!event) return fail(c, "EVENT_NOT_FOUND", "Escolha o evento da programação.", 404);
  const points = parseScanPoints(body.points);
  if (points === null) return fail(c, "POINTS_INVALID", "Informe uma quantidade inteira de pontos (maior que zero).");
  const user = c.get("user");
  const camper = typeof body.camperId === "string" ? await findCamperById(body.camperId) : null;
  if (!camper || !canSeeCamper(await resolveScope(user), camper)) return fail(c, "CAMPER_NOT_FOUND", "Criança não encontrada.", 404);
  const first = firstName((await namesOf([camper._id])).get(camper._id)?.name ?? "") || "Esta criança";
  const team = camper.team ? await findTeamById(camper.team) : null;
  if (!team) return fail(c, "CAMPER_WITHOUT_TEAM", `${first} não está em nenhum time.`, 409);
  if (await scannedForEvent(event._id, camper._id)) return fail(c, "ALREADY_SCANNED", `${first} já foi lido(a) neste evento.`, 409);
  const note = scanNote(event);
  // one value per event: a change re-points everyone scanned before
  const current = await eventScanPoints(event._id);
  if (current !== null && current !== points) await repointEventScans(event._id, points, note);
  const entry = await insertScore({ teamId: team._id, points, kind: "add", note, camperId: camper._id, eventId: event._id, byPersonId: user.id });
  publish("scores");
  let checkedIn = false;
  if (!camper.checkin) {
    const stamp = { at: new Date(), byPersonId: user.id, byRole: user.coreRole, note: AUTO_CHECKIN_NOTE };
    await setCamperCheckin(camper._id, "church", stamp);
    await logCheckin({ who: "camper", personId: camper._id, kind: "church", action: "checkin", ...stamp });
    publish("campers");
    checkedIn = true;
  }
  return c.json({ score: serializeScore(entry), team: { id: team._id, name: team.name, color: team.color }, camperName: first, checkedIn }, 201);
});

/**
 * PUT /api/scores/scan/:eventId  { points }
 * Changes the points of EVERY scan already made for the event (the value is
 * one per event). No-op when nobody was scanned yet. Same callers as the scan.
 */
scores.put("/scan/:eventId", requireRole("admin", "staff"), requireScanner, requireScoreOpen, async (c) => {
  const event = await findEventById(c.req.param("eventId"));
  if (!event) return fail(c, "EVENT_NOT_FOUND", "Evento não encontrado.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const points = body ? parseScanPoints(body.points) : null;
  if (points === null) return fail(c, "POINTS_INVALID", "Informe uma quantidade inteira de pontos (maior que zero).");
  const changed = await repointEventScans(event._id, points, scanNote(event));
  if (changed > 0) publish("scores");
  return c.json({ changed });
});

/** POST /api/scores/reset/:teamId  { note? } — zeroes the team: writes a line cancelling the current total (history kept). */
scores.post("/reset/:teamId", requireRole("admin", "staff"), requireScorekeeper, requireScoreOpen, async (c) => {
  const team = await findTeamById(c.req.param("teamId"));
  if (!team) return fail(c, "TEAM_NOT_FOUND", "Time não encontrado.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";
  const total = await teamTotal(team._id);
  if (total === 0) return fail(c, "ALREADY_ZERO", `${team.name} já está com zero pontos.`, 409);
  const user = c.get("user");
  const entry = await insertScore({ teamId: team._id, points: -total, kind: "reset", note, camperId: null, eventId: null, byPersonId: user.id });
  publish("scores");
  return c.json({ score: serializeScore(entry) }, 201);
});

/** DELETE /api/scores/:id — removes one line (a mistake), which also undoes its points. A score helper only removes their OWN scan lines. */
scores.delete("/:id", requireRole("admin", "staff"), requireScanner, requireScoreOpen, async (c) => {
  const entry = await findScoreById(c.req.param("id"));
  if (!entry) return fail(c, "SCORE_NOT_FOUND", "Lançamento não encontrado.", 404);
  const user = c.get("user");
  if (!canKeepScore(await resolveScope(user)) && (entry.byPersonId !== user.id || !entry.camperId)) {
    return c.json({ error: { code: "FORBIDDEN", message: "Você só pode apagar as suas próprias leituras de crachá." } }, 403);
  }
  const ok = await deleteScore(entry._id);
  if (!ok) return fail(c, "SCORE_NOT_FOUND", "Lançamento não encontrado.", 404);
  publish("scores");
  return c.json({ success: true });
});

export default scores;
