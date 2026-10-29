-- =====================================================================
-- Vectron Components — Demand Planning
-- 14: Formulas as data
-- =====================================================================
--
-- The driver tree and the volume-to-value build-up, held as rows rather than
-- written into views. src/lib/measures.ts loads these, compiles them with the
-- calculation engine (src/lib/calc-engine.ts, ported from SDP Configurator
-- 5.0) and evaluates them for whatever scope the planning grid is showing.
--
-- TWO EXPRESSIONS PER MEASURE
-- ---------------------------
-- EXPRESSION is evaluated per leaf cell (series x week). AGG_EXPRESSION is
-- evaluated at any parent node, on the SUMMED additive measures. A NULL
-- AGG_EXPRESSION means "sum the leaves". This is the only correct way to roll
-- up a ratio: a category's event uplift is its summed after-event volume over
-- its summed baseline, not the sum (or average) of its series' uplifts.
--
-- THE DRIVER CHAIN IS EXACT
-- -------------------------
-- Each factor is the ratio of successive running totals of the additive
-- contribution spine (V_PLAN_CONTRIBUTION):
--   EVENT_UPLIFT  = after-event / baseline
--   PROMO_LIFT    = after-promo / after-event
--   CONSENSUS_ADJ = after-streams / after-promo
--   PLANNER_ADJ   = committed / after-streams
-- so their product telescopes to committed / baseline, and
--   PLAN_UNITS = BASELINE x product of factors x PRICE_RESPONSE
-- equals the committed plan exactly when no price change is applied, provided
-- no running total that is a denominator is zero where the plan is not.
-- V_INTEGRITY_FORMULAS asserts that condition (driver_chain_defined).
--
-- The factors are an ORDER-DEPENDENT decomposition (event before promotion
-- before streams before planner), like V_DRIVER_WATERFALL. It is exact, but it
-- is not a Shapley split, and the UI says so.
--
-- Like 05, 06, 12 and 13, tables are IF NOT EXISTS; seed rows are MERGEd.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

CREATE TABLE IF NOT EXISTS DIM_MEASURE (
  MEASURE_CODE  VARCHAR(40)  PRIMARY KEY,
  MEASURE_LABEL VARCHAR(80)  NOT NULL,
  -- units | EUR | kg | factor | EUR/pc | kg/pc | pct | share
  UNIT          VARCHAR(20)  NOT NULL,
  -- volume | driver | value | rate | assumption
  MEASURE_GROUP VARCHAR(20)  NOT NULL,
  -- INPUT: supplied by the loader from data. FORMULA: computed by the engine.
  CALC_TYPE     VARCHAR(10)  NOT NULL,
  -- Shown as a grid row (assumptions and intermediates are not).
  IS_VISIBLE    BOOLEAN      NOT NULL DEFAULT TRUE,
  -- A planner may type into this row in the grid.
  IS_EDITABLE   BOOLEAN      NOT NULL DEFAULT FALSE,
  DISPLAY_ORDER NUMBER(4,0)  NOT NULL,
  -- For INPUT measures: where the loader takes the value from.
  SOURCE        VARCHAR(200),
  DESCRIPTION   VARCHAR(400)
);

CREATE TABLE IF NOT EXISTS DIM_MEASURE_FORMULA (
  MEASURE_CODE   VARCHAR(40)  NOT NULL,
  VERSION_NO     NUMBER(4,0)  NOT NULL,
  EXPRESSION     VARCHAR(600),
  AGG_EXPRESSION VARCHAR(600),
  IS_ACTIVE      BOOLEAN      NOT NULL DEFAULT TRUE,
  EFFECTIVE_FROM_CYCLE VARCHAR(10) NOT NULL,
  AUTHOR         VARCHAR(80)  NOT NULL,
  NOTE           VARCHAR(400),
  CREATED_AT     TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (MEASURE_CODE, VERSION_NO)
);

