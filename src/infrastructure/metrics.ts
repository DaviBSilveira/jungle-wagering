import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

@Injectable()
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { counts: number[]; sum: number; count: number }>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, labels: Record<string, string>, value: number): void {
    const key = metricKey(name, labels);
    const current = this.histograms.get(key) ?? { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
    current.sum += value;
    current.count += 1;
    BUCKETS.forEach((bucket, index) => {
      if (value <= bucket) current.counts[index] += 1;
    });
    this.histograms.set(key, current);
  }

  async render(orm: MikroORM): Promise<string> {
    const lines: string[] = [];
    for (const [key, value] of this.counters) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, hist] of this.histograms) {
      const name = key.split('{')[0];
      const labels = key.endsWith('}') ? key.slice(name.length, -1) : '';
      BUCKETS.forEach((bucket, index) => {
        const extra = labels ? `${labels},le="${bucket}"` : `{le="${bucket}"`;
        lines.push(`${name}_bucket${extra}} ${hist.counts[index]}`);
      });
      const suffix = labels ? `${labels}}` : '';
      lines.push(`${name}_sum${suffix} ${hist.sum}`);
      lines.push(`${name}_count${suffix} ${hist.count}`);
    }
    let lag = 0;
    try {
      const rows = await orm.em.fork().getConnection().execute<Array<{ lag: string | null }>>(
        `select extract(epoch from (now() - min(occurred_at)))::text as lag
         from outbox_messages
         where published_at is null`,
      );
      lag = rows[0]?.lag ? Number(rows[0].lag) : 0;
    } catch {
      lag = -1;
    }
    lines.push(`outbox_lag_seconds ${Number.isFinite(lag) ? lag : -1}`);
    return `${lines.join('\n')}\n`;
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return name;
  const body = keys.map((key) => `${key}="${labels[key]}"`).join(',');
  return `${name}{${body}}`;
}
