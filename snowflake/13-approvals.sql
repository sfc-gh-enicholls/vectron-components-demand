-- =====================================================================
-- Vectron Components — Demand Planning
-- 13: Approvals workflow
-- =====================================================================
--
-- Three things now need an approval before they touch shared numbers:
--
--   scenario_promote   a draft scenario -> the committed plan
--   stream_submission  a sales / marketing / finance input -> the consensus
--   cycle_signoff      the committed plan -> an immutable cycle snapshot
--
-- The chain table design is adapted from SDP Configurator 5.0's
-- 27_workflow_v2.sql. Its UI was a mock; this one is enforced on the server.
--
-- WHO IS ACTING
-- -------------
-- The app connects as ONE Snowflake user, so CURRENT_USER() cannot tell a
-- planner from an approver. DIM_APP_USER holds SIMULATED personas; the app
-- shell's "Acting as" picker chooses one, and every request and action
-- records both the persona and CURRENT_USER(). The UI says plainly that the
-- personas are simulated.
--
-- WHERE THE RULES LIVE
-- --------------------
-- src/lib/workflow.ts is the state machine (allowed transitions, required
-- role per step, no self-approval). It is pure and unit-tested. These
-- procedures are the ATOMIC WRITE: they re-check the request has not moved
-- since the app read it (expected status + step), then apply the action and,
-- on final approval, its effect, inside one transaction. The checks that
-- protect the plan (staleness, locks, cycle state) are repeated here so they
-- hold even if the app is bypassed.
--
-- Like 05, 06 and 12, all state tables are IF NOT EXISTS.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- Roles and simulated personas.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS DIM_APP_ROLE (
  ROLE_ID     VARCHAR(30)  PRIMARY KEY,
  ROLE_LABEL  VARCHAR(80)  NOT NULL,
  DESCRIPTION VARCHAR(300)
);

MERGE INTO DIM_APP_ROLE AS t
USING (
  SELECT * FROM VALUES
    ('demand_planner', 'Demand planner',       'Builds scenarios and reviews exceptions; submits scenarios for promotion.'),
    ('demand_lead',    'Demand planning lead', 'Owns the consensus plan; approves promotions and stream inputs, requests cycle sign-off.'),
    ('sales_lead',     'Commercial director',  'Submits the field sales view.'),
    ('marketing_lead', 'Product director',       'Submits the product marketing view.'),
    ('finance_lead',   'FP&A manager',         'Submits the finance target.'),
    ('sop_lead',       'S&OP lead',            'Signs off the cycle.')
  AS v(ROLE_ID, ROLE_LABEL, DESCRIPTION)
) AS s ON t.ROLE_ID = s.ROLE_ID
WHEN MATCHED THEN UPDATE SET ROLE_LABEL = s.ROLE_LABEL, DESCRIPTION = s.DESCRIPTION
WHEN NOT MATCHED THEN INSERT (ROLE_ID, ROLE_LABEL, DESCRIPTION)
  VALUES (s.ROLE_ID, s.ROLE_LABEL, s.DESCRIPTION);

CREATE TABLE IF NOT EXISTS DIM_APP_USER (
  USER_ID      VARCHAR(40)  PRIMARY KEY,
  DISPLAY_NAME VARCHAR(80)  NOT NULL,
  ROLE_ID      VARCHAR(30)  NOT NULL,
  TITLE        VARCHAR(120),
  -- For stream owners: the consensus stream they submit.
  STREAM_ID    VARCHAR(20),
  IS_SIMULATED BOOLEAN      NOT NULL DEFAULT TRUE,
  SORT_ORDER   NUMBER(3,0)
);

-- Names reuse the planners and submitters already present in the generated
-- data, so the audit trail reads consistently with FACT_DEMAND_PLAN.PLANNER
-- and FACT_PLAN_INPUT.SUBMITTED_BY.
MERGE INTO DIM_APP_USER AS t
USING (
  SELECT * FROM VALUES
    ('u-kapoor',    'S. Kapoor',    'demand_planner', 'Demand planner, OE customers',      NULL,        10),
    ('u-nolan',     'T. Nolan',     'demand_planner', 'Demand planner, service and aftermarket', NULL,  20),
    ('u-delacroix', 'M. Delacroix', 'demand_lead',    'Demand planning lead',              'planner',   30),
    ('u-brandt',    'K. Brandt',    'sales_lead',     'Key account director, OEM',         'sales',     40),
    ('u-moreau',    'J. Moreau',    'marketing_lead', 'Programme manager, launches',       'marketing', 50),
    ('u-lindqvist', 'T. Lindqvist', 'finance_lead',   'FP&A manager',                      'finance',   60),
    ('u-rousseau',  'A. Rousseau',  'sop_lead',       'S&OP lead',                         NULL,        70)
  AS v(USER_ID, DISPLAY_NAME, ROLE_ID, TITLE, STREAM_ID, SORT_ORDER)
) AS s ON t.USER_ID = s.USER_ID
WHEN MATCHED THEN UPDATE SET DISPLAY_NAME = s.DISPLAY_NAME, ROLE_ID = s.ROLE_ID,
  TITLE = s.TITLE, STREAM_ID = s.STREAM_ID, SORT_ORDER = s.SORT_ORDER
