-- =====================================================================
-- Vectron Components — Demand Planning
-- 11: Signal sources — the agent reconciles, it does not compete
-- =====================================================================
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------
-- A Tier 1 planner already hears three voices on every number: what the
-- OEM's EDI schedule says, what the vehicle market (IHS) says the OEM will
-- build, and what Vectron's own statistics say. An agent that issues a
-- fourth opinion and ignores the other three is one more voice in a full
-- room. What is missing is the reconciliation: when the call-off says one
-- thing and IHS says another, who decides, and on what basis?
--
-- So every proposal carries the signals that bear on it, each with a STANCE
-- (agrees / disagrees / neutral). The agent's job becomes reading across
-- them, and a split is surfaced as CONTESTED rather than smoothed over.
--
-- WHAT IS REAL AND WHAT IS SYNTHETIC
-- ---------------------------------------------------------------------
-- Every stance here is COMPUTED from this database; none is invented per
-- proposal. IS_SIMULATED is FALSE on all four sources. The underlying data
-- is synthetic (the EDI releases and the IHS-style feed say so on their own
-- tables and pages), but the stance is a fact about that data, so it can
-- disagree with the agent because the data does.
--
--   * OE pull velocity  — 13-week pull growth against the prior 13 weeks
--   * OEM call-off      — the latest EDI release against the plan for the
--                         proposal's weeks, corrected by that OEM's trailing
--                         bias (V_CALLOFF_CORRECTED), so a chronically hot
--                         schedule does not read as support for an increase
--   * Vehicle market    — IHS-implied volume against plan for the series
--                         over the forward plan window (V_IHS_GAP)
--   * Plant calendar    — whether a shutdown, changeover or macro event
--                         falls inside the proposal window (DIM_EVENT)
--
-- Call-off and vehicle market only bear on OE series production. On
-- service and aftermarket series they are recorded as neutral with a
-- reason, so coverage stays complete and the UI never implies a test that
-- was not run.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- DIM_SIGNAL_SOURCE — rebuilt, so sources from earlier designs disappear.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_SIGNAL_SOURCE (
  SOURCE_ID     VARCHAR(30) PRIMARY KEY,
  SOURCE_NAME   VARCHAR(60) NOT NULL,
  SOURCE_KIND   VARCHAR(30) NOT NULL,   -- internal | customer | market
  OWNER_DOMAIN  VARCHAR(40) NOT NULL,
  DESCRIPTION   VARCHAR(500),
  -- TRUE where a stance is fabricated rather than computed. None are.
  IS_SIMULATED  BOOLEAN     NOT NULL,
  DISPLAY_ORDER NUMBER(3,0) NOT NULL
);

INSERT INTO DIM_SIGNAL_SOURCE VALUES
  ('pos_velocity', 'OE pull velocity', 'internal', 'Demand planning',
   'Measured pull growth over the last 13 weeks against the 13 before it, from FACT_POS_WEEKLY.',
   FALSE, 10),
  ('oem_calloff', 'OEM call-off', 'customer', 'Customer logistics',
   'Latest EDI release for the proposal weeks against the plan, after removing the OEM''s own trailing over-call (V_CALLOFF_CORRECTED). OE series only.',
   FALSE, 20),
  ('vehicle_market', 'Vehicle market (IHS)', 'market', 'Market intelligence',
   'IHS-implied volume (vehicles x pieces per vehicle x calibrated installation rate) against plan over the forward window. Feed is a synthetic stand-in for S&P Global Mobility. OE series only.',
   FALSE, 30),
  ('event_calendar', 'Plant calendar', 'internal', 'Demand planning',
   'Whether a shutdown, changeover or macro event in DIM_EVENT falls inside the proposal window.',
   FALSE, 40);

