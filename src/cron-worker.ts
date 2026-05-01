// Standalone cron worker. Deployed via `wrangler deploy --env cron`.
// We don't rely on @astrojs/cloudflare's scheduled() integration because
// adapter compatibility for cron handlers is uneven across versions.
import { purgeOldOrders } from "./cron/purge";
import type { AppEnv } from "./db/client";

export default {
  async scheduled(
    _event: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        const result = await purgeOldOrders(env);
        // Best-effort log; cron worker logs go to Workers Insights.
        console.log("PDPA purge", JSON.stringify(result));
      })(),
    );
  },
} satisfies ExportedHandler<AppEnv>;