MERGE INTO DIM_MEASURE AS t
USING (
  SELECT * FROM VALUES
    -- Additive contribution spine (inputs).
    ('BASELINE_UNITS',   'Baseline',               'units',    'volume',     'INPUT',   TRUE,  FALSE, 10,  'V_PLAN_CONTRIBUTION.BASELINE_UNITS', 'Statistical forecast net of the derived event and promotion effects.'),
    ('EVENT_UNITS',      'Event effect',           'units',    'volume',     'INPUT',   FALSE, FALSE, 11,  'V_PLAN_CONTRIBUTION.EVENT_UNITS', NULL),
    ('PROMO_UNITS',      'Promotion effect',       'units',    'volume',     'INPUT',   FALSE, FALSE, 12,  'V_PLAN_CONTRIBUTION.PROMO_UNITS', NULL),
    ('STREAM_UNITS',     'Sales, marketing, finance', 'units', 'volume',     'INPUT',   FALSE, FALSE, 13,  'V_PLAN_CONTRIBUTION.SALES_DELTA + MARKETING_DELTA + FINANCE_DELTA', 'Accepted stream inputs only.'),
    ('PLANNER_UNITS',    'Planner and agent',      'units',    'volume',     'INPUT',   FALSE, FALSE, 14,  'V_PLAN_CONTRIBUTION.PLANNER_DELTA + AGENT_DELTA, or scenario plan minus streams', 'The reconciliation residual.'),
    -- Only loaded on /plan, for the stream being entered. It is that stream's
    -- own number (its accepted input, else the statistical forecast), which is
    -- what a stream input sets; it is NOT the plan, and feeds no formula.
    ('STREAM_VIEW_UNITS', 'Stream view',           'units',    'volume',     'INPUT',   FALSE, TRUE,  15,  'FACT_PLAN_INPUT.INPUT_UNITS for the selected stream, else STAT_UNITS', 'The selected stream''s own figure. Editing it submits that stream''s input for approval.'),
    -- Running totals (intermediates).
    ('AFTER_EVENT_UNITS',   'After events',        'units',    'volume',     'FORMULA', FALSE, FALSE, 20,  NULL, NULL),
    ('AFTER_PROMO_UNITS',   'After promotions',    'units',    'volume',     'FORMULA', FALSE, FALSE, 21,  NULL, NULL),
    ('AFTER_STREAMS_UNITS', 'After stream inputs', 'units',    'volume',     'FORMULA', FALSE, FALSE, 22,  NULL, NULL),
    ('COMMITTED_UNITS',     'Plan before price',   'units',    'volume',     'FORMULA', FALSE, FALSE, 23,  NULL, 'The committed (or scenario) plan before any price change.'),
    -- Driver factors.
    ('EVENT_UPLIFT',     'Event uplift',           'factor',   'driver',     'FORMULA', TRUE,  FALSE, 30,  NULL, 'After-event volume over baseline.'),
    ('PROMO_LIFT',       'Promotion lift',         'factor',   'driver',     'FORMULA', TRUE,  FALSE, 31,  NULL, 'After-promotion over after-event volume.'),
    ('CONSENSUS_ADJ',    'Consensus adjustment',   'factor',   'driver',     'FORMULA', TRUE,  FALSE, 32,  NULL, 'Effect of accepted sales, marketing and finance input.'),
    ('PLANNER_ADJ',      'Planner adjustment',     'factor',   'driver',     'FORMULA', TRUE,  FALSE, 33,  NULL, 'Effect of the planner reconciliation and accepted agent proposals.'),
    ('PRICE_CHANGE_PCT', 'Price change',           'pct',      'driver',     'INPUT',   TRUE,  TRUE,  34,  'Planner input, default 0', 'Ex-works list price change. Editable.'),
    ('PRICE_RESPONSE',   'Price response',         'factor',   'driver',     'INPUT',   TRUE,  FALSE, 35,  'priceMultiplier(PRICE_CHANGE_PCT, tier, channel) from elasticity.json', 'Volume response to the price change, from the shared elasticity assumptions.'),
    ('PLAN_UNITS',       'Plan',                   'units',    'volume',     'FORMULA', TRUE,  TRUE,  1,   NULL, 'Baseline times every driver. Editable: an edit becomes a scenario edit.'),
    ('SHARE_OF_PARENT',  'Share of parent',        'share',    'volume',     'FORMULA', TRUE,  FALSE, 2,   NULL, 'This row''s plan as a share of the node above it.'),
    -- Assumptions (inputs, per series).
    ('UNIT_PRICE_EUR',   'Ex-works price',     'EUR/pc', 'assumption', 'INPUT',   FALSE, FALSE, 50,  'V_SERIES.UNIT_PRICE_EUR', NULL),
    ('PART_WEIGHT_KG',              'ABV',                'pct',      'assumption', 'INPUT',   FALSE, FALSE, 51,  'DIM_PRODUCT.PART_WEIGHT_KG (percent, e.g. 40)', NULL),
    ('FREIGHT_EUR_CASE',     'Logistics',          'EUR/pc', 'assumption', 'INPUT',   FALSE, FALSE, 52,  'DIM_DUTY.FREIGHT_EUR_PER_CASE', NULL),
    ('TARIFF_PCT',           'Cross-border tariff','pct',      'assumption', 'INPUT',   FALSE, FALSE, 53,  'DIM_DUTY.IMPORT_TARIFF_PCT (fraction)', NULL),
    ('EXCISE_EUR_PER_LPA',   'Material surcharge', 'EUR/kg',   'assumption', 'INPUT',   FALSE, FALSE, 54,  'DIM_DUTY.EXCISE_EUR_PER_LPA', NULL),
    ('AD_VALOREM_PCT',       'Customs brokerage',  'pct',      'assumption', 'INPUT',   FALSE, FALSE, 55,  'DIM_DUTY.AD_VALOREM_PCT (fraction)', NULL),
    -- Per-case rates.
    ('NET_PRICE_EUR_CASE',   'Price after change', 'EUR/pc', 'rate',       'FORMULA', TRUE,  FALSE, 60,  NULL, NULL),
    ('LPA_PER_CASE',         'Weight per piece',   'kg/pc',    'rate',       'FORMULA', FALSE, FALSE, 61,  NULL, 'Part weight: the base of the material surcharge.'),
    ('CIF_EUR_CASE',         'CIF',                'EUR/pc', 'rate',       'FORMULA', FALSE, FALSE, 62,  NULL, NULL),
    ('TARIFF_EUR_CASE',      'Tariff per piece',   'EUR/pc', 'rate',       'FORMULA', FALSE, FALSE, 63,  NULL, NULL),
    ('EXCISE_EUR_CASE',      'Surcharge per piece',  'EUR/pc', 'rate',       'FORMULA', FALSE, FALSE, 64,  NULL, NULL),
    ('DUTY_PAID_EUR_CASE',   'Duty-paid cost',     'EUR/pc', 'rate',       'FORMULA', FALSE, FALSE, 65,  NULL, NULL),
    ('LANDED_EUR_CASE',      'Delivered cost per piece', 'EUR/pc', 'rate',     'FORMULA', TRUE,  FALSE, 66,  NULL, 'Duty-paid cost plus ad valorem, the same build-up as V_LANDED_COST.'),
    -- Value lines (additive).
    ('PLAN_VALUE_EUR',       'Plan value',         'EUR',      'value',      'FORMULA', TRUE,  FALSE, 70,  NULL, 'Plan units at the ex-works price after any change.'),
    ('BASE_VALUE_EUR',       'Value at list price', 'EUR',     'value',      'FORMULA', FALSE, FALSE, 69,  NULL, 'Plan units at the unchanged ex-works price; the base a price change is measured against.'),
    ('PLAN_LPA',             'Material weight',    'kg',       'value',      'FORMULA', TRUE,  FALSE, 71,  NULL, NULL),
    ('DUTY_EUR',             'Duty and tariff',    'EUR',      'value',      'FORMULA', TRUE,  FALSE, 72,  NULL, 'Tariff, excise and ad valorem on the plan.'),
    ('LANDED_COST_EUR',      'Landed cost',        'EUR',      'value',      'FORMULA', TRUE,  FALSE, 73,  NULL, NULL)
  AS v(MEASURE_CODE, MEASURE_LABEL, UNIT, MEASURE_GROUP, CALC_TYPE, IS_VISIBLE, IS_EDITABLE, DISPLAY_ORDER, SOURCE, DESCRIPTION)
) AS s ON t.MEASURE_CODE = s.MEASURE_CODE
WHEN MATCHED THEN UPDATE SET MEASURE_LABEL = s.MEASURE_LABEL, UNIT = s.UNIT, MEASURE_GROUP = s.MEASURE_GROUP,
  CALC_TYPE = s.CALC_TYPE, IS_VISIBLE = s.IS_VISIBLE, IS_EDITABLE = s.IS_EDITABLE,
  DISPLAY_ORDER = s.DISPLAY_ORDER, SOURCE = s.SOURCE, DESCRIPTION = s.DESCRIPTION
