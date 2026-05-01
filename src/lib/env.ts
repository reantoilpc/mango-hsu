// Astro 6 removed `Astro.locals.runtime.env`. Use `cloudflare:workers` import
// (request-scoped via AsyncLocalStorage). Wrap once here so downstream files
// import a typed `env` instead of casting at every call site.
import { env as workerEnv } from "cloudflare:workers";
import type { AppEnv } from "../db/client";

export const env = workerEnv as unknown as AppEnv;
