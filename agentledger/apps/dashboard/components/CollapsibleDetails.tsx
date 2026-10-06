'use client';

import { useState, type ReactNode } from 'react';

/** Controlled `<details>` that starts open/closed and still toggles. */
export function CollapsibleDetails({
  defaultOpen = true,
  className,
  summaryClassName,
  summary,
  children,
}: {
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className={className ?? 'group'}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary
        className={
          summaryClassName ??
          'flex cursor-pointer list-none items-center border-b border-edge/70 px-5 py-3.5 marker:content-none [&::-webkit-details-marker]:hidden'
        }
      >
        {summary}
      </summary>
      {children}
    </details>
  );
}
