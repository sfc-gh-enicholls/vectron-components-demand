import {
  FALLBACK_CATALOGUE,
  selectNode,
  selectedNodeId,
  type HierarchyDef,
  type HNode,
} from "@/lib/dimensions";

const node = (id: string, label: string, parent: string | null): HNode => ({ id, label, parent });
const base = (id: string) => FALLBACK_CATALOGUE.find((tree) => tree.id === id)!;

const PRODUCT: HierarchyDef = {
  ...base("PRODUCT_CATEGORY"),
  nodes: [
    node("PRODUCT_CATEGORY", "Total portfolio", null),
    node("PRODUCT_CATEGORY/Cognac", "Cognac", "PRODUCT_CATEGORY"),
    node("PRODUCT_CATEGORY/Cognac/Martell VS", "Martell VS", "PRODUCT_CATEGORY/Cognac"),
    node("PRODUCT_CATEGORY/Gin", "Gin", "PRODUCT_CATEGORY"),
    node("PRODUCT_CATEGORY/Gin/Beefeater", "Beefeater", "PRODUCT_CATEGORY/Gin"),
  ],
};

const ROUTE: HierarchyDef = {
  ...base("CUSTOMER_ROUTE"),
  nodes: [
    node("CUSTOMER_ROUTE", "All customers", null),
    node("CUSTOMER_ROUTE/Domestic", "Domestic", "CUSTOMER_ROUTE"),
    node("CUSTOMER_ROUTE/Domestic/Northern deliveryMode", "Northern deliveryMode", "CUSTOMER_ROUTE/Domestic"),
    node("CUSTOMER_ROUTE/Domestic/Northern deliveryMode/United States", "United States", "CUSTOMER_ROUTE/Domestic/Northern deliveryMode"),
    node("CUSTOMER_ROUTE/Travel retail", "Travel retail", "CUSTOMER_ROUTE"),
    node("CUSTOMER_ROUTE/Travel retail/Northern deliveryMode", "Northern deliveryMode", "CUSTOMER_ROUTE/Travel retail"),
  ],
};

describe("selectedNodeId", () => {
  it("is the root when the dimension is unset", () => {
    expect(selectedNodeId(PRODUCT, { CUSTOMER_NAME: "France" })).toBe("PRODUCT_CATEGORY");
  });

  it("follows the deepest set level", () => {
    expect(selectedNodeId(PRODUCT, { CATEGORY_NAME: "Cognac" })).toBe("PRODUCT_CATEGORY/Cognac");
    expect(selectedNodeId(PRODUCT, { CATEGORY_NAME: "Cognac", PRODUCT_NAME: "Martell VS" }))
      .toBe("PRODUCT_CATEGORY/Cognac/Martell VS");
  });

  it("finds a product named without its category, as deep links do", () => {
    expect(selectedNodeId(PRODUCT, { PRODUCT_NAME: "Beefeater" })).toBe("PRODUCT_CATEGORY/Gin/Beefeater");
  });

  it("uses ancestors to tell apart nodes that share a label", () => {
    expect(selectedNodeId(ROUTE, { ROUTE_TO_CUSTOMER: "Travel retail", DELIVERY_MODE: "Northern deliveryMode" }))
      .toBe("CUSTOMER_ROUTE/Travel retail/Northern deliveryMode");
    expect(selectedNodeId(ROUTE, { ROUTE_TO_CUSTOMER: "Domestic", DELIVERY_MODE: "Northern deliveryMode" }))
      .toBe("CUSTOMER_ROUTE/Domestic/Northern deliveryMode");
  });

  it("falls back to the root for a path naming no node", () => {
    expect(selectedNodeId(PRODUCT, { CATEGORY_NAME: "Gin", PRODUCT_NAME: "Martell VS" })).toBe("PRODUCT_CATEGORY");
  });
});

describe("selectNode", () => {
  it("writes the node's ancestry and leaves other dimensions alone", () => {
    expect(selectNode({ CHANNEL_NAME: "On-Trade" }, PRODUCT, "PRODUCT_CATEGORY/Cognac/Martell VS")).toEqual({
      CHANNEL_NAME: "On-Trade",
      CATEGORY_NAME: "Cognac",
      PRODUCT_NAME: "Martell VS",
      PRODUCT_LINE: null,
      PRICE_TIER: null,
      ROLLUP_PRODUCT: null,
    });
  });

  it("clears what was below the old choice", () => {
    const next = selectNode({ CATEGORY_NAME: "Cognac", PRODUCT_NAME: "Martell VS" }, PRODUCT, "PRODUCT_CATEGORY/Gin");
    expect(next.CATEGORY_NAME).toBe("Gin");
    expect(next.PRODUCT_NAME).toBeNull();
  });

  it("clears the dimension at the root", () => {
    const next = selectNode({ CATEGORY_NAME: "Gin", CUSTOMER_NAME: "France" }, PRODUCT, "PRODUCT_CATEGORY");
    expect(next.CATEGORY_NAME).toBeNull();
    expect(next.CUSTOMER_NAME).toBe("France");
  });

  it("sets a non-default tree as the roll-up, and its alternate levels", () => {
    const next = selectNode({ CUSTOMER_NAME: "France" }, ROUTE, "CUSTOMER_ROUTE/Domestic/Northern deliveryMode/United States");
    expect(next).toMatchObject({
      ROUTE_TO_CUSTOMER: "Domestic",
      DELIVERY_MODE: "Northern deliveryMode",
      CUSTOMER_NAME: "United States",
      REGION: null,
      ROLLUP_CUSTOMER: "CUSTOMER_ROUTE",
    });
  });

  it("round-trips with selectedNodeId", () => {
    for (const tree of [PRODUCT, ROUTE]) {
      for (const candidate of tree.nodes!) {
        expect(selectedNodeId(tree, selectNode({}, tree, candidate.id))).toBe(candidate.id);
      }
    }
  });
});
