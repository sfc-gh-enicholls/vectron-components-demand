/**
 * Declarative calculation engine: formulas held as data, evaluated in
 * dependency order.
 *
 * PORTED from SDP Configurator 5.0 (app-template/src/lib/calc-engine.ts,
 * "SDP v3 Declarative Calculation Engine"): tokenizer, recursive-descent
 * parser, dependency graph and Kahn topological sort with cycle reporting.
 * The certainty / confidence-interval helpers were not ported.
 *
 * Fixed on the way in, each pinned by a test in src/__tests__/calc-engine.test.ts:
 *  1. RATIO() always returned 0 through evaluateAll, which never passed the
 *     parent total. Parent totals are now an explicit input, and a RATIO with
 *     no parent total supplied THROWS instead of answering 0.
 *  2. Trailing tokens were silently ignored: "[A] [B]" evaluated as [A].
 *  3. "1.2.3" parsed as 1.2.
 *  4. Bare identifiers were references, so "UNITS-RETURNS" was ONE reference,
 *     not a subtraction. References must now be bracketed: [UNITS]-[RETURNS].
 *  5. LAG / CUMULATE over an expression silently returned 0. Their argument
 *     must now be a single reference.
 *  6. A formula that failed to parse was skipped, so everything downstream
 *     quietly read 0. It now throws, naming the formula.
 *  7. Duplicate formula codes: the last one silently won. Now an error.
 *  8. validateFormula built the graph WITHOUT the candidate formula, so it
 *     could not see a cycle the candidate itself would create.
 *
 * Conventions kept from the source: division by zero yields 0 (a price per
 * case on zero units is 0, not Infinity), and an unknown reference reads 0
 * during evaluation; validateFormula is where unknown references are caught.
 *
 * Pure: no I/O, safe on server and client.
 */

// ─── TYPES ────────────────────────────────────────────────────────────

export type CalcType = "INPUT" | "AGG" | "FORMULA";

export interface FormulaRow {
  /** The measure this formula computes, e.g. "NET_REVENUE". */
  code: string;
  calcType: CalcType;
  expression: string | null;
  isActive: boolean;
}

export type ExprNode =
  | { type: "ref"; code: string }
  | { type: "num"; value: number }
  | { type: "binop"; op: "+" | "-" | "*" | "/"; left: ExprNode; right: ExprNode }
  | { type: "unary"; op: "-"; operand: ExprNode }
  | { type: "sum"; args: ExprNode[] }
  | { type: "lag"; ref: string; n: number }
  | { type: "cumulate"; ref: string }
  | { type: "ratio"; driver: ExprNode }
  | { type: "iif"; cond: ExprNode; then: ExprNode; else: ExprNode };

export interface ParseResult {
  ast: ExprNode | null;
  refs: string[];
  error: string | null;
}

export interface EvaluateOptions {
  /** Prior-period values for LAG(ref, n), keyed `${code}@${n}`; CUMULATE reads `${code}__cumulate`. */
  lagValues?: Map<string, number>;
  /** The parent's value of each RATIO formula's measure, keyed by the formula's code. */
  parentTotals?: Map<string, number>;
}

// ─── TOKENIZER ────────────────────────────────────────────────────────

type Token =
  | { type: "REF"; code: string }
  | { type: "NUM"; value: number }
  | { type: "OP"; op: "+" | "-" | "*" | "/" }
  | { type: "LPAREN" }
  | { type: "RPAREN" }
  | { type: "COMMA" }
  | { type: "IDENT"; name: string }
  | { type: "EOF" };

