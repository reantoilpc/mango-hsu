/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

import type { AppEnv } from "./db/client";
import type { SessionInfo } from "./lib/auth";

declare global {
  namespace App {
    interface Locals {
      runtime?: {
        env: AppEnv;
        ctx: { waitUntil(p: Promise<unknown>): void };
      };
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
