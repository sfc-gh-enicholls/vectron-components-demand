import { NextRequest, NextResponse } from "next/server";
import { getContext } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { hierarchyPredicate, parseHierarchyPath } from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";
import {
  type AgentSignalRow,
  type AgentSignalSummaryRow,
  PRIORITY_ORDER,
  PRIORITY_RANK,
  type AgentQueueRow,
  type AgentWeekRow,
  type DraftScenarioRow,
  type LiveRunRow,
  parseJsonText,
} from "./shared";

export const dynamic = "force-dynamic";

// The queue's base universe (live, still proposed), so the hierarchy dropdowns
// only offer nodes with something to review. Must match the base WHERE below.
const LIVE_PROPOSAL_SCOPE = `(SELECT CATEGORY_NAME, PRODUCT_NAME, CUSTOMER_NAME, CHANNEL_NAME
  FROM APP.V_AGENT_QUEUE
  WHERE RUN_TYPE = 'live' AND STATUS = 'proposed')`;

function humanPriorityRankSql(column: string) {
  return `CASE ${column}
    WHEN 'Critical' THEN 1
    WHEN 'High' THEN 2
    WHEN 'Medium' THEN 3
    ELSE 4
  END`;
}

function readOptionalString(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readMinConfidence(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("minConfidence must be between 0 and 1.");
  }
  return parsed;
}

