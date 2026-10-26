import { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { Device } from "@shared/schema";

interface DeviceChartProps {
  devices: Device[];
}

const STATUS_META = [
  { key: "connected", label: "Connected", color: "hsl(158, 64%, 52%)" },
  { key: "unstable", label: "Unstable", color: "hsl(43, 96%, 56%)" },
  { key: "disconnected", label: "Offline", color: "hsl(240, 5%, 65%)" },
] as const;

const statusConfig = {
  connected: { label: "Connected", color: "hsl(158, 64%, 52%)" },
  unstable: { label: "Unstable", color: "hsl(43, 96%, 56%)" },
  disconnected: { label: "Offline", color: "hsl(240, 5%, 65%)" },
} satisfies ChartConfig;

const typeConfig = {
  desktop: { label: "Desktop", color: "hsl(264, 83%, 57%)" },
  mobile: { label: "Mobile", color: "hsl(199, 89%, 48%)" },
  server: { label: "Server", color: "hsl(158, 64%, 52%)" },
  other: { label: "Other", color: "hsl(240, 5%, 65%)" },
} satisfies ChartConfig;

const TYPE_ORDER = ["desktop", "mobile", "server", "other"] as const;

export function DeviceChart({ devices }: DeviceChartProps) {
  const statusData = useMemo(
    () =>
      STATUS_META.map((s) => ({
        name: s.label,
        key: s.key,
        value: devices.filter((d) => d.status === s.key).length,
        fill: `var(--color-${s.key})`,
      })),
    [devices],
  );

  const typeData = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of devices) {
      const t = TYPE_ORDER.includes(d.deviceType as (typeof TYPE_ORDER)[number])
        ? d.deviceType
        : "other";
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return TYPE_ORDER.map((t) => ({
      type: typeConfig[t].label,
      count: counts.get(t) ?? 0,
      fill: `var(--color-${t})`,
    }));
  }, [devices]);

  if (devices.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-muted-foreground">
            No devices match the current search.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Devices by status</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={statusConfig} className="h-[240px] w-full">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie
                data={statusData}
                dataKey="value"
                nameKey="name"
                innerRadius={55}
                outerRadius={85}
                strokeWidth={2}
              >
                {statusData.map((entry) => (
                  <Cell key={entry.key} fill={entry.fill} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <div className="mt-2 flex items-center justify-center gap-4 text-xs">
            {STATUS_META.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                {s.label}:{" "}
                {devices.filter((d) => d.status === s.key).length}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Devices by type</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={typeConfig} className="h-[240px] w-full">
            <BarChart data={typeData} margin={{ left: -20 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="type"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={12}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                fontSize={12}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {typeData.map((entry) => (
                  <Cell key={entry.type} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