-- ---------------------------------------------------------------------
-- FACT_PROPOSAL_SIGNAL — one row per proposal per source. A table, so two
-- reads of a page see the same stances. Rebuilt wholesale by this file.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE FACT_PROPOSAL_SIGNAL AS
WITH prop AS (
  SELECT
    p.PROPOSAL_ID, p.PROPOSAL_TYPE, p.SERIES_ID, p.WEEK_FROM, p.WEEK_TO,
    p.DELTA_UNITS, s.CUSTOMER_ID, s.CHANNEL_ID,
    CASE WHEN p.DELTA_UNITS > 0 THEN 1
         WHEN p.DELTA_UNITS < 0 THEN -1 ELSE 0 END AS DIRECTION
  FROM FACT_AGENT_PROPOSAL p
  JOIN APP.V_SERIES s ON s.SERIES_ID = p.SERIES_ID
),
-- A signal "agrees" when it points the same way as the proposal by more
-- than a 2% dead band; within the band it is neutral.
velocity AS (
  SELECT d.SERIES_ID,
         SUM(IFF(wi.WEEKS_AGO <= 13, d.UNITS, 0)) AS RECENT,
         SUM(IFF(wi.WEEKS_AGO BETWEEN 14 AND 26, d.UNITS, 0)) AS PRIOR
  FROM FACT_POS_WEEKLY d
  JOIN APP.V_WEEK_INDEX wi ON wi.WEEK_ID = d.WEEK_ID
  WHERE wi.WEEKS_AGO <= 26
  GROUP BY 1
),
vel AS (
  SELECT p.PROPOSAL_ID, p.DIRECTION,
         (v.RECENT - v.PRIOR) / NULLIF(v.PRIOR, 0) AS X
  FROM prop p LEFT JOIN velocity v ON v.SERIES_ID = p.SERIES_ID
),
-- The latest release covers the 12 weeks after history; proposal weeks
-- outside it are simply not covered by any schedule.
latest_release AS (
  SELECT MAX(RELEASE_WEEK_ID) AS RELEASE_WEEK_ID FROM FACT_EDI_RELEASE
),
-- Bias ratio per OEM and horizon, from the same trailing window the
-- de-biased KPI uses; applied to the live release.
bias AS (
  SELECT c.CUSTOMER_ID, c.HORIZON_WEEKS,
         SUM(c.CORRECTED_UNITS) / NULLIF(SUM(c.RELEASE_UNITS), 0) AS CORR_RATIO
  FROM APP.V_CALLOFF_CORRECTED c
  WHERE c.RELEASE_WEEK_ID = (SELECT MAX(RELEASE_WEEK_ID) FROM APP.V_CALLOFF_CORRECTED)
  GROUP BY 1, 2
),
calloff AS (
  SELECT p.PROPOSAL_ID, p.DIRECTION,
         SUM(r.RELEASE_UNITS * COALESCE(b.CORR_RATIO, 1)) AS CALL_UNITS,
         SUM(d.PLAN_UNITS) AS PLAN_UNITS
  FROM prop p
  JOIN FACT_EDI_RELEASE r
    ON r.SERIES_ID = p.SERIES_ID
   AND r.RELEASE_WEEK_ID = (SELECT RELEASE_WEEK_ID FROM latest_release)
   AND r.TARGET_WEEK_ID BETWEEN p.WEEK_FROM AND p.WEEK_TO
   AND r.HORIZON_WEEKS >= 1
  LEFT JOIN bias b ON b.CUSTOMER_ID = p.CUSTOMER_ID AND b.HORIZON_WEEKS = r.HORIZON_WEEKS
  JOIN FACT_DEMAND_PLAN d ON d.SERIES_ID = p.SERIES_ID AND d.WEEK_ID = r.TARGET_WEEK_ID
  GROUP BY 1, 2
),
ihs AS (
  SELECT g.SERIES_ID,
         SUM(g.PLAN_UNITS) AS PLAN_UNITS, SUM(g.IMPLIED_UNITS) AS IMPLIED_UNITS
  FROM APP.V_IHS_GAP g
  WHERE NOT g.IS_ACTUAL AND g.PLAN_UNITS IS NOT NULL
  GROUP BY 1
),
evt AS (
  SELECT p.PROPOSAL_ID, p.PROPOSAL_TYPE,
         COUNT(e.EVENT_ID) AS N,
         LISTAGG(DISTINCT e.EVENT_TYPE, ', ') AS TYPES
  FROM prop p
  LEFT JOIN DIM_EVENT e ON e.WEEK_ID BETWEEN p.WEEK_FROM AND p.WEEK_TO
  GROUP BY 1, 2
)
SELECT PROPOSAL_ID, SOURCE_ID, STANCE, SIGNAL_TEXT, STRENGTH FROM (
  SELECT v.PROPOSAL_ID, 'pos_velocity' AS SOURCE_ID,
    CASE WHEN v.X IS NULL OR ABS(v.X) < 0.02 OR v.DIRECTION = 0 THEN 'neutral'
         WHEN SIGN(v.X) = v.DIRECTION THEN 'agrees' ELSE 'disagrees' END AS STANCE,
    CASE WHEN v.X IS NULL THEN 'Pull has no comparable prior period'
         ELSE 'Pull ' || IFF(v.X >= 0, 'up ', 'down ') || TO_VARCHAR(ROUND(ABS(v.X) * 100, 1))
              || ' per cent over 13 weeks' END AS SIGNAL_TEXT,
    LEAST(1.0, ABS(COALESCE(v.X, 0)) * 4) AS STRENGTH
  FROM vel v

  UNION ALL
  -- The call-off speaks to the gap between schedule and plan: if the
  -- de-biased schedule is above plan, it supports an increase.
  SELECT p.PROPOSAL_ID, 'oem_calloff',
    CASE WHEN p.CHANNEL_ID <> 'CH-OE' OR c.PLAN_UNITS IS NULL OR c.PLAN_UNITS = 0 OR p.DIRECTION = 0 THEN 'neutral'
         WHEN ABS(c.CALL_UNITS / c.PLAN_UNITS - 1) < 0.02 THEN 'neutral'
         WHEN SIGN(c.CALL_UNITS / c.PLAN_UNITS - 1) = p.DIRECTION THEN 'agrees'
         ELSE 'disagrees' END,
    CASE WHEN p.CHANNEL_ID <> 'CH-OE' THEN 'Not an OE series: no OEM schedule applies'
         WHEN c.PLAN_UNITS IS NULL THEN 'Proposal weeks are beyond the latest schedule'
         ELSE 'De-biased call-off is ' || TO_VARCHAR(ROUND(ABS(c.CALL_UNITS / NULLIF(c.PLAN_UNITS, 0) - 1) * 100, 1))
              || ' per cent ' || IFF(c.CALL_UNITS >= c.PLAN_UNITS, 'above', 'below') || ' plan for these weeks' END,
    CASE WHEN c.PLAN_UNITS > 0 THEN LEAST(1.0, ABS(c.CALL_UNITS / c.PLAN_UNITS - 1) * 5) ELSE 0.2 END
  FROM prop p LEFT JOIN calloff c ON c.PROPOSAL_ID = p.PROPOSAL_ID

  UNION ALL
  SELECT p.PROPOSAL_ID, 'vehicle_market',
    CASE WHEN p.CHANNEL_ID <> 'CH-OE' OR i.IMPLIED_UNITS IS NULL OR i.PLAN_UNITS = 0 OR p.DIRECTION = 0 THEN 'neutral'
         WHEN ABS(i.IMPLIED_UNITS / i.PLAN_UNITS - 1) < 0.02 THEN 'neutral'
         WHEN SIGN(i.IMPLIED_UNITS / i.PLAN_UNITS - 1) = p.DIRECTION THEN 'agrees'
         ELSE 'disagrees' END,
    CASE WHEN p.CHANNEL_ID <> 'CH-OE' THEN 'Not an OE series: vehicle builds do not drive it directly'
         WHEN i.IMPLIED_UNITS IS NULL THEN 'No calibrated installation rate for this series'
         ELSE 'Vehicle market implies ' || TO_VARCHAR(ROUND(ABS(i.IMPLIED_UNITS / NULLIF(i.PLAN_UNITS, 0) - 1) * 100, 1))
              || ' per cent ' || IFF(i.IMPLIED_UNITS >= i.PLAN_UNITS, 'more', 'less') || ' than plan over the forward window' END,
    CASE WHEN i.PLAN_UNITS > 0 THEN LEAST(1.0, ABS(i.IMPLIED_UNITS / i.PLAN_UNITS - 1) * 5) ELSE 0.2 END
  FROM prop p LEFT JOIN ihs i ON i.SERIES_ID = p.SERIES_ID

  UNION ALL
  SELECT e.PROPOSAL_ID, 'event_calendar',
    CASE WHEN e.N > 0 THEN 'agrees'
         -- Event phasing with no event in the window is a real contradiction.
         WHEN e.PROPOSAL_TYPE = 'event_phasing' THEN 'disagrees'
         ELSE 'neutral' END,
    CASE WHEN e.N > 0 THEN TO_VARCHAR(e.N) || ' plant event(s) in the window: ' || LOWER(e.TYPES)
         ELSE 'No plant event falls in the proposal window' END,
    IFF(e.N > 0, 0.7, 0.4)
  FROM evt e
);

