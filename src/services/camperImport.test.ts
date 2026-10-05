import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { applyCategoryChoices, applyImportDelta, camperDataFromPreview, camperIdentityKey, concatOtherColumns, directImportField, extractImportNumber, IMPORT_ID_VALUE_RE, isEmptyCategoryValue, isIgnoredImportColumn, isNarrativeCategoryText, narrativeOnlyAtoms, normalizeEmergencyContact, parseImportSex, parseSpreadsheet, splitCategoryText } from "./camperImport";
import type { CamperImportReviewItem } from "../types";

function book(rows: unknown[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Crianças");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

describe("camper spreadsheet parser", () => {
  test("keeps duplicate headers unique and exposes five samples", () => {
    const data = book([
      ["Nome", "Nome", "Nascimento"],
      ["Ana", "Mãe Ana", "01/02/2016"],
      ["Bia", "Mãe Bia", "02/03/2016"],
    ]);
    const parsed = parseSpreadsheet(data, "kids.xlsx");
    expect(parsed.rows).toHaveLength(2);
    expect(Object.keys(parsed.rows[0])).toEqual(["Nome", "Nome (2)", "Nascimento"]);
    expect(parsed.columns[0].samples).toEqual(["Ana", "Bia"]);
  });

  test("rejects a sheet without children", () => {
    expect(() => parseSpreadsheet(book([["Nome", "Nascimento"]]), "empty.xlsx")).toThrow();
  });

  test("keeps UTF-8 accents intact in CSV headers and values", () => {
    const csv = new TextEncoder().encode("Nome,Observações de saúde\nAna,Pressão alta\n");
    const parsed = parseSpreadsheet(csv, "staff.csv");
    expect(Object.keys(parsed.rows[0])).toEqual(["Nome", "Observações de saúde"]);
    expect(parsed.rows[0]["Observações de saúde"]).toBe("Pressão alta");
  });

  test("does not reformat or shift literal CSV dates", () => {
    const csv = new TextEncoder().encode("Nome;Data de nascimento\nAna;2016-04-16\nBia;16/04/16\nClara;2019-12-12\n");
    const parsed = parseSpreadsheet(csv, "kids.csv");
    expect(parsed.rows.map((row) => row["Data de nascimento"])).toEqual(["2016-04-16", "16/04/16", "2019-12-12"]);
  });
});

describe("camper deterministic column mapping", () => {
  test("spreadsheet UUID columns stay out of mapping and notes", () => {
    expect(isIgnoredImportColumn("id")).toBe(true);
    expect(isIgnoredImportColumn("room_id")).toBe(true);
    expect(isIgnoredImportColumn("bus_id")).toBe(true);
    expect(isIgnoredImportColumn("team_id")).toBe(true);
    expect(isIgnoredImportColumn("quarto")).toBe(false);
    expect(isIgnoredImportColumn("transporte")).toBe(false);
    expect(IMPORT_ID_VALUE_RE.test("89c85104-0d73-4ebf-821c-08f94689254e")).toBe(true);
    expect(IMPORT_ID_VALUE_RE.test("MENINOS - 403")).toBe(false);
    expect(concatOtherColumns({
      id: "f73f61af-c696-48e8-9f61-d55e6c58715d",
      rg: "83122818191",
      quarto: "COORDENAÇÃO - 505",
      room_id: "75ff6440-bfc0-4968-8aba-a3f43de3fce9",
    }, new Set(["quarto"]))).toBe("rg: 83122818191.");
  });

  test("specific labels win over generic words", () => {
    expect(directImportField("Gostaria de ficar no mesmo quarto de alguém?")?.key).toBe("bedroomPreference");
    expect(directImportField("Série/ano escolar")?.key).toBe("schoolGrade");
    expect(directImportField("Carteirinha do convênio")?.key).toBe("insuranceCard");
    expect(directImportField("E-mail do responsável")?.key).toBe("guardianEmail");
    expect(directImportField("Sexo (M ou F)")?.key).toBe("probableGender");
  });

  test("recognizes absence values without creating health categories", () => {
    for (const value of ["Não", "nada", "Nenhuma", "-", "sem alergias", "não tenho alergia", "sem problema de saúde"]) expect(isEmptyCategoryValue(value)).toBe(true);
    expect(isEmptyCategoryValue("Não come amendoim")).toBe(false);
  });

  test("normalizes leading zeroes in room and bus numbers", () => {
    expect(extractImportNumber("Ônibus 01 - azul")).toBe("1");
    expect(extractImportNumber("bus 1")).toBe("1");
    expect(extractImportNumber("Q0403")).toBe("403");
  });

  test("parses only explicit spreadsheet sex values", () => {
    expect(parseImportSex("Feminino")).toBe("F");
    expect(parseImportSex("M")).toBe("M");
    expect(parseImportSex("menina")).toBe("F");
    expect(parseImportSex("não informado")).toBeNull();
    expect(parseImportSex("Alex")).toBeNull();
  });

  test("normalization helper remains deterministic for explicit uses", () => {
    expect(normalizeEmergencyContact("Marcela/11999488182")).toBe("Marcela · (11) 99948-8182");
    expect(normalizeEmergencyContact("'+55 (11) 99417-5791")).toBe("(11) 99417-5791");
    expect(normalizeEmergencyContact("Bruna 11 984989876 André 11964762460")).toBe("Bruna · (11) 98498-9876 · André · (11) 96476-2460");
    expect(normalizeEmergencyContact("Elaíde 11965636070/ Jailson 965214635")).toBe("Elaíde · (11) 96563-6070 · Jailson · (11) 96521-4635");
  });
});

function review(overrides: Partial<CamperImportReviewItem>): CamperImportReviewItem {
  return { id: "review-1", row: 2, kind: "leader", field: "leader", kidName: "Ana", guardianName: "", birthDate: "", age: null, emergencyContact: "", original: "Tia Bia", value: "", skip: false, resolved: false, ...overrides };
}

describe("camper import review delta", () => {
  test("one grouped leader correction updates every affected child", () => {
    const preview = [
      { row: 2, name: "Ana", birthDate: "2017-01-02", guardianName: "Maria", guardianPhone: "+5511999999999", caretakerId: null, blocked: true },
      { row: 5, name: "Bia", birthDate: "2017-03-04", guardianName: "Joana", guardianPhone: "+5511999999999", caretakerId: null, blocked: true },
    ];
    const result = applyImportDelta(preview, [review({ affectedRows: [2, 5], options: [{ id: "staff-id", label: "Tia Bia" }] })], { "review-1": { value: "staff-id" } });
    expect(result.skipped).toEqual([]);
    expect(result.rows.map((r) => r.caretakerId)).toEqual(["staff-id", "staff-id"]);
    expect(result.rows.every((r) => r.blocked === false)).toBe(true);
  });

  test("skipping a grouped required correction skips each affected child once", () => {
    const preview = [
      { row: 2, name: "Ana", birthDate: "2017-01-02", guardianName: "Maria", guardianPhone: "+5511999999999", blocked: true },
      { row: 5, name: "Bia", birthDate: "2017-03-04", guardianName: "Joana", guardianPhone: "+5511999999999", blocked: true },
    ];
    const result = applyImportDelta(preview, [review({ affectedRows: [2, 5] })], { "review-1": { skip: true } });
    expect(result.skipped.map((r) => r.row)).toEqual([2, 5]);
    expect(result.rows.every((r) => r.blocked === true)).toBe(true);
  });

  test("an imported camper enters the background review queue", () => {
    const data = camperDataFromPreview({ row: 2, name: "Ana", birthDate: "2017-01-02", blocked: false }, "import-id");
    expect(data?.ops.importId).toBe("import-id");
    expect(data?.ops.aiReviewStatus).toBe("pending");
  });

  test("camper import keeps an uninformed bed position blank",()=>{
    const data=camperDataFromPreview({row:2,name:"Ana",birthDate:"2017-01-02",blocked:false},"import-id");
    expect(data?.ops.bed).toBeNull();
  });

  test("camper import sends a readable emergency contact to core (kind emergencyContact), never to the camp row",()=>{
    const data=camperDataFromPreview({row:2,name:"Ana",birthDate:"2017-01-02",emergencyContact:"Marcela (tia) 11999488182",blocked:false},"import-id");
    expect(data?.kid.data.emergencyContact).toEqual({name:"Marcela",phone:"+5511999488182",relation:"tia"});
    expect(JSON.stringify(data?.ops)).not.toContain("Marcela");
  });

  test("person data and health go to core; the camp row keeps camp ops only", () => {
    const data = camperDataFromPreview({ row: 2, name: "Ana", birthDate: "2017-01-02", guardianName: "Maria", guardianPhone: "+5511999999999", allergies: ["x"], healthNotes: "asma", generalNotes: "gosta de futebol", probableGender: "F", blocked: false }, "import-id");
    expect(data?.kid).toMatchObject({ name: "Ana", birthDate: "2017-01-02" });
    expect(data?.guardian).toMatchObject({ name: "Maria", phone: "+5511999999999" });
    expect(data?.health).toMatchObject({ allergies: ["x"], healthNotes: "asma" });
    expect(data?.ops.generalNotes).toBe("gosta de futebol");
    expect(JSON.stringify(data?.ops)).not.toContain("Ana");
    expect(JSON.stringify(data?.ops)).not.toContain("asma");
  });

  test("the sheet's explicit sex and church go to core with the kid (sex never guessed)", () => {
    const told = camperDataFromPreview({ row: 2, name: "Ana", birthDate: "2017-01-02", probableGender: "F", church: " IP Alphaville ", blocked: false }, "import-id");
    expect(told?.kid).toMatchObject({ sex: "F", homeChurch: "IP Alphaville" });
    const silent = camperDataFromPreview({ row: 2, name: "Ana", birthDate: "2017-01-02", probableGender: null, sex: "F", blocked: false }, "import-id");
    expect(silent?.kid).toMatchObject({ sex: null, homeChurch: "" });
    expect(JSON.stringify(told?.ops)).not.toContain("Alphaville");
  });

  test("uses full name or single name plus birthdate as the deterministic duplicate key",()=>{
    expect(camperIdentityKey("Ana Maria Silva","2017-01-02")).toBe("name:ana maria silva");
    expect(camperIdentityKey("Ana","2017-01-02")).toBe("name-birth:ana:2017-01-02");
    expect(camperIdentityKey("Ana",null)).toBeNull();
  });

  test("duplicate review choices update, keep or merge deterministically",()=>{
    const duplicate=review({kind:"duplicate",existingId:"existing",existingData:{name:"Ana",birthDate:"2017-01-02",school:"Antiga"},incomingData:{name:"Ana",birthDate:"2017-01-02",school:"Nova",church:"IPAlpha"},mergedData:{name:"Ana",birthDate:"2017-01-02",school:"Nova",church:"IPAlpha"},mergeAvailable:true});
    const row={row:2,name:"Ana",birthDate:"2017-01-02",guardianName:"Maria",guardianPhone:"+5511999999999",blocked:true};
    expect(applyImportDelta([row],[duplicate],{"review-1":{value:"keep"}}).skipped[0]?.reason).toBe("Cadastro existente mantido");
    const updated=applyImportDelta([row],[duplicate],{"review-1":{value:"update"}}).rows[0];
    expect(updated.existingCamperId).toBe("existing");
    expect(updated.blocked).toBe(false);
    const merged=applyImportDelta([row],[duplicate],{"review-1":{value:"merge"}}).rows[0];
    expect(merged.church).toBe("IPAlpha");
    expect(merged.existingCamperId).toBe("existing");
  });

  test("declined category options become observations instead of selections", () => {
    const [row] = applyCategoryChoices([{
      row: 2,
      allergies: ["keep", "decline"],
      drugAllergies: [],
      healthIssues: ["decline-health"],
      bed: "decline-bed",
      generalNotes: "Recado existente.",
      categoryNotesById: {
        decline: ["Alergias informadas: água gelada."],
        "decline-health": ["Condições de saúde informadas: terror noturno."],
        "decline-bed": ["Posição da cama informada: perto da porta."],
      },
    }], ["decline", "decline-health", "decline-bed"]);
    expect(row.allergies).toEqual(["keep"]);
    expect(row.healthIssues).toEqual([]);
    expect(row.bed).toBeNull();
    expect(row.generalNotes).toBe("Recado existente. Posição da cama informada: perto da porta. Alergias informadas: água gelada. Condições de saúde informadas: terror noturno.");
    expect(row.categoryNotesById).toBeDefined();
  });
});

describe("narrative health cells", () => {
  const prophylaxis = "Portador de valva aórtica bicúspide, com insuficiência discreta e ectasia de aorta ascendente. Possui recomendação de antibioticoterapia profilática APENAS CASO NECESSIDADE de procedimentos cruentos: Amoxil (500mg/5ml) 17ml via oral 60 min antes de procedimentos.";
  test("labels stay labels, narratives stay notes", () => {
    expect(isNarrativeCategoryText("Rinite")).toBe(false);
    expect(isNarrativeCategoryText("Rinite alérgica, poeira e mofo")).toBe(false);
    expect(isNarrativeCategoryText(prophylaxis)).toBe(true);
    expect(isNarrativeCategoryText("uma duas três quatro cinco seis sete oito nove dez onze doze treze quatorze quinze")).toBe(true);
  });
  test("a narrative cell never spawns category atoms", () => {
    expect(splitCategoryText(prophylaxis)).toEqual([]);
  });
  test("only atoms seen exclusively in narratives are blocked", () => {
    const blocked = narrativeOnlyAtoms([
      ["Rinite, poeira", ["Rinite", "Poeira"]],
      [prophylaxis, ["Valva aórtica bicúspide", "Amoxil"]],
      ["Asma desde os 3 anos com uso de bombinha em crises frequentes e acompanhamento", ["Asma"]],
      ["Asma", ["Asma"]],
    ]);
    expect([...blocked].sort()).toEqual(["Amoxil", "Valva aórtica bicúspide"]);
    expect(narrativeOnlyAtoms([])).toEqual(new Set());
  });
});
