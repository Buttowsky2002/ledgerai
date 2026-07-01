/** Declares what each connector preset can pull from a provider API. */
export interface ConnectorCapabilities {
  supportsUsage: boolean;
  supportsBilling: boolean;
  supportsUsers: boolean;
  supportsProjects: boolean;
  supportsWorkspaces: boolean;
  supportsApiKeys: boolean;
  supportsUserLevelCost: boolean;
  supportsModelLevelUsage: boolean;
}

export type AuxiliaryFetchStep = 'users' | 'projects' | 'api_keys' | 'workspaces';

/** Optional provider endpoint used during sync to enrich attribution context. */
export interface AuxiliaryFetchConfig {
  step: AuxiliaryFetchStep;
  path: string;
  method?: 'GET' | 'POST';
  itemsPath?: string;
  idField: string;
  nameField?: string;
  emailField?: string;
}

export const DEFAULT_CAPABILITIES: ConnectorCapabilities = {
  supportsUsage: true,
  supportsBilling: false,
  supportsUsers: false,
  supportsProjects: false,
  supportsWorkspaces: false,
  supportsApiKeys: false,
  supportsUserLevelCost: false,
  supportsModelLevelUsage: true,
};

export const PRESET_CAPABILITIES: Record<string, ConnectorCapabilities> = {
  'openai-usage': {
    supportsUsage: true,
    supportsBilling: true,
    supportsUsers: true,
    supportsProjects: true,
    supportsWorkspaces: false,
    supportsApiKeys: true,
    supportsUserLevelCost: false,
    supportsModelLevelUsage: true,
  },
  'anthropic-usage': {
    supportsUsage: true,
    supportsBilling: true,
    supportsUsers: true,
    supportsProjects: false,
    supportsWorkspaces: true,
    supportsApiKeys: false,
    supportsUserLevelCost: true,
    supportsModelLevelUsage: true,
  },
  'cursor-usage': {
    supportsUsage: true,
    supportsBilling: true,
    supportsUsers: false,
    supportsProjects: false,
    supportsWorkspaces: false,
    supportsApiKeys: false,
    supportsUserLevelCost: true,
    supportsModelLevelUsage: true,
  },
  'github-copilot-business': {
    supportsUsage: true,
    supportsBilling: true,
    supportsUsers: true,
    supportsProjects: false,
    supportsWorkspaces: false,
    supportsApiKeys: false,
    supportsUserLevelCost: true,
    supportsModelLevelUsage: true,
  },
  'generic-rest-spend': DEFAULT_CAPABILITIES,
  'generic-rest-usage': DEFAULT_CAPABILITIES,
};

export const PRESET_AUXILIARY_FETCHES: Record<string, AuxiliaryFetchConfig[]> = {
  'openai-usage': [
    {
      step: 'users',
      path: '/v1/organization/users',
      itemsPath: 'data',
      idField: 'id',
      emailField: 'email',
      nameField: 'name',
    },
    {
      step: 'projects',
      path: '/v1/organization/projects',
      itemsPath: 'data',
      idField: 'id',
      nameField: 'name',
    },
    {
      step: 'api_keys',
      path: '/v1/organization/admin_api_keys',
      itemsPath: 'data',
      idField: 'id',
      nameField: 'name',
    },
  ],
};

export function resolveCapabilities(
  presetId: string | undefined,
  definitionCapabilities?: ConnectorCapabilities,
): ConnectorCapabilities {
  if (definitionCapabilities) return definitionCapabilities;
  if (presetId && PRESET_CAPABILITIES[presetId]) return PRESET_CAPABILITIES[presetId];
  return DEFAULT_CAPABILITIES;
}

export function attributionWarning(capabilities: ConnectorCapabilities): string | undefined {
  if (capabilities.supportsUserLevelCost) return undefined;
  return (
    'This provider does not expose direct user-level cost data. BadgerIQ is attributing spend ' +
    'using project, workspace, or API key mappings.'
  );
}