WHEN NOT MATCHED THEN INSERT (MEASURE_CODE, MEASURE_LABEL, UNIT, MEASURE_GROUP, CALC_TYPE, IS_VISIBLE,
  IS_EDITABLE, DISPLAY_ORDER, SOURCE, DESCRIPTION)
  VALUES (s.MEASURE_CODE, s.MEASURE_LABEL, s.UNIT, s.MEASURE_GROUP, s.CALC_TYPE, s.IS_VISIBLE,
  s.IS_EDITABLE, s.DISPLAY_ORDER, s.SOURCE, s.DESCRIPTION);

-- Version 1 of every formula. A later edit adds VERSION_NO 2 and deactivates 1,
-- so the formula that produced a past number is never lost.
MERGE INTO DIM_MEASURE_FORMULA AS t
USING (
  SELECT * FROM VALUES
    ('AFTER_EVENT_UNITS',   '[BASELINE_UNITS] + [EVENT_UNITS]', NULL),
    ('AFTER_PROMO_UNITS',   '[AFTER_EVENT_UNITS] + [PROMO_UNITS]', NULL),
    ('AFTER_STREAMS_UNITS', '[AFTER_PROMO_UNITS] + [STREAM_UNITS]', NULL),
    ('COMMITTED_UNITS',     '[AFTER_STREAMS_UNITS] + [PLANNER_UNITS]', NULL),
    ('EVENT_UPLIFT',        '[AFTER_EVENT_UNITS] / [BASELINE_UNITS]',      '[AFTER_EVENT_UNITS] / [BASELINE_UNITS]'),
    ('PROMO_LIFT',          '[AFTER_PROMO_UNITS] / [AFTER_EVENT_UNITS]',   '[AFTER_PROMO_UNITS] / [AFTER_EVENT_UNITS]'),
    ('CONSENSUS_ADJ',       '[AFTER_STREAMS_UNITS] / [AFTER_PROMO_UNITS]', '[AFTER_STREAMS_UNITS] / [AFTER_PROMO_UNITS]'),
    ('PLANNER_ADJ',         '[COMMITTED_UNITS] / [AFTER_STREAMS_UNITS]',   '[COMMITTED_UNITS] / [AFTER_STREAMS_UNITS]'),
    ('PLAN_UNITS',          '[BASELINE_UNITS] * [EVENT_UPLIFT] * [PROMO_LIFT] * [CONSENSUS_ADJ] * [PLANNER_ADJ] * [PRICE_RESPONSE]', NULL),
    -- Share of parent exists only at a node, where the parent is known.
    ('SHARE_OF_PARENT',     NULL, 'RATIO([PLAN_UNITS])'),
    ('NET_PRICE_EUR_CASE',  '[UNIT_PRICE_EUR] * (1 + [PRICE_CHANGE_PCT])', '[PLAN_VALUE_EUR] / [PLAN_UNITS]'),
    ('LPA_PER_CASE',        '[PART_WEIGHT_KG]',                                '[PLAN_LPA] / [PLAN_UNITS]'),
    ('CIF_EUR_CASE',        '[NET_PRICE_EUR_CASE] + [FREIGHT_EUR_CASE]', NULL),
    ('TARIFF_EUR_CASE',     '[CIF_EUR_CASE] * [TARIFF_PCT]',             NULL),
    ('EXCISE_EUR_CASE',     '[LPA_PER_CASE] * [EXCISE_EUR_PER_LPA]',     NULL),
    ('DUTY_PAID_EUR_CASE',  '[CIF_EUR_CASE] + [TARIFF_EUR_CASE] + [EXCISE_EUR_CASE]', NULL),
    ('LANDED_EUR_CASE',     '[DUTY_PAID_EUR_CASE] * (1 + [AD_VALOREM_PCT])', '[LANDED_COST_EUR] / [PLAN_UNITS]'),
    ('PLAN_VALUE_EUR',      '[PLAN_UNITS] * [NET_PRICE_EUR_CASE]', NULL),
    ('BASE_VALUE_EUR',      '[PLAN_UNITS] * [UNIT_PRICE_EUR]', NULL),
    -- Aggregate-only rules for two INPUT drivers: at a node, the price change is
    -- value-weighted and the price response is the plan over the plan before price.
    ('PRICE_CHANGE_PCT',    NULL, '[PLAN_VALUE_EUR] / [BASE_VALUE_EUR] - 1'),
    ('PRICE_RESPONSE',      NULL, '[PLAN_UNITS] / [COMMITTED_UNITS]'),
    ('PLAN_LPA',            '[PLAN_UNITS] * [LPA_PER_CASE]',       NULL),
    ('DUTY_EUR',            '[PLAN_UNITS] * ([TARIFF_EUR_CASE] + [EXCISE_EUR_CASE] + [DUTY_PAID_EUR_CASE] * [AD_VALOREM_PCT])', NULL),
    ('LANDED_COST_EUR',     '[PLAN_UNITS] * [LANDED_EUR_CASE]',    NULL)
  AS v(MEASURE_CODE, EXPRESSION, AGG_EXPRESSION)
) AS s ON t.MEASURE_CODE = s.MEASURE_CODE AND t.VERSION_NO = 1
WHEN MATCHED THEN UPDATE SET EXPRESSION = s.EXPRESSION, AGG_EXPRESSION = s.AGG_EXPRESSION
WHEN NOT MATCHED THEN INSERT (MEASURE_CODE, VERSION_NO, EXPRESSION, AGG_EXPRESSION, IS_ACTIVE,
  EFFECTIVE_FROM_CYCLE, AUTHOR, NOTE)
  VALUES (s.MEASURE_CODE, 1, s.EXPRESSION, s.AGG_EXPRESSION, TRUE, '2026-W37', 'seed',
  'Version 1, seeded by 14-formulas.sql.');

