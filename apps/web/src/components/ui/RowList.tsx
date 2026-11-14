"use client";

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import styles from "./RowList.module.css";

export interface Column {
  id: string;
  /** Column header, also shown beside the value when a row stacks on a narrow screen. */
  header: string;
  align?: "left" | "right";
  /** A CSS grid track: `7rem`, `minmax(0, 1fr)`. The primary column takes the remaining width. */
  width?: string;
  /** The row's main text. Exactly one column should be primary. */
  primary?: boolean;
  /** Buttons at the far right; the header is read by screen readers only. */
  actions?: boolean;
}

const ColumnsContext = createContext<readonly Column[]>([]);

export interface RowListProps {
  /** Accessible name of the list: "Markets", "Your orders". */
  label: string;
  columns: readonly Column[];
  /** For a list of five or more columns: its rows stack below 56rem, not only on a phone. */
  dense?: boolean;
  children: ReactNode;
}

/** The ledger pattern: a header of small mono labels, then ruled rows with numbers in fixed columns. */
export function RowList({ label, columns, dense = false, children }: RowListProps) {
  const template = columns.map((column) => column.width ?? (column.primary ? "minmax(0, 1fr)" : "max-content")).join(" ");
  return (
    <div className={`${styles.list} ${dense ? styles.dense : ""}`} role="table" aria-label={label} style={{ "--columns": template } as CSSProperties}>
      <div role="rowgroup">
        <div className={styles.header} role="row">
          {columns.map((column) => (
            <span key={column.id} role="columnheader" className={`${styles.heading} ${column.align === "right" ? styles.right : ""}`}>
              {column.actions ? <span className="sr-only">{column.header}</span> : column.header}
            </span>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        <ColumnsContext.Provider value={columns}>{children}</ColumnsContext.Provider>
      </div>
    </div>
  );
}

export interface RowProps {
  /** One node per column, in column order. */
  cells: readonly ReactNode[];
  /** Content spanning the full width under the row, such as an expanded receipt. */
  detail?: ReactNode;
}

export function Row({ cells, detail }: RowProps) {
  const columns = useContext(ColumnsContext);
  return (
    <div className={styles.row} role="row">
      {columns.map((column, index) => (
        <div
          key={column.id}
          role="cell"
          className={[styles.cell, column.primary ? styles.primary : "", column.actions ? styles.actions : "", column.align === "right" ? styles.right : ""].filter(Boolean).join(" ")}
        >
          {!column.primary && !column.actions && <span className={styles.cellLabel}>{column.header}</span>}
          {cells[index]}
        </div>
      ))}
      {detail && (
        <div role="cell" className={styles.detail}>
          {detail}
        </div>
      )}
    </div>
  );
}
