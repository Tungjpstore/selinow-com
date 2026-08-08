import { describe, expect, it } from "vitest";

import {
  assertProductionWorkerUploadResult,
  buildProductionWorkerVersionMessage,
} from "../../scripts/lib/release.mjs";

const binding = {
  commitSha: "a".repeat(40),
  manifestRef: ".wrangler/releases/release_20260809_abcdef12/release-manifest.json",
  releaseId: "release_20260809_abcdef12",
  treeSha: "b".repeat(40),
};

describe("production Worker upload binding", () => {
  it("creates a structured release provenance message", () => {
    expect(JSON.parse(buildProductionWorkerVersionMessage({ ...binding, role: "candidate" }))).toEqual({
      ...binding,
      role: "candidate",
    });
  });

  it("admits exactly one newly uploaded version with the expected binding", () => {
    const current = "11111111-1111-4111-8111-111111111111";
    const candidate = "22222222-2222-4222-8222-222222222222";
    expect(assertProductionWorkerUploadResult({
      after: {
        items: [
          { id: current },
          { annotations: { "workers/message": JSON.stringify({ ...binding, role: "candidate" }) }, id: candidate },
        ],
      },
      before: { items: [{ id: current }] },
      expectedBinding: binding,
    })).toMatchObject({ workerVersion: candidate });
  });

  it("rejects missing provenance or an ambiguous version delta", () => {
    const current = "11111111-1111-4111-8111-111111111111";
    const candidate = "22222222-2222-4222-8222-222222222222";
    expect(() => assertProductionWorkerUploadResult({
      after: { items: [{ id: current }, { id: candidate }] },
      before: { items: [{ id: current }] },
      expectedBinding: binding,
    })).toThrow("production_worker_upload_binding_mismatch");
    expect(() => assertProductionWorkerUploadResult({
      after: { items: [{ id: current }] },
      before: { items: [{ id: current }] },
      expectedBinding: binding,
    })).toThrow("production_worker_upload_version_delta_invalid");
  });
});
