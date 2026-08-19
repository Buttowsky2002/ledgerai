/** Invoice-relevant user spend — metered + seat + Cursor overage, not included usage value. */
export function userBillableSpendUsd(row: {
  cost_usd?: number | string;
  metered_usd?: number | string;
  seat_usd?: number | string;
  cursor_on_demand_usd?: number | string;
}): number {
  const cost = Number(row.cost_usd ?? 0);
  const metered = Number(row.metered_usd ?? 0);
  const seat = Number(row.seat_usd ?? 0);
  const onDemand = Number(row.cursor_on_demand_usd ?? 0);
  const meteredNonCursor = Math.max(0, metered - onDemand);
  return Math.max(cost, meteredNonCursor + onDemand + seat);
}

/** Headline spend for accounting — billable + Cursor included usage value. */
export function userTotalSpendUsd(row: {
  cost_usd?: number | string;
  total_spend_usd?: number | string;
  metered_usd?: number | string;
  seat_usd?: number | string;
  cursor_on_demand_usd?: number | string;
  cursor_included_usd?: number | string;
}): number {
  const billable =
    row.metered_usd != null || row.cost_usd != null
      ? userBillableSpendUsd(row)
      : Number(row.total_spend_usd ?? 0);
  return billable + Number(row.cursor_included_usd ?? 0);
}
