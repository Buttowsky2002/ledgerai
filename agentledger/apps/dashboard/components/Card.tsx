'use client';

import { ReactNode } from 'react';
import { CollapsibleDetails } from './CollapsibleDetails';

export function Card({
  title,
  subtitle,
  actions,
  children,
  /** When true (default for titled cards), header toggles body open/closed. */
  collapsible,
  defaultOpen = true,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const canCollapse = collapsible ?? Boolean(title);
  const header = (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
      <div className="min-w-0">
        {title && (
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-200">{title}</h2>
        )}
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {actions ? (
          <div
            className="flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {actions}
          </div>
        ) : null}
        {canCollapse && (
          <span
            aria-hidden
            className="text-[10px] text-muted transition-transform duration-150 group-open:rotate-180"
          >
            ▼
          </span>
        )}
      </div>
    </div>
  );

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-edge bg-panel shadow-card">
      {canCollapse && (title || actions) ? (
        <CollapsibleDetails defaultOpen={defaultOpen} className="group" summary={header}>
          <div className="p-5">{children}</div>
        </CollapsibleDetails>
      ) : (
        <>
          {(title || actions) && (
            <div className="flex items-center justify-between gap-4 border-b border-edge/70 px-5 py-3.5">
              {header}
            </div>
          )}
          <div className="p-5">{children}</div>
        </>
      )}
    </section>
  );
}