const FUNCTIONS = new Set(["SUM", "LAG", "CUMULATE", "RATIO", "IIF"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "[") {
      const end = src.indexOf("]", i);
      if (end === -1) throw new Error(`Unclosed '[' at position ${i}`);
      const code = src.slice(i + 1, end).trim();
      if (!code) throw new Error(`Empty reference at position ${i}`);
      tokens.push({ type: "REF", code });
      i = end + 1;
      continue;
    }
    if (ch === "(") { tokens.push({ type: "LPAREN" }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "RPAREN" }); i++; continue; }
    if (ch === ",") { tokens.push({ type: "COMMA" }); i++; continue; }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ type: "OP", op: ch });
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const start = i;
      let num = "";
      while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
      if (!/^(\d+\.?\d*|\.\d+)$/.test(num)) throw new Error(`Malformed number '${num}' at position ${start}`);
      tokens.push({ type: "NUM", value: Number(num) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      let id = "";
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) id += src[i++];
      const upper = id.toUpperCase();
      if (!FUNCTIONS.has(upper)) {
        throw new Error(`'${id}' at position ${start} is not a function. Wrap measure references in brackets: [${id}]`);
      }
      tokens.push({ type: "IDENT", name: upper });
      continue;
    }
    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({ type: "EOF" });
  return tokens;
}

