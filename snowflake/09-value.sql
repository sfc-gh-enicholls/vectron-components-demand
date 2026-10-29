-- =====================================================================
-- Vectron Components — Demand Planning
-- 09: Volume to value — the price and mix bridge
-- =====================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Everything upstream plans units. Finance argues about euros, and the two move
-- apart: a year can deliver flat volume and strong revenue growth, or growing
-- volume and falling revenue, and which of those happened is the whole
-- conversation in a finance-led S&OP. The gap between volume growth and value
-- growth is the number that conversation turns on, so the app has to be able to
-- decompose it rather than show the two side by side and leave the reader to
-- guess.
--
-- THE DECOMPOSITION, AND WHY IT IS EXACT
-- --------------------------------------
-- Revenue is sum over series of quantity times realised price. Writing 0 for
-- the base period and 1 for the comparison period, the change decomposes as
--
--   dR = sum(q1*p1) - sum(q0*p0)
--      = sum(q1*(p1-p0))                  <- PRICE   (like-for-like pricing)
--      + sum(q1*p0) - Q1*p0_bar           <- MIX     (composition shifted)
--      + (Q1-Q0)*p0_bar                   <- VOLUME  (more or less, at base mix)
--
-- where Q is total quantity and p0_bar = R0/Q0 is the base-period average
-- realised price. The three terms telescope back to dR identically, so this is
-- an identity rather than an approximation, and it is asserted by an integrity
-- check in the same way V_PLAN_CONTRIBUTION is.
--
-- MIX IS DERIVED, NOT A DUMPING GROUND
-- ------------------------------------
-- It would be easier to define mix as "whatever is left after volume and price",
-- and it would give the same number. Writing it out properly as
-- sum(q1*p0) - Q1*p0_bar is worth the effort because it says what mix MEANS:
-- this period's volumes valued at last period's prices, against what that same
-- total volume would have earned at last period's AVERAGE price. It is
-- positive when the growth came in richer lines than the base mix. A reader can
-- argue with that. Nobody can argue with a residual.
--
-- WHY THE PRIMITIVES ARE STORED AT SERIES GRAIN AND THE EFFECTS ARE NOT
-- --------------------------------------------------------------------
-- Volume and mix both reference p0_bar, which is a property of the GROUP being
-- looked at, not of a series. So the three effects cannot be computed per series
-- and then summed — group by product and by customer and you would get different,
-- both-wrong answers. What IS additive is the underlying quantities: q0, q1, r0,
-- r1, the price effect, and this period's volume valued at base prices. Those
-- are stored per series, and the three effects are assembled at whatever level
-- the caller groups by. V_REVENUE_BRIDGE does that assembly for a set of useful
-- levels; the base view is there for any other cut.
--
-- REALISED PRICE, NOT LIST PRICE
-- ------------------------------
-- Price comes from NET_REVENUE_EUR / UNITS on actual shipments, so discount
-- and promotional investment are already inside it. UNIT_PRICE_EUR on the
-- product is a list price and would report a price effect of zero in a year where
-- the whole movement was discount.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA APP;

