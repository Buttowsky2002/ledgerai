export type Connector = {
  connectorId: string;
  displayName: string;
  provider: string;
  category: string;
  status: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastErrorMessageSafe?: string | null;
  syncStatus?: {
    lastSyncAt: string | null;
    lastSyncStatus: string;
    recordsImported: number;
    usersDetected: number;
    unmappedRecords: number;
    spendSyncedUsd: number;
    errorMessage?: string | null;
  };
  capabilities?: {
    supportsUserLevelCost: boolean;
  };
  attributionWarning?: string;
};

export type Preset = {
  definitionId?: string;
  name: string;
  provider: string;
  category: string;
  builtIn?: boolean;
  definitionJson?: {
    baseUrl?: string;
    authType?: string;
    category?: string;
    endpoints?: { path?: string; method?: string }[];
  };
};

export type PreviewResult = {
  ok: boolean;
  warning?: string;
  rawResponse: unknown;
  normalizedPreview: Record<string, unknown>[];
  suggestedMappings: { source: string; target: string; confidence: number }[];
  errors: { recordRef: string; code: string; message: string }[];
};