-- =====================================================================
-- APP views
-- =====================================================================
USE SCHEMA APP;

CREATE OR REPLACE VIEW V_PROPOSAL_SIGNALS AS
SELECT
  ps.PROPOSAL_ID, ps.SOURCE_ID, ps.STANCE, ps.SIGNAL_TEXT, ps.STRENGTH,
  ds.SOURCE_NAME, ds.SOURCE_KIND, ds.OWNER_DOMAIN, ds.DESCRIPTION,
  ds.IS_SIMULATED, ds.DISPLAY_ORDER
FROM CORE.FACT_PROPOSAL_SIGNAL ps
JOIN CORE.DIM_SIGNAL_SOURCE ds ON ds.SOURCE_ID = ps.SOURCE_ID;

-- IS_CONTESTED: the sources split. That is where a planner's attention is
-- worth something; for example the call-off supports an increase that the
-- vehicle market does not.
CREATE OR REPLACE VIEW V_PROPOSAL_SIGNAL_SUMMARY AS
SELECT
  PROPOSAL_ID,
  COUNT(*)                                                    AS SIGNALS,
  SUM(IFF(STANCE = 'agrees', 1, 0))                           AS AGREE_COUNT,
  SUM(IFF(STANCE = 'disagrees', 1, 0))                        AS DISAGREE_COUNT,
  SUM(IFF(STANCE = 'neutral', 1, 0))                          AS NEUTRAL_COUNT,
  SUM(IFF(SOURCE_KIND <> 'internal', 1, 0))                   AS EXTERNAL_SIGNALS,
  SUM(IFF(IS_SIMULATED, 1, 0))                                AS SIMULATED_SIGNALS,
  SUM(CASE STANCE WHEN 'agrees' THEN STRENGTH
                  WHEN 'disagrees' THEN -STRENGTH ELSE 0 END) AS NET_SUPPORT,
  (SUM(IFF(STANCE = 'agrees', 1, 0)) > 0
   AND SUM(IFF(STANCE = 'disagrees', 1, 0)) > 0)              AS IS_CONTESTED,
  LISTAGG(CASE WHEN STANCE = 'disagrees' THEN SOURCE_NAME END, ', ')
    WITHIN GROUP (ORDER BY DISPLAY_ORDER)                     AS DISSENTING_SOURCES
