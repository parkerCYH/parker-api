import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_RULES } from "./known-rules.js";

// 不是 e2e 測試,是原始碼一致性防呆(ADR-0004 的例外段落):掃描 src/modules/**/*.ts
// (排除測試檔)裡所有 canUser(...) 呼叫點用到的 rule 字串,斷言全部登記在 KNOWN_RULES。
// 不掃 canPlayer(...)——Player-RBAC 是另一套系統,不在這份目錄範圍內。
const SRC_MODULES_DIR = fileURLToPath(new URL("..", import.meta.url));

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

const CAN_USER_CALL_PATTERN = /canUser\s*\(\s*[^,()]+,\s*(["'`])((?:(?!\1).)*)\1/g;

function findRuleUsages(files: string[]): { rule: string; file: string }[] {
  const usages: { rule: string; file: string }[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");

    for (const match of content.matchAll(CAN_USER_CALL_PATTERN)) {
      usages.push({ rule: match[2], file });
    }
  }

  return usages;
}

describe("KNOWN_RULES 靜態一致性", () => {
  it("every canUser(...) call site's rule string is registered in KNOWN_RULES", () => {
    const files = collectTsFiles(SRC_MODULES_DIR);
    const usages = findRuleUsages(files);

    // 至少要掃到東西,不然這個防呆測試本身可能壞了(regex 沒對到、目錄找錯)。
    expect(usages.length).toBeGreaterThan(0);

    const knownRuleStrings = new Set(KNOWN_RULES.map((r) => r.rule));
    const missing = usages.filter((u) => !knownRuleStrings.has(u.rule));

    expect(missing).toEqual([]);
  });
});