// ─── PARSER ───────────────────────────────────────────────────────────
// expr    := term (('+'|'-') term)*
// term    := unary (('*'|'/') unary)*
// unary   := '-' unary | primary
// primary := REF | NUM | '(' expr ')' | FUNC '(' args ')'

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }
  private expect<T extends Token["type"]>(type: T): Extract<Token, { type: T }> {
    const t = this.peek();
    if (t.type !== type) throw new Error(`Expected ${type}, got ${t.type}`);
    return this.advance() as Extract<Token, { type: T }>;
  }

  parseAll(): ExprNode {
    const node = this.parseExpr();
    if (this.peek().type !== "EOF") {
      throw new Error(`Unexpected ${this.peek().type} after the end of the expression`);
    }
    return node;
  }

  private parseExpr(): ExprNode {
    let left = this.parseTerm();
    for (let t = this.peek(); t.type === "OP" && (t.op === "+" || t.op === "-"); t = this.peek()) {
      this.advance();
      left = { type: "binop", op: t.op, left, right: this.parseTerm() };
    }
    return left;
  }

  private parseTerm(): ExprNode {
    let left = this.parseUnary();
    for (let t = this.peek(); t.type === "OP" && (t.op === "*" || t.op === "/"); t = this.peek()) {
      this.advance();
      left = { type: "binop", op: t.op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    const t = this.peek();
    if (t.type === "OP" && t.op === "-") {
      this.advance();
      return { type: "unary", op: "-", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parseSingleRef(fn: string): string {
    const t = this.peek();
    if (t.type !== "REF") throw new Error(`${fn}() takes a single [reference], not an expression`);
    this.advance();
    const next = this.peek();
    if (next.type !== "COMMA" && next.type !== "RPAREN") {
      throw new Error(`${fn}() takes a single [reference], not an expression`);
    }
    return t.code;
  }

  private parsePrimary(): ExprNode {
    const t = this.peek();
    if (t.type === "REF") { this.advance(); return { type: "ref", code: t.code }; }
    if (t.type === "NUM") { this.advance(); return { type: "num", value: t.value }; }
    if (t.type === "LPAREN") {
      this.advance();
      const inner = this.parseExpr();
      this.expect("RPAREN");
      return inner;
    }
    if (t.type === "IDENT") {
      this.advance();
      this.expect("LPAREN");
      switch (t.name) {
        case "SUM": {
          const args: ExprNode[] = [this.parseExpr()];
          while (this.peek().type === "COMMA") { this.advance(); args.push(this.parseExpr()); }
          this.expect("RPAREN");
          return { type: "sum", args };
        }
        case "LAG": {
          const ref = this.parseSingleRef("LAG");
          this.expect("COMMA");
          const n = this.expect("NUM").value;
          if (!Number.isInteger(n) || n < 1) throw new Error("LAG() periods must be a positive whole number");
          this.expect("RPAREN");
          return { type: "lag", ref, n };
        }
        case "CUMULATE": {
          const ref = this.parseSingleRef("CUMULATE");
          this.expect("RPAREN");
          return { type: "cumulate", ref };
        }
        case "RATIO": {
          const driver = this.parseExpr();
          this.expect("RPAREN");
          return { type: "ratio", driver };
        }
        case "IIF": {
          const cond = this.parseExpr();
          this.expect("COMMA");
          const thenE = this.parseExpr();
          this.expect("COMMA");
          const elseE = this.parseExpr();
          this.expect("RPAREN");
          return { type: "iif", cond, then: thenE, else: elseE };
        }
      }
      throw new Error(`Unknown function: ${t.name}`);
    }
    throw new Error(`Unexpected ${t.type}`);
  }
}

// ─── PUBLIC: parse ────────────────────────────────────────────────────

export function parseExpression(expr: string): ParseResult {
  try {
    const ast = new Parser(expr).parseAll();
    return { ast, refs: extractRefs(ast), error: null };
  } catch (err) {
    return { ast: null, refs: [], error: (err as Error).message ?? String(err) };
  }
}

export function extractRefs(node: ExprNode): string[] {
  const refs = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.type) {
      case "ref": refs.add(n.code); return;
      case "num": return;
      case "binop": walk(n.left); walk(n.right); return;
      case "unary": walk(n.operand); return;
      case "sum": n.args.forEach(walk); return;
      case "lag":
      case "cumulate": refs.add(n.ref); return;
      case "ratio": walk(n.driver); return;
      case "iif": walk(n.cond); walk(n.then); walk(n.else); return;
    }
  };
  walk(node);
  return [...refs];
}

/** True when the expression contains RATIO(), so a parent total is required. */
export function usesRatio(node: ExprNode): boolean {
  switch (node.type) {
    case "ratio": return true;
    case "binop": return usesRatio(node.left) || usesRatio(node.right);
    case "unary": return usesRatio(node.operand);
    case "sum": return node.args.some(usesRatio);
    case "iif": return usesRatio(node.cond) || usesRatio(node.then) || usesRatio(node.else);
    default: return false;
  }
}

// ─── DEPENDENCY GRAPH + TOPO SORT ─────────────────────────────────────

function assertUniqueCodes(formulas: FormulaRow[]): void {
  const seen = new Set<string>();
  for (const formula of formulas) {
    if (!formula.isActive) continue;
    if (seen.has(formula.code)) throw new Error(`Duplicate active formula for [${formula.code}]`);
    seen.add(formula.code);
  }
}

/** code -> the codes it references. Throws on duplicates or unparseable expressions. */
export function buildDependencyGraph(formulas: FormulaRow[]): Map<string, string[]> {
  assertUniqueCodes(formulas);
  const graph = new Map<string, string[]>();
  for (const formula of formulas) {
    if (!formula.isActive) continue;
    if (!formula.expression || formula.calcType === "INPUT") {
      graph.set(formula.code, []);
      continue;
    }
    const result = parseExpression(formula.expression);
    if (result.error) throw new Error(`Formula [${formula.code}] does not parse: ${result.error}`);
    graph.set(formula.code, result.refs);
  }
  return graph;
}

export interface TopoResult {
  /** tiers[0] has no dependencies; tiers[n] depends only on earlier tiers. */
  tiers: string[][];
  order: string[];
  /** Non-empty means the graph cannot be evaluated. */
  cycles: string[][];
}

export function topoSort(graph: Map<string, string[]>): TopoResult {
  const allNodes = new Set(graph.keys());
  for (const deps of graph.values()) deps.forEach((dep) => allNodes.add(dep));

  const inDegree = new Map<string, number>();
  const downstream = new Map<string, Set<string>>();
  for (const node of allNodes) {
    inDegree.set(node, 0);
    downstream.set(node, new Set());
  }
  for (const [node, deps] of graph) {
    for (const dep of new Set(deps)) {
      inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
      downstream.get(dep)?.add(node);
    }
  }

  const tiers: string[][] = [];
  const processed = new Set<string>();
  let tier = [...allNodes].filter((node) => (inDegree.get(node) ?? 0) === 0).sort();
  while (tier.length > 0) {
    tiers.push(tier);
    tier.forEach((node) => processed.add(node));
    const next: string[] = [];
    for (const node of tier) {
      for (const child of downstream.get(node) ?? []) {
        const degree = (inDegree.get(child) ?? 0) - 1;
        inDegree.set(child, degree);
        if (degree === 0 && !processed.has(child)) next.push(child);
      }
    }
    tier = next.sort();
  }

  // Anything left is in, or downstream of, a cycle. Report the cycle itself.
  const cycles: string[][] = [];
  const reported = new Set<string>();
  for (const start of [...allNodes].filter((node) => !processed.has(node)).sort()) {
    const stack: string[] = [];
    const onStack = new Set<string>();
    const visited = new Set<string>();
    const walk = (node: string): string[] | null => {
      if (onStack.has(node)) return [...stack.slice(stack.indexOf(node)), node];
      if (visited.has(node)) return null;
      visited.add(node);
      stack.push(node);
      onStack.add(node);
      for (const dep of graph.get(node) ?? []) {
        const found = walk(dep);
        if (found) return found;
      }
      stack.pop();
      onStack.delete(node);
      return null;
    };
    const cycle = walk(start);
    if (cycle) {
      const key = [...new Set(cycle)].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        cycles.push(cycle);
      }
    }
  }

  return { tiers, order: tiers.flat(), cycles };
}

// ─── EVALUATOR ────────────────────────────────────────────────────────

export function evaluate(
  node: ExprNode,
  values: Map<string, number>,
  options: EvaluateOptions & { parentTotal?: number } = {},
): number {
  const recur = (n: ExprNode) => evaluate(n, values, options);
  switch (node.type) {
    case "ref":
      return values.get(node.code) ?? 0;
    case "num":
      return node.value;
    case "binop": {
      const left = recur(node.left);
      const right = recur(node.right);
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return right !== 0 ? left / right : 0;
      }
      return 0;
    }
    case "unary":
      return -recur(node.operand);
    case "sum":
      return node.args.reduce((total, arg) => total + recur(arg), 0);
    case "lag":
      return options.lagValues?.get(`${node.ref}@${node.n}`) ?? 0;
    case "cumulate":
      return (options.lagValues?.get(`${node.ref}__cumulate`) ?? 0) + (values.get(node.ref) ?? 0);
    case "ratio": {
      if (options.parentTotal === undefined) {
        throw new Error("RATIO() needs the parent total, and none was supplied");
      }
      return options.parentTotal !== 0 ? recur(node.driver) / options.parentTotal : 0;
    }
    case "iif":
      return recur(node.cond) !== 0 ? recur(node.then) : recur(node.else);
  }
}

