import { db } from "../../shared/db.js";
import { requests } from "./schema.js";

export async function recordRequest(): Promise<void> {
  await db.insert(requests).values({});
}

export async function countRequests(): Promise<number> {
  const rows = await db.select().from(requests);
  return rows.length;
}
