import type { APIRoute } from "astro";
import { env } from "../../../lib/env";
import { loadSiteSettings } from "../../../lib/site-settings";

export const GET: APIRoute = async () => {
  const settings = await loadSiteSettings(env);
  return new Response(JSON.stringify(settings), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
