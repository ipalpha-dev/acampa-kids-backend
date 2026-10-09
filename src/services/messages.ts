import { config } from "../config";
import { emailSlug, hasEmailTwin, templateDefault, TEMPLATE_SLUGS, type TemplateKey } from "../messages/templates";
import { recordSms } from "../models/smsUsage";
import { campEditionId } from "./acting";
import { coreClient, ipalphaEnabled } from "./ipalpha";
import { IpalphaRejected, MESSAGE_RECIPIENTS_MAX, type MessageAudience, type MessageRecipient, type MessageStatus } from "./ipalpha/coreClient";

/**
 * Every SMS / e-mail Acampa sends goes through notifications-api by personId
 * with a project template (CONTRACTS §13): core resolves the contact and the
 * language, renders and delivers, and logs the access for the person. Acampa
 * never sees a phone or an e-mail address.
 *
 * `{link}` (APP_URL) is filled in here when the template uses it and the
 * caller did not. `{name}` (each recipient's own first name), `{aboutName}`
 * (the person the message is about — `aboutPersonId`; a recipient who may not
 * see them, or has no name, is skipped by core) and
 * `{birthdayNames}` are filled by core — Acampa never sends a name. A message
 * whose own variables cannot be filled is skipped (logged as a count), never
 * sent with a blank. Where Acampa
 * cannot read the member list (a role of the edition, today's birthdays),
 * `sendToRoles` hands core an `audience` and shared variables only — core
 * resolves the people, Acampa never sees them.
 * Best effort: a failure is logged (counts only) and never thrown into the
 * write that triggered it.
 */
export interface SendInput {
  personId: string;
  variables?: Record<string, string | number>;
  /** the person the message is about (a kid, a team member): core fills `{aboutName}` as the recipient may see it */
  aboutPersonId?: string;
}

export type SendSummary = Record<MessageStatus, number>;

/** filled by notifications-api per recipient (decision: apps never send names) */
const CORE_FILLED = new Set(["name", "aboutName", "birthdayNames"]);
/** notifications-api cap on `audience.excludePersonIds` */
const EXCLUDE_MAX = 1000;

export function appLink(): string {
  return config.appUrl || "";
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function sendSlug(slug: string, recipients: MessageRecipient[], editionId: string | null, aboutPersonId?: string): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, notMember: 0, noContact: 0, skipped: 0, failed: 0 };
  for (const batch of chunks(recipients, MESSAGE_RECIPIENTS_MAX)) {
    const results = await coreClient().sendTemplate({ templateSlug: slug, recipients: batch, ...(editionId ? { editionId } : {}), ...(aboutPersonId ? { aboutPersonId } : {}) });
    for (const r of results) summary[r.status]++;
  }
  return summary;
}

/** The e-mail twin after its SMS: a failure is logged and never undoes the SMS leg (no mark is lifted for it). */
async function sendTwin(label: string, send: () => Promise<number>, slug: string): Promise<void> {
  try {
    void recordSms({ at: new Date(), templateSlug: slug, channel: "email", sent: await send() });
  } catch (err) {
    console.error(`[messages] ${label} e-mail failed (${err instanceof Error ? err.message : "error"}) — the SMS went out`);
  }
}

/** Sends one catalog message (and its e-mail twin, when the catalog has one) to every recipient. */
export async function sendMessage(key: TemplateKey, recipients: SendInput[], label: string = key): Promise<SendSummary | null> {
  const unique = [...new Map(recipients.filter((r) => r.personId).map((r) => [r.personId, r])).values()];
  if (unique.length === 0 || !ipalphaEnabled()) return null;
  const slug = TEMPLATE_SLUGS[key];
  const byAbout = new Map<string, SendInput[]>();
  for (const r of unique) byAbout.set(r.aboutPersonId ?? "", [...(byAbout.get(r.aboutPersonId ?? "") ?? []), r]);
  let skipped = 0;
  const as = (s: string, list: SendInput[]): MessageRecipient[] =>
    list.flatMap((r) => {
      const variables = appVariables(templateDefault(s)?.variables ?? [], r.variables);
      if (variables) return [{ personId: r.personId, variables }];
      skipped++;
      return [];
    });
  try {
    const editionId = await campEditionId();
    const sms: SendSummary = { sent: 0, notMember: 0, noContact: 0, skipped: 0, failed: 0 };
    for (const [about, list] of byAbout) {
      const part = await sendSlug(slug, as(slug, list), editionId, about || undefined);
      for (const k of Object.keys(sms) as MessageStatus[]) sms[k] += part[k];
    }
    // counts only: a message whose variables Acampa cannot fill is never sent half-empty
    if (skipped) console.warn(`[messages] ${label}: ${skipped} not sent — a variable could not be filled`);
    sms.skipped += skipped;
    void recordSms({ at: new Date(), templateSlug: slug, channel: "sms", sent: sms.sent });
    if (hasEmailTwin(slug)) {
      await sendTwin(label, async () => {
        let sent = 0;
        for (const [about, list] of byAbout) sent += (await sendSlug(emailSlug(slug), as(emailSlug(slug), list), editionId, about || undefined)).sent;
        return sent;
      }, emailSlug(slug));
    }
    console.log(`[messages] ${label}: ${sms.sent} sent, ${sms.noContact} without contact, ${sms.notMember} not members, ${sms.failed} failed`);
    if (sms.skipped) console.log(`[messages] ${label}: ${sms.skipped} skipped (no name, the person not visible to them, or a variable Acampa could not fill)`);
    return sms;
  } catch (err) {
    logFailure(label, err);
    return null;
  }
}

