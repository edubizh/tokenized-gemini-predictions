import type { HTMLAttributes } from "react";
import styles from "./Panel.module.css";

/** A white surface on the page, for anything that is not a list. Never inside another surface. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={[styles.panel, className ?? ""].filter(Boolean).join(" ")} />;
}