WHEN NOT MATCHED THEN INSERT (USER_ID, DISPLAY_NAME, ROLE_ID, TITLE, STREAM_ID, IS_SIMULATED, SORT_ORDER)
  VALUES (s.USER_ID, s.DISPLAY_NAME, s.ROLE_ID, s.TITLE, s.STREAM_ID, TRUE, s.SORT_ORDER);

-- ---------------------------------------------------------------------
-- Chains and steps. One chain per object type.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS DIM_APPROVAL_CHAIN (
  CHAIN_ID     VARCHAR(40)  PRIMARY KEY,
  OBJECT_TYPE  VARCHAR(30)  NOT NULL,
  CHAIN_LABEL  VARCHAR(120) NOT NULL,
  -- Comma-separated roles allowed to raise a request on this chain.
  SUBMIT_ROLES VARCHAR(200) NOT NULL
);

CREATE TABLE IF NOT EXISTS DIM_APPROVAL_STEP (
  CHAIN_ID   VARCHAR(40)  NOT NULL,
  STEP_NO    NUMBER(2,0)  NOT NULL,
  ROLE_ID    VARCHAR(30)  NOT NULL,
  STEP_LABEL VARCHAR(120) NOT NULL,
  PRIMARY KEY (CHAIN_ID, STEP_NO)
);

MERGE INTO DIM_APPROVAL_CHAIN AS t
USING (
  SELECT * FROM VALUES
    ('chain-scenario-promote',  'scenario_promote',  'Promote scenario to the committed plan', 'demand_planner'),
    ('chain-stream-submission', 'stream_submission', 'Accept stream input into the consensus', 'sales_lead,marketing_lead,finance_lead'),
    ('chain-cycle-signoff',     'cycle_signoff',     'Sign off the S&OP cycle',                'demand_lead')
  AS v(CHAIN_ID, OBJECT_TYPE, CHAIN_LABEL, SUBMIT_ROLES)
) AS s ON t.CHAIN_ID = s.CHAIN_ID
WHEN MATCHED THEN UPDATE SET OBJECT_TYPE = s.OBJECT_TYPE, CHAIN_LABEL = s.CHAIN_LABEL, SUBMIT_ROLES = s.SUBMIT_ROLES
WHEN NOT MATCHED THEN INSERT (CHAIN_ID, OBJECT_TYPE, CHAIN_LABEL, SUBMIT_ROLES)
  VALUES (s.CHAIN_ID, s.OBJECT_TYPE, s.CHAIN_LABEL, s.SUBMIT_ROLES);

MERGE INTO DIM_APPROVAL_STEP AS t
USING (
  SELECT * FROM VALUES
    ('chain-scenario-promote',  1, 'demand_lead', 'Demand lead approval'),
    ('chain-stream-submission', 1, 'demand_lead', 'Demand lead accepts into consensus'),
    ('chain-cycle-signoff',     1, 'sop_lead',    'S&OP lead sign-off')
  AS v(CHAIN_ID, STEP_NO, ROLE_ID, STEP_LABEL)
) AS s ON t.CHAIN_ID = s.CHAIN_ID AND t.STEP_NO = s.STEP_NO
WHEN MATCHED THEN UPDATE SET ROLE_ID = s.ROLE_ID, STEP_LABEL = s.STEP_LABEL
WHEN NOT MATCHED THEN INSERT (CHAIN_ID, STEP_NO, ROLE_ID, STEP_LABEL)
  VALUES (s.CHAIN_ID, s.STEP_NO, s.ROLE_ID, s.STEP_LABEL);

-- ---------------------------------------------------------------------
-- Requests and the append-only action log.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_APPROVAL_REQUEST (
  REQUEST_ID        VARCHAR(40)  PRIMARY KEY,
  CHAIN_ID          VARCHAR(40)  NOT NULL,
  OBJECT_TYPE       VARCHAR(30)  NOT NULL,
  -- scenario id | pending-input request id (= REQUEST_ID) | cycle week
  OBJECT_ID         VARCHAR(80)  NOT NULL,
  CYCLE_WEEK        VARCHAR(10)  NOT NULL,
  -- submitted | approved | rejected | changes_requested | withdrawn
  STATUS            VARCHAR(20)  NOT NULL,
  CURRENT_STEP      NUMBER(2,0)  NOT NULL,
  TITLE             VARCHAR(200) NOT NULL,
  -- JSON text: what the approver is shown (units moved, value at stake, etc.)
  SUMMARY           VARCHAR(4000),
  REQUESTED_BY_USER VARCHAR(40)  NOT NULL,
  REQUESTED_BY_SF   VARCHAR(80)  NOT NULL,
  REQUESTED_AT      TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  DECIDED_AT        TIMESTAMP_NTZ
);