/** A refused / failed send is logged (reason only) and never surfaces to the person whose action triggered it. */
function logFailure(label: string, err: unknown): void {
  if (err instanceof IpalphaRejected) console.warn(`[messages] ${label} refused by core (${err.status} ${err.reason}) — not sent`);
  else console.error(`[messages] ${label} failed (${err instanceof Error ? err.message : "error"})`);
}

/**
 * The variables Acampa sends: the caller's and `{link}` — never the ones core fills. null when a declared one cannot be
 * filled (empty, or APP_URL unset): that message is not sent at all, never with a blank or a placeholder.
 */
function appVariables(declared: readonly string[], given: Record<string, string | number> = {}): Record<string, string> | null {
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(given)) if (!CORE_FILLED.has(k) && String(val).trim()) v[k] = String(val);
  if (declared.includes("link") && v.link === undefined && appLink()) v.link = appLink();
  return declared.every((k) => CORE_FILLED.has(k) || v[k] !== undefined) ? v : null;
}

/** accepted count (0 = nothing to send), or why nothing is known to have gone out */
export type AudienceOutcome = number | "refused" | "failed";

/**
 * Sends one catalog message (and its e-mail twin) to the members of `roles` in the camp's edition (+ project-wide),
 * minus `excludePersonIds`; with `birthdayOf` core sends only to those who see a birthday kid of those roles
 * (`{birthdayNames}`). Variables are shared by everyone. Returns how many messages core accepted (0 = nothing to
 * send), `refused` when core clearly said no (nothing went out — a once-only mark may be lifted), `failed` when it is
 * unknown (timeout / network: core may have accepted — never retried).
 */
export async function sendToRoles(
  key: TemplateKey,
  roles: string[],
  opts: { birthdayOf?: string[]; excludePersonIds?: string[]; variables?: Record<string, string | number>; aboutPersonId?: string } = {},
  label: string = key,
): Promise<AudienceOutcome> {
  if (roles.length === 0 || !ipalphaEnabled()) return 0;
  const slug = TEMPLATE_SLUGS[key];
  const exclude = [...new Set(opts.excludePersonIds ?? [])];
  if (exclude.length > EXCLUDE_MAX) {
    // core takes at most EXCLUDE_MAX: dropping some would message people who must not get it — not sent at all
    console.warn(`[messages] ${label}: not sent — ${exclude.length} people to leave out (max ${EXCLUDE_MAX})`);
    return 0;
  }
  try {
    const editionId = await campEditionId();
    const audience: MessageAudience = {
      roles,
      ...(editionId ? { editionId } : {}),
      ...(opts.birthdayOf?.length ? { birthdayOf: { roles: opts.birthdayOf } } : {}),
      ...(exclude.length ? { excludePersonIds: exclude } : {}),
    };
    const variables = appVariables(templateDefault(slug)?.variables ?? [], opts.variables);
    if (!variables) {
      console.warn(`[messages] ${label}: not sent — a variable could not be filled`);
      return 0;
    }
    const about = opts.aboutPersonId ? { aboutPersonId: opts.aboutPersonId } : {};
    const { accepted } = await coreClient().sendTemplateToAudience({ templateSlug: slug, audience, variables, ...about });
    void recordSms({ at: new Date(), templateSlug: slug, channel: "sms", sent: accepted });
    const twin = hasEmailTwin(slug) ? appVariables(templateDefault(emailSlug(slug))?.variables ?? [], opts.variables) : null;
    if (twin) await sendTwin(label, async () => (await coreClient().sendTemplateToAudience({ templateSlug: emailSlug(slug), audience, variables: twin, ...about })).accepted, emailSlug(slug));
    console.log(`[messages] ${label}: ${accepted} accepted for ${roles.length} role(s)`);
    return accepted;
  } catch (err) {
    logFailure(label, err);
    return err instanceof IpalphaRejected ? "refused" : "failed";
  }
}

/** pt-BR preview of a catalog message with the given variables (settings / rooms-apply previews). */
export function previewMessage(key: TemplateKey, variables: Record<string, string | number>): string {
  const body = templateDefault(TEMPLATE_SLUGS[key])?.body["pt-BR"] ?? "";
  return body.replace(/\{(\w+)\}/g, (_, k: string) => (variables[k] !== undefined ? String(variables[k]) : k === "link" ? appLink() : `{${k}}`));
}
