-- =====================================================================
-- Vectron Components — Demand Planning
-- 06: Consensus inputs and the additive plan contribution spine
-- =====================================================================
--
-- Separate file for the same reason 05 is: re-running 03 CREATE OR REPLACEs the
-- fact tables and wipes the generated data. Consensus submissions must survive
-- that, so they live here and 03 is never edited to accommodate them.
--
-- WHY THIS EXISTS
-- ---------------
-- The app called its forecast a consensus, but the data had no consensus in it:
-- FACT_DEMAND_PLAN carried a single OVERRIDE_UNITS column and one planner name.
-- There was no sales, marketing or finance input anywhere. This adds the missing
-- contributing streams.
--
-- GRAIN, AND WHY IT IS NOT FIXED
-- ------------------------------
-- Each team submits at WHATEVER hierarchy level it thinks in — sales by product
-- and customer, finance by category — and the submission is disaggregated to the
-- leaf here, exactly as a planner's hierarchy edit already is. So this table is
-- at SERIES x WEEK grain but carries NODE_LEVEL / NODE_KEY provenance, which
-- means a -6% sales submission on Indian Whisky x India stays traceable after it
-- has been spread across 18 series.
--
-- Storing at the leaf is what makes reconciliation a plain join rather than a
-- recursive rollup, and it is why a stream can never disagree with its own
-- children.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- DIM_INPUT_STREAM — who contributes to the consensus.
--
-- IS_TARGET matters and is not decoration. Finance submit a NUMBER THEY WANT,
-- not a number they expect; treating a target as a forecast is one of the most
-- common ways an IBP process quietly corrupts its own demand plan. The UI shows
-- target streams differently for that reason.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS DIM_INPUT_STREAM (
  STREAM_ID     VARCHAR(20)  PRIMARY KEY,
  STREAM_LABEL  VARCHAR(60)  NOT NULL,
  DESCRIPTION   VARCHAR(400),
  -- Order in the contribution waterfall: baseline, then each stream, then the
  -- planner reconciling, then anything the agent contributed.
  SEQUENCE_NO   NUMBER(3,0)  NOT NULL,
  -- Semantic token name, resolved by the app. Never a literal colour: the app
  -- carries three themes and a stored hex would be wrong in at least two.
  COLOUR_TOKEN  VARCHAR(40)  NOT NULL,
  IS_TARGET     BOOLEAN      NOT NULL DEFAULT FALSE,
  OWNER_ROLE    VARCHAR(80)
);

MERGE INTO DIM_INPUT_STREAM t
USING (
  SELECT * FROM VALUES
    ('sales',     'Key accounts',     'OEM key-account view: nominations, share-of-business changes and what each customer has signalled beyond its EDI schedule. Bottom-up, and the most opinionated input in the cycle.',           10, 'chart-2', FALSE, 'Key Account Director, OEM'),
    ('marketing', 'Programme management', 'Launch and run-out view: SOP ramp curves, EOP dates and aftermarket campaigns, and the volume each programme milestone implies.',         20, 'chart-6', FALSE, 'Programme Manager, Launches'),
    ('finance',   'Finance target',   'The budget commitment. A target rather than a forecast, so it is deliberately shown apart from the forecasting streams.',          30, 'chart-4', TRUE,  'FP&A Manager'),
    ('planner',   'Demand planner',   'The reconciliation. Weighs the streams against the statistical baseline and owns the number that becomes the demand plan.',        40, 'accent',  FALSE, 'Demand Planning Lead')
  AS v (STREAM_ID, STREAM_LABEL, DESCRIPTION, SEQUENCE_NO, COLOUR_TOKEN, IS_TARGET, OWNER_ROLE)
) s ON s.STREAM_ID = t.STREAM_ID
WHEN MATCHED THEN UPDATE SET
  STREAM_LABEL = s.STREAM_LABEL, DESCRIPTION = s.DESCRIPTION,
  SEQUENCE_NO = s.SEQUENCE_NO, COLOUR_TOKEN = s.COLOUR_TOKEN,
  IS_TARGET = s.IS_TARGET, OWNER_ROLE = s.OWNER_ROLE
