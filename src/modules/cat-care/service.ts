import { canPlayer, listPlayersWithAccess } from "../auth/index.js";
import * as repo from "./repository.js";

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

export async function recordBowelMovement(
  catId: string,
  playerId: string,
  input: { recordedAt?: string; stoolType?: string; isAbnormal?: boolean; notes?: string },
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

export async function listBowelMovements(catId: string) {
  return repo.listBowelMovements(catId);
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
  input: { recordedAt?: string; stoolType?: string; isAbnormal?: boolean; notes?: string },
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

export async function recordWeight(
  catId: string,
  playerId: string,
  input: { measuredAt?: string; weightGrams: number; method?: string; notes?: string },
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

export async function listWeightRecords(catId: string) {
  return repo.listWeightRecords(catId);
}

// PATCH /cats/{catId}/weight-records/{id}(ticket #23):只有當初 measured_by 本人能編輯。
export async function updateWeightRecord(
  catId: string,
  recordId: string,
  playerId: string,
  input: { measuredAt?: string; weightGrams?: number; method?: string; notes?: string },
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
