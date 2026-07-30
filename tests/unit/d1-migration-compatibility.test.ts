import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  D1_MAX_COMPOUND_SELECT_TERMS,
  findCompoundSelectLimitViolations,
} from "../helpers/d1-migration-guard";

describe("D1 migration compatibility", () => {
  it("rejects compound SELECT chains above the observed D1 limit", () => {
    const sql = `
      SELECT 1
      UNION ALL SELECT 2
      UNION ALL SELECT 3
      UNION ALL SELECT 4
      UNION ALL SELECT 5
      UNION ALL SELECT 6;
    `;

    expect(findCompoundSelectLimitViolations(sql)).toEqual([{ line: 2, terms: 6 }]);
  });

  it("ignores SQL comments, literals and independent compliant chains", () => {
    const sql = `
      -- SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6
      SELECT 'UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6';
      SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5;
      SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10;
    `;

    expect(findCompoundSelectLimitViolations(sql)).toEqual([]);
  });

  it("keeps every repository migration within the D1 compound SELECT limit", () => {
    const directory = join(process.cwd(), "migrations");
    const violations = readdirSync(directory)
      .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename))
      .sort()
      .flatMap((filename) => findCompoundSelectLimitViolations(
        readFileSync(join(directory, filename), "utf8"),
      ).map((violation) => ({ filename, ...violation })));

    expect(D1_MAX_COMPOUND_SELECT_TERMS).toBe(5);
    expect(violations).toEqual([]);
  });
});