CREATE TABLE IF NOT EXISTS FACT_APPROVAL_ACTION (
  ACTION_ID     VARCHAR(40)  PRIMARY KEY,
  REQUEST_ID    VARCHAR(40)  NOT NULL,
  STEP_NO       NUMBER(2,0)  NOT NULL,
  -- submit | approve | reject | request_changes | withdraw
  ACTION        VARCHAR(20)  NOT NULL,
  FROM_STATUS   VARCHAR(20),
  TO_STATUS     VARCHAR(20)  NOT NULL,
  ACTOR_USER_ID VARCHAR(40)  NOT NULL,
  ACTOR_SF_USER VARCHAR(80)  NOT NULL,
  NOTE          VARCHAR(600),
  ACTED_AT      TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ---------------------------------------------------------------------
-- FACT_PLAN_INPUT_PENDING — stream inputs awaiting acceptance.
--
-- A separate table, NOT a status column on FACT_PLAN_INPUT: that table is
-- keyed (cycle, stream, series, week), so a pending row would overwrite the
-- accepted value it is meant to replace only once approved. Keeping pending
-- input apart also means V_PLAN_CONTRIBUTION, and its additivity contract,
-- is untouched: only accepted input ever reaches it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_PLAN_INPUT_PENDING (
  REQUEST_ID    VARCHAR(40)  NOT NULL,
  CYCLE_WEEK    VARCHAR(10)  NOT NULL,
  STREAM_ID     VARCHAR(20)  NOT NULL,
  SERIES_ID     VARCHAR(80)  NOT NULL,
  WEEK_ID       VARCHAR(10)  NOT NULL,
  BASE_UNITS    NUMBER(14,2) NOT NULL,
  INPUT_UNITS   NUMBER(14,2) NOT NULL,
  DELTA_UNITS   NUMBER(14,2) NOT NULL,
  NODE_LEVEL    VARCHAR(40),
  NODE_KEY      VARCHAR(200),
  DISAGG_METHOD VARCHAR(30)  NOT NULL,
  EDIT_GROUP_ID VARCHAR(40)  NOT NULL,
  REASON_CODE   VARCHAR(30),
  NOTE          VARCHAR(600),
  SUBMITTED_BY  VARCHAR(80)  NOT NULL,
  SUBMITTED_AT  TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  -- Delete marker: the submission returns this cell to the baseline, so on
  -- acceptance the accepted row is removed rather than overwritten.
  IS_DELETE     BOOLEAN      NOT NULL DEFAULT FALSE,
  PRIMARY KEY (REQUEST_ID, SERIES_ID, WEEK_ID)
);

-- ---------------------------------------------------------------------
-- SP_SUBMIT_REQUEST — raise a request and move its object into review.
--
-- Scenario: draft -> in_review (every edit path requires draft, so this
-- freezes it). Cycle: open -> in_review (promotions and stream acceptance
-- are refused until it is decided). Stream submission: pending rows must
-- already be staged under this REQUEST_ID.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE SP_SUBMIT_REQUEST(
  P_REQUEST_ID VARCHAR, P_CHAIN_ID VARCHAR, P_OBJECT_ID VARCHAR,
  P_TITLE VARCHAR, P_SUMMARY VARCHAR, P_USER_ID VARCHAR, P_SF_USER VARCHAR,
  P_NOTE VARCHAR, P_ACTION_ID VARCHAR
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
  v_type    VARCHAR;
  v_cycle   VARCHAR;
  v_cstatus VARCHAR;
  v_n       NUMBER;
BEGIN
  v_type := (SELECT MAX(OBJECT_TYPE) FROM VECTRON_DEMAND.CORE.DIM_APPROVAL_CHAIN WHERE CHAIN_ID = :P_CHAIN_ID);
  IF (v_type IS NULL) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'Unknown approval chain.');
  END IF;

  -- The submitter's role must be one the chain accepts. The app checks this
  -- too (workflow.ts canSubmit); it is repeated so a direct CALL cannot skip it.
  v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.DIM_APPROVAL_CHAIN c
          JOIN VECTRON_DEMAND.CORE.DIM_APP_USER u ON u.USER_ID = :P_USER_ID
          WHERE c.CHAIN_ID = :P_CHAIN_ID
            AND ARRAY_CONTAINS(u.ROLE_ID::VARIANT, SPLIT(c.SUBMIT_ROLES, ',')));
  IF (v_n = 0) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'This role cannot submit on this approval chain.');
  END IF;

  v_cycle := (SELECT HISTORY_END_WEEK FROM VECTRON_DEMAND.APP.V_CONTEXT);
  v_cstatus := (SELECT MAX(STATUS) FROM VECTRON_DEMAND.CORE.DIM_PLAN_CYCLE WHERE CYCLE_WEEK = :v_cycle);

  -- One open request per object.
  v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_APPROVAL_REQUEST
          WHERE OBJECT_TYPE = :v_type AND OBJECT_ID = :P_OBJECT_ID AND STATUS = 'submitted');
  IF (v_n > 0) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'This item already has an open approval request.');
  END IF;

  IF (v_type IN ('scenario_promote', 'stream_submission') AND COALESCE(v_cstatus, '') <> 'open') THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error',
      'The ' || v_cycle || ' cycle is ' || COALESCE(v_cstatus, 'not open') || '. Nothing new can be submitted until a new cycle opens.');
  END IF;

  IF (v_type = 'scenario_promote') THEN
    v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.DIM_SCENARIO WHERE SCENARIO_ID = :P_OBJECT_ID AND STATUS = 'draft');
    IF (v_n = 0) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'Only a draft scenario can be submitted for promotion.');
    END IF;
    v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_SCENARIO_EDIT WHERE SCENARIO_ID = :P_OBJECT_ID);
    IF (v_n = 0) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'A scenario needs at least one edit before it can be submitted.');
    END IF;
  ELSEIF (v_type = 'stream_submission') THEN
    v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_PLAN_INPUT_PENDING
            WHERE REQUEST_ID = :P_REQUEST_ID AND CYCLE_WEEK = :v_cycle);
    IF (v_n = 0) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'No staged input found for this submission.');
    END IF;
    -- A stream owner submits only their own stream.
    v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_PLAN_INPUT_PENDING p
            JOIN VECTRON_DEMAND.CORE.DIM_APP_USER u ON u.USER_ID = :P_USER_ID
            WHERE p.REQUEST_ID = :P_REQUEST_ID AND p.STREAM_ID <> COALESCE(u.STREAM_ID, ''));
    IF (v_n > 0) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'You can only submit input for your own stream.');
    END IF;
    -- Two open submissions for the same stream must not cover the same cells:
    -- acceptance overwrites, so whichever was approved last would silently win.
    v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_PLAN_INPUT_PENDING mine
            JOIN VECTRON_DEMAND.CORE.FACT_PLAN_INPUT_PENDING other
              ON other.STREAM_ID = mine.STREAM_ID AND other.CYCLE_WEEK = mine.CYCLE_WEEK
             AND other.SERIES_ID = mine.SERIES_ID AND other.WEEK_ID = mine.WEEK_ID
             AND other.REQUEST_ID <> mine.REQUEST_ID
            JOIN VECTRON_DEMAND.CORE.FACT_APPROVAL_REQUEST r
              ON r.REQUEST_ID = other.REQUEST_ID AND r.STATUS = 'submitted'
            WHERE mine.REQUEST_ID = :P_REQUEST_ID);
    IF (v_n > 0) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error',
        'An earlier submission for the same weeks is still awaiting approval. Withdraw it, or wait for the decision, before submitting again.');
    END IF;
  ELSEIF (v_type = 'cycle_signoff') THEN
    IF (P_OBJECT_ID <> v_cycle OR COALESCE(v_cstatus, '') <> 'open') THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'Only the live, open cycle can be submitted for sign-off.');
    END IF;
    v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_APPROVAL_REQUEST
            WHERE CYCLE_WEEK = :v_cycle AND STATUS = 'submitted'
              AND OBJECT_TYPE IN ('scenario_promote', 'stream_submission'));
    IF (v_n > 0) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error',
        'Decide the ' || v_n || ' open promotion or stream request(s) before requesting sign-off.');
    END IF;
  END IF;

  BEGIN TRANSACTION;
  INSERT INTO VECTRON_DEMAND.CORE.FACT_APPROVAL_REQUEST
    (REQUEST_ID, CHAIN_ID, OBJECT_TYPE, OBJECT_ID, CYCLE_WEEK, STATUS, CURRENT_STEP,
     TITLE, SUMMARY, REQUESTED_BY_USER, REQUESTED_BY_SF)
  VALUES (:P_REQUEST_ID, :P_CHAIN_ID, :v_type, :P_OBJECT_ID, :v_cycle, 'submitted', 1,
          :P_TITLE, :P_SUMMARY, :P_USER_ID, :P_SF_USER);
  INSERT INTO VECTRON_DEMAND.CORE.FACT_APPROVAL_ACTION
    (ACTION_ID, REQUEST_ID, STEP_NO, ACTION, FROM_STATUS, TO_STATUS, ACTOR_USER_ID, ACTOR_SF_USER, NOTE)
  VALUES (:P_ACTION_ID, :P_REQUEST_ID, 1, 'submit', NULL, 'submitted', :P_USER_ID, :P_SF_USER, :P_NOTE);
  IF (v_type = 'scenario_promote') THEN
    UPDATE VECTRON_DEMAND.CORE.DIM_SCENARIO SET STATUS = 'in_review', UPDATED_AT = CURRENT_TIMESTAMP()
    WHERE SCENARIO_ID = :P_OBJECT_ID;
  ELSEIF (v_type = 'cycle_signoff') THEN
    UPDATE VECTRON_DEMAND.CORE.DIM_PLAN_CYCLE SET STATUS = 'in_review', APPROVAL_REQUEST_ID = :P_REQUEST_ID
    WHERE CYCLE_WEEK = :P_OBJECT_ID;
  END IF;
  COMMIT;
  RETURN OBJECT_CONSTRUCT('ok', TRUE, 'requestId', P_REQUEST_ID, 'status', 'submitted');
