'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { TablePager } from '@/components/TablePager';
import { UtilizationStatusBadge } from '@/components/UtilizationStatusBadge';
import { VendorSpendCell } from '@/components/VendorSpendCell';
import { DataTable, usd } from '@/components/ui';
import { paginateItems, USERS_PAGE_SIZE } from '@/lib/table-pager';
import type { VendorSpendSlice } from '@/lib/vendor-spend';

type UserRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
  vendor_spend?: Record<string, VendorSpendSlice>;
  status?: 'active' | 'low_use' | 'inactive';
  has_seat?: boolean;
  seat_provider?: string;
};

export function VendorUsersTable({
  vendorId,
  from,
  to,
  users,
}: {
  vendorId: string;
  from: string;
  to: string;
  users: UserRow[];
}) {
  const vendorUsers = useMemo(
    () =>
      users
        .filter(
          (u) =>
            (u.vendor_spend?.[vendorId]?.total_usd ?? 0) > 0 ||
            (u.has_seat && u.seat_provider === vendorId),
        )
        .sort(
          (a, b) =>
            (b.vendor_spend?.[vendorId]?.total_usd ?? 0) -
            (a.vendor_spend?.[vendorId]?.total_usd ?? 0),
        ),
    [users, vendorId],
  );

  const [page, setPage] = useState(1);
  const slice = useMemo(
    () => paginateItems(vendorUsers, page, USERS_PAGE_SIZE),
    [vendorUsers, page],
  );

  if (vendorUsers.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted">No user spend for this vendor in range.</p>
    );
  }

  return (
    <>
      <DataTable
        columns={[
          { key: 'user', label: 'User' },
          { key: 'email', label: 'Email' },
          { key: 'status', label: 'Status' },
          { key: 'spend', label: 'Spend', align: 'right' },
        ]}
        rows={slice.items.map((u) => ({
          user: (
            <Link
              href={`/users/${encodeURIComponent(u.user_id)}?from=${from}&to=${to}`}
              className="text-accent hover:underline"
            >
              {u.display_name}
            </Link>
          ),
          email: u.email ?? '—',
          status: u.status ? <UtilizationStatusBadge status={u.status} /> : '—',
          spend: <VendorSpendCell slice={u.vendor_spend?.[vendorId]} />,
        }))}
        footerRows={[
          {
            user: <span className="text-xs uppercase tracking-wide text-muted">Total</span>,
            email: '',
            status: '',
            spend: usd(
              vendorUsers.reduce((s, u) => s + (u.vendor_spend?.[vendorId]?.total_usd ?? 0), 0),
            ),
          },
        ]}
      />
      <TablePager slice={slice} onPageChange={setPage} label="users" />
    </>
  );
}
