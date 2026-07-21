import { calculateCursorDailyRoi } from './cursor-roi';

describe('calculateCursorDailyRoi', () => {
  it('values accepted lines, tabs, and composer/chat activity', () => {
    const r = calculateCursorDailyRoi({
      linesAccepted: 100,
      linesAdded: 200,
      linesDeleted: 10,
      linesCommitted: 200,
      tabsAccepted: 50,
      composerRequests: 5,
      chatRequests: 10,
      assumptions: { qualityAdjustmentFactor: 1, avgEngineerHourlyRate: 100 },
    });
    // 100*0.5 + 50*0.25 + 5*3 + 10*2 = 50 + 12.5 + 15 + 20 = 97.5 min → 1.625 hr → $162.50
    expect(r.estimatedValueUsd).toBeCloseTo(162.5, 1);
    expect(r.linesCommitted).toBe(200);
  });
});
