export interface KnownRule {
  rule: string;
  description: string;
}

// User-RBAC 專用目錄(不含 Player-RBAC 的 <service>.access——那是另一套系統,見
// docs/services/rbac.md「規則目錄」)。人工維護,任何新的 canUser(...) 呼叫點用到的規則都要
// 同步加進來,否則會被 known-rules.scan.test.ts 的靜態掃描抓到。
export const KNOWN_RULES: KnownRule[] = [
  { rule: "admin.users.view", description: "讀取 User 清單" },
  { rule: "admin.users.approve", description: "核准/拒絕申請、調整既有 User 的 Role" },
  { rule: "admin.whitelist.manage", description: "管理邀請白名單" },
  { rule: "rbac.roles.manage", description: "管理 Role/Rule 本身" },
  { rule: "admin.catCare.viewAll", description: "查看 cat-care 的全部資料(gateway)" },
];
