import { GitHubCopilotSyncService } from './github-copilot-sync.service';
import { GitHubCopilotClient } from './github-copilot-client';

jest.mock('./github-copilot-client');

describe('GitHubCopilotSyncService integration', () => {
  const mockPrisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  };
  const mockSecrets = { resolveSecret: jest.fn(async () => 'ghp_test') };
  const mockTx: Record<string, Record<string, jest.Mock>> = {
    aiProviderConnection: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    connector: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    githubCopilotSeat: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    githubCopilotMember: { upsert: jest.fn() },
    githubCopilotMemberTeam: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    githubCopilotUsageDaily: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    githubCopilotRoiDaily: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    githubCopilotMemberSpendDaily: { upsert: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (GitHubCopilotClient as jest.Mock).mockImplementation(() => ({
      fetchBilling: jest.fn(async () => ({})),
      fetchAllSeats: jest.fn(async () => [
        {
          orgSlug: 'acme',
          githubUserId: 1,
          githubLogin: 'alice',
          isActive: true,
          monthlySeatCost: 19,
          rawPayload: {},
        },
      ]),
      fetchMembersDetailed: jest.fn(async () => [
        { githubUserId: 1, githubLogin: 'alice', isOrgMember: true },
      ]),
      fetchTeams: jest.fn(async () => [{ slug: 'eng', name: 'Engineering' }]),
      fetchTeamMembers: jest.fn(async () => [{ id: 1, login: 'alice' }]),
      fetchOrg28DayUsage: jest.fn(async () => []),
      fetchUsers28DayUsage: jest.fn(async () => [
        {
          usageDate: '2024-06-01',
          githubLogin: 'alice',
          teamSlug: 'eng',
          editor: 'vscode',
          language: 'typescript',
          model: 'gpt-4',
          feature: 'completion',
          suggestionsCount: 10,
          acceptancesCount: 5,
          linesSuggested: 20,
          linesAccepted: 12,
          activeUsers: 1,
          engagedUsers: 1,
          chatTurns: 3,
          prSummaryCount: 1,
          aiCreditsUsed: 50,
          rawPayload: {},
        },
      ]),
      fetchUsers1DayUsage: jest.fn(async () => []),
    }));
  });

  it('syncs seats, members, teams, usage, and member spend with idempotent upserts', async () => {
    mockTx.aiProviderConnection.findUnique.mockResolvedValue({
      connectionId: 'conn-1',
      connectorId: 'c-1',
      orgSlug: 'acme',
      roiAssumptions: {},
    });
    mockTx.connector.findUnique.mockResolvedValue({ secretRef: 'secret-1' });
    mockTx.githubCopilotSeat.findMany.mockResolvedValue([
      { assigningTeamSlug: 'eng', isActive: true, lastActivityAt: new Date() },
    ]);

    const svc = new GitHubCopilotSyncService(
      mockPrisma as never,
      mockSecrets as never,
    );
    const result = await svc.syncConnection('conn-1', 'tenant-1');

    expect(result.ok).toBe(true);
    expect(result.seatsImported).toBe(1);
    expect(result.membersImported).toBe(1);
    expect(result.teamLinksImported).toBe(1);
    expect(result.usageRowsImported).toBe(1);
    expect(mockTx.githubCopilotSeat.upsert).toHaveBeenCalled();
    expect(mockTx.githubCopilotMember.upsert).toHaveBeenCalled();
    expect(mockTx.githubCopilotMemberTeam.upsert).toHaveBeenCalled();
    expect(mockTx.githubCopilotUsageDaily.upsert).toHaveBeenCalled();
    expect(mockTx.connector.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'connected' }) }),
    );
  });
});