export interface CalcLineageEntry {
  code: string;
  expression: string;
  inputs: Record<string, number>;
  result: number;
  tier: number;
}

export interface EvaluateAllResult {
  values: Map<string, number>;
  lineage: CalcLineageEntry[];
  order: string[];
}

export interface CompiledFormulas {
  formulas: Map<string, { row: FormulaRow; ast: ExprNode; refs: string[]; needsParent: boolean }>;
  order: string[];
  tierOf: Map<string, number>;
}

/**
 * Parse and order a formula set once. Evaluating many cells (series x week)
 * against the same formulas should compile once and call evaluateCompiled.
 */
export function compileFormulas(formulas: FormulaRow[]): CompiledFormulas {
  const graph = buildDependencyGraph(formulas);
  const { order, cycles, tiers } = topoSort(graph);
  if (cycles.length > 0) {
    throw new Error(`Circular dependency: ${cycles.map((cycle) => cycle.join(" → ")).join("; ")}`);
  }
  const compiled: CompiledFormulas["formulas"] = new Map();
  for (const row of formulas) {
    if (!row.isActive || row.calcType === "INPUT" || !row.expression) continue;
    const parsed = parseExpression(row.expression);
    if (!parsed.ast) throw new Error(`Formula [${row.code}] does not parse: ${parsed.error}`);
    compiled.set(row.code, { row, ast: parsed.ast, refs: parsed.refs, needsParent: usesRatio(parsed.ast) });
  }
  const tierOf = new Map<string, number>();
  tiers.forEach((codes, index) => codes.forEach((code) => tierOf.set(code, index)));
  return { formulas: compiled, order, tierOf };
}