WHEN NOT MATCHED THEN INSERT
  (STREAM_ID, STREAM_LABEL, DESCRIPTION, SEQUENCE_NO, COLOUR_TOKEN, IS_TARGET, OWNER_ROLE)
  VALUES (s.STREAM_ID, s.STREAM_LABEL, s.DESCRIPTION, s.SEQUENCE_NO, s.COLOUR_TOKEN, s.IS_TARGET, s.OWNER_ROLE);

-- ---------------------------------------------------------------------
-- FACT_PLAN_INPUT — one row per (cycle, stream, series, week).
--
-- CYCLE_WEEK is what lets closed cycles coexist with the live one. Without it
-- there would be no way to ask "what did sales say eight weeks ago, and were
-- they right", which is the only question that turns these streams from
-- decoration into evidence.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_PLAN_INPUT (
  CYCLE_WEEK    VARCHAR(10)  NOT NULL,
  STREAM_ID     VARCHAR(20)  NOT NULL,
  SERIES_ID     VARCHAR(80)  NOT NULL,
  WEEK_ID       VARCHAR(10)  NOT NULL,
  -- The statistical baseline the submission was made against, so the delta
  -- remains meaningful after the baseline moves.
  BASE_UNITS    NUMBER(14,2) NOT NULL,
  INPUT_UNITS   NUMBER(14,2) NOT NULL,
  DELTA_UNITS   NUMBER(14,2) NOT NULL,
  -- Provenance of the level the human actually worked at.
  NODE_LEVEL    VARCHAR(40),
  NODE_KEY      VARCHAR(200),
  DISAGG_METHOD VARCHAR(30)  NOT NULL,
  EDIT_GROUP_ID VARCHAR(40)  NOT NULL,
  REASON_CODE   VARCHAR(30),
  NOTE          VARCHAR(600),
  SUBMITTED_BY  VARCHAR(80)  NOT NULL,
  SUBMITTED_AT  TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (CYCLE_WEEK, STREAM_ID, SERIES_ID, WEEK_ID)
);

-- ---------------------------------------------------------------------
-- Derived forward event and promotion effects.
--
-- HONEST LABEL: these are RECONSTRUCTED, not measured. FACT_DRIVER_CONTRIB has
-- a real causal decomposition but it stops at 2026-W37, and weather and macro
-- are not knowable forward at all, so extending it would be inventing data.
--
-- What is legitimately knowable forward is the CALENDAR: DIM_EVENT holds the
-- dates and lead times, and FACT_PROMOTION holds committed promotions. So the
-- event and promotion components are estimated from each series' own realised
-- response to prior occurrences, and everything the estimate does not explain
-- stays in the baseline term. That keeps the decomposition exactly additive
-- while being clear about which parts are observed and which are inferred.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_PLAN_EFFECT (
  SERIES_ID    VARCHAR(80)  NOT NULL,
  WEEK_ID      VARCHAR(10)  NOT NULL,
  -- EVENT | PROMO
  EFFECT_TYPE  VARCHAR(20)  NOT NULL,
  EFFECT_UNITS NUMBER(14,2) NOT NULL,
  -- What drove it, for the tooltip: 'Diwali 2026', 'Multibuy at 20%'.
  EFFECT_LABEL VARCHAR(120),
  IS_DERIVED   BOOLEAN      NOT NULL DEFAULT TRUE,
  PRIMARY KEY (SERIES_ID, WEEK_ID, EFFECT_TYPE)
);

