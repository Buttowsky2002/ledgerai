import { calculateCopilotRoi, mergeRoiAssumptions } from './github-copilot-roi';
import { DEFAULT_ROI_ASSUMPTIONS } from './github-copilot.types';

describe('mergeRoiAssumptions', () => {
  it('returns defaults when partial is empty', () => {
    expect(mergeRoiAssumptions()).toEqual(DEFAULT_ROI_ASSUMPTIONS);
  });

  it('overrides provided fields only', () => {
    const merged = mergeRoiAssumptions({ avgEngineerHourlyRate: 100 });
    expect(merged.avgEngineerHourlyRate).toBe(100);
    expect(merged.seatPriceUsd).toBe(19);
  });
});

describe('calculateCopilotRoi', () => {
  it('computes seat cost with no overage', () => {
    const r = calculateCopilotRoi({
      assignedSeats: 10,
      activeSeats: 8,
      aiCreditsUsed: 5000,
      linesAccepted: 0,
      chatTurns: 0,
      prSummaryCount: 0,
    });
    expect(r.baseSeatCost).toBe(190);
    expect(r.includedAiCredits).toBe(19000);
    expect(r.overageEstimate).toBe(0);
    expect(r.totalCopilotCost).toBe(190);
    expect(r.estimatedValue).toBe(0);
    expect(r.roiPercentage).toBe(-100);
  });

  it('computes overage when credits exceed included allocation', () => {
    const r = calculateCopilotRoi({
      assignedSeats: 2,
      activeSeats: 2,
      aiCreditsUsed: 5000,
      linesAccepted: 0,
      chatTurns: 0,
      prSummaryCount: 0,
    });
    expect(r.includedAiCredits).toBe(3800);
    expect(r.overageEstimate).toBe(12);
    expect(r.totalCopilotCost).toBe(50);
  });

  it('computes estimated value from accepted lines, chat, and PR summaries', () => {
    const r = calculateCopilotRoi({
      assignedSeats: 1,
      activeSeats: 1,
      aiCreditsUsed: 100,
      linesAccepted: 100,
      chatTurns: 10,
      prSummaryCount: 5,
    });
    // completion: 100 min, chat: 50 min, pr: 50 min → 200 min = 3.333h gross
    // adjusted: 3.333 * 0.7 = 2.333h → value = 175
    expect(r.grossHoursSaved).toBeCloseTo(3.3333, 3);
    expect(r.adjustedHoursSaved).toBeCloseTo(2.3333, 3);
    expect(r.estimatedValue).toBeCloseTo(175, 0);
    expect(r.totalCopilotCost).toBe(19);
    expect(r.roiPercentage).toBeGreaterThan(700);
  });

  it('respects custom assumptions', () => {
    const r = calculateCopilotRoi({
      assignedSeats: 1,
      activeSeats: 1,
      aiCreditsUsed: 0,
      linesAccepted: 60,
      chatTurns: 0,
      prSummaryCount: 0,
      assumptions: {
        minutesSavedPerAcceptedLine: 2,
        qualityAdjustmentFactor: 1,
        avgEngineerHourlyRate: 100,
        seatPriceUsd: 19,
      },
    });
    expect(r.grossHoursSaved).toBe(2);
    expect(r.estimatedValue).toBe(200);
  });

  it('returns zero ROI percentage when cost is zero', () => {
    const r = calculateCopilotRoi({
      assignedSeats: 0,
      activeSeats: 0,
      aiCreditsUsed: 0,
      linesAccepted: 10,
      chatTurns: 0,
      prSummaryCount: 0,
    });
    expect(r.totalCopilotCost).toBe(0);
    expect(r.roiPercentage).toBe(0);
  });
});