EXCEPTION
  WHEN OTHER THEN
    ROLLBACK;
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', SQLERRM);
END;
$$;

-- ---------------------------------------------------------------------
-- SP_ACT_ON_REQUEST — approve / reject / request_changes / withdraw.
--
-- The app decides the transition with workflow.ts and passes what it decided.
-- This procedure does NOT trust that: it derives the resulting status, step and
-- finality itself, refuses any call whose arguments disagree, and re-checks the
-- actor's role and that nobody decides their own request. So a direct CALL
-- cannot promote with a mismatched flag or approve as the wrong role.
--
-- P_EXPECTED_STATUS and P_EXPECTED_STEP are what the app read. The status
-- update is CONDITIONAL on them inside the transaction, so a concurrent action
-- that got there first makes this one update no row, and it rolls back.
-- On the FINAL approval the object's effect runs in the same transaction.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE SP_ACT_ON_REQUEST(
  P_REQUEST_ID VARCHAR, P_ACTION VARCHAR, P_USER_ID VARCHAR, P_SF_USER VARCHAR,
  P_NOTE VARCHAR, P_EXPECTED_STATUS VARCHAR, P_EXPECTED_STEP NUMBER,
  P_TO_STATUS VARCHAR, P_NEXT_STEP NUMBER, P_IS_FINAL BOOLEAN, P_ACTION_ID VARCHAR
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
  v_type    VARCHAR;
  v_object  VARCHAR;
  v_rcycle  VARCHAR;
  v_status  VARCHAR;
  v_step    NUMBER;
  v_cycle   VARCHAR;
  v_cstatus VARCHAR;
  v_stale   NUMBER DEFAULT 0;
  v_locked  NUMBER DEFAULT 0;
  v_rows    NUMBER DEFAULT 0;
  v_units   NUMBER(16,2);
  v_n       NUMBER;
  v_chain   VARCHAR;
  v_requser VARCHAR;
  v_steps   NUMBER;
  v_srole   VARCHAR;
  v_arole   VARCHAR;
  v_to      VARCHAR;
  v_next    NUMBER;
