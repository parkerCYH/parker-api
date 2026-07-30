import { canPlayer, getPlayerByEmail, getPlayerProfile, listPlayersWithAccess } from "../auth/index.js";
import { requestBloodworkRecognition, requestChatReply, requestHealthAdvice } from "../eve/index.js";
import type { ChatCatCareData } from "../eve/index.js";
import { env } from "../../shared/env.js";
import * as repo from "./repository.js";
import { consumeBloodworkJob, createBloodworkJob } from "./bloodwork-jobs.js";
import type { BloodworkValues, FluidSite, FluidType, Method, StoolType } from "./schema.js";

// `?to=` 是日期(YYYY-MM-DD),`new Date(dateOnly)` 會解析成當天 UTC 00:00,而不是當天結束——
// 直接拿去跟 timestamptz 欄位做 lte 比較會把當天 00:00 之後的紀錄全部濾掉。統一補上
// 當天最後一毫秒,`from` 維持原樣(當天開始正好是 00:00,不需要調整)。
function endOfDayUtc(dateOnly: string): Date {
  return new Date(`${dateOnly}T23:59:59.999Z`);
}

export async function createCat(
  playerId: string,
  input: { name: string; birthdate?: string; notes?: string },
) {
  return repo.createCat({ ...input, creatorPlayerId: playerId });
}

export async function isCatMember(catId: string, playerId: string): Promise<boolean> {
  return repo.isCatMember(catId, playerId);
}

export async function listCatsForPlayer(playerId: string) {
  return repo.listCatsForPlayer(playerId);
}

export async function getCatForPlayer(catId: string, playerId: string) {
  if (!(await repo.isCatMember(catId, playerId))) return undefined;
  return repo.findActiveCatById(catId);
}

// PATCH /cats/{catId}(票 07,定案見票 06):任何 cat_players 成員都能編輯基本資料,
// 不限定晶片登記人——晶片轉移是獨立動作,不套用它的權限限制到一般編輯上。
export async function updateCat(
  catId: string,
  input: { name?: string; birthdate?: string; notes?: string },
) {
  return repo.updateCat(catId, input);
}

// DELETE /cats/{catId}(ticket #23):封存而非硬刪除,歷史紀錄保留。
export async function archiveCat(catId: string) {
  return repo.archiveCat(catId);
}

export type InviteResult =
  | { kind: "ok"; player: NonNullable<Awaited<ReturnType<typeof getPlayerByEmail>>> }
  | { kind: "player_not_found" };

// POST /cats/{catId}/players(ticket #24):email 查既有帳號,不做邀請碼機制。
// 已是成員時 idempotent 成功,不當錯誤處理。
export async function invitePlayer(catId: string, email: string): Promise<InviteResult> {
  const player = await getPlayerByEmail(email);
  if (!player) return { kind: "player_not_found" };

  await repo.addCatPlayer(catId, player.id);
  return { kind: "ok", player };
}

export type LeaveResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "conflict"; reason: "chip_holder" | "would_orphan" };

// DELETE /cats/{catId}/players/me(ticket #24):僅限本人退出。晶片責任人不能直接退出
// (須先轉移);沒有晶片責任人的貓不能退到零成員。有晶片責任人時,其他成員可以退到只剩
// 責任人一人——責任人本身出不去,自然保底至少一名成員。
export async function leaveCat(catId: string, playerId: string): Promise<LeaveResult> {
  if (!(await repo.isCatMember(catId, playerId))) return { kind: "not_found" };

  const cat = await repo.findCatById(catId);
  if (cat?.chipPlayerId === playerId) return { kind: "conflict", reason: "chip_holder" };

  if (!cat?.chipPlayerId) {
    const memberCount = await repo.countCatPlayers(catId);
    if (memberCount <= 1) return { kind: "conflict", reason: "would_orphan" };
  }

  await repo.removeCatPlayer(catId, playerId);
  return { kind: "ok" };
}

export type ChipTransferResult =
  | { kind: "ok"; cat: NonNullable<Awaited<ReturnType<typeof repo.setChipPlayer>>> }
  | { kind: "player_not_found" }
  | { kind: "not_a_member" };

