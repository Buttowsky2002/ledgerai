export interface CursorRoiAssumptions {
  avgEngineerHourlyRate: number;
  /** AI-suggested lines accepted in editor (Tab/Composer/Chat applies). */
  minutesSavedPerAcceptedLine: number;
  minutesSavedPerTabAccepted: number;
  minutesSavedPerComposerRequest: number;
  minutesSavedPerChatRequest: number;
  qualityAdjustmentFactor: number;
}

export const DEFAULT_CURSOR_ROI_ASSUMPTIONS: CursorRoiAssumptions = {
  avgEngineerHourlyRate: 75,
  minutesSavedPerAcceptedLine: 0.5,
  minutesSavedPerTabAccepted: 0.25,
  minutesSavedPerComposerRequest: 3,
  minutesSavedPerChatRequest: 2,
  qualityAdjustmentFactor: 0.7,
};

export interface CursorDailyActivityInput {
  linesAccepted: number;
  linesAdded: number;
  linesDeleted: number;
  linesCommitted: number;
  tabsAccepted: number;
  composerRequests: number;
  chatRequests: number;
  assumptions?: Partial<CursorRoiAssumptions>;
}

export interface CursorDailyRoiResult {
  linesCommitted: number;
  linesAccepted: number;
  estimatedHoursSaved: number;
  estimatedValueUsd: number;
  /** Productivity proxy suitable for outcome attribution (0.65 default). */
  attributionConfidence: number;
}

/** Pure productivity estimate from Cursor daily-usage metrics — not invoice-grade revenue. */
export function calculateCursorDailyRoi(input: CursorDailyActivityInput): CursorDailyRoiResult {
  const a = { ...DEFAULT_CURSOR_ROI_ASSUMPTIONS, ...input.assumptions };
  const linesAccepted = Math.max(0, input.linesAccepted);
  const linesCommitted = Math.max(0, input.linesCommitted || input.linesAdded);
  const tabsAccepted = Math.max(0, input.tabsAccepted);
  const composerRequests = Math.max(0, input.composerRequests);
  const chatRequests = Math.max(0, input.chatRequests);

  const minutesSaved =
    linesAccepted * a.minutesSavedPerAcceptedLine +
    tabsAccepted * a.minutesSavedPerTabAccepted +
    composerRequests * a.minutesSavedPerComposerRequest +
    chatRequests * a.minutesSavedPerChatRequest;
  const estimatedHoursSaved = (minutesSaved / 60) * a.qualityAdjustmentFactor;
  const estimatedValueUsd = estimatedHoursSaved * a.avgEngineerHourlyRate;

  return {
    linesCommitted,
    linesAccepted,
    estimatedHoursSaved: round4(estimatedHoursSaved),
    estimatedValueUsd: round2(estimatedValueUsd),
    attributionConfidence: 0.65,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
