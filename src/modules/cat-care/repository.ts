import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../../shared/db.js";
import {
  bloodworkRecords,
  bowelMovements,
  catPlayers,
  cats,
  conversations,
  fluidInjections,
  healthAdvice,
  healthAdviceBloodworkRecords,
  messages,
  weightRecords,
} from "./schema.js";
import type {
  BloodworkStatus,
  BloodworkValues,
  FluidSite,
  FluidType,
  HealthAdviceContent,
  MessageRole,
  Method,
  StoolType,
} from "./schema.js";

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

export async function updateCat(
  catId: string,
  patch: { name?: string; birthdate?: string; notes?: string },
) {
  const [cat] = await db.update(cats).set(patch).where(eq(cats.id, catId)).returning();
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

export async function createFluidInjection(input: {
  catId: string;
  injectedBy: string;
  injectedAt: Date;
  site: FluidSite;
  siteOther?: string;
  volumeMl: number;
  fluidType: FluidType;
  fluidTypeOther?: string;
  notes?: string;
}) {
  const [row] = await db.insert(fluidInjections).values(input).returning();
  return row;
}

// 支援 ?from=&to= 日期區間篩選 injected_at(比照 bowel/weight)。
export async function listFluidInjections(catId: string, range?: { from?: Date; to?: Date }) {
  const conditions = [eq(fluidInjections.catId, catId)];
  if (range?.from) conditions.push(gte(fluidInjections.injectedAt, range.from));
  if (range?.to) conditions.push(lte(fluidInjections.injectedAt, range.to));

  return db
    .select()
    .from(fluidInjections)
    .where(and(...conditions))
    .orderBy(desc(fluidInjections.injectedAt));
}

export async function findFluidInjectionById(id: string) {
  const [row] = await db.select().from(fluidInjections).where(eq(fluidInjections.id, id)).limit(1);
  return row;
}

export async function updateFluidInjection(
  id: string,
  patch: {
    injectedAt?: Date;
    site?: FluidSite;
    siteOther?: string | null;
    volumeMl?: number;
    fluidType?: FluidType;
    fluidTypeOther?: string | null;
    notes?: string;
  },
) {
  const [row] = await db.update(fluidInjections).set(patch).where(eq(fluidInjections.id, id)).returning();
  return row;
}

// DELETE /cats/{catId}/fluid-injections/{id}:hard delete,單筆紀錄打錯直接刪,限 injected_by 本人。
export async function deleteFluidInjection(id: string): Promise<void> {
  await db.delete(fluidInjections).where(eq(fluidInjections.id, id));
}

export async function createBloodworkRecord(
  input: {
    catId: string;
    recordedBy: string;
    recordedAt: Date;
    status: BloodworkStatus;
  } & BloodworkValues,
) {
  const [row] = await db.insert(bloodworkRecords).values(input).returning();
  return row;
}

// 支援 ?from=&to= 日期區間篩選 recorded_at(比照 bowel/weight/fluid)。
export async function listBloodworkRecords(catId: string, range?: { from?: Date; to?: Date }) {
  const conditions = [eq(bloodworkRecords.catId, catId)];
  if (range?.from) conditions.push(gte(bloodworkRecords.recordedAt, range.from));
  if (range?.to) conditions.push(lte(bloodworkRecords.recordedAt, range.to));

  return db
    .select()
    .from(bloodworkRecords)
    .where(and(...conditions))
    .orderBy(desc(bloodworkRecords.recordedAt));
}

export async function findBloodworkRecordById(id: string) {
  const [row] = await db.select().from(bloodworkRecords).where(eq(bloodworkRecords.id, id)).limit(1);
  return row;
}

export async function updateBloodworkRecord(
  id: string,
  patch: { recordedAt?: Date; status?: BloodworkStatus } & BloodworkValues,
) {
  const [row] = await db.update(bloodworkRecords).set(patch).where(eq(bloodworkRecords.id, id)).returning();
  return row;
}

// DELETE /cats/{catId}/bloodwork-records/{id}:hard delete,單筆紀錄打錯直接刪,限 recorded_by 本人。
export async function deleteBloodworkRecord(id: string): Promise<void> {
  await db.delete(bloodworkRecords).where(eq(bloodworkRecords.id, id));
}

// 票 22:健康建議情境用,批次依 id 查詢、順便確認每一筆都屬於這隻貓(呼叫端比對回傳筆數
// 是否等於傳入的 id 數量,藉此判斷是否有 id 不存在或屬於別的貓咪)。
export async function findBloodworkRecordsByIds(catId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(bloodworkRecords)
    .where(and(eq(bloodworkRecords.catId, catId), inArray(bloodworkRecords.id, ids)));
}

// 票 22:寫入一筆健康建議 + 與所選驗血紀錄的多對多關聯,兩者要嘛一起成功要嘛一起失敗。
export async function createHealthAdvice(input: {
  requestedBy: string;
  advice: HealthAdviceContent;
  bloodworkRecordIds: string[];
}) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(healthAdvice)
      .values({ requestedBy: input.requestedBy, advice: input.advice })
      .returning();

    await tx.insert(healthAdviceBloodworkRecords).values(
      input.bloodworkRecordIds.map((bloodworkRecordId) => ({
        healthAdviceId: row.id,
        bloodworkRecordId,
      })),
    );

    return row;
  });
}

