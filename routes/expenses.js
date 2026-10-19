import { Router } from 'express';
import { wrap, bad, tx, cleanItems, totalOf } from '../utils/helpers.js';
import { addToInventory } from '../utils/inventory.js';

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
         e.payment_method AS "paymentMethod",
         e.status AS "status",
         e.created_at AS "createdAt",
         COALESCE(json_agg(json_build_object(
           'id', i.id, 'name', i.item_name, 'quantity', i.quantity,
           'unitPrice', i.unit_price::float, 'productLink', i.product_link
         ) ORDER BY i.item_name) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
  FROM expenses e
  LEFT JOIN merchants m ON m.id = e.merchant_id
  LEFT JOIN categories c ON c.id = e.category_id
  LEFT JOIN expense_items i ON i.expense_id = e.id`;

const EXPENSE_GROUP = 'GROUP BY e.id, m.name, c.name, c.auto_inventory, c.icon, e.payment_method, e.status';

async function insertItems(db, expenseId, items) {
  for (const it of items) {
    await db.query(
      `INSERT INTO expense_items (id, expense_id, item_name, quantity, unit_price, product_link)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [expenseId, it.name, it.quantity, it.unitPrice, it.productLink],
    );
  }
}

export default function expenseRoutes(pool) {
  const router = Router();

  // Middleware to extract and require user ID
  const requireUser = (req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Missing user ID' });
    }
    req.userId = userId;
    next();
  };

  router.use(requireUser);

  // --- Expenses CRUD ---
  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `${EXPENSE_SELECT} WHERE e.user_id = $1 ${EXPENSE_GROUP} ORDER BY e.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    const { merchantId, categoryId, orderReference, date, paymentMethod, status } = req.body;
    const items = cleanItems(req.body.items);
    if (!merchantId || !categoryId || !items) {
      return bad(res, 'A merchant, a category and at least one valid item are required');
    }

    const expenseDate = date || new Date().toISOString().split('T')[0];
    const pm = paymentMethod || 'Cash';
    const st = status || 'Paid';

    const result = await tx(pool, async (db) => {
      // Ensure category belongs to user (or matches)
      const cat = await db.query('SELECT auto_inventory FROM categories WHERE id = $1 AND user_id = $2', [categoryId, req.userId]);
      if (cat.rowCount === 0) return null;

      const created = await db.query(
        `INSERT INTO expenses (id, user_id, merchant_id, total_amount, category_id, order_reference, date, payment_method, status, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now())
         RETURNING id`,
        [req.userId, merchantId, totalOf(items), categoryId, orderReference || null, expenseDate, pm, st],
      );
      const expenseId = created.rows[0].id;
      await insertItems(db, expenseId, items);

      let addedToInventory = 0;
      if (cat.rows[0].auto_inventory) {
        for (const it of items) {
          await addToInventory(db, it, merchantId, req.userId);
          addedToInventory += 1;
        }
      }
      return { expenseId, addedToInventory };
    });

    if (!result) return bad(res, 'Unknown category or unauthorized');
    const { rows } = await pool.query(`${EXPENSE_SELECT} WHERE e.id = $1 AND e.user_id = $2 ${EXPENSE_GROUP}`, [result.expenseId, req.userId]);
    res.status(201).json({ expense: rows[0], addedToInventory: result.addedToInventory });
  }));

  router.patch('/:id', wrap(async (req, res) => {
    const { merchantId, categoryId, orderReference, date, paymentMethod, status } = req.body;
    const items = cleanItems(req.body.items);
    if (!merchantId || !categoryId || !items) {
      return bad(res, 'A merchant, a category and at least one valid item are required');
    }

    const expenseDate = date || new Date().toISOString().split('T')[0];
    const pm = paymentMethod || 'Cash';
    const st = status || 'Paid';

    const found = await tx(pool, async (db) => {
      const updated = await db.query(
        `UPDATE expenses
         SET merchant_id = $3, category_id = $4, order_reference = $5, total_amount = $6, date = $7, payment_method = $8, status = $9
         WHERE id = $1 AND user_id = $2 RETURNING id`,
        [req.params.id, req.userId, merchantId, categoryId, orderReference || null, totalOf(items), expenseDate, pm, st],
      );
      if (updated.rowCount === 0) return false;
      await db.query('DELETE FROM expense_items WHERE expense_id = $1', [req.params.id]);
      await insertItems(db, req.params.id, items);
      return true;
    });

    if (!found) return res.status(404).json({ error: 'Expense not found' });
    const { rows } = await pool.query(`${EXPENSE_SELECT} WHERE e.id = $1 AND e.user_id = $2 ${EXPENSE_GROUP}`, [req.params.id, req.userId]);
    res.json(rows[0]);
  }));

  // --- Recurring Templates ---
  router.get('/recurring', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT rt.id, rt.type, rt.name, rt.amount::float, rt.category_id AS "categoryId", 
              c.name AS "categoryName", rt.merchant_id AS "merchantId", m.name AS "merchantName", 
              rt.payment_method AS "paymentMethod", rt.frequency, rt.expected_day AS "expectedDay"
       FROM recurring_templates rt
       LEFT JOIN categories c ON rt.category_id = c.id
       LEFT JOIN merchants m ON rt.merchant_id = m.id
       WHERE rt.user_id = $1
       ORDER BY rt.expected_day ASC`,
      [req.userId]
    );
    res.json(rows);
  }));

  router.post('/recurring', wrap(async (req, res) => {
    const { type, name, amount, categoryId, merchantId, paymentMethod, frequency, expectedDay } = req.body;
    if (!name || !amount) return bad(res, 'Name and amount are required');

    const created = await pool.query(
      `INSERT INTO recurring_templates (id, user_id, type, name, amount, category_id, merchant_id, payment_method, frequency, expected_day)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.userId, type || 'expense', name.trim(), amount, categoryId || null, merchantId || null, paymentMethod || 'Cash', frequency || 'monthly', expectedDay || 1]
    );
    res.status(201).json(created.rows[0]);
  }));

  return router;
}