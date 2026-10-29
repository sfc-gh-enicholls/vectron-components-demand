import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/snowflake";
import { getContext } from "@/lib/data";
import { getActor, round2, same2 } from "@/app/api/scenarios/shared";
import { warmOrderCache } from "@/lib/supply";

/**
 * The demand review workbench.
 *
 * GET  — the exception worklist, plus full detail for one series when
 *        ?series= is supplied: history, forward plan with interval, and the
 *        additive driver decomposition for a chosen week.
 * POST — commit a planner override. Requires a reason code, because an
 *        override with no recorded reason cannot be learned from later, and
 *        the override scorecard on /accuracy depends on it.
 */
export const dynamic = "force-dynamic";

const DRIVER_SUM_TOLERANCE = 0.05;

interface ExceptionRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  CUSTOMER_NAME: string;
  CHANNEL_NAME: string;
  CATEGORY_NAME: string;
  SEGMENT_ABC: string;
  SEGMENT_XYZ: string;
  PLAN_UNITS_8WK: number;
  STAT_UNITS_8WK: number;
  NAIVE_UNITS_8WK: number;
  GAP_UNITS: number;
  GAP_VALUE_EUR: number;
  GAP_PCT: number;
  REASON_CODE: string | null;
  REASON_LABEL: string | null;
  PLANNER: string | null;
  ANY_LOCKED: boolean;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getContext();
    const sp = req.nextUrl.searchParams;
    const seriesId = sp.get("series");
    const week = sp.get("week");

    const [worklist, agentRows] = await Promise.all([
      query<ExceptionRow>(
        `SELECT SERIES_ID, SERIES_LABEL, PRODUCT_NAME, CUSTOMER_NAME, CHANNEL_NAME,
                CATEGORY_NAME, SEGMENT_ABC, SEGMENT_XYZ,
                PLAN_UNITS_8WK, STAT_UNITS_8WK, NAIVE_UNITS_8WK,
                GAP_UNITS, GAP_VALUE_EUR, GAP_PCT,
                REASON_CODE, REASON_LABEL, PLANNER, ANY_LOCKED
         FROM APP.V_EXCEPTIONS
         ORDER BY ABS(GAP_VALUE_EUR) DESC
         LIMIT 200`,
      ),
      query<{
        SERIES_ID: string;
        PROPOSAL_ID: string;
        PRIORITY: string;
        PROPOSAL_TYPE: string;
        CONFIDENCE: number;
      }>(
        `SELECT SERIES_ID, PROPOSAL_ID, PRIORITY, PROPOSAL_TYPE, CONFIDENCE
         FROM APP.V_AGENT_QUEUE
         WHERE RUN_TYPE = ?
           AND STATUS = ?
           AND SERIES_ID IS NOT NULL
         QUALIFY ROW_NUMBER() OVER (
           PARTITION BY SERIES_ID
           ORDER BY CASE PRIORITY
                      WHEN 'Critical' THEN 1
                      WHEN 'High' THEN 2
                      WHEN 'Medium' THEN 3
                      ELSE 4
                    END,
                    ABS(DELTA_VALUE_EUR) DESC,
                    CONFIDENCE DESC
         ) = 1`,
        ["live", "proposed"],
      ),
    ]);

    const agentBySeries = new Map(
      agentRows.map((row) => [
        row.SERIES_ID,
        {
          proposalId: row.PROPOSAL_ID,
          priority: row.PRIORITY,
          proposalType: row.PROPOSAL_TYPE,
          confidence: Number(row.CONFIDENCE) || 0,
        },
      ]),
    );

    const reasons = await query(
      `SELECT REASON_CODE, REASON_LABEL, REASON_GROUP, REQUIRES_NOTE
       FROM CORE.DIM_REASON_CODE ORDER BY REASON_GROUP, REASON_LABEL`,
    );

    if (!seriesId) {
      return NextResponse.json({
        context: ctx,
        worklist: worklist.map((row) => ({
          ...row,
          agentRecommendation: agentBySeries.get(row.SERIES_ID) ?? null,
        })),
        reasons,
        detail: null,
      });
    }

    // Which week to decompose. Defaults to the most recent completed week,
    // because that is the last one with actuals to explain.
    const targetWeek = week ?? ctx.HISTORY_END_WEEK;

    const [history, forward, drivers, promos, seriesMeta] = await Promise.all([
      query(
        `SELECT a.WEEK_ID, a.POS_UNITS, a.SHIP_UNITS, a.STOCK_UNITS,
                a.WEEKS_OF_COVER, a.PROMO_FLAG, a.PROMO_DEPTH_PCT,
                a.DISTRIBUTION_POINTS, a.LOST_SALES_UNITS
         FROM APP.V_ACTUALS_WEEKLY a
         JOIN APP.V_WEEK_INDEX wi ON wi.WEEK_ID = a.WEEK_ID
         WHERE a.SERIES_ID = ? AND wi.WEEKS_AGO <= 78
         ORDER BY a.WEEK_ID`,
        [seriesId],
      ),
      query(
        `SELECT WEEK_ID, STAT_UNITS, OVERRIDE_UNITS, PLAN_UNITS, NAIVE_UNITS,
                LOWER_95, UPPER_95, LAG_WEEKS, REASON_CODE, REASON_LABEL,
                PLANNER, IS_LOCKED, UNIT_PRICE_EUR
         FROM APP.V_PLAN_FORWARD
         WHERE SERIES_ID = ? ORDER BY WEEK_ID`,
        [seriesId],
      ),
      query<{ DRIVER: string; DRIVER_LABEL: string; DRIVER_ORDER: number;
              CONTRIB_UNITS: number; IS_MODELLED_INPUT: boolean }>(
        `SELECT DRIVER, DRIVER_LABEL, DRIVER_ORDER, CONTRIB_UNITS, IS_MODELLED_INPUT
         FROM APP.V_DRIVER_WATERFALL
         WHERE SERIES_ID = ? AND WEEK_ID = ?
         ORDER BY DRIVER_ORDER`,
        [seriesId, targetWeek],
      ),
      query(
        `SELECT PROMO_ID, START_WEEK_ID, END_WEEK_ID, MECHANIC, DEPTH_PCT,
                PLANNED_UPLIFT_PCT, ACTUAL_UPLIFT_PCT
         FROM CORE.FACT_PROMOTION
         WHERE SERIES_ID = ? ORDER BY START_WEEK_ID DESC LIMIT 12`,
        [seriesId],
      ),
      query(
        `SELECT SERIES_ID, SERIES_LABEL, PRODUCT_NAME, PRODUCT_LINE, CUSTOMER_NAME,
                CHANNEL_NAME, CATEGORY_NAME, PRICE_TIER, SEGMENT_ABC,
                SEGMENT_XYZ, LIFECYCLE_STATUS, BASE_ANNUAL_UNITS,
                BASE_ANNUAL_VALUE_EUR, UNIT_PRICE_EUR
         FROM APP.V_SERIES WHERE SERIES_ID = ?`,
        [seriesId],
      ),
    ]);

    if (!seriesMeta.length) {
      return NextResponse.json(
        { error: `Series ${seriesId} not found` },
        { status: 404 },
      );
    }

    // The waterfall claims to explain the actual. Verify that rather than
    // asserting it: if the contributions do not sum to POS, the UI must say so.
    const driverTotal = drivers.reduce(
      (s, d) => s + Number(d.CONTRIB_UNITS), 0,
    );
    const actualRow = (history as Array<{ WEEK_ID: string; POS_UNITS: number }>)
      .find((h) => h.WEEK_ID === targetWeek);
    const actual = actualRow ? Number(actualRow.POS_UNITS) : null;
    const reconciles =
      actual === null ? null : Math.abs(driverTotal - actual) <= DRIVER_SUM_TOLERANCE;

    return NextResponse.json({
      context: ctx,
      worklist: worklist.map((row) => ({
        ...row,
        agentRecommendation: agentBySeries.get(row.SERIES_ID) ?? null,
      })),
      reasons,
      detail: {
        series: seriesMeta[0],
        targetWeek,
        history,
        forward,
        drivers,
        promos,
        driverTotal,
        actual,
        reconciles,
        agentRecommendation: agentBySeries.get(seriesId) ?? null,
      },
    });
  } catch (err) {
    console.error("review route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load review" },
      { status: 500 },
    );
  }
}