// 設定/轉移晶片登記責任人(ticket #24):目標必須先是 cat_players 成員;一旦設定過就只能
// 轉移,不會被清空(沒有「清空」的操作入口)。
export async function setChipPlayer(catId: string, email: string): Promise<ChipTransferResult> {
  const player = await getPlayerByEmail(email);
  if (!player) return { kind: "player_not_found" };

  if (!(await repo.isCatMember(catId, player.id))) return { kind: "not_a_member" };

  const cat = await repo.setChipPlayer(catId, player.id);
  return { kind: "ok", cat };
}

// GET /cats/{catId}/players(ticket #25):讀出一隻貓目前的 cat_players 成員名單,
// 補上 #24 只做寫入(邀請/退出/轉移)沒做的對應讀取。
export async function listCatPlayers(catId: string) {
  const playerIds = await repo.listCatPlayerIds(catId);
  const profiles = await Promise.all(playerIds.map((playerId) => getPlayerProfile(playerId)));
  return profiles.filter((profile): profile is NonNullable<typeof profile> => Boolean(profile));
}

export async function recordBowelMovement(
  catId: string,
  playerId: string,
  input: { recordedAt?: string; stoolType?: StoolType; isAbnormal?: boolean; notes?: string },
) {
  return repo.createBowelMovement({
    catId,
    recordedBy: playerId,
    recordedAt: input.recordedAt ? new Date(input.recordedAt) : new Date(),
    stoolType: input.stoolType,
    isAbnormal: input.isAbnormal,
    notes: input.notes,
  });
}

// 支援 ?from=&to= 日期區間篩選(ticket #24)。
export async function listBowelMovements(catId: string, range?: { from?: string; to?: string }) {
  return repo.listBowelMovements(catId, {
    from: range?.from ? new Date(range.from) : undefined,
    to: range?.to ? endOfDayUtc(range.to) : undefined,
  });
}

export type EditResult<T> =
  | { kind: "ok"; record: T }
  | { kind: "not_found" }
  | { kind: "forbidden" };

