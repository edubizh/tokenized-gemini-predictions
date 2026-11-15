"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ApiEvent, Cadence } from "@outcome/relayer/api-types";
import { PageHeader } from "@/components/shell/Shell";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConfig } from "@/lib/config";
import { useEvents, useHealth } from "@/lib/relayer/hooks";
import { cadenceLabel, cadencesOf, categoriesOf, filterEvents, sortEvents, type EventSort } from "./derive";
import { EventCard } from "./EventCard";
import { indexQueryString, readIndexQuery, type IndexQuery } from "./filters";
import styles from "./Markets.module.css";

const TITLE = "Markets";
const LEAD = "Every market the venue lists, settled on Solana devnet with test dollars of no value.";
const ALL = "all";

const SORTS = [
  { value: "ending", label: "Ending soon" },
  { value: "newest", label: "Newly listed" },
  { value: "volume", label: "Volume" },
] as const satisfies ReadonlyArray<{ value: EventSort; label: string }>;

/** The filters, read from the query string and written back to it without a navigation. */
function useIndexQuery(): [IndexQuery, (patch: Partial<IndexQuery>) => void] {
  const query = readIndexQuery(useSearchParams());
  const update = (patch: Partial<IndexQuery>) => {
    const next = { ...readIndexQuery(new URLSearchParams(window.location.search)), ...patch };
    window.history.replaceState(null, "", `${window.location.pathname}${indexQueryString(next)}`);
  };
  return [query, update];
}

/** The shape of the grid while the first answer is on its way. */
export function MarketsLoading() {
  return (
    <>
      <PageHeader title={TITLE}>{LEAD}</PageHeader>
      <div className={styles.grid} aria-busy="true">
        <span className="sr-only">Loading markets</span>
        {Array.from({ length: 6 }, (_, index) => (
          <Panel key={index} className={styles.card}>
            <div className={styles.cardHead}>
              <Skeleton width="40px" height="40px" />
              <div className={styles.heading}>
                <Skeleton width="80%" height="1.25rem" />
                <Skeleton width="40%" height="1rem" />
              </div>
            </div>
            <div className={styles.buttons}>
              <Skeleton width="100%" height="var(--control-row)" />
              <Skeleton width="100%" height="var(--control-row)" />
            </div>
            <Skeleton width="60%" height="24px" />
          </Panel>
        ))}
      </div>
    </>
  );
}

function Filters({ events, query, search, onSearch, update }: { events: ApiEvent[]; query: IndexQuery; search: string; onSearch(text: string): void; update(patch: Partial<IndexQuery>): void }) {
  return (
    <div className={styles.filters} role="search" aria-label="Filter markets">
      <div className={styles.filterLine}>
        <div className={styles.search}>
          <Field label="Search" type="search" value={search} onChange={onSearch} placeholder="Asset, title or strike" data-testid="filter-search" />
        </div>
        <div className={styles.group} data-testid="filter-sort">
          <span className={styles.groupLabel} aria-hidden="true">
            Sort by
          </span>
          <Segmented label="Sort by" size="row" value={query.sort} onChange={(sort) => update({ sort })} options={SORTS} />
        </div>
      </div>
      <div className={styles.filterLine}>
        <div className={styles.group} data-testid="filter-category">
          <span className={styles.groupLabel} aria-hidden="true">
            Category
          </span>
          <Segmented
            label="Category"
            size="row"
            value={query.category ?? ALL}
            onChange={(category) => update({ category: category === ALL ? null : category })}
            options={[{ value: ALL, label: "All" }, ...categoriesOf(events).map((category) => ({ value: category, label: category }))]}
          />
        </div>
        <div className={styles.group} data-testid="filter-cadence">
          <span className={styles.groupLabel} aria-hidden="true">
            Timeframe
          </span>
          <Segmented<Cadence | typeof ALL>
            label="Timeframe"
            size="row"
            value={query.cadence ?? ALL}
            onChange={(cadence) => update({ cadence: cadence === ALL ? null : cadence })}
            options={[{ value: ALL, label: "All" }, ...cadencesOf(events).map((cadence) => ({ value: cadence, label: cadenceLabel(cadence) }))]}
          />
        </div>
      </div>
    </div>
  );
}

/** Every event the venue lists, as cards, with filters kept in the query string. Open to everyone. */
export function MarketsIndex() {
  const config = useConfig();
  const events = useEvents();
  const { offline } = useHealth();
  const [query, update] = useIndexQuery();
  const [search, setSearch] = useState(query.search);

  const onSearch = (text: string) => {
    setSearch(text);
    update({ search: text });
  };
  const clear = () => {
    setSearch("");
    update({ category: null, cadence: null, search: "", sort: query.sort });
  };

  if (!config.bootstrapped) {
    return (
      <>
        <PageHeader title={TITLE}>{LEAD}</PageHeader>
        <Notice title="Nothing is deployed yet">The program and its test dollars are not on Solana devnet yet. Markets appear here once they are.</Notice>
      </>
    );
  }

  if (offline || events.error !== null) {
    // Prices from before the relayer went quiet are not shown as if they were current.
    return (
      <>
        <PageHeader title={TITLE}>{LEAD}</PageHeader>
        <Notice title="The relayer is not answering">
          Markets cannot be listed without it, and this page retries on its own. Your positions are still in <Link href="/portfolio">Portfolio</Link>.
        </Notice>
      </>
    );
  }

  if (events.data === undefined) return <MarketsLoading />;

  if (events.data.length === 0) {
    return (
      <>
        <PageHeader title={TITLE}>{LEAD}</PageHeader>
        <Notice title="No markets right now">The venue lists nothing at the moment. New markets appear here on their own.</Notice>
      </>
    );
  }

  const all = events.data;
  const shown = sortEvents(filterEvents(all, { ...query, search }), query.sort);
  const contracts = all.reduce((sum, event) => sum + event.markets.length, 0);

  return (
    <>
      <PageHeader title={TITLE}>
        {all.length} markets with {contracts} contracts, settled on Solana devnet with test dollars of no value.
      </PageHeader>
      <Filters events={all} query={query} search={search} onSearch={onSearch} update={update} />
      {shown.length === 0 ? (
        <Notice
          title="No market matches"
          action={
            <Button size="row" onClick={clear} data-testid="filter-clear">
              Clear filters
            </Button>
          }
        >
          Try another word, or show every category and timeframe.
        </Notice>
      ) : (
        <ul className={styles.grid} aria-label="Markets">
          {shown.map((event) => (
            <li key={event.ticker}>
              <EventCard event={event} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
