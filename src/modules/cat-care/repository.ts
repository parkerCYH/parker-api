import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "../../shared/db.js";
import { bowelMovements, catPlayers, cats, weightRecords } from "./schema.js";
import type { Method, StoolType } from "./schema.js";

export async function createCat(input: {
  name: string;
  birthdate?: string;
  notes?: string;
  creatorPlayerId: string;
}) {
  return db.transaction(async (tx) => {
    const [cat] = await tx
      .insert(cats)
      .values({ name: input.name, birthdate: input.birthdate, notes: input.notes })
      .returning();

    await tx.insert(catPlayers).values({ catId: cat.id, playerId: input.creatorPlayerId });

    return cat;
  });
}

export async function isCatMember(catId: string, playerId: string): Promise<boolean> {
  const [row] = await db
    .select({ catId: catPlayers.catId })
    .from(catPlayers)
    .where(and(eq(catPlayers.catId, catId), eq(catPlayers.playerId, playerId)))
    .limit(1);
  return Boolean(row);
}

// Player app 用:預設排除已封存的貓咪(ticket #23),回應帶 chipPlayerId(ticket #25)。
export async function listCatsForPlayer(playerId: string) {
  return db
    .select({
      id: cats.id,
      name: cats.name,
      birthdate: cats.birthdate,
      notes: cats.notes,
      chipPlayerId: cats.chipPlayerId,
      createdAt: cats.createdAt,
    })
    .from(cats)
    .innerJoin(catPlayers, eq(catPlayers.catId, cats.id))
    .where(and(eq(catPlayers.playerId, playerId), isNull(cats.archivedAt)));
}

// admin gateway 用(ticket #23):不過濾已封存,回應多帶 archivedAt、chipPlayerId(ticket #25)。
export async function listAllCatsForPlayer(playerId: string) {
  return db
    .select({
      id: cats.id,
      name: cats.name,
      birthdate: cats.birthdate,
      notes: cats.notes,
      archivedAt: cats.archivedAt,
      chipPlayerId: cats.chipPlayerId,
      createdAt: cats.createdAt,
    })
    .from(cats)
    .innerJoin(catPlayers, eq(catPlayers.catId, cats.id))
    .where(eq(catPlayers.playerId, playerId));
}

// Player app 的單一貓咪詳情用:已封存視同不存在(ticket #23),回應帶 chipPlayerId(ticket #25)。
export async function findActiveCatById(catId: string) {
  const [cat] = await db
    .select({
      id: cats.id,
      name: cats.name,
      birthdate: cats.birthdate,
      notes: cats.notes,
      chipPlayerId: cats.chipPlayerId,
      createdAt: cats.createdAt,
    })
    .from(cats)
    .where(and(eq(cats.id, catId), isNull(cats.archivedAt)))
    .limit(1);
  return cat;
}

// admin gateway 用:不論是否已封存都回傳(ticket #20、#23)。
export async function findCatById(catId: string) {
  const [cat] = await db.select().from(cats).where(eq(cats.id, catId)).limit(1);
  return cat;
}

export async function archiveCat(catId: string) {
  const [cat] = await db
    .update(cats)
    .set({ archivedAt: new Date() })
    .where(eq(cats.id, catId))
    .returning();
  return cat;
}

// 邀請(ticket #24):目標已是成員時 no-op,邀請本身是 idempotent 的。
export async function addCatPlayer(catId: string, playerId: string): Promise<void> {
  await db.insert(catPlayers).values({ catId, playerId }).onConflictDoNothing();
}

export async function removeCatPlayer(catId: string, playerId: string): Promise<void> {
  await db.delete(catPlayers).where(and(eq(catPlayers.catId, catId), eq(catPlayers.playerId, playerId)));
}

export async function countCatPlayers(catId: string): Promise<number> {
  const rows = await db.select({ playerId: catPlayers.playerId }).from(catPlayers).where(eq(catPlayers.catId, catId));
  return rows.length;
}

// GET /cats/{catId}/players 用(ticket #25):單一貓咪目前的成員 player id 清單。
export async function listCatPlayerIds(catId: string): Promise<string[]> {
  const rows = await db.select({ playerId: catPlayers.playerId }).from(catPlayers).where(eq(catPlayers.catId, catId));
  return rows.map((row) => row.playerId);
}

