import type { ApiHistory } from "@outcome/relayer/api-types";
import { formatClock } from "@/features/markets/wording";
import { formatCents } from "@/lib/format";
import { chartLine, chartSummary } from "./chart";
import { formatWhen } from "./when";
import styles from "./Event.module.css";

const WIDTH = 600;
const HEIGHT = 160;
const GRID = [7_500, 5_000, 2_500] as const;

/**
 * The Yes price of one contract over time, on a fixed 0 to 100 cent scale with three quiet
 * gridlines and the last price marked. The points are the history and the newest trade (see
 * `priceSeries`). The drawing is for the eye; the caption under it says the last, lowest and
 * highest price in words.
 */
export function PriceChart({ points = [], loading }: { points?: ApiHistory["points"]; loading: boolean }) {
  const line = chartLine(points, WIDTH, HEIGHT);
  const summary = chartSummary(points);
  const first = points[0];
  const final = points.at(-1);
  // A day or more of history is told by date and time, a shorter one by the time alone.
  const when = (atMs: number) => (first && final && final.at - first.at >= 86_400_000 ? formatWhen(atMs) : formatClock(atMs));

  if (!line || !summary || !first || !final) {
    return (
      <div className={styles.chartEmpty} data-testid="price-chart">
        <p>{loading ? "Loading the price history." : "No trades yet. The price of Yes is drawn here once the contract trades."}</p>
      </div>
    );
  }

  return (
    <figure className={styles.chart} data-testid="price-chart">
      <div className={styles.plot}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          {GRID.map((px) => (
            <line key={px} x1="0" x2={WIDTH} y1={HEIGHT * (1 - px / 10_000)} y2={HEIGHT * (1 - px / 10_000)} className={styles.gridline} />
          ))}
          <path d={line.d} className={styles.trace} />
        </svg>
        {GRID.map((px) => (
          <span key={px} className={styles.gridLabel} style={{ top: `${100 - px / 100}%` }} aria-hidden="true">
            {formatCents(BigInt(px))}
          </span>
        ))}
        <span className={styles.lastMark} style={{ left: `${(line.last.x / WIDTH) * 100}%`, top: `${(line.last.y / HEIGHT) * 100}%` }} aria-hidden="true" />
      </div>
      <div className={styles.axis} aria-hidden="true">
        <span>{when(first.at)}</span>
        <span>{when(final.at)}</span>
      </div>
      <figcaption className={styles.caption}>
        {`Yes last traded at ${formatCents(summary.last)}; low ${formatCents(summary.low)}, high ${formatCents(summary.high)} since ${when(first.at)}.`}
      </figcaption>
    </figure>
  );
}