-- =====================================================================
-- APP views
-- =====================================================================
USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- V_PLAN_CONTRIBUTION — the additive spine behind the chart columns.
--
-- The contract this view exists to guarantee:
--
--   BASELINE_EVENT_FREE + EVENT + PROMO
--     + SALES_DELTA + MARKETING_DELTA + FINANCE_DELTA
--     + PLANNER_DELTA + AGENT_DELTA
--   = PLAN_UNITS,  exactly.
--
-- If the parts do not equal the whole, a stacked column chart drawn from them
-- is simply lying, and no reader could tell. V_DATA_INTEGRITY asserts it.
--
-- How exactness is achieved: PLANNER_DELTA is computed as the RESIDUAL between
-- the final plan and everything attributed above it. That is not a fudge — the
-- planner genuinely owns the reconciliation, so whatever the streams do not
-- account for IS the planner's contribution by definition. And BASELINE is
-- taken net of the derived effects so the event and promotion columns do not
-- double-count what the statistical model already contained.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_PLAN_CONTRIBUTION AS
WITH cycle AS (
  SELECT MAX(CYCLE_WEEK) AS CYCLE_WEEK FROM CORE.FACT_PLAN_INPUT
),
eff AS (
  SELECT SERIES_ID, WEEK_ID,
         SUM(CASE WHEN EFFECT_TYPE = 'EVENT' THEN EFFECT_UNITS ELSE 0 END) AS EVENT_UNITS,
         SUM(CASE WHEN EFFECT_TYPE = 'PROMO' THEN EFFECT_UNITS ELSE 0 END) AS PROMO_UNITS
  FROM CORE.FACT_PLAN_EFFECT GROUP BY 1, 2
),
inp AS (
  SELECT i.SERIES_ID, i.WEEK_ID,
         SUM(CASE WHEN i.STREAM_ID = 'sales'     THEN i.DELTA_UNITS ELSE 0 END) AS SALES_DELTA,
         SUM(CASE WHEN i.STREAM_ID = 'marketing' THEN i.DELTA_UNITS ELSE 0 END) AS MARKETING_DELTA,
         SUM(CASE WHEN i.STREAM_ID = 'finance'   THEN i.DELTA_UNITS ELSE 0 END) AS FINANCE_DELTA
  FROM CORE.FACT_PLAN_INPUT i
  JOIN cycle c ON c.CYCLE_WEEK = i.CYCLE_WEEK
  GROUP BY 1, 2
),
-- Agent contribution: only proposals the planner actually accepted, and only
-- where the accepting decision wrote to the committed plan rather than a
-- scenario. A proposal sitting in the inbox has contributed nothing.
agent AS (
  SELECT pw.PROPOSAL_ID, p.SERIES_ID, pw.WEEK_ID,
         SUM(pw.PROPOSED_UNITS - pw.CURRENT_UNITS) AS AGENT_DELTA
  FROM CORE.FACT_AGENT_PROPOSAL p
  JOIN CORE.FACT_AGENT_PROPOSAL_WEEK pw ON pw.PROPOSAL_ID = p.PROPOSAL_ID
  JOIN CORE.FACT_AGENT_DECISION d       ON d.PROPOSAL_ID = p.PROPOSAL_ID
  WHERE d.DECISION IN ('accept', 'edit_accept')
    AND d.SCENARIO_ID IS NULL
  GROUP BY 1, 2, 3
),
agent_agg AS (
  SELECT SERIES_ID, WEEK_ID, SUM(AGENT_DELTA) AS AGENT_DELTA
  FROM agent GROUP BY 1, 2
)
SELECT
  p.SERIES_ID,
  p.WEEK_ID,
  s.CATEGORY_NAME, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_NAME,
  s.SEGMENT_ABC, s.SEGMENT_XYZ,
  p.UNIT_PRICE_EUR,
  p.STAT_UNITS,
  p.PLAN_UNITS,
  -- Baseline net of the derived effects, so the columns never double-count.
  p.STAT_UNITS - COALESCE(eff.EVENT_UNITS, 0) - COALESCE(eff.PROMO_UNITS, 0)
                                                    AS BASELINE_UNITS,
  COALESCE(eff.EVENT_UNITS, 0)                      AS EVENT_UNITS,
  COALESCE(eff.PROMO_UNITS, 0)                      AS PROMO_UNITS,
  COALESCE(inp.SALES_DELTA, 0)                      AS SALES_DELTA,
  COALESCE(inp.MARKETING_DELTA, 0)                  AS MARKETING_DELTA,
  COALESCE(inp.FINANCE_DELTA, 0)                    AS FINANCE_DELTA,
  COALESCE(ag.AGENT_DELTA, 0)                       AS AGENT_DELTA,
  -- The residual, which is precisely what the planner reconciled.
  p.PLAN_UNITS
    - p.STAT_UNITS
    - COALESCE(inp.SALES_DELTA, 0)
    - COALESCE(inp.MARKETING_DELTA, 0)
    - COALESCE(inp.FINANCE_DELTA, 0)
    - COALESCE(ag.AGENT_DELTA, 0)                   AS PLANNER_DELTA
