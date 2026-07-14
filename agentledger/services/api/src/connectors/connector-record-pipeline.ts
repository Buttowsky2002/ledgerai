import { computeDedupeHash } from './engine/dedupe';
import { enrichRecordCost } from './cost-estimator';
import { enrichCursorBilling } from './cursor-billing';
import { computeMeteredCostUsd } from './metered-cost';
import {
  applyAttributionToMetrics,
  isUnmapped,
  type AttributionMapping,
  type ProviderEntity,
} from './attribution/attribution-resolver';
import type { ConnectorDefinition } from './types/connector-definition';
import type { NormalizedRecord } from './types/normalized-record';
import type { NormalizedUsageMetrics } from './types/normalized-usage-event';

/** Enrich cost, recompute dedupe hash, and apply attribution before import. */
export function finalizeConnectorRecord(
  rec: NormalizedRecord,
  definition: ConnectorDefinition,
  mappings: AttributionMapping[],
  entities: ProviderEntity[],
): { record: NormalizedRecord; unmapped: boolean } {
  const enriched = enrichCursorBilling(enrichRecordCost(rec.metrics as NormalizedUsageMetrics) as Record<string, unknown>);
  enriched.metered_cost_usd = computeMeteredCostUsd(enriched);
  const dedupeHash =
    rec.record_type === definition.destinationRecordType
      ? computeDedupeHash(definition.dedupe, enriched, rec.lineage.external_record_id)
      : rec.lineage.dedupe_hash;
  const metrics = applyAttributionToMetrics(enriched, mappings, entities);
  const attribution = {
    userId: String(metrics.user_id ?? ''),
    method: String(metrics.attribution_method ?? ''),
  };
  return {
    record: {
      ...rec,
      metrics,
      lineage: { ...rec.lineage, dedupe_hash: dedupeHash },
    },
    unmapped: isUnmapped(attribution),
  };
}

export function finalizeConnectorRecords(
  records: NormalizedRecord[],
  definition: ConnectorDefinition,
  mappings: AttributionMapping[],
  entities: ProviderEntity[],
): { records: NormalizedRecord[]; unmappedRecords: number } {
  let unmappedRecords = 0;
  const finalized = records.map((rec) => {
    const { record, unmapped } = finalizeConnectorRecord(rec, definition, mappings, entities);
    if (unmapped) unmappedRecords++;
    return record;
  });
  return { records: finalized, unmappedRecords };
}
