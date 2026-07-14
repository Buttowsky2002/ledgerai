import type { PortalCsvFormat } from './csv-format';

/** Providers supported by manual billing CSV import. */
export const PORTAL_BILLING_PROVIDERS = [
  'anthropic',
  'cursor',
  'openai',
  'google',
  'azure',
] as const;

export type PortalBillingProvider = (typeof PORTAL_BILLING_PROVIDERS)[number];

const DISPLAY_NAMES: Record<PortalBillingProvider, string> = {
  anthropic: 'Anthropic',
  cursor: 'Cursor',
  openai: 'OpenAI',
  google: 'Google',
  azure: 'Azure OpenAI',
};

export function isPortalBillingProvider(value: string): value is PortalBillingProvider {
  return (PORTAL_BILLING_PROVIDERS as readonly string[]).includes(value);
}

export function platformDisplayName(provider: string): string {
  if (isPortalBillingProvider(provider)) return DISPLAY_NAMES[provider];
  return provider;
}

/** Infer billing provider from detected CSV shape — null when the user must choose. */
export function providerForFormat(format: PortalCsvFormat): PortalBillingProvider | null {
  switch (format) {
    case 'anthropic_spend_report':
    case 'anthropic_console':
      return 'anthropic';
    case 'cursor_analytics':
      return 'cursor';
    default:
      return null;
  }
}

export function resolvePortalProvider(
  format: PortalCsvFormat,
  override?: string,
): PortalBillingProvider | null {
  const picked = override?.trim().toLowerCase();
  if (picked && isPortalBillingProvider(picked)) return picked;
  return providerForFormat(format);
}
