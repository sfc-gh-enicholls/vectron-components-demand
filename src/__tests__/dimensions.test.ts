import {
  ALT_LEVELS,
  BASE_LEVELS,
  DEFAULT_ROLLUPS,
  DIMENSION_OF,
  FALLBACK_CATALOGUE,
  LEAF_OF,
  children,
  hierarchiesFor,
  leavesOf,
  levelOrder,
  pathParams,
  pathTo,
  readRollups,
  rollupsToParams,
  validateHierarchy,
  type HNode,
} from "@/lib/dimensions";

describe("levelOrder", () => {
  it("gives exactly the original four levels with no roll-up", () => {
    expect(levelOrder()).toEqual(["CATEGORY_NAME", "PRODUCT_NAME", "CUSTOMER_NAME", "CHANNEL_NAME"]);
    expect(levelOrder({})).toEqual([...BASE_LEVELS]);
    expect(levelOrder(DEFAULT_ROLLUPS)).toEqual([...BASE_LEVELS]);
  });

  it("swaps in an alternate tree's levels per dimension", () => {
    expect(levelOrder({ PRODUCT: "PRODUCT_FAMILY" })).toEqual(["PRODUCT_LINE", "PRODUCT_NAME", "CUSTOMER_NAME", "CHANNEL_NAME"]);
    expect(levelOrder({ PRODUCT: "PRODUCT_TIER", CHANNEL: "CHANNEL_GROUP" }))
      .toEqual(["PRICE_TIER", "PRODUCT_NAME", "CUSTOMER_NAME", "CHANNEL_GROUP", "CHANNEL_NAME"]);
    expect(levelOrder({ CUSTOMER: "CUSTOMER_ROUTE" }))
      .toEqual(["CATEGORY_NAME", "PRODUCT_NAME", "ROUTE_TO_CUSTOMER", "DELIVERY_MODE", "CUSTOMER_NAME", "CHANNEL_NAME"]);
    expect(levelOrder({ CUSTOMER: "CUSTOMER_REGION" }))
      .toEqual(["CATEGORY_NAME", "PRODUCT_NAME", "REGION", "CUSTOMER_NAME", "CHANNEL_NAME"]);
  });

  it("falls back to the default tree for an unknown or wrong-dimension id", () => {
    expect(levelOrder({ PRODUCT: "NOPE" })).toEqual([...BASE_LEVELS]);
    expect(levelOrder({ PRODUCT: "CUSTOMER_REGION" })).toEqual([...BASE_LEVELS]);
  });
});

describe("level metadata", () => {
  it("maps every alternate level to a leaf of its own dimension", () => {
    for (const level of ALT_LEVELS) {
      expect(DIMENSION_OF[LEAF_OF[level]]).toBe(DIMENSION_OF[level]);
    }
  });
});

describe("roll-up query string", () => {
  it("emits roll-ups only when non-default", () => {
    expect(rollupsToParams(DEFAULT_ROLLUPS)).toEqual({});
    expect(rollupsToParams({ CUSTOMER: "CUSTOMER_REGION" })).toEqual({ ROLLUP_CUSTOMER: "CUSTOMER_REGION" });
  });

  it("reads only known, non-default trees of the right dimension", () => {
    const params: Record<string, string> = {
      ROLLUP_PRODUCT: "PRODUCT_CATEGORY",
      ROLLUP_CUSTOMER: "CUSTOMER_ROUTE",
      ROLLUP_CHANNEL: "PRODUCT_FAMILY",
    };
    expect(readRollups((key) => params[key])).toEqual({ CUSTOMER: "CUSTOMER_ROUTE" });
  });

  it("leaves a default path's params exactly as before roll-ups existed", () => {
    const path = { CATEGORY_NAME: "Cognac", PRODUCT_NAME: "Martell VS", CUSTOMER_NAME: null, CHANNEL_NAME: "On-trade" };
    const params = pathParams(path);
    expect(params).toEqual({ CATEGORY_NAME: "Cognac", PRODUCT_NAME: "Martell VS", CHANNEL_NAME: "On-trade" });
    expect(Object.keys(params)).toEqual(["CATEGORY_NAME", "PRODUCT_NAME", "CHANNEL_NAME"]);
    expect(pathParams({})).toEqual({});
    expect(pathParams({ ROLLUP_PRODUCT: "PRODUCT_CATEGORY" })).toEqual({});
  });

  it("adds alternate levels and non-default roll-ups after the base levels", () => {
    const params = pathParams({ REGION: "Europe", CUSTOMER_NAME: "France", ROLLUP_CUSTOMER: "CUSTOMER_REGION" });
    expect(Object.entries(params)).toEqual([
      ["CUSTOMER_NAME", "France"],
      ["REGION", "Europe"],
      ["ROLLUP_CUSTOMER", "CUSTOMER_REGION"],
    ]);
  });
});

