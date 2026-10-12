const DEFAULT_LOW_STOCK = 2;

const STATUS_SQL = `CASE
  WHEN COALESCE(current_qty, 0) <= 0 THEN 'out'
  WHEN current_qty <= COALESCE(low_stock_threshold, ${DEFAULT_LOW_STOCK}) THEN 'low'
  ELSE 'in_stock' END`;

export async function refreshStatus(db, id) {
  return db.query(`UPDATE inventory SET status = ${STATUS_SQL} WHERE id = $1`, [id]);
}

export async function addToInventory(db, item, merchantId) {
  const existing = await db.query('SELECT id FROM inventory WHERE lower(item_name) = lower($1) LIMIT 1', [item.name]);
  let id;
  if (existing.rowCount > 0) {
    id = existing.rows[0].id;
    await db.query(
      `UPDATE inventory
       SET current_qty = COALESCE(current_qty, 0) + $2, last_purchased_from_id = $3, updated_at = now()
       WHERE id = $1`,
      [id, item.quantity, merchantId],
    );
  } else {
    const created = await db.query(
      `INSERT INTO inventory
         (id, item_name, current_qty, low_stock_threshold, last_purchased_from_id, updated_at, status, category)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), 'in_stock', NULL)
       RETURNING id`,
      [item.name, item.quantity, DEFAULT_LOW_STOCK, merchantId],
    );
    id = created.rows[0].id;
  }
  await refreshStatus(db, id);
}