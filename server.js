import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import pg from 'pg';

const pool = new pg.Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
});

const app = express();
app.use(cors());
app.use(express.json());

const DEFAULT_LOW_STOCK = 2;
const INVENTORY_CATEGORIES = ['Food', 'Toiletries', 'Cleaning supplies', 'Electronics', 'Others'];

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const bad = (res, message) => res.status(400).json({ error: message });

// Runs fn inside a transaction: everything is saved, or nothing is
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Validates the line items sent by the app. Returns null if anything is wrong.
function cleanItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const out = [];
  for (const it of items) {
    const name = String(it.name ?? '').trim();
    const quantity = Math.round(Number(it.quantity));
    const unitPrice = Number(it.unitPrice);
    if (!name || !(quantity > 0) || !(unitPrice >= 0)) return null;
    out.push({ name, quantity, unitPrice, productLink: it.productLink ? String(it.productLink) : null });
  }
  return out;
}

const totalOf = (items) => Math.round(items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0) * 100) / 100;

async function insertItems(db, expenseId, items) {
  for (const it of items) {
    await db.query(
      `INSERT INTO expense_items (id, expense_id, item_name, quantity, unit_price, product_link)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [expenseId, it.name, it.quantity, it.unitPrice, it.productLink],
    );
  }
}

// ---------- inventory helpers ----------
const STATUS_SQL = `CASE
  WHEN COALESCE(current_qty, 0) <= 0 THEN 'out'
  WHEN current_qty <= COALESCE(low_stock_threshold, ${DEFAULT_LOW_STOCK}) THEN 'low'
  ELSE 'in_stock' END`;

const refreshStatus = (db, id) => db.query(`UPDATE inventory SET status = ${STATUS_SQL} WHERE id = $1`, [id]);

// A bought item restocks the inventory row with the same name, or creates a new unsorted one
async function addToInventory(db, item, merchantId) {
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

// ---------- queries ----------
const EXPENSE_SELECT = `
  SELECT e.id,
         e.merchant_id AS "merchantId",
         COALESCE(m.name, 'Unknown merchant') AS "merchantName",
         e.total_amount::float AS "totalAmount",
         e.category_id AS "categoryId",
         COALESCE(c.name, 'Uncategorized') AS "categoryName",
         COALESCE(c.auto_inventory, false) AS "autoInventory",
         c.icon AS "categoryIcon",
         e.order_reference AS "orderReference",
         e.date AS "date",
         e.created_at AS "createdAt",
         COALESCE(json_agg(json_build_object(
            'id', i.id, 'name', i.item_name, 'quantity', i.quantity,
            'unitPrice', i.unit_price::float, 'productLink', i.product_link
         ) ORDER BY i.item_name) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
  FROM expenses e
  LEFT JOIN merchants m ON m.id = e.merchant_id
  LEFT JOIN categories c ON c.id = e.category_id
  LEFT JOIN expense_items i ON i.expense_id = e.id`;
const EXPENSE_GROUP = 'GROUP BY e.id, m.name, c.name, c.auto_inventory, c.icon';

const INVENTORY_SELECT = `
  SELECT v.id,
         v.item_name AS "name",
         v.category,
         COALESCE(v.current_qty, 0) AS "quantity",
         COALESCE(v.low_stock_threshold, ${DEFAULT_LOW_STOCK}) AS "lowStockThreshold",
         v.storage_location AS "storageLocation",
         v.status,
         m.name AS "lastPurchasedFrom",
         v.updated_at AS "updatedAt"
  FROM inventory v
  LEFT JOIN merchants m ON m.id = v.last_purchased_from_id`;

// ---------- routes ----------
app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ---------- routes: categories ----------
app.get('/api/categories', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, auto_inventory AS "autoInventory", icon FROM categories ORDER BY name');
  res.json(rows);
}));

app.post('/api/categories', wrap(async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const autoInventory = Boolean(req.body.autoInventory);
  const icon = String(req.body.icon ?? 'pricetag-outline').trim();

  if (!name) return bad(res, 'Category name is required');

  const created = await pool.query(
    'INSERT INTO categories (id, name, auto_inventory, icon) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, name, auto_inventory AS "autoInventory", icon',
    [name, autoInventory, icon]
  );
  res.status(201).json(created.rows[0]);
}));

app.put('/api/categories/:id', wrap(async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const autoInventory = Boolean(req.body.autoInventory);
  const icon = String(req.body.icon ?? 'pricetag-outline').trim();

  if (!name) return bad(res, 'Category name is required');

  const updated = await pool.query(
    'UPDATE categories SET name = $1, auto_inventory = $2, icon = $3 WHERE id = $4 RETURNING id, name, auto_inventory AS "autoInventory", icon',
    [name, autoInventory, icon, req.params.id]
  );

  if (updated.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
  res.json(updated.rows[0]);
}));

// ---------- routes: merchants ----------
app.get('/api/merchants', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, type, platform_url AS "platformUrl" FROM merchants ORDER BY name');
  res.json(rows);
}));

app.post('/api/merchants', wrap(async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const type = String(req.body.type ?? 'Online').trim();
  if (!name) return bad(res, 'Merchant name is required');

  // Check if merchant already exists (case-insensitive)
  const existing = await pool.query('SELECT id, name, type, platform_url AS "platformUrl" FROM merchants WHERE lower(name) = lower($1)', [name]);
  if (existing.rowCount > 0) {
    return res.json(existing.rows[0]);
  }

  const created = await pool.query(
    'INSERT INTO merchants (id, name, type) VALUES (gen_random_uuid(), $1, $2) RETURNING id, name, type, platform_url AS "platformUrl"',
    [name, type]
  );
  res.status(201).json(created.rows[0]);
}));

app.get('/api/expenses', wrap(async (req, res) => {
  const { rows } = await pool.query(`${EXPENSE_SELECT} ${EXPENSE_GROUP} ORDER BY e.created_at DESC`);
  res.json(rows);
}));

// Create an expense with its items. If the category has auto_inventory, the items go to inventory too.
app.post('/api/expenses', wrap(async (req, res) => {
  const { merchantId, categoryId, orderReference, date } = req.body;
  const items = cleanItems(req.body.items);
  if (!merchantId || !categoryId || !items) {
    return bad(res, 'A merchant, a category and at least one valid item are required');
  }

  const expenseDate = date || new Date().toISOString().split('T')[0];

  const result = await tx(async (db) => {
    const cat = await db.query('SELECT auto_inventory FROM categories WHERE id = $1', [categoryId]);
    if (cat.rowCount === 0) return null;

    const created = await db.query(
      `INSERT INTO expenses (id, merchant_id, total_amount, category_id, order_reference, date, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())
       RETURNING id`,
      [merchantId, totalOf(items), categoryId, orderReference || null, expenseDate],
    );
    const expenseId = created.rows[0].id;
    await insertItems(db, expenseId, items);

    let addedToInventory = 0;
    if (cat.rows[0].auto_inventory) {
      for (const it of items) {
        await addToInventory(db, it, merchantId);
        addedToInventory += 1;
      }
    }
    return { expenseId, addedToInventory };
  });

  if (!result) return bad(res, 'Unknown category');
  const { rows } = await pool.query(`${EXPENSE_SELECT} WHERE e.id = $1 ${EXPENSE_GROUP}`, [result.expenseId]);
  res.status(201).json({ expense: rows[0], addedToInventory: result.addedToInventory });
}));

// Edit an expense. Its items are replaced. Inventory is NOT changed by edits.
app.patch('/api/expenses/:id', wrap(async (req, res) => {
  const { merchantId, categoryId, orderReference, date } = req.body;
  const items = cleanItems(req.body.items);
  if (!merchantId || !categoryId || !items) {
    return bad(res, 'A merchant, a category and at least one valid item are required');
  }

  const expenseDate = date || new Date().toISOString().split('T')[0];

  const found = await tx(async (db) => {
    const updated = await db.query(
      `UPDATE expenses
       SET merchant_id = $2, category_id = $3, order_reference = $4, total_amount = $5, date = $6
       WHERE id = $1 RETURNING id`,
      [req.params.id, merchantId, categoryId, orderReference || null, totalOf(items), expenseDate],
    );
    if (updated.rowCount === 0) return false;
    await db.query('DELETE FROM expense_items WHERE expense_id = $1', [req.params.id]);
    await insertItems(db, req.params.id, items);
    return true;
  });

  if (!found) return res.status(404).json({ error: 'Expense not found' });
  const { rows } = await pool.query(`${EXPENSE_SELECT} WHERE e.id = $1 ${EXPENSE_GROUP}`, [req.params.id]);
  res.json(rows[0]);
}));

app.get('/api/inventory', wrap(async (req, res) => {
  const { rows } = await pool.query(`${INVENTORY_SELECT} ORDER BY v.item_name`);
  res.json(rows);
}));

// Maps what the app sends to the real column names
const INVENTORY_FIELDS = {
  name: 'item_name',
  category: 'category',
  quantity: 'current_qty',
  lowStockThreshold: 'low_stock_threshold',
  storageLocation: 'storage_location',
};

app.patch('/api/inventory/:id', wrap(async (req, res) => {
  const sets = [];
  const values = [req.params.id];

  for (const [key, column] of Object.entries(INVENTORY_FIELDS)) {
    if (!(key in req.body)) continue;
    let value = req.body[key];

    if (key === 'name') {
      value = String(value ?? '').trim();
      if (!value) return bad(res, 'Name cannot be empty');
    }
    if (key === 'category' && value !== null && !INVENTORY_CATEGORIES.includes(value)) {
      return bad(res, 'Unknown inventory category');
    }
    if (key === 'quantity' || key === 'lowStockThreshold') {
      value = Math.max(0, Math.round(Number(value)));
      if (Number.isNaN(value)) return bad(res, `${key} must be a number`);
    }
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return bad(res, 'Nothing to update');

  const found = await tx(async (db) => {
    const updated = await db.query(
      `UPDATE inventory SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`,
      values,
    );
    if (updated.rowCount === 0) return false;
    await refreshStatus(db, req.params.id);
    return true;
  });

  if (!found) return res.status(404).json({ error: 'Item not found' });
  const { rows } = await pool.query(`${INVENTORY_SELECT} WHERE v.id = $1`, [req.params.id]);
  res.json(rows[0]);
}));

// ---------- errors + start ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT) || 3001;
// 0.0.0.0 lets a phone on your Wi-Fi reach the server, not just this computer
app.listen(port, '0.0.0.0', () => console.log(`Bleue Nook API listening on http://localhost:${port}`));