-- ---------------------------------------------------------------------
-- FACT_SCENARIO_DRIVER — driver overrides inside a scenario.
--
-- A price change typed into the grid is a DRIVER edit. Its volume response is
-- written to FACT_SCENARIO_EDIT like any other edit (so promotion, staleness
-- and the agent all see it); the driver value itself is kept here, so the
-- scenario's value lines use the changed price. Promotion carries the volume
-- only: list prices are not part of the committed demand plan.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_SCENARIO_DRIVER (
  SCENARIO_ID   VARCHAR(40)  NOT NULL,
  SERIES_ID     VARCHAR(80)  NOT NULL,
  WEEK_ID       VARCHAR(10)  NOT NULL,
  MEASURE_CODE  VARCHAR(40)  NOT NULL,
  DRIVER_VALUE  NUMBER(18,6) NOT NULL,
  EDIT_GROUP_ID VARCHAR(40)  NOT NULL,
  EDITED_BY     VARCHAR(80)  NOT NULL,
  EDITED_AT     TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (SCENARIO_ID, SERIES_ID, WEEK_ID, MEASURE_CODE)
);

USE SCHEMA APP;
-- ---------------------------------------------------------------------
-- V_MEASURE_CATALOG — what the engine loads.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_MEASURE_CATALOG AS
SELECT m.MEASURE_CODE, m.MEASURE_LABEL, m.UNIT, m.MEASURE_GROUP, m.CALC_TYPE,
       m.IS_VISIBLE, m.IS_EDITABLE, m.DISPLAY_ORDER, m.SOURCE, m.DESCRIPTION,
       f.VERSION_NO, f.EXPRESSION, f.AGG_EXPRESSION, f.EFFECTIVE_FROM_CYCLE, f.AUTHOR, f.NOTE