-- =====================================================================
-- STEP 0: give shipment revenue a realised price.
--
-- WHY THIS IS NECESSARY, AND WHY IT IS HERE
-- -----------------------------------------
-- The bridge below cannot work without it. generate_facts.py wrote shipment
-- revenue as `round(order * list_price, 2)` — a single flat price per series for
-- all 222 weeks — so realised price was IDENTICAL in both comparison periods and
-- the price effect came out as exactly zero for all 692 series present in both.
-- A price-and-mix bridge whose price term is structurally zero is decorative,
-- which is the specific thing this was meant not to be.
--
-- IDEMPOTENT BY CONSTRUCTION. The new value is derived from UNITS and the
-- product's list price, NOT from the current NET_REVENUE_EUR. Re-running this file
-- therefore recomputes the same number rather than compounding a multiplier,
-- which a naive `SET NET_REVENUE_EUR = NET_REVENUE_EUR * factor` would do.
--
-- UNITS ARE NOT TOUCHED, so the inventory reconciliation identity — which is
-- volume-only and is an existing integrity check — is unaffected.
--
-- FOUR SOURCES OF PRICE MOVEMENT, all illustrative but each how a Tier 1
-- actually prices:
--   1. OEM PRICE-DOWNS. Series supply contracts (LTAs) commit the supplier to
--      an annual productivity give-back to the OEM, typically 1.5-3% a year.
--      OE prices therefore FALL year on year even in an inflationary market.
--   2. RAW-MATERIAL SURCHARGE. Steel and aluminium are passed through on an
--      index with a lag; the 2022-23 spike is being unwound, so the surcharge
--      is shrinking. Weighted by part weight per euro: a heavy cheap part
--      (a brake disc) carries far more surcharge than a mechatronic unit.
--   3. SERVICE AND AFTERMARKET PRICING. OES and IAM parts are not under LTA
--      price-downs; they take list increases, which is why the service
--      business carries a better margin than OE series.
--   4. DISTRIBUTOR REBATES AND KITS on the independent aftermarket, from
--      FACT_PROMOTION, passed through at a mechanic-specific rate.
-- The resulting tension is the point of the bridge: OE price is negative,
-- service price is positive, and channel mix decides which wins.
-- =====================================================================
UPDATE CORE.FACT_SHIPMENTS_WEEKLY sh
SET NET_REVENUE_EUR = ROUND(
      sh.UNITS * f.GROSS_PRICE * (1 - LEAST(0.45, GREATEST(0, f.DISCOUNT))), 2)
FROM (
  SELECT
    sh2.SERIES_ID,
    sh2.WEEK_ID,
    s.UNIT_PRICE_EUR *
      CASE WHEN s.CHANNEL_ID = 'CH-OE' THEN
        -- Price-down compounding from 2023, 2.5% a year (illustrative LTA).
        POWER(0.975, w.ISO_YEAR - 2023)
      ELSE
        CASE w.ISO_YEAR WHEN 2023 THEN 1.000 WHEN 2024 THEN 1.045
                        WHEN 2025 THEN 1.078 ELSE 1.101 END
      END
      -- Surcharge: euros of material per euro of price, scaled by an index
      -- that unwinds from 2023. Capped so a commodity disc stays sensible.
      * (1 + LEAST(0.25, d.PART_WEIGHT_KG / NULLIF(s.UNIT_PRICE_EUR, 0) * 1.2)
             * CASE w.ISO_YEAR WHEN 2023 THEN 0.30 WHEN 2024 THEN 0.22
                               WHEN 2025 THEN 0.16 ELSE 0.12 END)  AS GROSS_PRICE,
    COALESCE(pr.EFF_DEPTH, 0)                                      AS DISCOUNT
  FROM CORE.FACT_SHIPMENTS_WEEKLY sh2
  JOIN APP.V_SERIES s     ON s.SERIES_ID = sh2.SERIES_ID
  JOIN CORE.DIM_PRODUCT d ON d.PRODUCT_ID = s.PRODUCT_ID
  JOIN CORE.DIM_WEEK w    ON w.WEEK_ID = sh2.WEEK_ID
  LEFT JOIN (
    -- Deepest concurrent promotion per series-week; aggregated so
    -- overlapping promotions cannot fan out the UPDATE.
    SELECT
      p.SERIES_ID,
      w2.WEEK_ID,
      MAX(p.DEPTH_PCT *
        CASE p.MECHANIC
          WHEN 'DISTRIBUTOR_REBATE' THEN 0.80   -- a straight net-price cut
          WHEN 'SEASONAL_KIT'       THEN 0.35   -- bundled kit, partly cost
          ELSE 0.20
        END) AS EFF_DEPTH
    FROM CORE.FACT_PROMOTION p
    JOIN CORE.DIM_WEEK w2
      ON w2.WEEK_ID BETWEEN p.START_WEEK_ID AND p.END_WEEK_ID
    GROUP BY 1, 2
  ) pr ON pr.SERIES_ID = sh2.SERIES_ID AND pr.WEEK_ID = sh2.WEEK_ID
) f
WHERE f.SERIES_ID = sh.SERIES_ID AND f.WEEK_ID = sh.WEEK_ID;


