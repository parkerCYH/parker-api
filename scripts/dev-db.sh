#!/usr/bin/env bash
# 啟動本機開發用 Postgres（docker compose），並登記進 devrun registry
# （純供 `devrun list` 查詢可見，devrun 不接管它的生命週期——停止請用
# `docker compose down`，不要用 `devrun stop`，見 devrun register 的說明）。
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d postgres

if command -v devrun >/dev/null 2>&1; then
  devrun register parker-api-postgres 5433 "postgres://parker:parker@localhost:5433/parker_api"
else
  echo "devrun 未安裝（見 .scratch/dev-server-port-management/），跳過 registry 登記" >&2
fi
