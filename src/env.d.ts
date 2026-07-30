/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

import type { SupportedLocale } from "./lib/i18n/locale";

declare global {
  namespace App {
    interface Locals {
      locale?: SupportedLocale;
      requestId: string;
    }
  }
}