FROM CORE.DIM_MEASURE m
LEFT JOIN CORE.DIM_MEASURE_FORMULA f
  ON f.MEASURE_CODE = m.MEASURE_CODE AND f.IS_ACTIVE;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_FORMULAS
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_FORMULAS AS
-- Every FORMULA measure has exactly one active formula with a leaf expression
-- or an aggregate one; an INPUT measure may carry only an aggregate rule.
SELECT 'formula_coverage' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM (
  SELECT m.MEASURE_CODE, m.CALC_TYPE, COUNT(f.MEASURE_CODE) AS N, COUNT(f.EXPRESSION) AS LEAF
  FROM CORE.DIM_MEASURE m
  LEFT JOIN CORE.DIM_MEASURE_FORMULA f ON f.MEASURE_CODE = m.MEASURE_CODE AND f.IS_ACTIVE
  GROUP BY 1, 2
)
WHERE (CALC_TYPE = 'FORMULA' AND N <> 1) OR (CALC_TYPE = 'INPUT' AND (N > 1 OR LEAF > 0))
UNION ALL
SELECT 'formula_orphan', COUNT(*)
FROM CORE.DIM_MEASURE_FORMULA f
LEFT JOIN CORE.DIM_MEASURE m ON m.MEASURE_CODE = f.MEASURE_CODE
WHERE m.MEASURE_CODE IS NULL
UNION ALL
-- The assumption the driver chain rests on: no running total is zero where
-- the plan is not, so every factor is defined.
SELECT 'driver_chain_defined', COUNT(*)
FROM V_PLAN_CONTRIBUTION
WHERE PLAN_UNITS <> 0
  AND (BASELINE_UNITS = 0
       OR BASELINE_UNITS + EVENT_UNITS = 0
       OR BASELINE_UNITS + EVENT_UNITS + PROMO_UNITS = 0
       OR BASELINE_UNITS + EVENT_UNITS + PROMO_UNITS + SALES_DELTA + MARKETING_DELTA + FINANCE_DELTA = 0)
