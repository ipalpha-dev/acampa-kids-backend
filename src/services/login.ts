import { addPersonId, ensureLoginAccount, findByPhone, toPublicUser, updateUser } from "../models/users";
import { findStaffByPhone } from "../models/staff";
import { listCampersOfGuardian } from "../models/campers";
import { getSettings, staffAccessOpen } from "../models/settings";
import { findCamp } from "../models/camps";
import { staffHasAccess } from "./scope";
import { availableRolesOf } from "./roles";
import { createSession } from "./session";
import { activeCamp } from "./campContext";
import { switchableCamps } from "./campAccess";
import type { Locale } from "../i18n";
import type { CheckinWindow, Role, User } from "../types";
import { minutesBetween, pickActiveRole } from "../utils";

/**
 * The pieces every login path shares — legacy phone + code (local or relayed
 * through IPAlpha) and "Entrar com IPAlpha": who the account is, which profile
 * it lands on, the frozen / access-window gates and the session answer.
 */

/** `{ id, label, year, active }` of the session's camp — falls back to the active camp for pre-migration sessions. */
export async function sessionCamp(campId: string): Promise<{ id: string; label: string; year: number; active: boolean }> {
  const camp = (await findCamp(campId)) ?? activeCamp();
  return { id: camp._id, label: camp.label, year: camp.year, active: camp.active };
}

/**
 * Ordinary team members may only log in inside `settings.staffAccessWindow`.
 * Returns the error payload to send (403) when the window is closed, or null.
 */
export async function staffWindowError(phone: string, role: Role) {
  const settings = await getSettings();
  const now = new Date();
  let window: CheckinWindow;
  if (role === "parent") {
    // parents: their own access window (Settings → Geral)
    if (staffAccessOpen(settings.parentAccessWindow, now)) return null;
    window = settings.parentAccessWindow;
  } else {
    if (role !== "staff" && role !== "health_staff") return null;
    const me = await findStaffByPhone(phone);
    if (!me) return null;
    if (staffHasAccess(me._id, settings, now)) return null;
    window = settings.staffAccessWindow;
  }
  const { from, until } = window;
  const audience = role === "parent" ? "parent" : "staff";
  if (until && now >= until) {
    return {
      code: "STAFF_ACCESS_ENDED",
      message: "O acampamento já terminou. Esperamos você no ano que vem!",
      audience,
      opensAt: from?.toISOString() ?? null,
      closesAt: until.toISOString(),
    };
  }
  return {
    code: "STAFF_ACCESS_NOT_YET",
    audience,
    message: role === "parent" ? "O app ainda não está liberado para os pais." : "O app ainda não está liberado para a equipe.",
    opensAt: from?.toISOString() ?? null,
    closesAt: until?.toISOString() ?? null,
  };
}

/**
 * The profile a login LANDS on: the highest-privilege one the person may
 * ACTUALLY enter with (see services/roles#availableRolesOf). The first token
 * uses the highest role; the client immediately shows the profile chooser
 * when more than one is available. Falls back to the stored list only when
 * the data offers nothing, so
 * the error the person gets is still about their own account.
 */
export async function landingRole(user: User): Promise<{ role: Role; available: Role[] }> {
  const available = await availableRolesOf(user);
  return { role: pickActiveRole(available.length > 0 ? available : user.roles), available };
}

/**
 * The account behind a phone. Roster / guardian phones may not have a users
 * doc yet (the admin form never created one) — provision it, exactly like the
 * phone login always did.
 */
export async function resolveAccountByPhone(phone: string): Promise<User | null> {
  let user = await findByPhone(phone);
  if (!user) {
    const [member, kids] = await Promise.all([findStaffByPhone(phone), listCampersOfGuardian(phone)]);
    if (member?.phone) await ensureLoginAccount(member.name, member.phone, "staff");
    if (kids.length) await ensureLoginAccount(kids[0].guardianName || kids[0].name, phone, "parent");
    user = await findByPhone(phone);
  }
  return user;
}

export const NO_PROFILE_ERROR = {
  code: "NO_PROFILE",
  message: "Este telefone não tem nenhum perfil no acampamento deste ano.",
} as const;

/** 423 payload while the account is frozen after wrong codes, else null. */
export function frozenError(user: Pick<User, "frozenUntil">, now = new Date()) {
  if (!user.frozenUntil || user.frozenUntil <= now) return null;
  const minutesLeft = minutesBetween(now, user.frozenUntil);
  return {
    code: "ACCOUNT_FROZEN",
    message: `Conta bloqueada por tentativas incorretas. Tente novamente em ${minutesLeft} minuto(s).`,
    minutesLeft,
  };
}

/**
 * Success of any login: clears the pending code, unfreezes, remembers the
 * device language and issues the session (length `hours` — auth-api's
 * `sessionIdleHours` from the answer that proved this login — else
 * `SESSION_HOURS`). The length is stored on the session and reused on profile /
 * camp switches. The body is the exact `/otp/verify` answer.
 */
export async function completeLogin(user: User, role: Role, available: Role[], locale: Locale, hours?: number) {
  await updateUser(user._id, { otp: null, frozenUntil: null, locale });
  const fresh: User = { ...user, locale };

  const { token, session } = await createSession(fresh._id, role, undefined, hours);
  const camps = await switchableCamps(fresh, role);

  return {
    success: true as const,
    token,
    tokenExpiresAt: session.expiresAt.toISOString(),
    // `roles` is what the switcher offers: the profiles the DATA gives this person
    user: { ...toPublicUser(fresh), roles: available, activeRole: role },
    camp: await sessionCamp(session.campId),
    ...(camps ? { camps } : {}),
  };
}

/**
 * Remembers that this IPAlpha person IS this account (`ipalphaPersonIds`
 * `$addToSet`) — the only thing Acampa keeps from core. A person id already
 * bound to another account stays there; that is logged (ids only) and the
 * login of this, phone-proven, account goes on.
 */
export async function bindPersonId(user: Pick<User, "_id" | "ipalphaPersonIds">, personId: string): Promise<void> {
  if (user.ipalphaPersonIds.includes(personId)) return;
  if (!(await addPersonId(user._id, personId))) {
    console.warn(`[ipalpha] an IPAlpha person already bound to another account was not bound to account ${user._id}`);
  }
}
