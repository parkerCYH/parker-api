import type { ErrorHandler } from "hono";

/**
 * README「錯誤訊息隔離」:任何非預期錯誤只寫進 log,回應一律是模糊安全的 JSON,
 * 避免 SQL / 資料庫結構等內部細節外洩。
 */
export const errorHandler: ErrorHandler = (err, c) => {
  console.error(err);

  return c.json(
    {
      error: "internal_server_error",
      message: "An unexpected error occurred",
    },
    500,
  );
};
