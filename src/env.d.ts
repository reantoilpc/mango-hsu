/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

import type { AppEnv } from "./db/client";
import type { SessionInfo } from "./lib/auth";

declare global {
  namespace App {
    interface Locals {
      // Astro 6 / @astrojs/cloudflare 13: env moved to `cloudflare:workers` import,
      // ctx moved to `Astro.locals.cfContext`. Old `runtime` shape kept off-type.
      cfContext?: { waitUntil(p: Promise<unknown>): void };
      session?: SessionInfo;
    }
  }

  interface ImportMetaEnv {
    readonly PUBLIC_APPS_SCRIPT_URL?: string;
    readonly PUBLIC_ORDER_TOKEN?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