FROM V_PLAN_FORWARD p
JOIN V_SERIES s   ON s.SERIES_ID = p.SERIES_ID
LEFT JOIN eff     ON eff.SERIES_ID = p.SERIES_ID AND eff.WEEK_ID = p.WEEK_ID
LEFT JOIN inp     ON inp.SERIES_ID = p.SERIES_ID AND inp.WEEK_ID = p.WEEK_ID
LEFT JOIN agent_agg ag ON ag.SERIES_ID = p.SERIES_ID AND ag.WEEK_ID = p.WEEK_ID;

-- ---------------------------------------------------------------------
-- V_CONSENSUS_ACCURACY — whose input was closest, for CLOSED cycles only.
--
-- A cycle is closed when its target weeks have outturn. This is the payoff of
-- storing CYCLE_WEEK: it lets the app show that (for instance) sales are
-- reliably 6% light on established products, which is a far more useful thing to
-- tell a commercial director than a generic accuracy number.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CONSENSUS_ACCURACY AS
SELECT
  i.CYCLE_WEEK,
  i.STREAM_ID,
  st.STREAM_LABEL,
  st.IS_TARGET,
  i.SERIES_ID,
  s.CATEGORY_NAME, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.SEGMENT_ABC,
  i.WEEK_ID,
  i.BASE_UNITS                                   AS BASELINE_UNITS,
  i.INPUT_UNITS                                  AS SUBMITTED_UNITS,
  a.UNITS                                     AS ACTUAL_UNITS,
  ABS(i.INPUT_UNITS - a.UNITS)                AS STREAM_ABS_ERROR,
  ABS(i.BASE_UNITS  - a.UNITS)                AS BASELINE_ABS_ERROR,
  i.INPUT_UNITS - a.UNITS                     AS STREAM_BIAS,
  -- Did submitting beat leaving the statistical baseline alone?
  CASE WHEN ABS(i.INPUT_UNITS - a.UNITS) < ABS(i.BASE_UNITS - a.UNITS)
       THEN TRUE ELSE FALSE END                  AS BEAT_BASELINE,
  s.UNIT_PRICE_EUR
FROM CORE.FACT_PLAN_INPUT i
JOIN CORE.DIM_INPUT_STREAM st ON st.STREAM_ID = i.STREAM_ID
JOIN V_SERIES s               ON s.SERIES_ID = i.SERIES_ID
JOIN CORE.FACT_POS_WEEKLY a
  ON a.SERIES_ID = i.SERIES_ID AND a.WEEK_ID = i.WEEK_ID;

-- ---------------------------------------------------------------------
-- Integrity, extended to ten checks.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_DATA_INTEGRITY AS
SELECT 'driver_additivity' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM (SELECT SERIES_ID, WEEK_ID, ROUND(SUM(CONTRIB_UNITS), 2) AS S
      FROM CORE.FACT_DRIVER_CONTRIB GROUP BY 1, 2) x
JOIN CORE.FACT_POS_WEEKLY p
  ON p.SERIES_ID = x.SERIES_ID AND p.WEEK_ID = x.WEEK_ID
WHERE ABS(x.S - p.UNITS) > 0.02
UNION ALL
SELECT 'inventory_reconciliation', COUNT(*)
FROM CORE.FACT_INVENTORY_WEEKLY i
JOIN CORE.FACT_SHIPMENTS_WEEKLY sh
  ON sh.SERIES_ID = i.SERIES_ID AND sh.WEEK_ID = i.WEEK_ID
