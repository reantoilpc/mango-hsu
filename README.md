# mango-hsu

> 芒果許，自產自消芒果

家族小規模芒果直銷的下單網站。每年產季客人透過 LINE 詢問購買，家人手動對帳；
這個網站把訂單、對帳、出貨流程結構化，讓家人能直接在後台處理。

## Status

- **V1**：Astro 靜態站 + Google Apps Script + Sheet（已退役，見 `docs/design-v1.md`）
- **V2**：Astro SSR + Cloudflare D1 + 自有 admin 後台（已上線）
- **V3**：LINE OA + LIFF 綁定，付款／出貨自動推 LINE 通知

## Stack

Astro 6 SSR · Cloudflare Workers (`@astrojs/cloudflare`) · D1 + Drizzle ORM · KV · Tailwind v4 · TypeScript · Bun

兩個 Worker：主站 (`/`、`/admin`、`/api/*`) 與 cron worker (`src/cron-worker.ts`，週日 18:00 UTC 跑 PDPA 6 個月清理)。

## Quickstart

```bash
bun install
bun run dev          # 本機 dev server，含 Cloudflare bindings via platformProxy
bun run build        # type-check + build
bun run db:generate  # 從 src/db/schema.ts 產 Drizzle migration
```

部署需要 Cloudflare 帳號 + `wrangler login`，並先用 `wrangler secret put` 設好
所有 secrets（清單見 `AppEnv` in `src/db/client.ts`）。

```bash
bun run deploy:stage           # build + deploy 主 Worker 到 stage
bun run deploy:prod            # build + deploy 主 Worker 到 prod
bunx wrangler deploy --env cron  # 部署 cron worker
```

> **注意**：`@astrojs/cloudflare` 13.x 會 flatten `dist/server/wrangler.json` 並
> 忽略根層級 `env.*`。`scripts/deploy.mjs` 會在 build 後 patch 該檔案。
> 加任何新 per-env binding 必須**同時**更新 `wrangler.jsonc` AND `scripts/deploy.mjs`。

## Pre-commit hook (一次性)

```bash
git config core.hooksPath .githooks
brew install gitleaks    # 或對應平台的 package
```

Hook 跑 `gitleaks protect --staged`，擋 token / key 形狀的 staged 內容。

## 文件

| 檔案 | 內容 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | 給 Claude Code 用的 repo 地圖 — 架構、命令、慣例 |
| [`docs/design-v1.md`](docs/design-v1.md) | V1 原始設計（Apps Script + Sheet，歷史記錄） |
| [`docs/design-v2.md`](docs/design-v2.md) | V2 設計（D1、admin、LIFF 等） |
| [`docs/family-runbook.md`](docs/family-runbook.md) | 家人操作手冊（V2 admin 後台） |

## License

MIT — 見 [`LICENSE`](LICENSE)。
