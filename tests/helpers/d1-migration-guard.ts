export const D1_MAX_COMPOUND_SELECT_TERMS = 5;

export interface CompoundSelectLimitViolation {
  line: number;
  terms: number;
}

interface CompoundSelectState {
  awaitingTerm: boolean;
  line: number;
  terms: number;
}

interface SqlToken {
  line: number;
  value: string;
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  let line = 1;

  const advance = (): string => {
    const character = sql[index] ?? "";
    index += 1;
    if (character === "\n") line += 1;
    return character;
  };

  while (index < sql.length) {
    const character = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (character === "-" && next === "-") {
      while (index < sql.length && advance() !== "\n") {
        // Skip line comments while preserving source line numbers.
      }
      continue;
    }
    if (character === "/" && next === "*") {
      advance();
      advance();
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) advance();
      if (index < sql.length) {
        advance();
        advance();
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = advance();
      while (index < sql.length) {
        const current = advance();
        if (current !== quote) continue;
        if (sql[index] === quote) {
          advance();
          continue;
        }
        break;
      }
      continue;
    }
    if (character === "[") {
      while (index < sql.length && advance() !== "]") {
        // SQLite bracket-quoted identifiers cannot contain an unescaped closing bracket.
      }
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const tokenLine = line;
      let value = "";
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index] ?? "")) value += advance();
      tokens.push({ line: tokenLine, value: value.toUpperCase() });
      continue;
    }
    if (character === "(" || character === ")" || character === ";") {
      tokens.push({ line, value: character });
    }
    advance();
  }

  return tokens;
}

export function findCompoundSelectLimitViolations(
  sql: string,
  maximumTerms = D1_MAX_COMPOUND_SELECT_TERMS,
): CompoundSelectLimitViolation[] {
  const states = new Map<number, CompoundSelectState>();
  const violations: CompoundSelectLimitViolation[] = [];
  let depth = 0;

  for (const token of tokenizeSql(sql)) {
    if (token.value === "(") {
      depth += 1;
      continue;
    }
    if (token.value === ")") {
      states.delete(depth);
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (token.value === ";") {
      states.clear();
      continue;
    }

    const state = states.get(depth);
    if (token.value === "SELECT") {
      if (state?.awaitingTerm) {
        state.awaitingTerm = false;
        state.terms += 1;
        if (state.terms === maximumTerms + 1) {
          violations.push({ line: state.line, terms: state.terms });
        }
      } else {
        states.set(depth, { awaitingTerm: false, line: token.line, terms: 1 });
      }
      continue;
    }
    if (token.value === "UNION" || token.value === "INTERSECT" || token.value === "EXCEPT") {
      if (state && !state.awaitingTerm) state.awaitingTerm = true;
    }
  }

  return violations;
}