BEGIN
  v_n := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_APPROVAL_REQUEST WHERE REQUEST_ID = :P_REQUEST_ID);
  IF (v_n = 0) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'Approval request not found.');
  END IF;
  SELECT OBJECT_TYPE, OBJECT_ID, CYCLE_WEEK, STATUS, CURRENT_STEP, CHAIN_ID, REQUESTED_BY_USER
    INTO :v_type, :v_object, :v_rcycle, :v_status, :v_step, :v_chain, :v_requser
  FROM VECTRON_DEMAND.CORE.FACT_APPROVAL_REQUEST WHERE REQUEST_ID = :P_REQUEST_ID;

  IF (v_status <> P_EXPECTED_STATUS OR v_step <> P_EXPECTED_STEP) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'conflict', TRUE,
      'error', 'This request changed while you were looking at it. Reload and try again.');
  END IF;
  IF (v_status <> 'submitted') THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'This request is already decided.');
  END IF;

  -- Derive the transition here rather than trusting the arguments.
  v_steps := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.DIM_APPROVAL_STEP WHERE CHAIN_ID = :v_chain);
  v_srole := (SELECT MAX(ROLE_ID) FROM VECTRON_DEMAND.CORE.DIM_APPROVAL_STEP WHERE CHAIN_ID = :v_chain AND STEP_NO = :v_step);
  v_arole := (SELECT MAX(ROLE_ID) FROM VECTRON_DEMAND.CORE.DIM_APP_USER WHERE USER_ID = :P_USER_ID);
  v_to := CASE P_ACTION
            WHEN 'approve' THEN IFF(v_step >= v_steps, 'approved', 'submitted')
            WHEN 'reject' THEN 'rejected'
            WHEN 'request_changes' THEN 'changes_requested'
            WHEN 'withdraw' THEN 'withdrawn'
          END;
  v_next := IFF(P_ACTION = 'approve' AND v_to = 'submitted', v_step + 1, v_step);
  IF (v_to IS NULL OR P_TO_STATUS <> v_to OR P_NEXT_STEP <> v_next OR P_IS_FINAL <> (v_to = 'approved')) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'The requested transition is not valid for this request.');
  END IF;
  IF (P_ACTION = 'withdraw') THEN
    IF (P_USER_ID <> v_requser) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'Only the person who submitted a request can withdraw it.');
    END IF;
  ELSE
    IF (P_USER_ID = v_requser) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'You cannot decide a request you submitted.');
    END IF;
    IF (COALESCE(v_arole, '') <> COALESCE(v_srole, '-')) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'This step needs a different role.');
    END IF;
  END IF;

  v_cycle := (SELECT HISTORY_END_WEEK FROM VECTRON_DEMAND.APP.V_CONTEXT);
  v_cstatus := (SELECT MAX(STATUS) FROM VECTRON_DEMAND.CORE.DIM_PLAN_CYCLE WHERE CYCLE_WEEK = :v_cycle);

  -- Pre-checks for a final approval, before anything is written.
  IF (v_to = 'approved') THEN
    IF (v_rcycle <> v_cycle) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error',
        'This request belongs to the ' || v_rcycle || ' cycle, which has closed. Resubmit against ' || v_cycle || '.');
    END IF;
    IF (v_type IN ('scenario_promote', 'stream_submission') AND COALESCE(v_cstatus, '') <> 'open') THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error',
        'The ' || v_cycle || ' cycle is ' || v_cstatus || '. The plan is frozen until it is decided.');
    END IF;
    IF (v_type = 'scenario_promote') THEN
      -- Stale: the committed plan moved since the edit was made, or the week left the horizon.
      v_stale := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_SCENARIO_EDIT e
                  LEFT JOIN VECTRON_DEMAND.CORE.FACT_DEMAND_PLAN p
                    ON p.SERIES_ID = e.SERIES_ID AND p.WEEK_ID = e.WEEK_ID
                  WHERE e.SCENARIO_ID = :v_object
                    AND (p.SERIES_ID IS NULL OR ABS(e.BASE_UNITS - p.PLAN_UNITS) >= 0.005));
      v_locked := (SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_SCENARIO_EDIT e
                   JOIN VECTRON_DEMAND.CORE.FACT_DEMAND_PLAN p
                     ON p.SERIES_ID = e.SERIES_ID AND p.WEEK_ID = e.WEEK_ID
                   WHERE e.SCENARIO_ID = :v_object AND p.IS_LOCKED);
      IF (v_stale > 0 OR v_locked > 0) THEN
        RETURN OBJECT_CONSTRUCT('ok', FALSE, 'stale', v_stale, 'locked', v_locked,
          'error', 'The committed plan has moved under ' || v_stale || ' edited cell(s) and '
                   || v_locked || ' are locked. Request changes so the planner can rebase.');
      END IF;
    ELSEIF (v_type = 'cycle_signoff') THEN
      IF (v_object <> v_cycle OR COALESCE(v_cstatus, '') <> 'in_review') THEN
        RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', 'The cycle is not awaiting sign-off.');
      END IF;
    END IF;
  END IF;

  BEGIN TRANSACTION;
  -- Conditional on the state read above: if a concurrent action moved the
  -- request first, this updates nothing and the whole action is abandoned.
  UPDATE VECTRON_DEMAND.CORE.FACT_APPROVAL_REQUEST
     SET STATUS = :v_to,
         CURRENT_STEP = :v_next,
         DECIDED_AT = IFF(:v_to = 'submitted', NULL, CURRENT_TIMESTAMP())
   WHERE REQUEST_ID = :P_REQUEST_ID
     AND STATUS = :P_EXPECTED_STATUS
     AND CURRENT_STEP = :P_EXPECTED_STEP;
  v_n := SQLROWCOUNT;
  IF (v_n <> 1) THEN
    ROLLBACK;
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'conflict', TRUE,
      'error', 'This request was decided by someone else a moment ago. Reload to see the outcome.');
  END IF;
  INSERT INTO VECTRON_DEMAND.CORE.FACT_APPROVAL_ACTION
    (ACTION_ID, REQUEST_ID, STEP_NO, ACTION, FROM_STATUS, TO_STATUS, ACTOR_USER_ID, ACTOR_SF_USER, NOTE)
  VALUES (:P_ACTION_ID, :P_REQUEST_ID, :v_step, :P_ACTION, :v_status, :v_to, :P_USER_ID, :P_SF_USER, :P_NOTE);

  IF (v_to IN ('rejected', 'changes_requested', 'withdrawn')) THEN
    -- The object goes back to being editable.
    IF (v_type = 'scenario_promote') THEN
      UPDATE VECTRON_DEMAND.CORE.DIM_SCENARIO SET STATUS = 'draft', UPDATED_AT = CURRENT_TIMESTAMP()
      WHERE SCENARIO_ID = :v_object AND STATUS = 'in_review';
    ELSEIF (v_type = 'cycle_signoff') THEN
      UPDATE VECTRON_DEMAND.CORE.DIM_PLAN_CYCLE SET STATUS = 'open', APPROVAL_REQUEST_ID = NULL
      WHERE CYCLE_WEEK = :v_object AND STATUS = 'in_review';
    END IF;
  ELSEIF (v_to = 'approved') THEN
    IF (v_type = 'scenario_promote') THEN
      MERGE INTO VECTRON_DEMAND.CORE.FACT_DEMAND_PLAN AS target
      USING (
        SELECT SERIES_ID, WEEK_ID, EDIT_UNITS, REASON_CODE, NOTE, EDITED_BY
        FROM VECTRON_DEMAND.CORE.FACT_SCENARIO_EDIT
        WHERE SCENARIO_ID = :v_object
      ) AS source
      ON target.SERIES_ID = source.SERIES_ID AND target.WEEK_ID = source.WEEK_ID
      WHEN MATCHED THEN UPDATE SET
        OVERRIDE_UNITS = source.EDIT_UNITS,
        PLAN_UNITS = source.EDIT_UNITS,
        REASON_CODE = source.REASON_CODE,
        OVERRIDE_NOTE = source.NOTE,
        PLANNER = source.EDITED_BY,
        UPDATED_AT = CURRENT_TIMESTAMP();
      v_rows := SQLROWCOUNT;
      UPDATE VECTRON_DEMAND.CORE.DIM_SCENARIO
         SET STATUS = 'promoted', PROMOTED_AT = CURRENT_TIMESTAMP(),
             PROMOTED_BY = (SELECT MAX(DISPLAY_NAME) FROM VECTRON_DEMAND.CORE.DIM_APP_USER WHERE USER_ID = :P_USER_ID),
             UPDATED_AT = CURRENT_TIMESTAMP()
       WHERE SCENARIO_ID = :v_object;
    ELSEIF (v_type = 'stream_submission') THEN
      DELETE FROM VECTRON_DEMAND.CORE.FACT_PLAN_INPUT AS i
      USING VECTRON_DEMAND.CORE.FACT_PLAN_INPUT_PENDING AS p
      WHERE p.REQUEST_ID = :P_REQUEST_ID AND p.IS_DELETE
        AND i.CYCLE_WEEK = p.CYCLE_WEEK AND i.STREAM_ID = p.STREAM_ID
        AND i.SERIES_ID = p.SERIES_ID AND i.WEEK_ID = p.WEEK_ID;
      MERGE INTO VECTRON_DEMAND.CORE.FACT_PLAN_INPUT AS target
      USING (
        SELECT * FROM VECTRON_DEMAND.CORE.FACT_PLAN_INPUT_PENDING
        WHERE REQUEST_ID = :P_REQUEST_ID AND NOT IS_DELETE
      ) AS source
      ON target.CYCLE_WEEK = source.CYCLE_WEEK AND target.STREAM_ID = source.STREAM_ID
         AND target.SERIES_ID = source.SERIES_ID AND target.WEEK_ID = source.WEEK_ID
      WHEN MATCHED THEN UPDATE SET
        BASE_UNITS = source.BASE_UNITS, INPUT_UNITS = source.INPUT_UNITS,
        DELTA_UNITS = source.DELTA_UNITS, NODE_LEVEL = source.NODE_LEVEL,
        NODE_KEY = source.NODE_KEY, DISAGG_METHOD = source.DISAGG_METHOD,
        EDIT_GROUP_ID = source.EDIT_GROUP_ID, REASON_CODE = source.REASON_CODE,
        NOTE = source.NOTE, SUBMITTED_BY = source.SUBMITTED_BY, SUBMITTED_AT = source.SUBMITTED_AT
      WHEN NOT MATCHED THEN INSERT (
        CYCLE_WEEK, STREAM_ID, SERIES_ID, WEEK_ID, BASE_UNITS, INPUT_UNITS, DELTA_UNITS,
        NODE_LEVEL, NODE_KEY, DISAGG_METHOD, EDIT_GROUP_ID, REASON_CODE, NOTE,
        SUBMITTED_BY, SUBMITTED_AT
      ) VALUES (
        source.CYCLE_WEEK, source.STREAM_ID, source.SERIES_ID, source.WEEK_ID,
        source.BASE_UNITS, source.INPUT_UNITS, source.DELTA_UNITS,
        source.NODE_LEVEL, source.NODE_KEY, source.DISAGG_METHOD, source.EDIT_GROUP_ID,
        source.REASON_CODE, source.NOTE, source.SUBMITTED_BY, source.SUBMITTED_AT
      );
      v_rows := SQLROWCOUNT;
    ELSEIF (v_type = 'cycle_signoff') THEN
      INSERT INTO VECTRON_DEMAND.CORE.FACT_PLAN_SNAPSHOT
        (CYCLE_WEEK, SERIES_ID, WEEK_ID, STAT_UNITS, OVERRIDE_UNITS, PLAN_UNITS)
      SELECT :v_object, SERIES_ID, WEEK_ID, STAT_UNITS, OVERRIDE_UNITS, PLAN_UNITS
      FROM VECTRON_DEMAND.CORE.FACT_DEMAND_PLAN;
      v_rows := SQLROWCOUNT;
      v_units := (SELECT SUM(PLAN_UNITS) FROM VECTRON_DEMAND.CORE.FACT_PLAN_SNAPSHOT WHERE CYCLE_WEEK = :v_object);
      UPDATE VECTRON_DEMAND.CORE.DIM_PLAN_CYCLE
         SET STATUS = 'signed_off',
             SIGNED_OFF_BY = (SELECT MAX(DISPLAY_NAME) FROM VECTRON_DEMAND.CORE.DIM_APP_USER WHERE USER_ID = :P_USER_ID),
             SIGNED_OFF_AT = CURRENT_TIMESTAMP(),
             SNAPSHOT_ROWS = :v_rows, SNAPSHOT_UNITS = :v_units,
             SNAPSHOT_SOURCE = 'signoff', APPROVAL_REQUEST_ID = :P_REQUEST_ID
       WHERE CYCLE_WEEK = :v_object;
    END IF;
  END IF;
  COMMIT;
  RETURN OBJECT_CONSTRUCT('ok', TRUE, 'status', P_TO_STATUS, 'rowsApplied', v_rows);
