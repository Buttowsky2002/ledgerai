import {
  CopilotRoiAssumptions,
  CopilotRoiResult,
  DEFAULT_ROI_ASSUMPTIONS,
} from './github-copilot.types';

export function mergeRoiAssumptions(
  partial?: Partial<CopilotRoiAssumptions>,
): CopilotRoiAssumptions {
  return { ...DEFAULT_ROI_ASSUMPTIONS, ...partial };
}

export interface CopilotRoiInput {
  assignedSeats: number;
  activeSeats: number;
  aiCreditsUsed: number;
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
  assumptions?: Partial<CopilotRoiAssumptions>;
}

/** Pure ROI engine — all outputs are estimates, not exact productivity measures. */
export function calculateCopilotRoi(input: CopilotRoiInput): CopilotRoiResult {
  const a = mergeRoiAssumptions(input.assumptions);
  const assignedSeats = Math.max(0, input.assignedSeats);
  const activeSeats = Math.max(0, input.activeSeats);
  const aiCreditsUsed = Math.max(0, input.aiCreditsUsed);
  const linesAccepted = Math.max(0, input.linesAccepted);
  const chatTurns = Math.max(0, input.chatTurns);
  const prSummaryCount = Math.max(0, input.prSummaryCount);

  const baseSeatCost = assignedSeats * a.seatPriceUsd;
  const includedAiCredits = assignedSeats * a.includedCreditsPerSeat;
  const overageEstimate = Math.max(0, aiCreditsUsed - includedAiCredits) * a.creditValueUsd;
  const totalCopilotCost = baseSeatCost + overageEstimate;

  const completionMinutesSaved = linesAccepted * a.minutesSavedPerAcceptedLine;
  const chatMinutesSaved = chatTurns * a.minutesSavedPerChatTurn;
  const prMinutesSaved = prSummaryCount * a.minutesSavedPerPrSummary;
  const grossHoursSaved =
    (completionMinutesSaved + chatMinutesSaved + prMinutesSaved) / 60;
  const adjustedHoursSaved = grossHoursSaved * a.qualityAdjustmentFactor;
  const estimatedValue = adjustedHoursSaved * a.avgEngineerHourlyRate;

  const roiPercentage =
    totalCopilotCost > 0
      ? ((estimatedValue - totalCopilotCost) / totalCopilotCost) * 100
      : 0;

  return {
    assignedSeats,
    activeSeats,
    baseSeatCost: round2(baseSeatCost),
    includedAiCredits: round2(includedAiCredits),
    aiCreditsUsed: round2(aiCreditsUsed),
    overageEstimate: round2(overageEstimate),
    totalCopilotCost: round2(totalCopilotCost),
    linesAccepted,
    chatTurns,
    prSummaryCount,
    grossHoursSaved: round4(grossHoursSaved),
    adjustedHoursSaved: round4(adjustedHoursSaved),
    estimatedValue: round2(estimatedValue),
    roiPercentage: round2(roiPercentage),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