// 設定/轉移晶片登記責任人(ticket #24)——呼叫端負責先確認目標是 cat_players 成員。
export async function setChipPlayer(catId: string, playerId: string) {
  const [cat] = await db
    .update(cats)
    .set({ chipPlayerId: playerId })
    .where(eq(cats.id, catId))
    .returning();
  return cat;
}

export async function createBowelMovement(input: {
  catId: string;
  recordedBy: string;
  recordedAt: Date;
  stoolType?: StoolType;
  isAbnormal?: boolean;
  notes?: string;
}) {
  const [row] = await db.insert(bowelMovements).values(input).returning();
  return row;
}

// 支援 ?from=&to= 日期區間篩選 recorded_at(ticket #24)。
export async function listBowelMovements(catId: string, range?: { from?: Date; to?: Date }) {
  const conditions = [eq(bowelMovements.catId, catId)];
  if (range?.from) conditions.push(gte(bowelMovements.recordedAt, range.from));
  if (range?.to) conditions.push(lte(bowelMovements.recordedAt, range.to));

  return db
    .select()
    .from(bowelMovements)
    .where(and(...conditions))
    .orderBy(desc(bowelMovements.recordedAt));
}

export async function findBowelMovementById(id: string) {
  const [row] = await db.select().from(bowelMovements).where(eq(bowelMovements.id, id)).limit(1);
  return row;
}

export async function updateBowelMovement(
  id: string,
  patch: { recordedAt?: Date; stoolType?: StoolType; isAbnormal?: boolean; notes?: string },
) {
  const [row] = await db.update(bowelMovements).set(patch).where(eq(bowelMovements.id, id)).returning();
  return row;
}

// DELETE /cats/{catId}/bowel-movements/{id}(ticket #25):hard delete,單筆紀錄打錯直接刪。
export async function deleteBowelMovement(id: string): Promise<void> {
  await db.delete(bowelMovements).where(eq(bowelMovements.id, id));
}

export async function createWeightRecord(input: {
  catId: string;
  measuredBy: string;
  measuredAt: Date;
  weightGrams: number;
  method?: Method;
  notes?: string;
}) {
  const [row] = await db.insert(weightRecords).values(input).returning();
  return row;
}

// 支援 ?from=&to= 日期區間篩選 measured_at(ticket #24)。
export async function listWeightRecords(catId: string, range?: { from?: Date; to?: Date }) {
  const conditions = [eq(weightRecords.catId, catId)];
  if (range?.from) conditions.push(gte(weightRecords.measuredAt, range.from));
  if (range?.to) conditions.push(lte(weightRecords.measuredAt, range.to));

  return db
    .select()
    .from(weightRecords)
    .where(and(...conditions))
    .orderBy(desc(weightRecords.measuredAt));
}

export async function findWeightRecordById(id: string) {
  const [row] = await db.select().from(weightRecords).where(eq(weightRecords.id, id)).limit(1);
  return row;
}

export async function updateWeightRecord(
  id: string,
  patch: { measuredAt?: Date; weightGrams?: number; method?: Method; notes?: string },
) {
  const [row] = await db.update(weightRecords).set(patch).where(eq(weightRecords.id, id)).returning();
  return row;
}

// DELETE /cats/{catId}/weight-records/{id}(ticket #25):hard delete,單筆紀錄打錯直接刪。
export async function deleteWeightRecord(id: string): Promise<void> {
  await db.delete(weightRecords).where(eq(weightRecords.id, id));
}

// 給 admin module 用(ticket #20):cat_players 裡出現過的所有 Player id(不重複)。
export async function listDistinctCatPlayerIds(): Promise<string[]> {
  const rows = await db.selectDistinct({ playerId: catPlayers.playerId }).from(catPlayers);
  return rows.map((row) => row.playerId);
}

// 給 admin module 用(ADR-0005):跨 Player 的全部貓咪清單,不做 membership 過濾。
// 已封存的貓咪也包含在內,多帶 archivedAt(ticket #23)、chipPlayerId(ticket #25)。
export async function listAllCats() {
  return db
    .select({
      id: cats.id,
      name: cats.name,
      birthdate: cats.birthdate,
      notes: cats.notes,
      archivedAt: cats.archivedAt,
      chipPlayerId: cats.chipPlayerId,
      createdAt: cats.createdAt,
    })
    .from(cats);
}