// 票 23:單筆驗血紀錄的歷史建議查詢——先找出這筆紀錄關聯到的 health_advice id,再一次性
// 撈出每一筆 advice 完整關聯的所有 bloodworkRecordIds(同一筆 advice 可能涵蓋多筆紀錄做趨勢
// 分析,票 22 定案),避免對每筆 advice 各查一次關聯表造成 N+1。
export async function listHealthAdviceForBloodworkRecord(bloodworkRecordId: string) {
  const rows = await db
    .select({ healthAdvice })
    .from(healthAdviceBloodworkRecords)
    .innerJoin(healthAdvice, eq(healthAdviceBloodworkRecords.healthAdviceId, healthAdvice.id))
    .where(eq(healthAdviceBloodworkRecords.bloodworkRecordId, bloodworkRecordId))
    .orderBy(desc(healthAdvice.createdAt));

  if (rows.length === 0) return [];

  const adviceIds = rows.map((row) => row.healthAdvice.id);
  const links = await db
    .select()
    .from(healthAdviceBloodworkRecords)
    .where(inArray(healthAdviceBloodworkRecords.healthAdviceId, adviceIds));

  const recordIdsByAdviceId = new Map<string, string[]>();
  for (const link of links) {
    const list = recordIdsByAdviceId.get(link.healthAdviceId) ?? [];
    list.push(link.bloodworkRecordId);
    recordIdsByAdviceId.set(link.healthAdviceId, list);
  }

  return rows.map((row) => ({
    ...row.healthAdvice,
    bloodworkRecordIds: recordIdsByAdviceId.get(row.healthAdvice.id) ?? [],
  }));
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

// 票 24:新建一條對話串,一隻貓可有多條(票 15 定案)。
export async function createConversation(input: { catId: string; createdBy: string }) {
  const [row] = await db.insert(conversations).values(input).returning();
  return row;
}

// 列出一隻貓底下的對話串,新到舊排序,供前端列表使用(票 15 定案的對話串列表)。
export async function listConversationsForCat(catId: string) {
  return db.select().from(conversations).where(eq(conversations.catId, catId)).orderBy(desc(conversations.createdAt));
}

export async function findConversationById(id: string) {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return row;
}

export async function createMessage(input: { conversationId: string; role: MessageRole; content: string }) {
  const [row] = await db.insert(messages).values(input).returning();
  return row;
}

// 送給 eve 當多輪對話的歷史 context(票 24),依時間正序(舊到新),跟前端呈現順序一致。
export async function listMessagesForConversation(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}