EXCEPTION
  WHEN OTHER THEN
    ROLLBACK;
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'error', SQLERRM);
END;
$$;

USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- V_APPROVAL_QUEUE — requests with who raised them and who must act next.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_APPROVAL_QUEUE AS
SELECT r.REQUEST_ID,
       r.CHAIN_ID,
       ch.CHAIN_LABEL,
       r.OBJECT_TYPE,
       r.OBJECT_ID,
       r.CYCLE_WEEK,
       r.STATUS,
       r.CURRENT_STEP,
       (SELECT COUNT(*) FROM CORE.DIM_APPROVAL_STEP st2 WHERE st2.CHAIN_ID = r.CHAIN_ID) AS STEP_COUNT,
       st.ROLE_ID     AS NEXT_ROLE_ID,
       ro.ROLE_LABEL  AS NEXT_ROLE_LABEL,
       st.STEP_LABEL  AS NEXT_STEP_LABEL,
       r.TITLE,
       r.SUMMARY,
       r.REQUESTED_BY_USER,
       u.DISPLAY_NAME AS REQUESTED_BY_NAME,
       u.ROLE_ID      AS REQUESTED_BY_ROLE,
       r.REQUESTED_BY_SF,
       r.REQUESTED_AT,
       r.DECIDED_AT