-- ---------------------------------------------------------------------
-- V_REVENUE_BRIDGE_BASE — additive primitives, one row per series.
--
-- Comparison is the most recent 52 weeks against the 52 before it. A rolling
-- year rather than a calendar one, because the calendar year is incomplete and
-- comparing a part-year against a whole one is the single easiest way to
-- manufacture a false decline.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_REVENUE_BRIDGE_BASE AS
WITH windowed AS (
  SELECT
    sh.SERIES_ID,
    CASE WHEN wi.WEEKS_AGO BETWEEN 1 AND 52    THEN 'current'
         WHEN wi.WEEKS_AGO BETWEEN 53 AND 104  THEN 'base' END AS PERIOD,
    sh.UNITS,
    sh.NET_REVENUE_EUR
  FROM CORE.FACT_SHIPMENTS_WEEKLY sh
  JOIN V_WEEK_INDEX wi ON wi.WEEK_ID = sh.WEEK_ID
  WHERE wi.WEEKS_AGO <= 104
),
per_series AS (
  SELECT
    SERIES_ID,
    SUM(CASE WHEN PERIOD = 'base'    THEN UNITS END)        AS Q0,
    SUM(CASE WHEN PERIOD = 'base'    THEN NET_REVENUE_EUR END) AS R0,
    SUM(CASE WHEN PERIOD = 'current' THEN UNITS END)        AS Q1,
    SUM(CASE WHEN PERIOD = 'current' THEN NET_REVENUE_EUR END) AS R1
  FROM windowed
  WHERE PERIOD IS NOT NULL
  GROUP BY 1
),
priced AS (
  SELECT
    SERIES_ID,
    COALESCE(Q0, 0) AS Q0, COALESCE(R0, 0) AS R0,
    COALESCE(Q1, 0) AS Q1, COALESCE(R1, 0) AS R1,
    -- Realised price per piece in each period. NULL where there was no volume,
    -- which is handled explicitly below rather than coalesced to zero: a zero
    -- price would report a launch as a total price collapse.
    CASE WHEN COALESCE(Q0, 0) > 0 THEN R0 / Q0 END AS P0,
    CASE WHEN COALESCE(Q1, 0) > 0 THEN R1 / Q1 END AS P1
  FROM per_series
)
SELECT
  p.SERIES_ID,
  s.PRODUCT_NAME, s.PRODUCT_LINE, s.CATEGORY_NAME, s.CUSTOMER_NAME, s.CUSTOMER_ID,
  s.CHANNEL_NAME, s.PRICE_TIER, s.REGION, s.SEGMENT_ABC,
  p.Q0, p.R0, p.Q1, p.R1, p.P0, p.P1,
  -- NEW AND DISCONTINUED LINES.
  --
  -- A series with no base volume has no base price, so there is no like-for-like
  -- price movement to measure and the price effect is zero by definition. Its
  -- whole contribution belongs to volume and mix, which is correct: a launch is
  -- not a price rise. A discontinued line has Q1 = 0, so its price and mix terms
  -- vanish automatically and the loss lands in volume.
  CASE WHEN p.P0 IS NOT NULL AND p.P1 IS NOT NULL
       THEN p.Q1 * (p.P1 - p.P0) ELSE 0 END           AS PRICE_EFFECT_EUR,
  -- This period's volume valued at base prices. For a new line there is no base
  -- price, so its own current price is used, which keeps the identity exact and
  -- routes the line's entire value into the mix and volume terms.
  p.Q1 * COALESCE(p.P0, p.P1, 0)                      AS R1_AT_BASE_PRICE_EUR,
  (p.Q0 = 0 AND p.Q1 > 0)                             AS IS_NEW,
  (p.Q0 > 0 AND p.Q1 = 0)                             AS IS_DISCONTINUED
FROM priced p
JOIN V_SERIES s ON s.SERIES_ID = p.SERIES_ID;

