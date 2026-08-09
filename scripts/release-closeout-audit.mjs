import { resolve } from "node:path";
import process from "node:process";

import {
  buildCloseoutReport,
  loadCloseoutInputs,
} from "./lib/release-closeout.mjs";
import { inspectProductionReadiness } from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = { json: false, evidencePath: undefined, productionSpecPath: undefined, secretNamesPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.productionSpecPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--secret-names") options.secretNamesPath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const inputs = await loadCloseoutInputs(options);
  const report = await buildCloseoutReport({
    ...inputs,
    inspectReadinessImplementation: (input) => inspectProductionReadiness({
      ...input,
      requireReleaseHardening: true,
    }),
  });
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${report.ok ? "PASS" : "FAIL"} production closeout (${report.summary.failed}/${report.summary.total} checks blocked)\n`
      + report.failedChecks.map((check) => `x ${check.name} [${check.category}] ${check.nextAction}`).join("\n")
      + (report.failedChecks.length > 0 ? "\n" : ""));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "release_closeout_audit_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
