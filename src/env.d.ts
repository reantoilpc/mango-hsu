/// <reference path="../.astro/types.d.ts" />

import type { AppEnv } from "./db/client";
import type { SessionInfo } from "./lib/auth";

declare namespace App {
  interface Locals {
    runtime?: {
      env: AppEnv;
      ctx: { waitUntil(p: Promise<unknown>): void };
    };
    session?: SessionInfo;
  }
}