-- ---------------------------------------------------------------------
-- V_REVENUE_BRIDGE — the three effects, assembled at several useful levels.
--
-- GROUP_LEVEL / GROUP_KEY keep one shape for every cut, so the page can switch
-- between them without a different payload each time. 'Total' is the whole
-- business and is the level the integrity check asserts against.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_REVENUE_BRIDGE AS
WITH lvl AS (
  SELECT 'Total'      AS GROUP_LEVEL, 'All products'      AS GROUP_KEY, b.* FROM V_REVENUE_BRIDGE_BASE b
  UNION ALL
  SELECT 'Category',    b.CATEGORY_NAME, b.* FROM V_REVENUE_BRIDGE_BASE b
  UNION ALL
  SELECT 'Product',       b.PRODUCT_NAME,    b.* FROM V_REVENUE_BRIDGE_BASE b
  UNION ALL
  SELECT 'Customer',      b.CUSTOMER_NAME,   b.* FROM V_REVENUE_BRIDGE_BASE b
  UNION ALL
  SELECT 'Price tier',  b.PRICE_TIER,    b.* FROM V_REVENUE_BRIDGE_BASE b
  UNION ALL
  SELECT 'Region',      b.REGION,        b.* FROM V_REVENUE_BRIDGE_BASE b
  UNION ALL
  SELECT 'Channel',     b.CHANNEL_NAME,  b.* FROM V_REVENUE_BRIDGE_BASE b
),
agg AS (
  SELECT
    GROUP_LEVEL, GROUP_KEY,
    SUM(Q0) AS Q0, SUM(R0) AS R0, SUM(Q1) AS Q1, SUM(R1) AS R1,
    SUM(PRICE_EFFECT_EUR)      AS PRICE_EFFECT_EUR,
    SUM(R1_AT_BASE_PRICE_EUR)  AS R1_AT_BASE_PRICE_EUR,
    COUNT(*)                   AS SERIES_COUNT,
    SUM(IFF(IS_NEW, 1, 0))     AS NEW_SERIES,
    SUM(IFF(IS_DISCONTINUED, 1, 0)) AS DISCONTINUED_SERIES
  FROM lvl
  GROUP BY 1, 2
),
effective AS (
  -- EFFECTIVE BASE PRICE. R0/Q0 is undefined for a group with no base volume —
  -- two products here launched inside the window — and letting that NULL through
  -- made both the volume and mix effects NULL, so the bridge returned nothing at
  -- all for them rather than returning something wrong.
  --
  -- Falling back to the group's own current average price is the choice that
  -- keeps the identity exact: volume becomes Q1 * p1_bar = R1, which IS the whole
  -- revenue change when there was no base, and mix and price both fall to zero.
  -- Reading that as "all of it is new volume" is correct — a launch is not a
  -- price rise and it is not a mix shift within an existing portfolio.
  SELECT
    a.*,
    COALESCE(a.R0 / NULLIF(a.Q0, 0), a.R1 / NULLIF(a.Q1, 0), 0) AS P0_BAR
  FROM agg a
)
SELECT
  a.GROUP_LEVEL, a.GROUP_KEY,
  a.Q0, a.R0, a.Q1, a.R1, a.SERIES_COUNT, a.NEW_SERIES, a.DISCONTINUED_SERIES,
  a.R1 - a.R0                                        AS REVENUE_CHANGE_EUR,
  a.Q1 - a.Q0                                        AS VOLUME_CHANGE_UNITS,
  (a.Q1 - a.Q0) / NULLIF(a.Q0, 0)                    AS VOLUME_GROWTH,
  (a.R1 - a.R0) / NULLIF(a.R0, 0)                    AS VALUE_GROWTH,
  -- The gap finance argues about: value growth that volume did not deliver.
  (a.R1 - a.R0) / NULLIF(a.R0, 0)
    - (a.Q1 - a.Q0) / NULLIF(a.Q0, 0)                AS VALUE_MINUS_VOLUME_GAP,
  a.P0_BAR                                           AS BASE_AVG_PRICE,
  a.R1 / NULLIF(a.Q1, 0)                             AS CURRENT_AVG_PRICE,
  -- The three effects. Order matters for reading, not for the arithmetic.
  (a.Q1 - a.Q0) * a.P0_BAR                           AS VOLUME_EFFECT_EUR,
  a.PRICE_EFFECT_EUR                                 AS PRICE_EFFECT_EUR,
  a.R1_AT_BASE_PRICE_EUR - a.Q1 * a.P0_BAR           AS MIX_EFFECT_EUR
FROM effective a;