/** Evaluate every formula in dependency order. Inputs are never overwritten by INPUT rows. */
export function evaluateCompiled(
  compiled: CompiledFormulas,
  inputs: Map<string, number>,
  options: EvaluateOptions & { withLineage?: boolean } = {},
): EvaluateAllResult {
  const values = new Map(inputs);
  const lineage: CalcLineageEntry[] = [];
  for (const code of compiled.order) {
    const formula = compiled.formulas.get(code);
    if (!formula) continue;
    const parentTotal = options.parentTotals?.get(code);
    if (formula.needsParent && parentTotal === undefined) {
      throw new Error(`[${code}] uses RATIO() but no parent total was supplied for it`);
    }
    const result = evaluate(formula.ast, values, { ...options, parentTotal });
    values.set(code, result);
    if (options.withLineage) {
      lineage.push({
        code,
        expression: formula.row.expression ?? "",
        inputs: Object.fromEntries(formula.refs.map((ref) => [ref, values.get(ref) ?? 0])),
        result,
        tier: compiled.tierOf.get(code) ?? 0,
      });
    }
  }
  return { values, lineage, order: compiled.order };
}

export function evaluateAll(
  formulas: FormulaRow[],
  inputs: Map<string, number>,
  options: EvaluateOptions & { withLineage?: boolean } = {},
): EvaluateAllResult {
  return evaluateCompiled(compileFormulas(formulas), inputs, options);
}

// ─── VALIDATION ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  refs: string[];
  tier: number | null;
}

/**
 * Validate a candidate formula for `code` against the measures that exist and
 * the formulas already defined. The candidate REPLACES any existing formula for
 * `code`, and is included in the graph, so a cycle it would create is caught.
 */
export function validateFormula(
  code: string,
  expression: string,
  knownMeasures: Set<string>,
  existingFormulas: FormulaRow[],
): ValidationResult {
  const parsed = parseExpression(expression);
  if (parsed.error) return { valid: false, errors: [`Parse error: ${parsed.error}`], refs: [], tier: null };

  const errors = parsed.refs
    .filter((ref) => !knownMeasures.has(ref))
    .map((ref) => `Unknown measure reference: [${ref}]`);
  if (parsed.refs.includes(code)) errors.push(`[${code}] cannot reference itself`);
  if (errors.length > 0) return { valid: false, errors, refs: parsed.refs, tier: null };

  const candidateSet: FormulaRow[] = [
    ...existingFormulas.filter((row) => row.code !== code),
    { code, calcType: "FORMULA", expression, isActive: true },
  ];
  let graph: Map<string, string[]>;
  try {
    graph = buildDependencyGraph(candidateSet);
  } catch (err) {
    return { valid: false, errors: [(err as Error).message], refs: parsed.refs, tier: null };
  }
  const { tiers, cycles } = topoSort(graph);
  if (cycles.length > 0) {
    return { valid: false, errors: [`Circular dependency: ${cycles[0].join(" → ")}`], refs: parsed.refs, tier: null };
  }
  const tier = tiers.findIndex((codes) => codes.includes(code));
  return { valid: true, errors: [], refs: parsed.refs, tier };
}
