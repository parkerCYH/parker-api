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
  return repo.findCatById(catId);
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

// 給 admin module 當 gateway 呼叫(見 ticket #14、ADR-0005),cat-care 自己不開對外端點。
export const listAllCats = repo.listAllCats;