UNION ALL
-- (There is deliberately no "factors multiply back to the plan" check here: the
-- factors are ratios of successive running totals, so their product is the
-- plan by algebra whenever every denominator is non-zero, and such a check
-- could never fire. driver_chain_defined above is the condition that matters,
-- and it covers scenarios too: a scenario changes only the planner residual,
-- which is a numerator, never a denominator. The runtime agreement of the
-- ENGINE with these views is checked by /api/measures?reconcile=1.)
-- The engine's PLAN_UNITS formula is the full chain, so an edit to the formula
-- table cannot quietly drop a factor.
SELECT 'driver_chain_complete', COUNT(*)
FROM (
  SELECT f.EXPRESSION
  FROM CORE.DIM_MEASURE_FORMULA f
  WHERE f.MEASURE_CODE = 'PLAN_UNITS' AND f.IS_ACTIVE
)
WHERE NOT (CONTAINS(EXPRESSION, '[BASELINE_UNITS]') AND CONTAINS(EXPRESSION, '[EVENT_UPLIFT]')
           AND CONTAINS(EXPRESSION, '[PROMO_LIFT]') AND CONTAINS(EXPRESSION, '[CONSENSUS_ADJ]')
           AND CONTAINS(EXPRESSION, '[PLANNER_ADJ]') AND CONTAINS(EXPRESSION, '[PRICE_RESPONSE]'))
UNION ALL
-- Driver overrides belong to a live scenario, and only to editable measures.
SELECT 'scenario_driver_orphan', COUNT(*)
FROM CORE.FACT_SCENARIO_DRIVER d
LEFT JOIN CORE.DIM_SCENARIO s ON s.SCENARIO_ID = d.SCENARIO_ID
LEFT JOIN CORE.DIM_MEASURE m ON m.MEASURE_CODE = d.MEASURE_CODE AND m.IS_EDITABLE AND m.CALC_TYPE = 'INPUT'
WHERE s.SCENARIO_ID IS NULL OR m.MEASURE_CODE IS NULL;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_ALL — extended for formulas. Composed, never redefined.
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
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_VALUE
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_DUTY
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_SIGNALS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_CYCLES
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_APPROVALS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_FORMULAS;
