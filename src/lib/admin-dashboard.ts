// V6 §5.7 — admin home operations dashboard helpers.
// Pure (no env/DB): the .astro page reads product_groups rows, then maps them
// through groupStockSummary for display. Keeping it pure makes the "low stock"
// rule unit-testable and consistent.

// 1 斤 = 100 fen. "Low stock" = pool at or below 5 斤; surface in red so the
// shop owner restocks before customers hit 售完.
export const LOW_STOCK_THRESHOLD_FEN = 500;

export function fenToJinLabel(fen: number): string {
  return (fen / 100).toFixed(2);
}

export interface GroupStockRow {
  id: number;
  name: string;
  stock_fen: number;
}

export interface GroupStockSummaryItem {
  id: number;
  name: string;
  stock_fen: number;
  jin: string;
  low: boolean;
  soldOut: boolean;
}

export function groupStockSummary(rows: GroupStockRow[]): GroupStockSummaryItem[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    stock_fen: r.stock_fen,
    jin: fenToJinLabel(r.stock_fen),
    low: r.stock_fen <= LOW_STOCK_THRESHOLD_FEN,
    soldOut: r.stock_fen <= 0,
  }));
}
