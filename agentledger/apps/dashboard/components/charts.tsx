'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const AXIS = '#8b95a5';
const GRID = '#1e2530';
const TOOLTIP = { background: '#11151d', border: '1px solid #1e2530', borderRadius: 6, fontSize: 12 };

type Row = Record<string, unknown>;

export function LineChartClient({ data, xKey, yKey }: { data: Row[]; xKey: string; yKey: string }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} stroke={AXIS} fontSize={12} tickLine={false} />
        <YAxis stroke={AXIS} fontSize={12} tickLine={false} width={48} />
        <Tooltip contentStyle={TOOLTIP} />
        <Line type="monotone" dataKey={yKey} stroke="#4f8cff" dot={false} strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function BarChartClient({ data, xKey, yKey }: { data: Row[]; xKey: string; yKey: string }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} stroke={AXIS} fontSize={12} tickLine={false} />
        <YAxis stroke={AXIS} fontSize={12} tickLine={false} width={48} />
        <Tooltip contentStyle={TOOLTIP} cursor={{ fill: '#ffffff10' }} />
        <Bar dataKey={yKey} fill="#4f8cff" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
