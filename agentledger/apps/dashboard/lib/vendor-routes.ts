/** Map fixed-cost / analytics vendor id to llm_calls provider slugs. */
export function vendorToProviders(vendor: string): string[] {
  const v = vendor.trim().toLowerCase();
  const map: Record<string, string[]> = {
    github: ['github_copilot', 'github_copilot_business', 'GitHub Copilot'],
    cursor: ['cursor'],
    anthropic: ['anthropic'],
    openai: ['openai'],
    google: ['google', 'vertex'],
    azure: ['azure', 'azure_openai'],
    aws: ['bedrock', 'aws'],
    lovable: ['lovable'],
  };
  return map[v] ?? [v];
}

export function providerMatchesVendor(provider: string, vendor: string): boolean {
  const p = provider.trim().toLowerCase();
  return vendorToProviders(vendor).some((slug) => p === slug.toLowerCase() || p.includes(slug.toLowerCase()));
}

export function vendorDetailHref(vendor: string, from: string, to: string): string {
  return `/vendors/${encodeURIComponent(vendor)}?from=${from}&to=${to}`;
}
