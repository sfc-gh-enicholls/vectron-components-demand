-- =====================================================================
-- 22-supply-signal.sql — supply as a signal on agent proposals
-- =====================================================================
-- Adds a fourth INTERNAL, COMPUTED signal (SOURCE_ID 'supply_plan': FACT_PROPOSAL_SIGNAL
-- is a CTAS, so SOURCE_ID is only as wide as 11-signals.sql's longest literal, 15): what the last constrained solve of
-- the committed plan says about the proposal's product x customer in the
-- proposal window. An increase where supply is already late or short
-- disagrees (more demand will not ship); a decrease there agrees. Where
-- supply has headroom the signal is neutral rather than "agrees": headroom
-- does not make a demand change right, it only makes it possible.
--
-- Its own file because 11-signals.sql ends by redefining V_INTEGRITY_ALL
-- without the later domains, so it cannot be re-run on its own. Idempotent:
-- replaces only supply_plan rows. Re-run after 11 or after a solve.
-- =====================================================================
USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

MERGE INTO DIM_SIGNAL_SOURCE t
USING (
  SELECT 'supply_plan' AS SOURCE_ID, 'Supply constraint' AS SOURCE_NAME,
         'internal' AS SOURCE_KIND, 'Supply planning' AS OWNER_DOMAIN,
         'The share of the net requirement the last constrained supply solve delivers on time for this product and customer in the proposal window (CORE.FACT_SUPPLY_PLAN). Disagrees with an increase where supply is already short. Computed, not simulated; the supply network itself is illustrative.' AS DESCRIPTION,
         FALSE AS IS_SIMULATED, 35 AS DISPLAY_ORDER
) s ON s.SOURCE_ID = t.SOURCE_ID
WHEN MATCHED THEN UPDATE SET
  SOURCE_NAME = s.SOURCE_NAME, SOURCE_KIND = s.SOURCE_KIND,
  OWNER_DOMAIN = s.OWNER_DOMAIN, DESCRIPTION = s.DESCRIPTION,
  IS_SIMULATED = s.IS_SIMULATED, DISPLAY_ORDER = s.DISPLAY_ORDER
WHEN NOT MATCHED THEN INSERT
  (SOURCE_ID, SOURCE_NAME, SOURCE_KIND, OWNER_DOMAIN, DESCRIPTION, IS_SIMULATED, DISPLAY_ORDER)
  VALUES (s.SOURCE_ID, s.SOURCE_NAME, s.SOURCE_KIND, s.OWNER_DOMAIN, s.DESCRIPTION,
          s.IS_SIMULATED, s.DISPLAY_ORDER);

-- Refresh as a procedure so the app can call it after every committed solve
-- (src/lib/supply.ts); otherwise the signal would describe an older solve.
CREATE OR REPLACE PROCEDURE VECTRON_DEMAND.APP.SP_REFRESH_SUPPLY_SIGNAL()
RETURNS NUMBER
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
BEGIN
  BEGIN TRANSACTION;
DELETE FROM VECTRON_DEMAND.CORE.FACT_PROPOSAL_SIGNAL WHERE SOURCE_ID = 'supply_plan';
INSERT INTO VECTRON_DEMAND.CORE.FACT_PROPOSAL_SIGNAL (PROPOSAL_ID, SOURCE_ID, STANCE, SIGNAL_TEXT, STRENGTH)
WITH prop AS (
  SELECT p.PROPOSAL_ID, p.WEEK_FROM, p.WEEK_TO, s.PRODUCT_ID, s.CUSTOMER_ID,
         b.PRODUCT_NAME, m.CUSTOMER_NAME,
         SIGN(p.DELTA_UNITS) AS DIRECTION
  FROM VECTRON_DEMAND.CORE.FACT_AGENT_PROPOSAL p
  JOIN VECTRON_DEMAND.CORE.DIM_SERIES s ON s.SERIES_ID = p.SERIES_ID
  JOIN VECTRON_DEMAND.CORE.DIM_PRODUCT b  ON b.PRODUCT_ID = s.PRODUCT_ID
  JOIN VECTRON_DEMAND.CORE.DIM_CUSTOMER m ON m.CUSTOMER_ID = s.CUSTOMER_ID
),
supply AS (
  SELECT pr.PROPOSAL_ID,
         SUM(sp.REQUESTED_UNITS) AS REQUESTED,
         SUM(sp.ON_TIME_UNITS)   AS ON_TIME
  FROM prop pr
  JOIN VECTRON_DEMAND.APP.V_PLAN_WEEK pw ON pw.WEEK_ID BETWEEN pr.WEEK_FROM AND pr.WEEK_TO
  JOIN VECTRON_DEMAND.CORE.FACT_SUPPLY_PLAN sp
    ON sp.PLAN_SOURCE = 'COMMITTED' AND sp.PRODUCT_ID = pr.PRODUCT_ID
   AND sp.CUSTOMER_ID = pr.CUSTOMER_ID AND sp.RECEIPT_WEEK_NO = pw.WEEK_NO
  GROUP BY 1
),
scored AS (
  SELECT pr.*, su.REQUESTED, su.ON_TIME,
         IFF(su.REQUESTED > 0, 1 - su.ON_TIME / su.REQUESTED, NULL) AS SHORT_SHARE
  FROM prop pr LEFT JOIN supply su ON su.PROPOSAL_ID = pr.PROPOSAL_ID
)
SELECT PROPOSAL_ID, 'supply_plan',
       CASE WHEN SHORT_SHARE IS NULL OR SHORT_SHARE < 0.05 THEN 'neutral'
            WHEN DIRECTION > 0 THEN 'disagrees'
            WHEN DIRECTION < 0 THEN 'agrees'
            ELSE 'neutral' END,
       CASE WHEN SHORT_SHARE IS NULL
              THEN 'No supply requirement for ' || PRODUCT_NAME || ' in ' || CUSTOMER_NAME || ' in this window'
            WHEN SHORT_SHARE < 0.05
              THEN 'Supply delivers ' || TO_VARCHAR(ROUND((1 - SHORT_SHARE) * 100, 1)) || ' per cent on time here, so it has headroom'
            ELSE 'Supply already delivers only ' || TO_VARCHAR(ROUND((1 - SHORT_SHARE) * 100, 1))
                 || ' per cent on time for ' || PRODUCT_NAME || ' in ' || CUSTOMER_NAME || ' in this window'
       END,
       CASE WHEN SHORT_SHARE IS NULL THEN 0.2
            WHEN SHORT_SHARE < 0.05 THEN 0.3
            ELSE LEAST(1.0, 0.4 + SHORT_SHARE * 3) END
FROM scored;
  -- Record which solve the signal reflects, so integrity can catch a stale one.
  UPDATE VECTRON_DEMAND.CORE.FACT_SUPPLY_SOLVE_RUN
     SET SIGNAL_REFRESHED_AT = CURRENT_TIMESTAMP()
   WHERE PLAN_SOURCE = 'COMMITTED';
  COMMIT;
  RETURN (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_PROPOSAL_SIGNAL WHERE SOURCE_ID = 'supply_plan');
END;
$$;

CALL VECTRON_DEMAND.APP.SP_REFRESH_SUPPLY_SIGNAL();
