import { ObjectId } from "mongodb";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config";
import { getDb } from "../db";
import { activeCampId } from "./campContext";
import type { Role, Session } from "../types";

const secret = new TextEncoder().encode(config.jwtSecret);

export async function createSession(
  userId: string,
  role: Session["role"],
  campId: string = activeCampId(),
  /** session length override (IPAlpha's `sessionIdleHours`); default `config.sessionHours` */
  hours?: number,
): Promise<{ token: string; session: Session }> {
  const db = await getDb();
  const now = new Date();
  const ttlHours = hours !== undefined && Number.isFinite(hours) && hours > 0 ? hours : config.sessionHours;
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  const { insertedId } = await db.collection("sessions").insertOne({
    userId,
    role,
    campId,
    createdAt: now,
    expiresAt,
    hours: ttlHours,
  });

  const session: Session = {
    _id: insertedId.toString(),
    userId,
    role,
    campId,
    createdAt: now,
    expiresAt,
    hours: ttlHours,
  };

  const token = await new SignJWT({
    sid: session._id,
    role,
    camp: campId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);

  return { token, session };
}

export async function verifySessionToken(
  token: string,
): Promise<{ userId: string; sessionId: string; role: Role; campId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub || typeof payload.sid !== "string") return null;

    // make sure the session still exists and hasn't expired
    const db = await getDb();
    const session = await db.collection("sessions").findOne({
      _id: new ObjectId(payload.sid),
    });

    if (!session) return null;
    if (session.expiresAt <= new Date()) {
      await db.collection("sessions").deleteOne({ _id: session._id });
      return null;
    }

    // sessions created before the multi-year camps feature carry no campId — the active camp
    const campId = typeof session.campId === "string" ? session.campId : (typeof payload.camp === "string" ? payload.camp : activeCampId());
    return { userId: payload.sub, sessionId: payload.sid, role: session.role as Role, campId };
  } catch {
    return null;
  }
}

/** Logs a person out everywhere: every session of that user (any role) is dropped. */
export async function revokeUserSessions(userId: string): Promise<number> {
  const db = await getDb();
  const res = await db.collection("sessions").deleteMany({ userId });
  return res.deletedCount;
}

/**
 * Profile / camp switch: the current session is revoked and a new one issued
 * with the SAME length it was opened with (`hours`, fixed at login — e.g.
 * IPAlpha's `sessionIdleHours`). Sessions from before `hours` existed get
 * `config.sessionHours`.
 */
export async function replaceSession(
  sessionId: string,
  userId: string,
  role: Session["role"],
  campId: string,
): Promise<{ token: string; session: Session }> {
  const db = await getDb();
  const current = await db.collection("sessions").findOne({ _id: new ObjectId(sessionId) }, { projection: { hours: 1 } });
  const hours = typeof current?.hours === "number" ? current.hours : undefined;
  await db.collection("sessions").deleteOne({ _id: new ObjectId(sessionId) });
  return createSession(userId, role, campId, hours);
}

export async function revokeSession(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.collection("sessions").deleteOne({ _id: new ObjectId(sessionId) });
}
