import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import process from "node:process";

const testResultsRoot = resolve(process.cwd(), "test-results");

function resolveOutputPath(value) {
  const outputPath = resolve(process.cwd(), value ?? "test-results/authenticated-safe-failures.json");
  if (outputPath !== testResultsRoot && !outputPath.startsWith(`${testResultsRoot}${sep}`)) {
    throw new Error("playwright_safe_failure_report_path_invalid");
  }
  return outputPath;
}

export function redactPlaywrightFailure(value) {
  return String(value)
    .replace(/(\/api\/auth\/magic-link\/consume)\?[^\s"'<>]*/giu, "$1?[redacted]")
    .replace(/([?&](?:code|csrf|session|token)=)[^&\s"'<>]*/giu, "$1[redacted]")
    .replace(/((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/giu, "$1[redacted]")
    .replace(/((?:SESSION_SECRET|MAGIC_LINK_SECRET|IDENTIFIER_HMAC_SECRET|CREDENTIAL_KEK_V1|INVENTORY_KEK_V1|EXPORT_KEK_V1|TURNSTILE_SECRET_KEY|DODO_PAYMENTS_API_KEY|DODO_PAYMENTS_WEBHOOK_KEY|DODO_PAYMENTS_WEBHOOK_SECRET|DODO_API_KEY|DODO_WEBHOOK_SECRET|PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT|PAYOS_CONTROLLED_STAGING_CLIENT_ID|CLOUDFLARE_API_TOKEN|CLOUDFLARE_PLATFORM_API_TOKEN|CLOUDFLARE_ROUTE_AUDIT_API_TOKEN|CLOUDFLARE_OAUTH_TOKEN|CF_API_TOKEN)\s*[:=]\s*)[^\s,;]+/gu, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted-opaque]");
}

function writeReport(outputPath, report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
}

export default class SafeFailureReporter {
  failures = [];
  outputPath;

  constructor(options = {}) {
    this.outputPath = resolveOutputPath(options.outputPath);
  }

  onBegin() {
    writeReport(this.outputPath, { failures: [], status: "running" });
  }

  onTestEnd(test, result) {
    if (result.status === test.expectedStatus) return;
    this.failures.push({
      errors: result.errors.map((error) => redactPlaywrightFailure(error.message ?? error.value ?? "test_failed")),
      file: test.location.file,
      line: test.location.line,
      project: test.parent.project()?.name ?? "unknown",
      retry: result.retry,
      status: result.status,
      title: test.title,
    });
  }

  onEnd(result) {
    writeReport(this.outputPath, { failures: this.failures, status: result.status });
  }
}
