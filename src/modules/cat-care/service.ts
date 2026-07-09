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
      cats: await repo.listCatsForPlayer(playerId),
    })),
  );
}

export async function getCatCarePlayer(playerId: string) {
  const [cats, hasAccess] = await Promise.all([
    repo.listCatsForPlayer(playerId),
    canPlayer(playerId, "catCare.access"),
  ]);

  if (cats.length === 0 && !hasAccess) return undefined;

  return { playerId, cats };
}