FROM CORE.FACT_APPROVAL_REQUEST r
JOIN CORE.DIM_APPROVAL_CHAIN ch ON ch.CHAIN_ID = r.CHAIN_ID
LEFT JOIN CORE.DIM_APPROVAL_STEP st ON st.CHAIN_ID = r.CHAIN_ID AND st.STEP_NO = r.CURRENT_STEP
LEFT JOIN CORE.DIM_APP_ROLE ro ON ro.ROLE_ID = st.ROLE_ID
LEFT JOIN CORE.DIM_APP_USER u ON u.USER_ID = r.REQUESTED_BY_USER;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_APPROVALS
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_APPROVALS AS
-- Every request's status is the TO_STATUS of its latest action.
SELECT 'approval_trail' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM CORE.FACT_APPROVAL_REQUEST r
LEFT JOIN (
  SELECT REQUEST_ID, TO_STATUS
  FROM CORE.FACT_APPROVAL_ACTION
  QUALIFY ROW_NUMBER() OVER (PARTITION BY REQUEST_ID ORDER BY ACTED_AT DESC, ACTION_ID DESC) = 1
) a ON a.REQUEST_ID = r.REQUEST_ID
WHERE a.REQUEST_ID IS NULL OR a.TO_STATUS <> r.STATUS
UNION ALL
-- Nobody approves their own request.
SELECT 'approval_self_approval', COUNT(*)
FROM CORE.FACT_APPROVAL_ACTION a
JOIN CORE.FACT_APPROVAL_REQUEST r ON r.REQUEST_ID = a.REQUEST_ID
WHERE a.ACTION = 'approve' AND a.ACTOR_USER_ID = r.REQUESTED_BY_USER
UNION ALL
-- Every approval was made by the role the step requires.
SELECT 'approval_role_mismatch', COUNT(*)
FROM CORE.FACT_APPROVAL_ACTION a
JOIN CORE.FACT_APPROVAL_REQUEST r ON r.REQUEST_ID = a.REQUEST_ID
JOIN CORE.DIM_APPROVAL_STEP st ON st.CHAIN_ID = r.CHAIN_ID AND st.STEP_NO = a.STEP_NO
LEFT JOIN CORE.DIM_APP_USER u ON u.USER_ID = a.ACTOR_USER_ID
WHERE a.ACTION IN ('approve', 'reject', 'request_changes')
  AND COALESCE(u.ROLE_ID, '') <> st.ROLE_ID
