'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const AXIS = '#9aa0ad';
const GRID = '#2a2e37';
const ACCENT = '#d4af37';
const TOOLTIP = {
  background: '#1b1e24',
  border: '1px solid #2a2e37',
  borderRadius: 8,
  fontSize: 12,
  boxShadow: '0 8px 24px -12px rgba(0,0,0,0.7)',
};

type Row = Record<string, unknown>;

/** Whether category labels need angled X-axis ticks (many bars or long names). */
function needsAngledCategoryLabels(labels: string[]): boolean {
  return labels.length > 4 || labels.some((l) => l.length > 10);
}

function categoryLabels(data: Row[], xKey: string): string[] {
  return data.map((r) => String(r[xKey] ?? ''));
}

/** Filled area chart — the headline trend treatment (gradient fade to the axis). */
export function AreaChartClient({ data, xKey, yKey }: { data: Row[]; xKey: string; yKey: string }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
            <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={52} />
        <Tooltip contentStyle={TOOLTIP} cursor={{ stroke: GRID }} />
        <Area type="monotone" dataKey={yKey} stroke={ACCENT} strokeWidth={2} fill="url(#areaFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Axis-less micro line for KPI cards. */
export function Sparkline({ data, yKey, height = 40 }: { data: Row[]; yKey: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <Line type="monotone" dataKey={yKey} stroke={ACCENT} strokeWidth={1.75} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function LineChartClient({ data, xKey, yKey }: { data: Row[]; xKey: string; yKey: string }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} stroke={AXIS} fontSize={12} tickLine={false} />
        <YAxis stroke={AXIS} fontSize={12} tickLine={false} width={48} />
        <Tooltip contentStyle={TOOLTIP} />
        <Line type="monotone" dataKey={yKey} stroke={ACCENT} dot={false} strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function BarChartClient({ data, xKey, yKey }: { data: Row[]; xKey: string; yKey: string }) {
  const labels = categoryLabels(data, xKey);
  const angled = needsAngledCategoryLabels(labels);
  const bottom = angled ? 76 : 8;
  const chartHeight = angled ? 300 : 260;

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey={xKey}
          stroke={AXIS}
          fontSize={10}
          tickLine={false}
          axisLine={false}
          interval={0}
          angle={angled ? -42 : 0}
          textAnchor={angled ? 'end' : 'middle'}
          height={angled ? 68 : 24}
          dy={angled ? 4 : 0}
        />
        <YAxis stroke={AXIS} fontSize={12} tickLine={false} axisLine={false} width={48} />
        <Tooltip contentStyle={TOOLTIP} cursor={{ fill: '#ffffff10' }} />
        <Bar dataKey={yKey} fill={ACCENT} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const PIE_COLORS = ['#d4af37', '#3ecf8e', '#e0a93c', '#f06a6a', '#a78bfa', '#22d3ee', '#fb923c'];

/** Donut chart for platform/model spend breakdown. */
export function PieChartClient({
  data,
  nameKey,
  valueKey,
}: {
  data: Row[];
  nameKey: string;
  valueKey: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          dataKey={valueKey}
          nameKey={nameKey}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={100}
          paddingAngle={2}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
