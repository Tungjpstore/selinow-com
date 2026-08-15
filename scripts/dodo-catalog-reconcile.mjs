import process from "node:process";

import {
  parseDodoCatalogArguments,
  readDodoCatalogReferences,
  readDodoCatalogProviderMode,
  reconcileDodoCatalog,
  validateDodoCatalogTarget,
} from "./lib/dodo-catalog-reconciliation.mjs";

function output(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${value.mode === "dry_run" ? "DRY-RUN" : "PASS"} ${value.environment}\n`);
  process.stdout.write(`= catalog: ${value.action}\n`);
  process.stdout.write(`= pending_rows: ${value.pendingCount}\n`);
  process.stdout.write(`= published_rows: ${value.publishedCount}\n`);
  process.stdout.write(`= closed_rows: ${value.closedCount}\n`);
  process.stdout.write(`= inserted_rows: ${value.insertedCount}\n`);
  process.stdout.write(`= updated_rows: ${value.updatedCount}\n`);
}

try {
  const options = parseDodoCatalogArguments(process.argv.slice(2));
  const references = readDodoCatalogReferences(process.env);
  if (!options.apply) {
    output({
      action: "would_reconcile_four_dodo_catalog_rows",
      environment: options.environment,
      mode: "dry_run",
      closedCount: 0,
      insertedCount: 0,
      pendingCount: null,
      publishedCount: null,
      updatedCount: 0,
    }, options.json);
  } else {
    const providerMode = readDodoCatalogProviderMode(process.env);
    validateDodoCatalogTarget({
      confirmProduction: options.confirmProduction,
      confirmProductionLiveCatalog: options.confirmProductionLiveCatalog,
      confirmStagingTestCatalog: options.confirmStagingTestCatalog,
      environment: options.environment,
      providerMode,
    });
    const result = await reconcileDodoCatalog({
      confirmProduction: options.confirmProduction,
      confirmProductionLiveCatalog: options.confirmProductionLiveCatalog,
      confirmStagingTestCatalog: options.confirmStagingTestCatalog,
      environment: options.environment,
      providerMode,
      references,
    });
    output({
      action: result.insertedCount === 4
        ? "catalog_rotated"
        : (result.updatedCount === 0 ? "catalog_already_configured" : "catalog_reconciled"),
      ...result,
    }, options.json);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "dodo_catalog_reconcile_failed";
  process.stderr.write(/^[a-z0-9_:.-]{1,180}$/u.test(message) ? `${message}\n` : "dodo_catalog_reconcile_failed\n");
  process.exitCode = 1;
}
