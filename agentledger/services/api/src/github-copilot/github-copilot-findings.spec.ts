import { generateCopilotFindings } from './github-copilot-findings';
import { DEFAULT_ROI_ASSUMPTIONS } from './github-copilot.types';

describe('generateCopilotFindings', () => {
  const now = new Date('2024-06-15T12:00:00Z');

  it('flags seats inactive 30+ days with waste estimate', () => {
    const findings = generateCopilotFindings({
      seats: [
        {
          githubLogin: 'alice',
          isActive: true,
          lastActivityAt: new Date('2024-05-01T00:00:00Z'),
          monthlySeatCost: 19,
        },
        {
          githubLogin: 'bob',
          isActive: true,
          lastActivityAt: new Date('2024-05-10T00:00:00Z'),
          monthlySeatCost: 19,
        },
      ],
      userUsage: [],
      teamRoi: [],
      assumptions: DEFAULT_ROI_ASSUMPTIONS,
      includedCreditsPerUser: 1900,
      now,
    });
    const f30 = findings.find((f) => f.id === 'seats-inactive-30d');
    expect(f30).toBeDefined();
    expect(f30?.message).toContain('30 days');
    expect(f30?.estimatedImpactUsd).toBe(38);
  });

  it('flags users near credit allocation', () => {
    const findings = generateCopilotFindings({
      seats: [],
      userUsage: [
        { githubLogin: 'alice', teamSlug: 'eng', aiCreditsUsed: 1800, linesAccepted: 100, acceptancesCount: 50 },
      ],
      teamRoi: [],
      assumptions: DEFAULT_ROI_ASSUMPTIONS,
      includedCreditsPerUser: 1900,
      now,
    });
    expect(findings.some((f) => f.id === 'near-credit-allocation')).toBe(true);
  });
});
