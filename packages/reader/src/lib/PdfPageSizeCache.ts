import type { SQLiteDB } from "@hayeah/sqlite-browser";

/**
 * Page size information using 1-based page numbering (page 1 = first page)
 */
export interface PageSize {
  pageNumber: number; // 1-based page number
  widthPt: number;
  heightPt: number;
}

export class PdfPageSizeCache {
  constructor(private db: SQLiteDB) {}

  /**
   * Get all cached page sizes for a book
   * Returns page sizes with 1-based page numbers
   */
  async getPageSizes(bookId: number): Promise<PageSize[] | null> {
    const result = await this.db.query(
      "SELECT page_index, width_pt, height_pt FROM pdf_page_sizes WHERE book_id = ? ORDER BY page_index",
      [bookId],
    );

    if (result.rows.length === 0) return null;

    // Convert 0-based page_index from DB to 1-based pageNumber
    return result.rows.map((row: any) => ({
      pageNumber: row.page_index + 1, // DB uses 0-based, convert to 1-based
      widthPt: row.width_pt,
      heightPt: row.height_pt,
    }));
  }

  /**
   * Save page sizes for a book (replaces existing data)
   * Expects pageSizes with 1-based page numbers
   */
  async savePageSizes(bookId: number, pageSizes: PageSize[]): Promise<void> {
    // Delete existing entries
    await this.db.exec("DELETE FROM pdf_page_sizes WHERE book_id = ?", [
      bookId,
    ]);

    // Insert new entries
    if (pageSizes.length === 0) return;

    const placeholders = pageSizes.map(() => "(?, ?, ?, ?)").join(", ");
    const sql = `INSERT INTO pdf_page_sizes (book_id, page_index, width_pt, height_pt) VALUES ${placeholders}`;

    const params: (number | string)[] = [];
    for (const size of pageSizes) {
      // Convert 1-based pageNumber to 0-based page_index for DB
      params.push(bookId, size.pageNumber - 1, size.widthPt, size.heightPt);
    }

    await this.db.exec(sql, params);
  }

  /**
   * Delete cached page sizes for a book
   */
  async deletePageSizes(bookId: number): Promise<void> {
    await this.db.exec("DELETE FROM pdf_page_sizes WHERE book_id = ?", [
      bookId,
    ]);
  }
}