FROM V_PROPOSAL_SIGNALS
GROUP BY PROPOSAL_ID;

CREATE OR REPLACE VIEW V_INTEGRITY_SIGNALS AS
SELECT 'signal_proposal_orphan' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM CORE.FACT_PROPOSAL_SIGNAL ps
LEFT JOIN CORE.FACT_AGENT_PROPOSAL p ON p.PROPOSAL_ID = ps.PROPOSAL_ID
WHERE p.PROPOSAL_ID IS NULL
UNION ALL
SELECT 'signal_source_orphan', COUNT(*)
FROM CORE.FACT_PROPOSAL_SIGNAL ps
LEFT JOIN CORE.DIM_SIGNAL_SOURCE ds ON ds.SOURCE_ID = ps.SOURCE_ID
WHERE ds.SOURCE_ID IS NULL
UNION ALL
SELECT 'signal_stance_valid', COUNT(*)
FROM CORE.FACT_PROPOSAL_SIGNAL
WHERE STANCE NOT IN ('agrees', 'disagrees', 'neutral')
UNION ALL
-- Every proposal carries all four sources, so no test is silently skipped.
SELECT 'signal_full_coverage', COUNT(*)
FROM (
  SELECT p.PROPOSAL_ID, COUNT(DISTINCT ps.SOURCE_ID) AS N
  FROM CORE.FACT_AGENT_PROPOSAL p
  LEFT JOIN CORE.FACT_PROPOSAL_SIGNAL ps ON ps.PROPOSAL_ID = p.PROPOSAL_ID
  GROUP BY 1
)
WHERE N <> (SELECT COUNT(*) FROM CORE.DIM_SIGNAL_SOURCE)
UNION ALL
SELECT 'signal_strength_range', COUNT(*)
FROM CORE.FACT_PROPOSAL_SIGNAL
WHERE STRENGTH < 0 OR STRENGTH > 1
UNION ALL
SELECT 'signal_none_simulated', COUNT(*)
FROM CORE.DIM_SIGNAL_SOURCE WHERE IS_SIMULATED;

-- V_INTEGRITY_ALL — extended for signals. MATURATION / VALUE / DUTY are
-- reworked in later stages; their names are kept until then.
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
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_SIGNALS;