// PATCH /cats/{catId}/bowel-movements/{id}(ticket #23):只有當初 recorded_by 本人能編輯。
export async function updateBowelMovement(
  catId: string,
  recordId: string,
  playerId: string,
  input: { recordedAt?: string; stoolType?: StoolType; isAbnormal?: boolean; notes?: string },
): Promise<EditResult<Awaited<ReturnType<typeof repo.updateBowelMovement>>>> {
  const record = await repo.findBowelMovementById(recordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };
  if (record.recordedBy !== playerId) return { kind: "forbidden" };

  const updated = await repo.updateBowelMovement(recordId, {
    ...(input.recordedAt !== undefined ? { recordedAt: new Date(input.recordedAt) } : {}),
    ...(input.stoolType !== undefined ? { stoolType: input.stoolType } : {}),
    ...(input.isAbnormal !== undefined ? { isAbnormal: input.isAbnormal } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  return { kind: "ok", record: updated };
}

export type DeleteResult = { kind: "ok" } | { kind: "not_found" } | { kind: "forbidden" };

// DELETE /cats/{catId}/bowel-movements/{id}(ticket #25):hard delete,限 recorded_by 本人。
export async function deleteBowelMovement(
  catId: string,
  recordId: string,
  playerId: string,
): Promise<DeleteResult> {
  const record = await repo.findBowelMovementById(recordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };
  if (record.recordedBy !== playerId) return { kind: "forbidden" };

  await repo.deleteBowelMovement(recordId);
  return { kind: "ok" };
}

export async function recordWeight(
  catId: string,
  playerId: string,
  input: { measuredAt?: string; weightGrams: number; method?: Method; notes?: string },
) {
  return repo.createWeightRecord({
    catId,
    measuredBy: playerId,
    measuredAt: input.measuredAt ? new Date(input.measuredAt) : new Date(),
    weightGrams: input.weightGrams,
    method: input.method,
    notes: input.notes,
  });
}

// 支援 ?from=&to= 日期區間篩選(ticket #24)。
export async function listWeightRecords(catId: string, range?: { from?: string; to?: string }) {
  return repo.listWeightRecords(catId, {
    from: range?.from ? new Date(range.from) : undefined,
    to: range?.to ? endOfDayUtc(range.to) : undefined,
  });
}

// PATCH /cats/{catId}/weight-records/{id}(ticket #23):只有當初 measured_by 本人能編輯。
export async function updateWeightRecord(
  catId: string,
  recordId: string,
  playerId: string,
  input: { measuredAt?: string; weightGrams?: number; method?: Method; notes?: string },
): Promise<EditResult<Awaited<ReturnType<typeof repo.updateWeightRecord>>>> {
  const record = await repo.findWeightRecordById(recordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };
  if (record.measuredBy !== playerId) return { kind: "forbidden" };

  const updated = await repo.updateWeightRecord(recordId, {
    ...(input.measuredAt !== undefined ? { measuredAt: new Date(input.measuredAt) } : {}),
    ...(input.weightGrams !== undefined ? { weightGrams: input.weightGrams } : {}),
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  return { kind: "ok", record: updated };
}

// DELETE /cats/{catId}/weight-records/{id}(ticket #25):hard delete,限 measured_by 本人。
export async function deleteWeightRecord(
  catId: string,
  recordId: string,
  playerId: string,
): Promise<DeleteResult> {
  const record = await repo.findWeightRecordById(recordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };
  if (record.measuredBy !== playerId) return { kind: "forbidden" };

  await repo.deleteWeightRecord(recordId);
  return { kind: "ok" };
}

export async function recordFluidInjection(
  catId: string,
  playerId: string,
  input: {
    injectedAt?: string;
    site: FluidSite;
    siteOther?: string;
    volumeMl: number;
    fluidType: FluidType;
    fluidTypeOther?: string;
    notes?: string;
  },
) {
  return repo.createFluidInjection({
    catId,
    injectedBy: playerId,
    injectedAt: input.injectedAt ? new Date(input.injectedAt) : new Date(),
    site: input.site,
    siteOther: input.siteOther,
    volumeMl: input.volumeMl,
    fluidType: input.fluidType,
    fluidTypeOther: input.fluidTypeOther,
    notes: input.notes,
  });
}

// 支援 ?from=&to= 日期區間篩選(比照 bowel/weight)。
export async function listFluidInjections(catId: string, range?: { from?: string; to?: string }) {
  return repo.listFluidInjections(catId, {
    from: range?.from ? new Date(range.from) : undefined,
    to: range?.to ? endOfDayUtc(range.to) : undefined,
  });
}

type OtherFieldResolution =
  | { kind: "ok"; patch?: string | null }
  | { kind: "invalid"; message: string };

// site='other'/fluidType='other' 時對應的自由文字欄位必填,非 other 時帶值直接拒絕(票 01 定案)。
// PATCH 是部分更新,判斷「有效值」要合併既有紀錄——切走 other 時自動清掉殘留的舊自由文字,
// 不要求呼叫端額外傳 null 才能清空。
function resolveOtherField(args: {
  enumChanging: boolean;
  isOther: boolean;
  inputOther: string | undefined;
  existingOther: string | null;
  fieldLabel: string;
}): OtherFieldResolution {
  const { enumChanging, isOther, inputOther, existingOther, fieldLabel } = args;

  if (isOther) {
    const effectiveOther = inputOther ?? existingOther ?? undefined;
    if (!effectiveOther) {
      return { kind: "invalid", message: `${fieldLabel} is required when the value is 'other'` };
    }
    return { kind: "ok", patch: inputOther };
  }

  if (inputOther !== undefined) {
    return { kind: "invalid", message: `${fieldLabel} must not be set unless the value is 'other'` };
  }

  if (enumChanging && existingOther !== null) {
    return { kind: "ok", patch: null };
  }

  return { kind: "ok" };
}

export type UpdateFluidInjectionResult =
  | { kind: "ok"; record: NonNullable<Awaited<ReturnType<typeof repo.updateFluidInjection>>> }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "invalid"; message: string };

// PATCH /cats/{catId}/fluid-injections/{id}:只有當初 injected_by 本人能編輯。
export async function updateFluidInjection(
  catId: string,
  recordId: string,
  playerId: string,
  input: {
    injectedAt?: string;
    site?: FluidSite;
    siteOther?: string;
    volumeMl?: number;
    fluidType?: FluidType;
    fluidTypeOther?: string;
    notes?: string;
  },
): Promise<UpdateFluidInjectionResult> {
  const record = await repo.findFluidInjectionById(recordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };
  if (record.injectedBy !== playerId) return { kind: "forbidden" };

  const siteResolution = resolveOtherField({
    enumChanging: input.site !== undefined,
    isOther: (input.site ?? record.site) === "other",
    inputOther: input.siteOther,
    existingOther: record.siteOther,
    fieldLabel: "siteOther",
  });
  if (siteResolution.kind === "invalid") return siteResolution;

  const fluidTypeResolution = resolveOtherField({
    enumChanging: input.fluidType !== undefined,
    isOther: (input.fluidType ?? record.fluidType) === "other",
    inputOther: input.fluidTypeOther,
    existingOther: record.fluidTypeOther,
    fieldLabel: "fluidTypeOther",
  });
  if (fluidTypeResolution.kind === "invalid") return fluidTypeResolution;

  const updated = await repo.updateFluidInjection(recordId, {
    ...(input.injectedAt !== undefined ? { injectedAt: new Date(input.injectedAt) } : {}),
    ...(input.site !== undefined ? { site: input.site } : {}),
    ...(siteResolution.patch !== undefined ? { siteOther: siteResolution.patch } : {}),
    ...(input.volumeMl !== undefined ? { volumeMl: input.volumeMl } : {}),
    ...(input.fluidType !== undefined ? { fluidType: input.fluidType } : {}),
    ...(fluidTypeResolution.patch !== undefined ? { fluidTypeOther: fluidTypeResolution.patch } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  return { kind: "ok", record: updated };
}

// DELETE /cats/{catId}/fluid-injections/{id}:hard delete,限 injected_by 本人。
export async function deleteFluidInjection(
  catId: string,
  recordId: string,
  playerId: string,
): Promise<DeleteResult> {
  const record = await repo.findFluidInjectionById(recordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };
  if (record.injectedBy !== playerId) return { kind: "forbidden" };

  await repo.deleteFluidInjection(recordId);
  return { kind: "ok" };
}

// POST /cats/{catId}/bloodwork-records(票 18):手動填寫入口,不經過 draft,建立時直接是
// confirmed(票 13 定案)。
export async function recordBloodworkRecord(
  catId: string,
  playerId: string,
  input: { recordedAt?: string } & BloodworkValues,
) {
  const { recordedAt, ...values } = input;
  return repo.createBloodworkRecord({
    catId,
    recordedBy: playerId,
    recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
    status: "confirmed",
    ...values,
  });
}

// 給票 20(AI 辨識情境後端)內部呼叫的寫入路徑,不透過公開的 POST(票 18 定案:公開 POST
// 固定寫 confirmed,draft 只能經這條路徑產生)。目前沒有任何 route 呼叫這個函式。
export async function createDraftBloodworkRecord(
  catId: string,
  playerId: string,
  input: { recordedAt?: string } & BloodworkValues,
) {
  const { recordedAt, ...values } = input;
  return repo.createBloodworkRecord({
    catId,
    recordedBy: playerId,
    recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
    status: "draft",
    ...values,
  });
}

// 支援 ?from=&to= 日期區間篩選(比照 bowel/weight/fluid)。
export async function listBloodworkRecords(catId: string, range?: { from?: string; to?: string }) {
  return repo.listBloodworkRecords(catId, {
    from: range?.from ? new Date(range.from) : undefined,
    to: range?.to ? endOfDayUtc(range.to) : undefined,
  });
}

export type UpdateBloodworkRecordResult = EditResult<
  NonNullable<Awaited<ReturnType<typeof repo.updateBloodworkRecord>>>
>;

// PATCH /cats/{catId}/bloodwork-records/{id}(票 18,狀態轉換見票 21):只有當初 recorded_by
// 本人能編輯,允許任意欄位子集更新(所有欄位選填)。status 只接受 route 層 schema 已限制的
// literal "confirmed"(draft→confirmed,票 09 定案的狀態機),不需要在這裡再檢查轉換方向。
export async function updateBloodworkRecord(
  catId: string,
  recordId: string,
  playerId: string,
  input: { recordedAt?: string; status?: "confirmed" } & BloodworkValues,
): Promise<UpdateBloodworkRecordResult> {
  const record = await repo.findBloodworkRecordById(recordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };
  if (record.recordedBy !== playerId) return { kind: "forbidden" };

  const { recordedAt, status, ...values } = input;
  const updated = await repo.updateBloodworkRecord(recordId, {
    ...(recordedAt !== undefined ? { recordedAt: new Date(recordedAt) } : {}),
    ...(status !== undefined ? { status } : {}),
    ...values,
  });
  return { kind: "ok", record: updated };
}

export type StartBloodworkRecognitionResult = { kind: "ok"; jobId: string } | { kind: "eve_unreachable" };

// POST /cats/{catId}/bloodwork-records/recognize(票 20):發起照片辨識作業。自己產生 job id、
// 記住 catId/playerId(見 bloodwork-jobs.ts),組出帶 job id 的 callback URL 一起交給 eve
// (票 08 定案的作業關聯方式)。eve 沒接受這個作業(網路錯誤或非 2xx)時,不留下孤兒 job。
export async function startBloodworkRecognition(
  catId: string,
  playerId: string,
  photo: { data: Buffer; mediaType: string; filename: string },
): Promise<StartBloodworkRecognitionResult> {
  const jobId = createBloodworkJob(catId, playerId);
  const callbackUrl = new URL(
    `/api/v1/cat-care/eve-callback/bloodwork-recognition/${jobId}`,
    env.PARKER_API_BASE_URL,
  ).toString();

  const result = await requestBloodworkRecognition({ photo, jobId, callbackUrl });
  if (!result.ok) {
    consumeBloodworkJob(jobId);
    return { kind: "eve_unreachable" };
  }

  return { kind: "ok", jobId };
}

export type BloodworkRecognitionCallbackPayload =
  | { status: "success"; data: BloodworkValues }
  | { status: "failed" };

export type HandleBloodworkRecognitionCallbackResult = { kind: "ok" } | { kind: "unknown_job" };

// eve → parker-api callback(票 20):success 時把票 08 定案的結構化數據透過 createDraftBloodworkRecord
// 寫入 draft 紀錄;failed 時不寫入任何東西,交由使用者改走手動填寫入口(票 08 定案)。
export async function handleBloodworkRecognitionCallback(
  jobId: string,
  payload: BloodworkRecognitionCallbackPayload,
): Promise<HandleBloodworkRecognitionCallbackResult> {
  const job = consumeBloodworkJob(jobId);
  if (!job) return { kind: "unknown_job" };

  if (payload.status === "success") {
    await createDraftBloodworkRecord(job.catId, job.playerId, payload.data);
  }

  return { kind: "ok" };
}

// DELETE /cats/{catId}/bloodwork-records/{id}(票 18):hard delete,限 recorded_by 本人。
export async function deleteBloodworkRecord(
  catId: string,
  recordId: string,
  playerId: string,
): Promise<DeleteResult> {
  const record = await repo.findBloodworkRecordById(recordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };
  if (record.recordedBy !== playerId) return { kind: "forbidden" };

  await repo.deleteBloodworkRecord(recordId);
  return { kind: "ok" };
}

// 從 DB 查出的驗血紀錄還原成 BloodworkValues 形狀,只留 34 項數值欄位給 eve(票 22),
// id/catId/recordedBy/recordedAt/status/createdAt 這些不是 eve 需要的資料。
function toBloodworkValues(record: Awaited<ReturnType<typeof repo.findBloodworkRecordsByIds>>[number]): BloodworkValues {
  const { id, catId, recordedBy, recordedAt, status, createdAt, ...values } = record;
  return values;
}

export type GetHealthAdviceResult =
  | { kind: "ok"; advice: Awaited<ReturnType<typeof repo.createHealthAdvice>> & { bloodworkRecordIds: string[] } }
  | { kind: "not_found" }
  | { kind: "eve_unreachable" };

// POST /cats/{catId}/bloodwork-records/health-advice(票 22):同步呼叫 eve 取得一或多筆
// 已存驗血紀錄的健康建議(票 14 定案,不套用票 08 的 job id + callback),寫入 health_advice
// + 多對多關聯表後回傳。傳入的 bloodworkRecordIds 必須全部屬於這隻貓,否則視為 404
// (不區分「id 不存在」跟「id 屬於別隻貓」,理由同其他 record 的 not_found 處理)。
export async function getHealthAdvice(
  catId: string,
  playerId: string,
  bloodworkRecordIds: string[],
): Promise<GetHealthAdviceResult> {
  const records = await repo.findBloodworkRecordsByIds(catId, bloodworkRecordIds);
  if (records.length !== bloodworkRecordIds.length) return { kind: "not_found" };

  const result = await requestHealthAdvice(records.map(toBloodworkValues));
  if (result.kind === "eve_unreachable") return { kind: "eve_unreachable" };

  const row = await repo.createHealthAdvice({
    requestedBy: playerId,
    advice: result.advice,
    bloodworkRecordIds,
  });
  return { kind: "ok", advice: { ...row, bloodworkRecordIds } };
}

export type GetHealthAdviceHistoryResult =
  | { kind: "ok"; advice: Awaited<ReturnType<typeof repo.listHealthAdviceForBloodworkRecord>> }
  | { kind: "not_found" };

// GET .../bloodwork-records/{id}/health-advice(票 23):查詢單筆驗血紀錄過去已產生過的健康
// 建議,前端拿來在紀錄頁面回頭查看,不用每次都重打 Gemini。record 不存在或不屬於這隻貓一律
// 視為 404(理由同 deleteBloodworkRecord)。
export async function getHealthAdviceHistory(
  catId: string,
  bloodworkRecordId: string,
): Promise<GetHealthAdviceHistoryResult> {
  const record = await repo.findBloodworkRecordById(bloodworkRecordId);
  if (!record || record.catId !== catId) return { kind: "not_found" };

  const advice = await repo.listHealthAdviceForBloodworkRecord(bloodworkRecordId);
  return { kind: "ok", advice };
}

// 給 admin module 當 gateway 呼叫(見 ticket #14、ADR-0005),cat-care 自己不開對外端點。
export const listAllCats = repo.listAllCats;

// 給 admin 的單一貓咪詳情 gateway route 用(ticket #20)——不像 getCatForPlayer,這裡不檢查
// membership,admin 的權限檢查(admin.catCare.viewAll)完全在 admin 那一層做掉。
export async function getCat(catId: string) {
  return repo.findCatById(catId);
}

// 「跟 cat-care 有關」的 Player:有 catCare.access,或是至少一隻貓的成員(ticket #20)。
// 只回 player_id + 所屬貓咪,不含 email/name——那是 auth 的 getPlayerProfile 的事,
// 組合是 admin gateway route 的責任。
export async function listCatCarePlayers() {
  const [grantedPlayerIds, memberPlayerIds] = await Promise.all([
    listPlayersWithAccess("catCare.access"),
    repo.listDistinctCatPlayerIds(),
  ]);

  const playerIds = [...new Set([...grantedPlayerIds, ...memberPlayerIds])];

  return Promise.all(
    playerIds.map(async (playerId) => ({
      playerId,
      cats: await repo.listAllCatsForPlayer(playerId),
    })),
  );
}

export async function getCatCarePlayer(playerId: string) {
  const [cats, hasAccess] = await Promise.all([
    repo.listAllCatsForPlayer(playerId),
    canPlayer(playerId, "catCare.access"),
  ]);

  if (cats.length === 0 && !hasAccess) return undefined;

  return { playerId, cats };
}

// POST /cats/{catId}/conversations(票 24):新建一條對話串(票 15 定案:一隻貓可有多條)。
export async function createConversation(catId: string, playerId: string) {
  return repo.createConversation({ catId, createdBy: playerId });
}

export async function listConversations(catId: string) {
  return repo.listConversationsForCat(catId);
}

// GET /cats/{catId}/conversations/{id}/messages(票 25:重新開啟既有對話串時,前端需要把先前
// 訊息復原到畫面上——票 24 沒有補這支端點,因為當時的 AC 只涵蓋「送出訊息」這一輪。
export type ListMessagesResult =
  | { kind: "ok"; messages: Awaited<ReturnType<typeof repo.listMessagesForConversation>> }
  | { kind: "not_found" };

export async function listMessages(catId: string, conversationId: string): Promise<ListMessagesResult> {
  const conversation = await repo.findConversationById(conversationId);
  if (!conversation || conversation.catId !== catId) return { kind: "not_found" };

  return { kind: "ok", messages: await repo.listMessagesForConversation(conversationId) };
}

// 票 24:把一隻貓的全部 cat-care 資料(不限驗血)蒐集成 eve 聊天 context 需要的形狀
// (票 15 定案:每輪全部塞入,不做篩選/摘要)。範圍不套用 ?from=&to=,固定撈全部歷史。
async function gatherCatCareData(catId: string): Promise<ChatCatCareData> {
  const [cat, bowelMovementRows, weightRecordRows, fluidInjectionRows, bloodworkRecordRows] = await Promise.all([
    repo.findCatById(catId),
    repo.listBowelMovements(catId),
    repo.listWeightRecords(catId),
    repo.listFluidInjections(catId),
    repo.listBloodworkRecords(catId),
  ]);

  return {
    cat: { name: cat?.name ?? "", birthdate: cat?.birthdate ?? null, notes: cat?.notes ?? null },
    bowelMovements: bowelMovementRows.map(({ id, catId, recordedBy, ...rest }) => rest),
    weightRecords: weightRecordRows.map(({ id, catId, measuredBy, ...rest }) => rest),
    fluidInjections: fluidInjectionRows.map(({ id, catId, injectedBy, ...rest }) => rest),
    bloodworkRecords: bloodworkRecordRows.map(({ id, catId, recordedBy, ...rest }) => rest),
  };
}

export type SendMessageResult =
  | { kind: "ok"; stream: ReadableStream<Uint8Array> }
  | { kind: "not_found" }
  | { kind: "eve_unreachable" };

// POST /cats/{catId}/conversations/{id}/messages(票 24):同步呼叫 eve,把 eve 的串流回應
// 原樣轉發給呼叫端(票 15 定案:三段都轉發串流,不等完整回應)。用 TransformStream 邊轉發邊
// 蒐集完整文字,串流結束後(flush)才把 assistant 訊息整段寫入 messages——parker-api 是
// 常駐 Node process(非 serverless),不需要 waitUntil 之類的機制延長生命週期。
export async function sendMessage(
  catId: string,
  conversationId: string,
  content: string,
): Promise<SendMessageResult> {
  const conversation = await repo.findConversationById(conversationId);
  if (!conversation || conversation.catId !== catId) return { kind: "not_found" };

  await repo.createMessage({ conversationId, role: "user", content });

  const [catCareData, history] = await Promise.all([
    gatherCatCareData(catId),
    repo.listMessagesForConversation(conversationId),
  ]);

  const result = await requestChatReply({
    catCareData,
    messages: history.map((message) => ({ role: message.role, content: message.content })),
  });
  if (result.kind === "eve_unreachable") return { kind: "eve_unreachable" };

  const decoder = new TextDecoder();
  let assistantContent = "";
  const capture = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      assistantContent += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    async flush() {
      assistantContent += decoder.decode();
      if (assistantContent.length > 0) {
        await repo.createMessage({ conversationId, role: "assistant", content: assistantContent });
      }
    },
  });

  return { kind: "ok", stream: result.response.body!.pipeThrough(capture) };
}