describe("validateHierarchy", () => {
  const tree: HNode[] = [
    { id: "root", label: "All", parent: null },
    { id: "a", label: "A", parent: "root" },
    { id: "b", label: "B", parent: "root" },
    { id: "a1", label: "A1", parent: "a" },
    { id: "a2", label: "A2", parent: "a" },
  ];

  it("accepts a tree", () => {
    expect(validateHierarchy(tree)).toEqual([]);
  });

  it("catches a duplicate id", () => {
    const errors = validateHierarchy([...tree, { id: "a1", label: "A1 again", parent: "b" }]);
    expect(errors.some((error) => error.includes("Duplicate node id: a1"))).toBe(true);
  });

  it("catches two roots", () => {
    const errors = validateHierarchy([...tree, { id: "root2", label: "Other", parent: null }]);
    expect(errors.some((error) => error.includes("exactly one root, found 2"))).toBe(true);
  });

  it("catches an orphan", () => {
    const errors = validateHierarchy([...tree, { id: "x", label: "X", parent: "missing" }]);
    expect(errors.some((error) => error.includes("missing parent missing"))).toBe(true);
  });

  it("catches a cycle", () => {
    const errors = validateHierarchy([
      ...tree,
      { id: "c1", label: "C1", parent: "c2" },
      { id: "c2", label: "C2", parent: "c1" },
    ]);
    expect(errors.some((error) => error.startsWith("Cycle detected"))).toBe(true);
  });

  it("walks children, leaves and paths", () => {
    expect(children(tree, "root").map((node) => node.id)).toEqual(["a", "b"]);
    expect(leavesOf(tree, "root").map((node) => node.id)).toEqual(["a1", "a2", "b"]);
    expect(pathTo(tree, "a2").map((node) => node.id)).toEqual(["root", "a", "a2"]);
    expect(pathTo(tree, "nope")).toEqual([]);
  });
});

describe("FALLBACK_CATALOGUE", () => {
  it("has one default tree per dimension and a single leaf level per tree", () => {
    for (const dimension of ["PRODUCT", "CUSTOMER", "CHANNEL", "TIME"] as const) {
      const trees = hierarchiesFor(dimension);
      expect(trees.length).toBeGreaterThan(0);
      expect(trees.filter((tree) => tree.isDefault)).toHaveLength(1);
      for (const tree of trees) {
        expect(tree.levels.filter((entry) => entry.isLeaf)).toHaveLength(1);
        expect(tree.levels.at(-1)?.isLeaf).toBe(true);
      }
    }
    expect(new Set(FALLBACK_CATALOGUE.map((tree) => tree.id)).size).toBe(FALLBACK_CATALOGUE.length);
  });

  it("describes valid trees: each tree's levels form a single-rooted, acyclic node list", () => {
    for (const tree of FALLBACK_CATALOGUE) {
      const nodes: HNode[] = [{ id: tree.id, label: tree.rootLabel, parent: null }];
      tree.levels.forEach((entry, index) => {
        nodes.push({ id: `${tree.id}/${index}`, label: entry.label, parent: index === 0 ? tree.id : `${tree.id}/${index - 1}` });
      });
      expect(validateHierarchy(nodes)).toEqual([]);
    }
  });

  it("names the default trees DEFAULT_ROLLUPS uses", () => {
    expect(hierarchiesFor("PRODUCT").find((tree) => tree.isDefault)?.id).toBe(DEFAULT_ROLLUPS.PRODUCT);
    expect(hierarchiesFor("CUSTOMER").find((tree) => tree.isDefault)?.id).toBe(DEFAULT_ROLLUPS.CUSTOMER);
    expect(hierarchiesFor("CHANNEL").find((tree) => tree.isDefault)?.id).toBe(DEFAULT_ROLLUPS.CHANNEL);
  });
});
