import { config } from "../config";
import { emailSlug, hasEmailTwin, templateDefault, TEMPLATE_SLUGS, type TemplateKey } from "../messages/templates";
import { recordSms } from "../models/smsUsage";
import { campEditionId } from "./acting";
import { coreClient, ipalphaEnabled } from "./ipalpha";
import { MESSAGE_RECIPIENTS_MAX, type MessageRecipient, type MessageStatus } from "./ipalpha/coreClient";
import { firstName, namesOf } from "./people";

/**
 * Every SMS / e-mail Acampa sends goes through notifications-api by personId
 * with a project template (CONTRACTS §13): core resolves the contact and the
 * language, renders and delivers, and logs the access for the person. Acampa
 * never sees a phone or an e-mail address.
 *
 * `{name}` (the recipient's first name) and `{link}` (APP_URL) are filled in
 * here when the template uses them and the caller did not. Best effort: a
 * failure is logged (counts only) and never thrown into the write that
 * triggered it.
 */
export interface SendInput {
  personId: string;
  variables?: Record<string, string | number>;
}

export type SendSummary = Record<MessageStatus, number>;

export function appLink(): string {
  return config.appUrl || "";
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function sendSlug(slug: string, recipients: MessageRecipient[], editionId: string | null): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, notMember: 0, noContact: 0, failed: 0 };
  for (const batch of chunks(recipients, MESSAGE_RECIPIENTS_MAX)) {
    const results = await coreClient().sendTemplate({ templateSlug: slug, recipients: batch, ...(editionId ? { editionId } : {}) });
    for (const r of results) summary[r.status]++;
  }
  return summary;
}

/** Sends one catalog message (and its e-mail twin, when the catalog has one) to every recipient. */
export async function sendMessage(key: TemplateKey, recipients: SendInput[], label: string = key): Promise<SendSummary | null> {
  const unique = [...new Map(recipients.filter((r) => r.personId).map((r) => [r.personId, r])).values()];
  if (unique.length === 0 || !ipalphaEnabled()) return null;
  const slug = TEMPLATE_SLUGS[key];
  const vars = templateDefault(slug)?.variables ?? [];
  try {
    const names = vars.includes("name") && unique.some((r) => r.variables?.name === undefined) ? await namesOf(unique.map((r) => r.personId)) : new Map();
    const link = appLink();
    const full: MessageRecipient[] = unique.map((r) => {
      const v: Record<string, string> = {};
      for (const [k, val] of Object.entries(r.variables ?? {})) v[k] = String(val);
      if (vars.includes("name") && v.name === undefined) v.name = firstName(names.get(r.personId)?.name ?? "");
      if (vars.includes("link") && v.link === undefined) v.link = link;
      // notifications-api refuses the whole batch when a declared variable is missing (§18): never leave one out
      for (const k of vars) v[k] ??= "";
      return { personId: r.personId, variables: v };
    });
    const editionId = await campEditionId();
    const sms = await sendSlug(slug, full, editionId);
    void recordSms({ at: new Date(), templateSlug: slug, channel: "sms", sent: sms.sent });
    if (hasEmailTwin(slug)) {
      const mail = await sendSlug(emailSlug(slug), full, editionId);
      void recordSms({ at: new Date(), templateSlug: emailSlug(slug), channel: "email", sent: mail.sent });
    }
    console.log(`[messages] ${label}: ${sms.sent} sent, ${sms.noContact} without contact, ${sms.notMember} not members, ${sms.failed} failed`);
    return sms;
  } catch (err) {
    console.error(`[messages] ${label} failed (${err instanceof Error ? err.message : "error"})`);
    return null;
  }
}

/** pt-BR preview of a catalog message with the given variables (settings / rooms-apply previews). */
export function previewMessage(key: TemplateKey, variables: Record<string, string | number>): string {
  const body = templateDefault(TEMPLATE_SLUGS[key])?.body["pt-BR"] ?? "";
  return body.replace(/\{(\w+)\}/g, (_, k: string) => (variables[k] !== undefined ? String(variables[k]) : k === "link" ? appLink() : `{${k}}`));
}