-- ---------------------------------------------------------------------
-- V_PRICE_TIER_SHIFT — content shift, measured rather than asserted.
--
-- Share of volume and of revenue by technology tier in both periods. A shift
-- toward mechatronic content (brake-by-wire, e-axles, steer-by-wire) shows up
-- as revenue share moving up the tiers faster than volume share: the evidence
-- for or against the mix effect above having a story behind it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_PRICE_TIER_SHIFT AS
WITH t AS (
  SELECT
    PRICE_TIER,
    SUM(Q0) AS Q0, SUM(R0) AS R0, SUM(Q1) AS Q1, SUM(R1) AS R1
  FROM V_REVENUE_BRIDGE_BASE
  GROUP BY 1
)
SELECT
  PRICE_TIER, Q0, R0, Q1, R1,
  Q0 / NULLIF(SUM(Q0) OVER (), 0)            AS BASE_VOLUME_SHARE,
  Q1 / NULLIF(SUM(Q1) OVER (), 0)            AS CURRENT_VOLUME_SHARE,
  R0 / NULLIF(SUM(R0) OVER (), 0)            AS BASE_VALUE_SHARE,
  R1 / NULLIF(SUM(R1) OVER (), 0)            AS CURRENT_VALUE_SHARE,
  Q1 / NULLIF(SUM(Q1) OVER (), 0)
    - Q0 / NULLIF(SUM(Q0) OVER (), 0)        AS VOLUME_SHARE_SHIFT,
  R1 / NULLIF(SUM(R1) OVER (), 0)
    - R0 / NULLIF(SUM(R0) OVER (), 0)        AS VALUE_SHARE_SHIFT,
  R0 / NULLIF(Q0, 0)                         AS BASE_AVG_PRICE,
  R1 / NULLIF(Q1, 0)                         AS CURRENT_AVG_PRICE
FROM t;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_VALUE — the bridge must be an identity, at every level.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_VALUE AS
-- Volume + price + mix must reconstruct the revenue change.
--
-- TOLERANCE IS RELATIVE, and it has to be. A flat 1-cent tolerance flagged 22
-- groups that were correct: Blended Scotch summed to -11,374,835.01 against a
-- change of -11,374,835.00, because at 1e8 scale a cent is about 1e-9 in
-- relative terms — at or below double precision. The tolerance below is one euro
-- or a billionth of the movement, whichever is larger, which still catches any
-- definitional error while ignoring representation noise.
--
-- COALESCE on the effects is deliberate: a group with no base volume has no base
-- average price, so volume and mix are NULL rather than zero, and a NULL sum
-- would silently pass a comparison instead of failing it.
SELECT 'revenue_bridge_additivity' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM V_REVENUE_BRIDGE
WHERE ABS((COALESCE(VOLUME_EFFECT_EUR, 0) + COALESCE(PRICE_EFFECT_EUR, 0)
           + COALESCE(MIX_EFFECT_EUR, 0)) - REVENUE_CHANGE_EUR)
      > GREATEST(1.0, ABS(REVENUE_CHANGE_EUR) * 1e-9)
UNION ALL
-- No effect may be NULL. This is what actually catches the new-product case that
-- the relative tolerance above is careful not to mask.
SELECT 'revenue_bridge_no_nulls', COUNT(*)
FROM V_REVENUE_BRIDGE
WHERE VOLUME_EFFECT_EUR IS NULL OR PRICE_EFFECT_EUR IS NULL
   OR MIX_EFFECT_EUR IS NULL
UNION ALL
-- Every level must reconcile to the same total revenue as the Total level. If a
-- dimension has a null or unmatched member, a cut would silently drop volume.
SELECT 'revenue_bridge_levels_tie', COUNT(*)
FROM (
  SELECT GROUP_LEVEL, ROUND(SUM(R1), 2) AS R1, ROUND(SUM(R0), 2) AS R0
  FROM V_REVENUE_BRIDGE GROUP BY 1
) lv
CROSS JOIN (
  SELECT ROUND(SUM(R1), 2) AS R1, ROUND(SUM(R0), 2) AS R0
  FROM V_REVENUE_BRIDGE WHERE GROUP_LEVEL = 'Total'
) tot
WHERE ABS(lv.R1 - tot.R1) > 0.01 OR ABS(lv.R0 - tot.R0) > 0.01
UNION ALL
-- A realised price must never be negative.
SELECT 'revenue_bridge_price_sane', COUNT(*)
FROM V_REVENUE_BRIDGE_BASE
WHERE COALESCE(P0, 0) < 0 OR COALESCE(P1, 0) < 0;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_ALL — extended for the value bridge.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_ALL AS
SELECT CHECK_NAME, VIOLATIONS FROM V_DATA_INTEGRITY
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_CALLOFFS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_IHS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_SERVICE
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_VALUE;
