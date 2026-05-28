// Standalone cron worker. Deployed via
// `wrangler deploy --env cron --config wrangler.jsonc`.
// We don't rely on @astrojs/cloudflare's scheduled() integration because
// adapter compatibility for cron handlers is uneven across versions.
//
// Purges both prod and stage in parallel. Each DB is independent —
// if one fails we still want the other to complete and be logged,
// so we use Promise.allSettled.
import { purgeOldOrders } from "./cron/purge";

type CronEnv = {
  DB: D1Database;        // mango-hsu-prod
  DB_STAGE: D1Database;  // mango-hsu-stage
};

export default {
  async scheduled(
    _event: ScheduledController,
    env: CronEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        const [prodResult, stageResult] = await Promise.allSettled([
          purgeOldOrders(env.DB),
          purgeOldOrders(env.DB_STAGE),
        ]);
        // Best-effort log; cron worker logs go to Workers Insights.
        console.log(
          "PDPA purge",
          JSON.stringify({
            prod:
              prodResult.status === "fulfilled"
                ? prodResult.value
                : { error: String(prodResult.reason) },
            stage:
              stageResult.status === "fulfilled"
                ? stageResult.value
                : { error: String(stageResult.reason) },
          }),
        );
      })(),
    );
  },
} satisfies ExportedHandler<CronEnv>;
