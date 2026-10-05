import { describe, expect, test } from "bun:test";
import { isIgnoredImportColumn } from "./camperImport";
import { applyStaffCategoryChoices, applyStaffDelta, directStaffField, isBlankStaffBedroom, normalizeStaffFreeText, parseStaffDuty, parseStaffImportSex, parseStaffRoomRole, resolveStaffColumnTarget, staffDataFromPreview } from "./staffImport";
import type { StaffImportReviewItem } from "../types";

const item = (patch: Partial<StaffImportReviewItem>): StaffImportReviewItem => ({ id:"r1",row:2,kind:"phone",field:"phone",memberName:"Ana",original:"",value:"",skip:false,resolved:false,...patch });

describe("staff import review delta",()=>{
  test("skipping an invalid phone still imports a staff member without login",()=>{
    const [row]=applyStaffDelta([{row:2,name:"Ana",phone:null}], [item({})], {r1:{skip:true}});
    expect(row.phone).toBeNull();
    expect(staffDataFromPreview(row,"import-1").ops.aiReviewStatus).toBe("pending");
  });
  test("different people never keep a conflicting phone",()=>{
    const [row]=applyStaffDelta([{row:2,name:"Ana",phone:"+5561999999999",existingStaffId:"old"}], [item({kind:"duplicate",existingId:"old"})], {r1:{value:"insert"}});
    expect(row.existingStaffId).toBeNull();
    expect(row.phone).toBeNull();
  });
  test("admin-safe preview data defaults to helper-compatible values",()=>{
    const data=staffDataFromPreview({name:"Ana",phone:null,active:true,roomRole:"helper",team:null},"import-1",true);
    expect(data.ops.draft).toBe(true);
    expect(data.ops.roomRole).toBe("helper");
    expect(data.ops.aiReviewStatus).toBeNull();
  });
  test("only the room wing sets the sex; the person goes to core and the duty columns become project roles",()=>{
    const data=staffDataFromPreview({name:"Ana",phone:"+5511999999999",sex:null,probableGender:"F",organizer:true,checkinHelper:true,vestHelper:false},"import-1");
    expect(data.person).toMatchObject({name:"Ana",phone:"+5511999999999"});
    expect(data.roles).toEqual(["equipe","organizacao","checkin"]);
    expect(JSON.stringify(data.ops)).not.toContain("Ana");
  });
  test("parses only explicit staff sex values",()=>{
    expect(parseStaffImportSex("Feminino")).toBe("F");
    expect(parseStaffImportSex("menina")).toBe("F");
    expect(parseStaffImportSex("MASCULINO")).toBe("M");
    expect(parseStaffImportSex("João")).toBeNull();
    expect(parseStaffImportSex("provavelmente F")).toBeNull();
  });
  test("keeps imported free text untouched for the background AI pass",()=>{
    expect(normalizeStaffFreeText(" Marcela/11999488182 ")).toBe("Marcela/11999488182");
    expect(normalizeStaffFreeText("Bruna 11 984989876 André 11964762460")).toBe("Bruna 11 984989876 André 11964762460");
  });
  test("declined staff category options move their raw wording to observations",()=>{
    const [row]=applyStaffCategoryChoices([{name:"Ana",allergies:["a","keep"],drugAllergies:["d"],healthIssues:[],healthNotes:"Já existia.",categoryNotesById:{a:["Alergias informadas: castanha."],d:["Alergias a medicamentos informadas: dipirona."]}}],["a","d"]);
    expect(row.allergies).toEqual(["keep"]);
    expect(row.drugAllergies).toEqual([]);
    expect(row.healthNotes).toBe("Já existia. Alergias informadas: castanha. Alergias a medicamentos informadas: dipirona.");
  });
  test("staff duplicate choices use the phone-matched registry",()=>{
    const duplicate=item({kind:"duplicate",existingId:"old",existingData:{name:"Ana",phone:"+5511999999999",healthNotes:"Atual"},incomingData:{name:"Ana Nova",phone:"+5511999999999",healthNotes:"Planilha"},mergedData:{name:"Ana Nova",phone:"+5511999999999",healthNotes:"Planilha"},mergeAvailable:true});
    expect(applyStaffDelta([{row:2,name:"Ana Nova",phone:"+5511999999999",blocked:true}],[duplicate],{r1:{value:"keep"}})[0]?.skipReason).toBe("Cadastro existente mantido");
    const updated=applyStaffDelta([{row:2,name:"Ana Nova",phone:"+5511999999999",blocked:true}],[duplicate],{r1:{value:"update"}})[0];
    expect(updated.existingStaffId).toBe("old");expect(updated.blocked).toBe(false);
    const merged=applyStaffDelta([{row:2,name:"Ana Nova",phone:"+5511999999999",blocked:true}],[duplicate],{r1:{value:"merge"}})[0];
    expect(merged.existingStaffId).toBe("old");expect(merged.healthNotes).toBe("Planilha");
  });
  test("maps adversarial staff headers deterministically",()=>{
    expect(directStaffField("Quem vai servir?")?.key).toBe("name");
    expect(directStaffField("Qual alojamento?")?.key).toBe("bedroom");
    expect(directStaffField("Remédio que dá alergia")?.key).toBe("drugAllergies");
    expect(directStaffField("Está participando?")?.key).toBe("active");
    expect(directStaffField("Gênero")?.key).toBe("probableGender");
    expect(directStaffField("E-mail")?.key).toBe("email");
    expect(directStaffField("CPF")?.key).toBe("document");
    expect(directStaffField("RG")?.key).toBe("document");
    expect(directStaffField("Identidade")?.key).toBe("document");
    expect(directStaffField("Passaporte")?.key).toBe("document");
    expect(directStaffField("CDIN")?.key).toBe("document");
    expect(staffDataFromPreview({name:"Ana",document:" 529.982.247-25 "},"import-1").person.data).toEqual({document:[{type:"cpf",number:"52998224725"}]});
    expect(directStaffField("Data de nascimento")?.key).toBe("birthDate");
    expect(directStaffField("Nascimento")?.key).toBe("birthDate");
    expect(staffDataFromPreview({name:"Ana",birthDate:"1990-04-12"},"import-1").person.birthDate).toBe("1990-04-12");
    expect(staffDataFromPreview({name:"Ana"},"import-1").person.birthDate).toBeNull();
    expect(resolveStaffColumnTarget("Data de nascimento")).toBe("birthDate");
    expect(directStaffField("Alergias (alimentar, tópica ou de medicamentos)")?.key).toBe("healthNotes");
    expect(directStaffField("Função no quarto")?.key).toBe("roomRole");
    expect(directStaffField("lider_checkin")?.key).toBe("checkinHelper");
    expect(directStaffField("Líder check-in")?.key).toBe("checkinHelper");
    expect(directStaffField("checkin leader")?.key).toBe("checkinHelper");
    expect(resolveStaffColumnTarget("lider_checkin", undefined, "roomRole")).toBe("checkinHelper");
    expect(resolveStaffColumnTarget("Nome")).toBe("name");
    expect(resolveStaffColumnTarget("Notas internas", undefined, null, "roomRole")).toBeNull();
    expect(resolveStaffColumnTarget("Cargo", undefined, "roomRole", "roomRole")).toBeNull();
    expect(resolveStaffColumnTarget("Cargo", "roomRole")).toBe("roomRole");
    expect(staffDataFromPreview({name:"Ana"},"import-1").ops.roomRole).toBe("helper");
    expect(parseStaffRoomRole("")).toBe("helper");
    expect(parseStaffRoomRole("auxiliar")).toBe("helper");
    expect(parseStaffRoomRole("líder")).toBe("caretaker");
    expect(directStaffField("quarto")?.key).toBe("bedroom");
    expect(directStaffField("transporte")?.key).toBe("transportation");
    expect(directStaffField("Organizador")?.key).toBe("organizer");
    expect(directStaffField("Ajudantes do check-in")?.key).toBe("checkinHelper");
    expect(directStaffField("Coletes")?.key).toBe("vestHelper");
    expect(directStaffField("Ajudantes do placar")?.key).toBe("scoreHelper");
    expect(directStaffField("Organizadores dos jogos")?.key).toBe("gameOrganizer");
    expect(directStaffField("pode gerenciar colete")?.key).toBe("vestHelper");
    expect(resolveStaffColumnTarget("Cargo", undefined, "organizer", "organizer")).toBe("organizer");
    expect(resolveStaffColumnTarget("Cargo", "checkinHelper")).toBe("checkinHelper");
    expect(parseStaffDuty("sim")).toBe(true);
    expect(parseStaffDuty("x")).toBe(true);
    expect(parseStaffDuty("1")).toBe(true);
    expect(parseStaffDuty("nao")).toBe(false);
    expect(parseStaffDuty("")).toBe(false);
    expect(isIgnoredImportColumn("id")).toBe(true);
    expect(isIgnoredImportColumn("room_id")).toBe(true);
    expect(isIgnoredImportColumn("bus_id")).toBe(true);
  });
  test("blank rooms do not need review",()=>{
    expect(isBlankStaffBedroom("")).toBe(true);
    expect(isBlankStaffBedroom("   ")).toBe(true);
    expect(isBlankStaffBedroom("sem quarto")).toBe(true);
    expect(isBlankStaffBedroom("n/a")).toBe(true);
    expect(isBlankStaffBedroom("Quarto 12")).toBe(false);
  });
  test("never leaves the same imported phone on two rows",()=>{
    const rows=applyStaffDelta([{row:2,name:"Ana",phone:"+5511999999999"},{row:3,name:"Bia",phone:"+5511999999999"}],[],{});
    expect(rows.map((row)=>row.phone)).toEqual(["+5511999999999",null]);
  });
  test("in-sheet phone conflict: chosen row keeps the number, the other is created without login",()=>{
    const reviews=[item({id:"a",row:2,kind:"duplicate",incomingData:{name:"Ana"}}),item({id:"b",row:3,kind:"duplicate",incomingData:{name:"Bia"}})];
    const rows=applyStaffDelta([{row:2,name:"Ana",phone:"+5511999999999"},{row:3,name:"Bia",phone:"+5511999999999"}],reviews,{a:{value:"keep-phone"},b:{value:"blank"}});
    expect(rows[0]).toMatchObject({phone:"+5511999999999",blocked:false,duplicateChoice:"keep-phone"});
    expect(rows[1]).toMatchObject({phone:null,blocked:false,duplicateChoice:"blank"});
  });
  test("in-sheet phone conflict: leaving it blank still creates both members without login",()=>{
    const reviews=[item({id:"a",row:2,kind:"duplicate"}),item({id:"b",row:3,kind:"duplicate"})];
    const rows=applyStaffDelta([{row:2,name:"Ana",phone:"+5511999999999"},{row:3,name:"Bia",phone:"+5511999999999"}],reviews,{a:{value:"blank"},b:{value:"blank"}});
    expect(rows.map((row)=>({phone:row.phone,blocked:row.blocked}))).toEqual([{phone:null,blocked:false},{phone:null,blocked:false}]);
  });
  test("in-sheet phone conflict: ignoring one person keeps the other with the number",()=>{
    const reviews=[item({id:"a",row:2,kind:"duplicate"}),item({id:"b",row:3,kind:"duplicate"})];
    const rows=applyStaffDelta([{row:2,name:"Ana",phone:"+5511999999999"},{row:3,name:"Bia",phone:"+5511999999999"}],reviews,{a:{value:"keep-phone"},b:{skip:true}});
    expect(rows[0]).toMatchObject({phone:"+5511999999999",blocked:false,duplicateChoice:"keep-phone"});
    expect(rows[1]).toMatchObject({blocked:true,skipReason:"Revisão ignorada"});
  });
  test("in-sheet phone conflict: a new number on one row keeps both logins",()=>{
    const reviews=[item({id:"a",row:2,kind:"duplicate"}),item({id:"b",row:3,kind:"duplicate"})];
    const rows=applyStaffDelta([{row:2,name:"Ana",phone:"+5511999999999"},{row:3,name:"Bia",phone:"+5511999999999"}],reviews,{a:{value:"keep-phone"},b:{value:"(11) 98888-7777"}});
    expect(rows[0]).toMatchObject({phone:"+5511999999999",blocked:false,duplicateChoice:"keep-phone"});
    expect(rows[1]).toMatchObject({phone:"+5511988887777",blocked:false,duplicateChoice:"new-phone"});
  });
});

