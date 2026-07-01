/** Cap for member ROI multiple display — avoids misleading 1000%+ style percentages. */
export const COPILOT_ROI_MULTIPLE_CAP = 10;

export function copilotNetValueUsd(valueCreated: number, allocatedCost: number): number {
  return valueCreated - allocatedCost;
}

/** Value ÷ cost; null when cost is zero. */
export function copilotRoiMultiple(valueCreated: number, allocatedCost: number): number | null {
  if (allocatedCost <= 0) return null;
  return valueCreated / allocatedCost;
}

/** e.g. `3.2×`, `0.4×`, or `>10×` when above cap. */
export function formatCopilotRoiMultiple(valueCreated: number, allocatedCost: number): string {
  const multiple = copilotRoiMultiple(valueCreated, allocatedCost);
  if (multiple == null) return '—';
  if (multiple >= COPILOT_ROI_MULTIPLE_CAP) return `>${COPILOT_ROI_MULTIPLE_CAP}×`;
  return `${multiple.toFixed(1)}×`;
}