UNION ALL
-- A promoted scenario went through an approved request.
SELECT 'promoted_without_approval', COUNT(*)
FROM CORE.DIM_SCENARIO s
LEFT JOIN CORE.FACT_APPROVAL_REQUEST r
  ON r.OBJECT_TYPE = 'scenario_promote' AND r.OBJECT_ID = s.SCENARIO_ID AND r.STATUS = 'approved'
WHERE s.STATUS = 'promoted' AND r.REQUEST_ID IS NULL
UNION ALL
-- A cycle signed off in the app went through an approved request.
SELECT 'signoff_without_approval', COUNT(*)
FROM CORE.DIM_PLAN_CYCLE c
LEFT JOIN CORE.FACT_APPROVAL_REQUEST r
  ON r.OBJECT_TYPE = 'cycle_signoff' AND r.OBJECT_ID = c.CYCLE_WEEK AND r.STATUS = 'approved'
WHERE c.STATUS = 'signed_off' AND c.SNAPSHOT_SOURCE = 'signoff' AND r.REQUEST_ID IS NULL
UNION ALL
-- A scenario in review has exactly one open request; a cycle likewise.
SELECT 'in_review_without_request', COUNT(*)
FROM (
  SELECT s.SCENARIO_ID AS OBJECT_ID, 'scenario_promote' AS OBJECT_TYPE
  FROM CORE.DIM_SCENARIO s WHERE s.STATUS = 'in_review'
  UNION ALL
  SELECT c.CYCLE_WEEK, 'cycle_signoff' FROM CORE.DIM_PLAN_CYCLE c WHERE c.STATUS = 'in_review'
) o
LEFT JOIN CORE.FACT_APPROVAL_REQUEST r
  ON r.OBJECT_TYPE = o.OBJECT_TYPE AND r.OBJECT_ID = o.OBJECT_ID AND r.STATUS = 'submitted'
WHERE r.REQUEST_ID IS NULL
UNION ALL
-- Staged input always belongs to a stream-submission request.
SELECT 'pending_input_orphan', COUNT(*)
FROM CORE.FACT_PLAN_INPUT_PENDING p
LEFT JOIN CORE.FACT_APPROVAL_REQUEST r
  ON r.REQUEST_ID = p.REQUEST_ID AND r.OBJECT_TYPE = 'stream_submission'
WHERE r.REQUEST_ID IS NULL
UNION ALL
SELECT 'approval_status_domain', COUNT(*)
FROM CORE.FACT_APPROVAL_REQUEST
WHERE STATUS NOT IN ('submitted', 'approved', 'rejected', 'changes_requested', 'withdrawn')
UNION ALL
SELECT 'scenario_status_domain', COUNT(*)
FROM CORE.DIM_SCENARIO
WHERE STATUS NOT IN ('draft', 'in_review', 'promoted', 'discarded');

-- ---------------------------------------------------------------------
-- V_INTEGRITY_ALL — extended for approvals. Composed, never redefined.
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
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_APPROVALS;
