import type { ReactNode } from 'react';
import styles from './table.module.css';
import { LoadingState } from './feedback';

export interface Column<Row> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
}

/**
 * Accessible data table (baseline B5-2) for later lists: projects, users, roles, audit events.
 * A caption names it, column headers carry scope, and it has explicit empty and loading states.
 * Wide tables scroll inside a focusable, labelled region, so the page never scrolls sideways.
 * Filtering, sorting and paging arrive with the first real data (Stage 8 onward).
 */
export function DataTable<Row>({
  id,
  caption,
  columns,
  rows,
  rowKey,
  loading = false,
  emptyMessage,
}: {
  readonly id: string;
  readonly caption: string;
  readonly columns: ReadonlyArray<Column<Row>>;
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly loading?: boolean;
  readonly emptyMessage: string;
}) {
  const captionId = `${id}-caption`;
  return (
    <div className={styles.scroll} role="region" aria-labelledby={captionId} tabIndex={0}>
      <table id={id} className={styles.table} aria-busy={loading ? true : undefined}>
        <caption id={captionId} className={styles.caption}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length}>
                <LoadingState label={`Loading ${caption.toLowerCase()}…`} />
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={styles.empty}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td key={c.key}>{c.cell(row)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
