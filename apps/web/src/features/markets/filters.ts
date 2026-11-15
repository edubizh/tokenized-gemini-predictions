// The filters of the markets index, as they are kept in its query string. Pure.

import type { Cadence } from "@outcome/relayer/api-types";
import type { EventSort } from "./derive";

export interface IndexQuery {
  /** Null: every category. */
  category: string | null;
  /** Null: every cadence. */
  cadence: Cadence | null;
  search: string;
  sort: EventSort;
}

const CADENCES: readonly string[] = ["5m", "15m", "hourly", "daily", "weekly", "monthly", "other"] satisfies Cadence[];
const SORTS: readonly string[] = ["ending", "newest", "volume"] satisfies EventSort[];

/** Anything missing or not recognised reads as its default. */
export function readIndexQuery(params: Pick<URLSearchParams, "get">): IndexQuery {
  const cadence = params.get("cadence") ?? "";
  const sort = params.get("sort") ?? "";
  return {
    category: params.get("category") || null,
    cadence: CADENCES.includes(cadence) ? (cadence as Cadence) : null,
    search: params.get("q") ?? "",
    sort: SORTS.includes(sort) ? (sort as EventSort) : "ending",
  };
}

/** The query string for these filters, `?…`, or an empty string when every one is at its default. */
export function indexQueryString({ category, cadence, search, sort }: IndexQuery): string {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (cadence) params.set("cadence", cadence);
  if (search.trim()) params.set("q", search.trim());
  if (sort !== "ending") params.set("sort", sort);
  const text = params.toString();
  return text ? `?${text}` : "";
}