interface OverridePayload {
  seriesId?: string;
  weekId?: string;
  overrideUnits?: number;
  reasonCode?: string;
  note?: string;
}

const REVIEW_SCENARIO_PREFIX = "Exception review";

/**
 * The draft scenario that collects this cycle's review overrides, created on
 * first use. If the cycle's review scenario has already been submitted or
 * promoted, a fresh one is started so a frozen scenario is never edited.
 */
async function reviewScenarioFor(cycleWeek: string, actor: string) {
  const name = `${REVIEW_SCENARIO_PREFIX} — ${cycleWeek}`;
  const existing = await query<{ SCENARIO_ID: string; SCENARIO_NAME: string }>(
    `SELECT SCENARIO_ID, SCENARIO_NAME
     FROM CORE.DIM_SCENARIO
     WHERE STATUS = 'draft' AND BASE_PLAN_WEEK = ? AND STARTSWITH(SCENARIO_NAME, ?)
     ORDER BY CREATED_AT DESC
     LIMIT 1`,
    [cycleWeek, name],
  );
  if (existing[0]) return { scenarioId: existing[0].SCENARIO_ID, name: existing[0].SCENARIO_NAME, created: false };

  const prior = await query<{ N: number }>(
    `SELECT COUNT(*) AS N FROM CORE.DIM_SCENARIO WHERE BASE_PLAN_WEEK = ? AND STARTSWITH(SCENARIO_NAME, ?)`,
    [cycleWeek, name],
  );
  const count = Number(prior[0]?.N) || 0;
  const finalName = count > 0 ? `${name} (${count + 1})` : name;
  const scenarioId = crypto.randomUUID();
  await query(
    `INSERT INTO CORE.DIM_SCENARIO (
       SCENARIO_ID, SCENARIO_NAME, DESCRIPTION, STATUS, BASE_PLAN_WEEK,
       PARENT_SCENARIO_ID, CREATED_BY, CREATED_AT, UPDATED_AT
     ) VALUES (?, ?, ?, 'draft', ?, NULL, ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
    [
      scenarioId,
      finalName,
      "Overrides entered on the exception review screen. Reaches the committed plan only when promoted and approved.",
      cycleWeek,
      actor,
    ],
  );
  return { scenarioId, name: finalName, created: true };
}

/**
 * Record a review override.
 *
 * This used to UPDATE FACT_DEMAND_PLAN directly. It now writes the override
 * into the cycle's review scenario, so the committed plan changes only through
 * an approved promotion (snowflake/13-approvals.sql). The planner is the acting
 * persona, never a name supplied by the client.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as OverridePayload;
    const { seriesId, weekId, overrideUnits, reasonCode, note } = body;

    if (!seriesId || !weekId) {
      return NextResponse.json(
        { error: "seriesId and weekId are required" },
        { status: 400 },
      );
    }
    if (typeof overrideUnits !== "number" || !Number.isFinite(overrideUnits)
        || overrideUnits < 0) {
      return NextResponse.json(
        { error: "overrideUnits must be a non-negative number" },
        { status: 400 },
      );
    }
    if (!reasonCode) {
      return NextResponse.json(
        { error: "A reason code is required. An override with no recorded reason cannot be reviewed or learned from." },
        { status: 400 },
      );
    }

    // Validate the reason against the dimension rather than trusting input,
    // and enforce the note requirement the dimension itself declares.
    const reason = await query<{ REASON_CODE: string; REQUIRES_NOTE: boolean }>(
      `SELECT REASON_CODE, REQUIRES_NOTE FROM CORE.DIM_REASON_CODE
       WHERE REASON_CODE = ?`,
      [reasonCode],
    );
    if (!reason.length) {
      return NextResponse.json(
        { error: `Unknown reason code '${reasonCode}'` },
        { status: 400 },
      );
    }
    if (reason[0].REQUIRES_NOTE && !note?.trim()) {
      return NextResponse.json(
        { error: `Reason '${reasonCode}' requires an explanatory note` },
        { status: 400 },
      );
    }

    const existing = await query<{ IS_LOCKED: boolean; PLAN_UNITS: number }>(
      `SELECT IS_LOCKED, PLAN_UNITS FROM CORE.FACT_DEMAND_PLAN
       WHERE SERIES_ID = ? AND WEEK_ID = ?`,
      [seriesId, weekId],
    );
    if (!existing.length) {
      return NextResponse.json(
        { error: `No plan row for ${seriesId} at ${weekId}. Overrides only apply to the forward horizon.` },
        { status: 404 },
      );
    }
    if (existing[0].IS_LOCKED) {
      return NextResponse.json(
        { error: "This week is locked. Unlock it before overriding." },
        { status: 409 },
      );
    }

    // No cycle check here: this writes a draft scenario, which cannot reach the
    // committed plan. The cycle lock is enforced where the plan is changed, at
    // submission and approval (SP_SUBMIT_REQUEST / SP_ACT_ON_REQUEST).
    const context = await getContext();
    const actor = await getActor();
    const scenario = await reviewScenarioFor(context.HISTORY_END_WEEK, actor);
    const baseUnits = round2(Number(existing[0].PLAN_UNITS) || 0);
    const editUnits = round2(overrideUnits);
    const trimmedNote = note?.trim() ? note.trim().slice(0, 600) : null;

    if (same2(editUnits, baseUnits)) {
      // Setting a cell back to the committed value removes the override.
      await query(
        `DELETE FROM CORE.FACT_SCENARIO_EDIT WHERE SCENARIO_ID = ? AND SERIES_ID = ? AND WEEK_ID = ?`,
        [scenario.scenarioId, seriesId, weekId],
      );
    } else {
      await query(
        `MERGE INTO CORE.FACT_SCENARIO_EDIT AS target
         USING (SELECT ? AS SCENARIO_ID, ? AS SERIES_ID, ? AS WEEK_ID, ? AS BASE_UNITS,
                       ? AS EDIT_UNITS, ? AS DELTA_UNITS, ? AS REASON_CODE, ? AS NOTE,
                       ? AS EDIT_GROUP_ID, ? AS EDITED_BY) AS source
         ON target.SCENARIO_ID = source.SCENARIO_ID
            AND target.SERIES_ID = source.SERIES_ID
            AND target.WEEK_ID = source.WEEK_ID
         WHEN MATCHED THEN UPDATE SET
           BASE_UNITS = source.BASE_UNITS, EDIT_UNITS = source.EDIT_UNITS,
           DELTA_UNITS = source.DELTA_UNITS, ORIGIN = 'planner', SOURCE_PROPOSAL_ID = NULL,
           REASON_CODE = source.REASON_CODE, NOTE = source.NOTE,
           EDIT_GROUP_ID = source.EDIT_GROUP_ID, PARENT_LEVEL = 'SERIES_ID',
           PARENT_KEY = source.SERIES_ID, DISAGG_METHOD = 'direct',
           EDITED_BY = source.EDITED_BY, EDITED_AT = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (
           SCENARIO_ID, SERIES_ID, WEEK_ID, BASE_UNITS, EDIT_UNITS, DELTA_UNITS,
           ORIGIN, SOURCE_PROPOSAL_ID, REASON_CODE, NOTE, EDIT_GROUP_ID,
           PARENT_LEVEL, PARENT_KEY, DISAGG_METHOD, EDITED_BY, EDITED_AT
         ) VALUES (
           source.SCENARIO_ID, source.SERIES_ID, source.WEEK_ID, source.BASE_UNITS,
           source.EDIT_UNITS, source.DELTA_UNITS, 'planner', NULL, source.REASON_CODE,
           source.NOTE, source.EDIT_GROUP_ID, 'SERIES_ID', source.SERIES_ID, 'direct',
           source.EDITED_BY, CURRENT_TIMESTAMP()
         )`,
        [
          scenario.scenarioId, seriesId, weekId, baseUnits, editUnits,
          round2(editUnits - baseUnits), reasonCode, trimmedNote, crypto.randomUUID(), actor,
        ],
      );
    }
    await query(
      `UPDATE CORE.DIM_SCENARIO SET UPDATED_AT = CURRENT_TIMESTAMP() WHERE SCENARIO_ID = ?`,
      [scenario.scenarioId],
    );
    warmOrderCache(scenario.scenarioId);

    return NextResponse.json({
      ok: true,
      committedPlanChanged: false,
      scenario: { id: scenario.scenarioId, name: scenario.name, created: scenario.created },
      row: {
        SERIES_ID: seriesId,
        WEEK_ID: weekId,
        COMMITTED_UNITS: baseUnits,
        OVERRIDE_UNITS: editUnits,
        REASON_CODE: reasonCode,
        OVERRIDE_NOTE: trimmedNote,
        PLANNER: actor,
      },
    });
  } catch (err) {
    console.error("override failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to save override" },
      { status: 500 },
    );
  }
}