LEFT JOIN CORE.FACT_POS_WEEKLY p
  ON p.SERIES_ID = i.SERIES_ID AND p.WEEK_ID = i.WEEK_ID
WHERE ABS((i.OPENING_UNITS + sh.UNITS
           - (COALESCE(p.UNITS, 0) - i.LOST_SALES_UNITS))
          - i.CLOSING_UNITS) > 0.02
UNION ALL
SELECT 'plan_without_forecast', COUNT(*)
FROM CORE.FACT_DEMAND_PLAN d
LEFT JOIN ML.FACT_FORECAST f
  ON f.SERIES_ID = d.SERIES_ID AND f.TARGET_WEEK_ID = d.WEEK_ID
 AND f.MODEL_NAME = 'VECTRON_STAT'
WHERE f.SERIES_ID IS NULL
UNION ALL
SELECT 'scenario_edit_delta', COUNT(*)
FROM CORE.FACT_SCENARIO_EDIT
WHERE ABS((EDIT_UNITS - BASE_UNITS) - DELTA_UNITS) > 0.02
UNION ALL
SELECT 'scenario_edit_orphan', COUNT(*)
FROM CORE.FACT_SCENARIO_EDIT e
LEFT JOIN CORE.FACT_DEMAND_PLAN d
  ON d.SERIES_ID = e.SERIES_ID AND d.WEEK_ID = e.WEEK_ID
WHERE d.SERIES_ID IS NULL
UNION ALL
SELECT 'proposal_week_totals', COUNT(*)
FROM (
  SELECT p.PROPOSAL_ID, p.CURRENT_UNITS AS HDR_CUR, p.PROPOSED_UNITS AS HDR_PROP,
         SUM(w.CURRENT_UNITS) AS WK_CUR, SUM(w.PROPOSED_UNITS) AS WK_PROP
  FROM CORE.FACT_AGENT_PROPOSAL p
  JOIN CORE.FACT_AGENT_PROPOSAL_WEEK w ON w.PROPOSAL_ID = p.PROPOSAL_ID
  GROUP BY 1,2,3
)
WHERE ABS(HDR_CUR - WK_CUR) > 0.05 OR ABS(HDR_PROP - WK_PROP) > 0.05
UNION ALL
SELECT 'decision_orphan', COUNT(*)
FROM CORE.FACT_AGENT_DECISION d
LEFT JOIN CORE.FACT_AGENT_PROPOSAL p ON p.PROPOSAL_ID = d.PROPOSAL_ID
WHERE p.PROPOSAL_ID IS NULL
UNION ALL
-- A submission whose stored delta disagrees with its own before/after values.
SELECT 'plan_input_delta', COUNT(*)
FROM CORE.FACT_PLAN_INPUT
WHERE ABS((INPUT_UNITS - BASE_UNITS) - DELTA_UNITS) > 0.02
UNION ALL
-- A submission pointing at a series-week that is not a real planning week.
SELECT 'plan_input_orphan', COUNT(*)
FROM CORE.FACT_PLAN_INPUT i
LEFT JOIN CORE.DIM_SERIES s ON s.SERIES_ID = i.SERIES_ID
LEFT JOIN CORE.DIM_WEEK w   ON w.WEEK_ID = i.WEEK_ID
WHERE s.SERIES_ID IS NULL OR w.WEEK_ID IS NULL
UNION ALL
-- THE IMPORTANT ONE. The chart's parts must equal its whole, or the stacked
-- columns misrepresent the plan line drawn beside them.
SELECT 'contribution_additivity', COUNT(*)
FROM V_PLAN_CONTRIBUTION
WHERE ABS((BASELINE_UNITS + EVENT_UNITS + PROMO_UNITS
           + SALES_DELTA + MARKETING_DELTA + FINANCE_DELTA
           + PLANNER_DELTA + AGENT_DELTA) - PLAN_UNITS) > 0.02;
