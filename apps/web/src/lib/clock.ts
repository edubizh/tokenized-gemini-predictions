// Offset between the cluster clock and the local clock. On-chain deadlines (order expiry,
// redemption opening) count down on the cluster clock; market close uses the wall clock.

export interface Clock {
  /** Record that the cluster clock read `chainTimeSecs` when the local clock read `localNowMs`. */
  sync(chainTimeSecs: number, localNowMs?: number): void;
  synced(): boolean;
  /** Cluster time minus local time, milliseconds. */
  offsetMs(): number;
  /** Cluster clock now, unix milliseconds. */
  chainNowMs(localNowMs?: number): number;
  /** Milliseconds until a deadline given in cluster unix seconds. */
  msUntilChain(deadlineSecs: number, localNowMs?: number): number;
}

export function createClock(): Clock {
  let offset = 0;
  let isSynced = false;
  const chainNowMs = (localNowMs = Date.now()) => localNowMs + offset;
  return {
    sync(chainTimeSecs, localNowMs = Date.now()) {
      if (!Number.isFinite(chainTimeSecs) || chainTimeSecs <= 0) return;
      offset = chainTimeSecs * 1000 - localNowMs;
      isSynced = true;
    },
    synced: () => isSynced,
    offsetMs: () => offset,
    chainNowMs,
    msUntilChain: (deadlineSecs, localNowMs) => deadlineSecs * 1000 - chainNowMs(localNowMs),
  };
}

/** The app's one clock, aligned from the relayer's `/health`, or from the cluster itself while the relayer is away. */
export const clock = createClock();

/** The cluster's Clock account. */
export const CLOCK_SYSVAR_ADDRESS = "SysvarC1ock11111111111111111111111111111111";

/** The unix timestamp held in the Clock account's data: a little-endian i64 after four 8-byte fields. */
export function clusterTimeFromSysvar(data: Uint8Array): number {
  if (data.byteLength < 40) throw new Error("The cluster clock could not be read.");
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(32, true));
}
