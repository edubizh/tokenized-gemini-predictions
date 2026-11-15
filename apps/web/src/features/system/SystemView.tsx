"use client";

import type { ReactNode } from "react";
import type { ApiHealth, ApiMarket, ApiStatus } from "@outcome/relayer/api-types";
import type { Venue } from "@/components/shell/network";
import { Badge } from "@/components/ui/Badge";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Fact, Facts } from "@/components/ui/Facts";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { marketTitle } from "@/features/markets/wording";
import { formatContracts, shortAddress } from "@/lib/format";
import styles from "./System.module.css";

/** The deployment's accounts. Null where nothing has been deployed yet. */
export interface SystemAddresses {
  program: string;
  config: string | null;
  stableMint: string | null;
  treasury: string | null;
}

export interface SystemViewProps {
  /** The venue the relayer trades on, as last reported. */
  venue: Venue;
  cluster: "devnet" | "localnet";
  /** Null before the relayer's first answer and while it cannot be reached. */
  health: ApiHealth | null;
  offline: boolean;
  /** Null until `/status` has answered, and while the relayer cannot be reached. */
  status: ApiStatus | null;
  /** The markets the relayer lists, to name the reconciliation rows. */
  markets: readonly ApiMarket[];
  addresses: SystemAddresses;
  addressUrl(address: string): string;
}

const RECONCILE: Column[] = [
  { id: "market", header: "Market", primary: true, width: "minmax(10rem, 1fr)" },
  { id: "yes", header: "Yes supply", align: "right", width: "5.5rem" },
  { id: "no", header: "No supply", align: "right", width: "5.5rem" },
  { id: "venue", header: "Venue position", align: "right", width: "7rem" },
  { id: "flight", header: "In flight", align: "right", width: "4.5rem" },
  { id: "house", header: "Operator inventory", align: "right", width: "8.5rem" },
  { id: "check", header: "Check", width: "7rem" },
];

/** Signed units as contracts: Yes positive, No negative. */
function signedContracts(units: bigint): string {
  if (units === 0n) return formatContracts(0n);
  return units > 0n ? `+${formatContracts(units)}` : `−${formatContracts(-units)}`;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`} id={id} data-testid={`system-${id}`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

/** How the demo works, where it lives on Solana, whether the relayer is running, and whether its books balance. */
export function SystemView({ venue, cluster, health, offline, status, markets, addresses, addressUrl }: SystemViewProps) {
  const venueName = venue === "mock" ? "a simulated venue" : "the exchange sandbox";
  const loading = <Skeleton width="6rem" />;
  const address = (value: string | null, missing: string) => (value === null ? missing : <ExternalLink href={addressUrl(value)}>{shortAddress(value)}</ExternalLink>);
  const unbalanced = status?.markets.filter((row) => !row.balanced).length ?? 0;

  return (
    <div className={styles.page}>
      <Section id="mechanism" title="The mechanism">
        <Panel className={styles.prose}>
          <p>When you buy, the program on Solana holds your test dollars with your limit price and a deadline.</p>
          <p>{`A relayer places the matching order at ${venueName}. It fills at once at your limit or better, or not at all.`}</p>
          <p>Tokens are minted to your wallet only on a fill. Without one the hold comes back in full, and after the deadline you can reclaim it yourself.</p>
          <p>When a market settles, each winning token redeems for $1.00 in test dollars; the other side pays nothing.</p>
          <p>The bridge is custodial: the program cannot see the venue, so fills and results are reported by the relayer, which you trust. Everything here is test money with no value.</p>
        </Panel>
      </Section>

      <div className={styles.pair}>
        <Section id="status" title="Status">
          {offline ? (
            <Notice title="The relayer cannot be reached">Its status is shown again when it answers. Holds and tokens are on Solana and are not affected.</Notice>
          ) : (
            <Panel>
              <h3 className="sr-only">Status of the relayer and the venue</h3>
              <Facts>
                <Fact label="Relayer">{health ? "Answering" : loading}</Fact>
                <Fact label="Venue">{health ? `${venue === "mock" ? "Simulated venue" : "Exchange sandbox"}, ${health.venueConnected ? "connected" : "not connected"}` : loading}</Fact>
                <Fact label="Cluster">{cluster === "devnet" ? "Solana devnet" : "Local validator"}</Fact>
                <Fact label="New orders">{health ? (health.paused.place ? "Paused" : "Accepted") : loading}</Fact>
                <Fact label="Fills">{health ? (health.paused.fill ? "Paused" : "Running") : loading}</Fact>
                <Fact label="Funds to pay winners">{status ? (status.solvency.ok ? "Covered" : "Not covered") : loading}</Fact>
              </Facts>
            </Panel>
          )}
        </Section>

        <Section id="addresses" title="Addresses">
          <Panel>
            <h3 className="sr-only">Accounts of the deployment on Solana</h3>
            <Facts>
              <Fact label="Program">{address(addresses.program, "Not deployed yet")}</Fact>
              <Fact label="Config">{address(addresses.config, "Not deployed yet")}</Fact>
              <Fact label="Test-dollar mint">{address(addresses.stableMint, "Not deployed yet")}</Fact>
              <Fact label="Treasury">{address(addresses.treasury, "Not deployed yet")}</Fact>
              <Fact label="Relayer">{health ? address(health.relayer, "") : offline ? "Not known" : loading}</Fact>
            </Facts>
          </Panel>
        </Section>
      </div>

      <Section id="reconciliation" title="Reconciliation">
        <div className={styles.lead}>
          {status && status.markets.length > 0 && (
            <Badge tone={unbalanced === 0 ? "positive" : "negative"}>{unbalanced === 0 ? "Balanced" : `${unbalanced} not balanced`}</Badge>
          )}
          <p className={styles.note}>For each market that has not expired, the venue position must equal Yes supply less No supply, plus fills in flight and operator inventory. In contracts.</p>
        </div>
        {status === null ? (
          offline ? (
            <p className={styles.note}>Not known while the relayer cannot be reached.</p>
          ) : (
            <Skeleton width="100%" height="8rem" />
          )
        ) : status.markets.length === 0 ? (
          <Notice title="Nothing to reconcile">A market is listed here from its creation on Solana until its contract expires.</Notice>
        ) : (
          <div data-testid="reconciliation">
            <RowList label="Reconciliation by market" columns={RECONCILE}>
              {status.markets.map((row) => {
                const market = markets.find((candidate) => candidate.symbol === row.symbol);
                return (
                  <Row
                    key={row.symbol}
                    cells={[
                      <span key="market">{market ? marketTitle(market) : row.symbol}</span>,
                      formatContracts(BigInt(row.yesSupply)),
                      formatContracts(BigInt(row.noSupply)),
                      signedContracts(BigInt(row.venueNet)),
                      signedContracts(BigInt(row.inFlight)),
                      signedContracts(BigInt(row.houseInventory)),
                      <Badge key="check" tone={row.balanced ? "positive" : "negative"}>
                        {row.balanced ? "Balanced" : "Not balanced"}
                      </Badge>,
                    ]}
                  />
                );
              })}
            </RowList>
          </div>
        )}
      </Section>
    </div>
  );
}
