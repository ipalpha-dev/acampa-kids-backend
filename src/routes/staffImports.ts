import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { coordinationContext } from "../services/acting";
import { registerAdult } from "../services/coreRegistration";
import { requireManager } from "../middleware/roles";
import { claimCamperImport, findCamperImport, insertCamperImport, markImportDictionaryPublished, updateCamperImport, upsertImportDictionary } from "../models/camperImports";
import { publish } from "../services/realtime";
import { appliedStatus, endFailedImportJob, jobFields, pausedImportsOf, resumeImportJob, startImportJob } from "../services/importJob";
import { syncWelcomes } from "../services/notify";
import { discardImportCategoryOptions, IMPORT_FILE_MAX_BYTES, publishImportDrafts } from "../services/camperImport";
import { analyzeStaffImport, applyStaffCategoryChoices, applyStaffDelta, insertImportStaff, STAFF_IMPORT_FIELDS } from "../services/staffImport";
import { getImportProgress, setImportProgress } from "../services/importProgress";
import { staffDataFromPreview } from "../services/staffImport";
import { insertStaff, listStaff } from "../models/staff";
import { importPhone } from "../services/camperImport";
import type { StaffImportReviewItem } from "../types";

type Env = { Variables: AuthVariables };
const routes=new Hono<Env>(); routes.use("*",requireAuth,requireManager);
const hash=(d:Uint8Array)=>createHash("sha256").update(d).digest("hex");
function fail(c:Context,code:string,message:string,status:400|404|409=400){return c.json({error:{code,message}},status)}
function serialize(r:NonNullable<Awaited<ReturnType<typeof findCamperImport>>>){return{id:r._id,fileName:r.fileName,fileType:r.fileType,status:r.status,dryRun:r.dryRun,columns:r.columns,dictionaries:r.dictionaries,reviews:r.reviews,preview:r.preview,skipped:r.skipped,createdItems:r.createdItems,startedAt:r.startedAt,finishedAt:r.finishedAt,error:r.error,...jobFields(r)};}
routes.get("/fields",(c)=>c.json({fields:STAFF_IMPORT_FIELDS.map(({key,label})=>({key,label}))}));
routes.get("/progress/:token",(c)=>c.json({progress:getImportProgress(c.req.param("token"))}));
/** The staff imports I started whose background health pass waits for my new sign-in (decision 50). */
routes.get("/needs-sign-in",async(c)=>c.json({imports:await pausedImportsOf(c,"staff")}));
/** Resumes a paused job with my fresh coordenação token (only the importer). */
routes.post("/:id/resume",async(c)=>{const result=await resumeImportJob(c,"staff");if(!result.ok)return c.json({error:result.error},result.status);return c.json({import:serialize(result.record)});});
routes.post("/analyze",async(c)=>{const body=await c.req.parseBody().catch(()=>null),file=body?.file;if(!(file instanceof File))return fail(c,"FILE_REQUIRED","Escolha um arquivo CSV ou Excel.");if(file.size>IMPORT_FILE_MAX_BYTES)return fail(c,"FILE_TOO_LARGE","A planilha pode ter no máximo 12 MB.");const progressId=typeof body?.progress==="string"?body.progress.slice(0,64):"";let mapping:Record<string,string|null>|undefined;try{mapping=typeof body?.mapping==="string"?JSON.parse(body.mapping):undefined}catch{return fail(c,"MAPPING_INVALID","O mapeamento é inválido.")}const data=new Uint8Array(await file.arrayBuffer()),user=c.get("user"),startedAt=new Date();let record=await insertCamperImport({subject:"staff",fileName:file.name,fileType:file.type,fileHash:hash(data),status:"analyzing",dryRun:true,columns:[],rows:[],dictionaries:[],reviews:[],preview:[],skipped:[],createdItems:[],dateFunction:"",startedAt,reviewStartedAt:null,finishedAt:null,finishedSmsSentAt:null,errorSmsSentAt:null,notificationCheckedAt:null,createdByPersonId:user.id,error:""});try{const a=await analyzeStaffImport({data,fileName:file.name,importId:record._id,mapping,signal:c.req.raw.signal,onProgress:progressId?(key,pct)=>setImportProgress(progressId,key,pct):undefined});record=(await updateCamperImport(record._id,{status:a.status,columns:a.columns,dictionaries:a.dictionaries,reviews:a.reviews,preview:a.preview,skipped:a.skipped,createdItems:a.createdItems,error:a.panicMessage}))!;await upsertImportDictionary(a.dictionaries,record._id);setImportProgress(progressId,"done",100);return c.json({import:serialize(record)});}catch(e){const message=e instanceof Error?e.message:"Não foi possível ler a planilha.";await updateCamperImport(record._id,{status:"error",error:message});return fail(c,"IMPORT_FAILED",message)}});
/** A row without a phone gets one during review: the person is registered in core (`equipe`) and added as a DRAFT team row. */
routes.post("/:id/members", async (c) => {
  const record = await findCamperImport(c.req.param("id"));
  if (!record || record.subject !== "staff") return fail(c, "IMPORT_NOT_FOUND", "Importação não encontrada.", 404);
  if (!["ready", "review"].includes(record.status)) return fail(c, "IMPORT_BLOCKED", "Esta importação não aceita alterações.", 409);
  const body = await c.req.json<{ reviewId?: string; phone?: string }>().catch(() => null);
  const item = (record.reviews as StaffImportReviewItem[]).find((r) => r.id === body?.reviewId && r.kind === "phone");
  const phone = importPhone(body?.phone ?? "");
  if (!item) return fail(c, "REVIEW_NOT_FOUND", "Pessoa não encontrada nesta revisão.", 404);
  if (!phone) return fail(c, "PHONE_INVALID", "Informe um celular brasileiro válido com DDD.");
  const row = record.preview.find((r) => Number(r.row) === item.row);
  if (!row) return fail(c, "ROW_NOT_FOUND", "Linha não encontrada.", 404);
  const ctx = await coordinationContext(c.get("session"));
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);
  const data = staffDataFromPreview({ ...row, phone }, record._id, true);
  const { personId } = await registerAdult(ctx.tokens, { name: data.person.name, phone, email: data.person.email, birthDate: data.person.birthDate, sex: data.person.sex, roles: data.roles, editionId: ctx.editionId, data: data.person.data });
  const existing = (await listStaff({ includeDraft: true, personIds: [personId] }))[0];
  const member = existing ?? (await insertStaff(personId, data.ops));
  const preview = record.preview.map((r) => (Number(r.row) === item.row ? { ...r, phone, existingStaffId: member._id } : r));
  const reviews = (record.reviews as StaffImportReviewItem[]).map((r) => (r.id === item.id ? { ...r, value: phone, resolved: true } : r));
  const updated = (await updateCamperImport(record._id, { preview, reviews, createdItems: [...record.createdItems, { kind: "staff", id: member._id, label: data.person.name, draft: true }] }))!;
  publish("staff");
  return c.json({ staff: { id: member._id, name: data.person.name }, import: serialize(updated) });
});
routes.post("/:id/apply",async(c)=>{const record=await findCamperImport(c.req.param("id"));if(!record||record.subject!=="staff")return fail(c,"IMPORT_NOT_FOUND","Importação não encontrada.",404);if(!["ready","review"].includes(record.status))return fail(c,"IMPORT_BLOCKED",record.error||"Esta importação não pode ser aplicada.",409);const body=await c.req.parseBody().catch(()=>null),file=body?.file;if(!(file instanceof File))return fail(c,"FILE_REQUIRED","Envie novamente a planilha original.");const data=new Uint8Array(await file.arrayBuffer());if(hash(data)!==record.fileHash)return fail(c,"FILE_CHANGED","A planilha mudou desde a prévia.",409);let delta:Record<string,{value?:string;skip?:boolean}>={},declinedCategoryIds:string[]=[],duplicateChoice:"update"|"keep"|"merge"|""="";try{delta=typeof body?.delta==="string"?JSON.parse(body.delta):{};const parsed=typeof body?.declinedCategoryIds==="string"?JSON.parse(body.declinedCategoryIds):[];declinedCategoryIds=Array.isArray(parsed)?parsed.filter((id):id is string=>typeof id==="string"):[];duplicateChoice=body?.duplicateChoice==="update"||body?.duplicateChoice==="keep"||body?.duplicateChoice==="merge"?body.duplicateChoice:"";}catch{return fail(c,"DELTA_INVALID","As correções são inválidas.")}const allowed=new Set(record.createdItems.filter((item)=>item.kind==="categoryOption").map((item)=>item.id));declinedCategoryIds=[...new Set(declinedCategoryIds.filter((id)=>allowed.has(id)))];if(duplicateChoice)for(const review of record.reviews as StaffImportReviewItem[])if(review.kind==="duplicate"&&!delta[review.id]?.value)delta[review.id]={...delta[review.id],value:duplicateChoice};const ctx=await coordinationContext(c.get("session"));if(!ctx.ok)return c.json({error:ctx.error},ctx.status);if(!(await claimCamperImport(record._id)))return fail(c,"IMPORT_ALREADY_APPLIED","Esta importação já foi aplicada.",409);await startImportJob(record._id,c.get("session"));try{const rows=applyStaffDelta(applyStaffCategoryChoices(record.preview,declinedCategoryIds),record.reviews as StaffImportReviewItem[],delta),result=await insertImportStaff(rows,record._id,ctx),finishedAt=new Date();
    // the spreadsheet's person data is not kept once applied (it lives in core now)
    const updated=(await updateCamperImport(record._id,{status:await appliedStatus(record._id),dryRun:false,skipped:result.skipped,finishedAt,error:"",rows:[],preview:[],reviews:(record.reviews as StaffImportReviewItem[]).map((r)=>({...r,existingData:undefined,incomingData:undefined,mergedData:undefined,value:delta[r.id]?.value??r.value,skip:delta[r.id]?.skip??r.skip,resolved:true}))}))!;await discardImportCategoryOptions(record._id,declinedCategoryIds);await Promise.all([markImportDictionaryPublished(record._id),publishImportDrafts(record._id)]);if(body?.sendWelcomes==="true")void syncWelcomes();publish("staff","bedrooms","teams","transports","categories","settings");return c.json({import:serialize(updated),...result,welcomeQueued:body?.sendWelcomes==="true"?result.eligiblePhones:0});}catch(e){const message=e instanceof Error?e.message:"A importação parou durante a gravação.";await updateCamperImport(record._id,{status:"error",error:message});await endFailedImportJob(record._id);return fail(c,"IMPORT_FAILED",message,409)}});
export default routes;
