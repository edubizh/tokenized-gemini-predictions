import type { CSSProperties } from "react";
import styles from "./Skeleton.module.css";

/** A still block with the dimensions of what will replace it. No shimmer. */
export function Skeleton({ width, height = "1em", inline }: { width: string; height?: string; inline?: boolean }) {
  return <span className={`${styles.skeleton} ${inline ? styles.inline : ""}`} style={{ width, height } as CSSProperties} aria-hidden="true" />;
}
