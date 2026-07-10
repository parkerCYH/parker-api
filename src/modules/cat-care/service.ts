import { canPlayer, getPlayerByEmail, getPlayerProfile, listPlayersWithAccess } from "../auth/index.js";
import * as repo from "./repository.js";
import type { Method, StoolType } from "./schema.js";

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
    to: range?.to ? new Date(range.to) : undefined,
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
    to: range?.to ? new Date(range.to) : undefined,
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