function readContestedOnly(value: string | null) {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function readSort(value: string | null) {
  if (!value) return "priority";
  if (value === "priority" || value === "contested") return value;
  throw new Error("sort must be either 'priority' or 'contested'.");
}

function splitDissentingSources(value: string | null) {
  if (!value) return [] as string[];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const proposalType = readOptionalString(params.get("proposalType"));
    const priority = readOptionalString(params.get("priority"));
    const path = parseHierarchyPath(params);
    const minConfidence = readMinConfidence(params.get("minConfidence"));
    const contestedOnly = readContestedOnly(params.get("contestedOnly"));
    const sort = readSort(params.get("sort"));

    if (priority && !PRIORITY_ORDER.includes(priority as (typeof PRIORITY_ORDER)[number])) {
      return NextResponse.json({ error: `Unknown priority '${priority}'.` }, { status: 400 });
    }

    const where = ["queue.RUN_TYPE = ?", "queue.STATUS = ?"];
    const binds: Array<string | number> = ["live", "proposed"];

    if (proposalType) {
      where.push("queue.PROPOSAL_TYPE = ?");
      binds.push(proposalType);
    }
    if (priority) {
      where.push("queue.PRIORITY = ?");
      binds.push(priority);
    }
    const scope = hierarchyPredicate(path, "queue");
    where.push(scope.sql);
    binds.push(...scope.binds);
    if (minConfidence !== null) {
      where.push("queue.CONFIDENCE >= ?");
      binds.push(minConfidence);
    }
    if (contestedOnly) {
      where.push("COALESCE(signal_summary.IS_CONTESTED, FALSE) = TRUE");
    }

    const filterClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderClause = sort === "contested"
      ? `COALESCE(signal_summary.IS_CONTESTED, FALSE) DESC,
         COALESCE(signal_summary.DISAGREE_COUNT, 0) DESC,
         ABS(COALESCE(signal_summary.NET_SUPPORT, 0)) ASC,
         ${humanPriorityRankSql("queue.PRIORITY")}, ABS(queue.DELTA_VALUE_EUR) DESC,
         queue.CONFIDENCE DESC, queue.SERIES_LABEL ASC`
      : `${humanPriorityRankSql("queue.PRIORITY")}, ABS(queue.DELTA_VALUE_EUR) DESC,
         queue.CONFIDENCE DESC, queue.SERIES_LABEL ASC`;

    const [context, runRows, draftScenarios, filterRows, hierarchyOptions, proposalRows] = await Promise.all([
      getContext(),
      query<LiveRunRow>(
        `SELECT RUN_ID, AS_OF_WEEK, RUN_TYPE, STARTED_AT, COMPLETED_AT, STATUS,
                PROPOSAL_COUNT, NARRATIVE_MODE, MODEL_NAME, CORTEX_CALLS,
                CORTEX_FALLBACKS
         FROM CORE.FACT_AGENT_RUN
         WHERE RUN_TYPE = ?
         ORDER BY COALESCE(COMPLETED_AT, STARTED_AT) DESC
         LIMIT 1`,
        ["live"],
      ),
      query<DraftScenarioRow>(
        `SELECT SCENARIO_ID, SCENARIO_NAME, DESCRIPTION, BASE_PLAN_WEEK,
                EDIT_COUNT, AGENT_EDITS, UPDATED_AT, CREATED_AT
         FROM APP.V_SCENARIO_SUMMARY
         WHERE STATUS = ?
         ORDER BY COALESCE(UPDATED_AT, CREATED_AT) DESC, SCENARIO_NAME ASC`,
        ["draft"],
      ),
      query<{
        PROPOSAL_TYPE: string;
        PRIORITY: string;
      }>(
        `SELECT DISTINCT PROPOSAL_TYPE, PRIORITY
         FROM APP.V_AGENT_QUEUE
         WHERE RUN_TYPE = ? AND STATUS = ?`,
        ["live", "proposed"],
      ),
      loadHierarchyOptions(LIVE_PROPOSAL_SCOPE, path),
      query<AgentQueueRow>(
        `SELECT queue.PROPOSAL_ID, queue.RUN_ID, queue.AS_OF_WEEK, queue.PROPOSAL_TYPE, queue.STATUS, queue.SERIES_ID,
                queue.NODE_LEVEL, queue.NODE_KEY, queue.WEEK_FROM, queue.WEEK_TO, queue.CURRENT_UNITS,
                queue.PROPOSED_UNITS, queue.DELTA_UNITS, queue.DELTA_VALUE_EUR, queue.CONFIDENCE,
                queue.REASON_CODE, queue.REASON_LABEL, queue.TRIGGER_SUMMARY, queue.DIAGNOSIS, queue.EVIDENCE,
                queue.RATIONALE, queue.RATIONALE_SOURCE, queue.CREATED_AT, queue.RUN_TYPE, queue.NARRATIVE_MODE,
                queue.MODEL_NAME, queue.SERIES_LABEL, queue.PRODUCT_NAME, queue.CUSTOMER_NAME, queue.CHANNEL_NAME,
                queue.CATEGORY_NAME, queue.SEGMENT_ABC, queue.SEGMENT_XYZ, queue.BASE_ANNUAL_VALUE_EUR,
                queue.PRIORITY
         FROM APP.V_AGENT_QUEUE AS queue
         LEFT JOIN APP.V_PROPOSAL_SIGNAL_SUMMARY AS signal_summary
           ON signal_summary.PROPOSAL_ID = queue.PROPOSAL_ID
         ${filterClause}
         ORDER BY ${orderClause}`,
        binds,
      ),
    ]);

    const proposalIds = proposalRows.map((row) => row.PROPOSAL_ID);
    const weekRows = proposalIds.length
      ? await query<AgentWeekRow>(
          `SELECT PROPOSAL_ID, WEEK_ID, CURRENT_UNITS, PROPOSED_UNITS
           FROM CORE.FACT_AGENT_PROPOSAL_WEEK
           WHERE PROPOSAL_ID IN (${proposalIds.map(() => "?").join(",")})
           ORDER BY PROPOSAL_ID, WEEK_ID`,
          proposalIds,
        )
      : [];

    const [signalSummaryRows, signalRows] = proposalIds.length
      ? await Promise.all([
          query<AgentSignalSummaryRow>(
            `SELECT PROPOSAL_ID, SIGNALS, AGREE_COUNT, DISAGREE_COUNT, NEUTRAL_COUNT,
                    EXTERNAL_SIGNALS, SIMULATED_SIGNALS, NET_SUPPORT, IS_CONTESTED,
                    DISSENTING_SOURCES
             FROM APP.V_PROPOSAL_SIGNAL_SUMMARY
             WHERE PROPOSAL_ID IN (${proposalIds.map(() => "?").join(",")})`,
            proposalIds,
          ),
          query<AgentSignalRow>(
            `SELECT PROPOSAL_ID, SOURCE_ID, STANCE, SIGNAL_TEXT, STRENGTH, SOURCE_NAME,
                    SOURCE_KIND, OWNER_DOMAIN, DESCRIPTION, IS_SIMULATED, DISPLAY_ORDER
             FROM APP.V_PROPOSAL_SIGNALS
             WHERE PROPOSAL_ID IN (${proposalIds.map(() => "?").join(",")})
             ORDER BY PROPOSAL_ID, DISPLAY_ORDER, SOURCE_NAME`,
            proposalIds,
          ),
        ])
      : [[], []];

    const weeksByProposal = new Map<string, AgentWeekRow[]>();
    for (const row of weekRows) {
      const rows = weeksByProposal.get(row.PROPOSAL_ID) ?? [];
      rows.push(row);
      weeksByProposal.set(row.PROPOSAL_ID, rows);
    }

    const signalSummaryByProposal = new Map(signalSummaryRows.map((row) => [row.PROPOSAL_ID, row]));
    const signalsByProposal = new Map<string, AgentSignalRow[]>();
    for (const row of signalRows) {
      const rows = signalsByProposal.get(row.PROPOSAL_ID) ?? [];
      rows.push(row);
      signalsByProposal.set(row.PROPOSAL_ID, rows);
    }

    const proposals = proposalRows.map((row) => {
      const weeks = (weeksByProposal.get(row.PROPOSAL_ID) ?? []).map((week) => ({
        weekId: week.WEEK_ID,
        currentUnits: Number(week.CURRENT_UNITS) || 0,
        proposedUnits: Number(week.PROPOSED_UNITS) || 0,
        deltaUnits: (Number(week.PROPOSED_UNITS) || 0) - (Number(week.CURRENT_UNITS) || 0),
      }));
      const signalSummary = signalSummaryByProposal.get(row.PROPOSAL_ID);
      const signals = (signalsByProposal.get(row.PROPOSAL_ID) ?? []).map((signal) => ({
        sourceId: signal.SOURCE_ID,
        stance: signal.STANCE,
        signalText: signal.SIGNAL_TEXT,
        strength: Number(signal.STRENGTH) || 0,
        sourceName: signal.SOURCE_NAME,
        sourceKind: signal.SOURCE_KIND,
        ownerDomain: signal.OWNER_DOMAIN,
        description: signal.DESCRIPTION,
        isSimulated: Boolean(signal.IS_SIMULATED),
        displayOrder: Number(signal.DISPLAY_ORDER) || 0,
      }));

      return {
        proposalId: row.PROPOSAL_ID,
        runId: row.RUN_ID,
        asOfWeek: row.AS_OF_WEEK,
        proposalType: row.PROPOSAL_TYPE,
        status: row.STATUS,
        seriesId: row.SERIES_ID,
        nodeLevel: row.NODE_LEVEL,
        nodeKey: row.NODE_KEY,
        weekFrom: row.WEEK_FROM,
        weekTo: row.WEEK_TO,
        currentUnits: Number(row.CURRENT_UNITS) || 0,
        proposedUnits: Number(row.PROPOSED_UNITS) || 0,
        deltaUnits: Number(row.DELTA_UNITS) || 0,
        deltaValueEur: Number(row.DELTA_VALUE_EUR) || 0,
        confidence: Number(row.CONFIDENCE) || 0,
        reasonCode: row.REASON_CODE,
        reasonLabel: row.REASON_LABEL,
        triggerSummary: row.TRIGGER_SUMMARY,
        diagnosis: parseJsonText<Record<string, unknown> | null>(row.DIAGNOSIS, null),
        evidence: parseJsonText<string[]>(row.EVIDENCE, []),
        rationale: row.RATIONALE,
        rationaleSource: row.RATIONALE_SOURCE,
        createdAt: row.CREATED_AT,
        runType: row.RUN_TYPE,
        narrativeMode: row.NARRATIVE_MODE,
        modelName: row.MODEL_NAME,
        seriesLabel: row.SERIES_LABEL,
        productName: row.PRODUCT_NAME,
        customerName: row.CUSTOMER_NAME,
        channelName: row.CHANNEL_NAME,
        categoryName: row.CATEGORY_NAME,
        segmentAbc: row.SEGMENT_ABC,
        segmentXyz: row.SEGMENT_XYZ,
        baseAnnualValueEur: row.BASE_ANNUAL_VALUE_EUR === null ? null : Number(row.BASE_ANNUAL_VALUE_EUR),
        priority: row.PRIORITY,
        priorityRank: PRIORITY_RANK[row.PRIORITY] ?? 99,
        signalSummary: {
          signals: Number(signalSummary?.SIGNALS) || 0,
          agreeCount: Number(signalSummary?.AGREE_COUNT) || 0,
          disagreeCount: Number(signalSummary?.DISAGREE_COUNT) || 0,
          neutralCount: Number(signalSummary?.NEUTRAL_COUNT) || 0,
          externalSignals: Number(signalSummary?.EXTERNAL_SIGNALS) || 0,
          simulatedSignals: Number(signalSummary?.SIMULATED_SIGNALS) || 0,
          netSupport: Number(signalSummary?.NET_SUPPORT) || 0,
          isContested: Boolean(signalSummary?.IS_CONTESTED),
          dissentingSources: splitDissentingSources(signalSummary?.DISSENTING_SOURCES ?? null),
        },
        signals,
        weeks,
      };
    });

    const totalValueEur = proposals.reduce((sum, row) => sum + Math.abs(row.deltaValueEur), 0);
    const contestedProposals = proposals.filter((proposal) => proposal.signalSummary.isContested).length;

    return NextResponse.json({
      context,
      latestRun: runRows[0]
        ? {
            runId: runRows[0].RUN_ID,
            asOfWeek: runRows[0].AS_OF_WEEK,
            runType: runRows[0].RUN_TYPE,
            startedAt: runRows[0].STARTED_AT,
            completedAt: runRows[0].COMPLETED_AT,
            status: runRows[0].STATUS,
            proposalCount: Number(runRows[0].PROPOSAL_COUNT) || 0,
            narrativeMode: runRows[0].NARRATIVE_MODE,
            modelName: runRows[0].MODEL_NAME,
            cortexCalls: Number(runRows[0].CORTEX_CALLS) || 0,
            cortexFallbacks: Number(runRows[0].CORTEX_FALLBACKS) || 0,
          }
        : null,
      summary: {
        openProposals: proposals.length,
        totalValueEur,
        contestedProposals,
      },
      filters: {
        proposalTypes: Array.from(new Set(filterRows.map((row) => row.PROPOSAL_TYPE))).sort(),
        priorities: PRIORITY_ORDER.filter((item) => filterRows.some((row) => row.PRIORITY === item)),
        applied: {
          proposalType,
          priority,
          path,
          minConfidence,
          contestedOnly,
          sort,
        },
      },
      options: {
        hierarchy: hierarchyOptions,
      },
      signalReconciliation: {
        headline: "The agent does not claim to know better. It reads across signals and shows where they conflict so planners can judge the contested calls.",
        simulationNote: "External programme signals from D-Star, Maestria, and Matrix are simulated for this demo. Internal signals from POS velocity, trade inventory, and event calendar are genuinely computed from the data.",
      },
      draftScenarios: draftScenarios.map((row) => ({
        scenarioId: row.SCENARIO_ID,
        name: row.SCENARIO_NAME,
        description: row.DESCRIPTION,
        basePlanWeek: row.BASE_PLAN_WEEK,
        editCount: Number(row.EDIT_COUNT) || 0,
        agentEdits: Number(row.AGENT_EDITS) || 0,
        updatedAt: row.UPDATED_AT,
        createdAt: row.CREATED_AT,
      })),
      proposals,
    });
  } catch (err) {
    console.error("agent route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load agent inbox" },
      { status: 500 },
    );
  }
}