import { Router } from 'express';
import { wrap, bad } from '../utils/helpers.js';

export default function recurringRoutes(pool) {
  const router = Router();

  // GET /api/recurring - Fetch all recurring templates[cite: 4]
  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT rt.id, rt.type, rt.name, rt.amount::float, rt.category_id AS "categoryId", 
              c.name AS "categoryName", rt.merchant_id AS "merchantId", m.name AS "merchantName", 
              rt.payment_method AS "paymentMethod", rt.frequency, rt.expected_day AS "expectedDay"
       FROM recurring_templates rt
       LEFT JOIN categories c ON rt.category_id = c.id
       LEFT JOIN merchants m ON rt.merchant_id = m.id
       ORDER BY rt.expected_day ASC`
    );
    res.json(rows);
  }));

  // POST /api/recurring - Create new bill or income stream template[cite: 4]
  router.post('/', wrap(async (req, res) => {
    const { type, name, amount, categoryId, merchantId, paymentMethod, frequency, expectedDay } = req.body;
    if (!name || !amount) return bad(res, 'Name and amount are required');

    const created = await pool.query(
      `INSERT INTO recurring_templates (id, type, name, amount, category_id, merchant_id, payment_method, frequency, expected_day)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        type || 'expense',
        name.trim(),
        amount,
        categoryId || null,
        merchantId || null,
        paymentMethod || 'Cash',
        frequency || 'monthly',
        expectedDay || 1,
      ]
    );
    res.status(201).json(created.rows[0]);
  }));

  // PUT /api/recurring/:id - Update an existing recurring template
  router.put('/:id', wrap(async (req, res) => {
    const { id } = req.params;
    const { type, name, amount, categoryId, merchantId, paymentMethod, frequency, expectedDay } = req.body;
    if (!name || !amount) return bad(res, 'Name and amount are required');

    const updated = await pool.query(
      `UPDATE recurring_templates 
       SET type = $1, name = $2, amount = $3, category_id = $4, merchant_id = $5, 
           payment_method = $6, frequency = $7, expected_day = $8
       WHERE id = $9 RETURNING *`,
      [
        type || 'expense',
        name.trim(),
        amount,
        categoryId || null,
        merchantId || null,
        paymentMethod || 'Cash',
        frequency || 'monthly',
        expectedDay || 1,
        id,
      ]
    );

    if (updated.rowCount === 0) return bad(res, 'Recurring template not found', 404);
    res.json(updated.rows[0]);
  }));

  // DELETE /api/recurring/:id - Delete a recurring template
  router.delete('/:id', wrap(async (req, res) => {
    const { id } = req.params;
    const deleted = await pool.query('DELETE FROM recurring_templates WHERE id = $1 RETURNING id', [id]);
    if (deleted.rowCount === 0) return bad(res, 'Recurring template not found', 404);
    res.json({ ok: true, deletedId: id });
  }));

  // POST /api/recurring/sync - Auto-generates pending bills/income streams for a given month
  router.post('/sync', wrap(async (req, res) => {
    const { year, month } = req.body; // e.g. year: 2026, month: 10
    if (!year || !month) return bad(res, 'Year and month are required');

    const pad = (n) => String(n).padStart(2, '0');
    const startDate = `${year}-${pad(month)}-01`;
    const endDate = `${year}-${pad(month)}-31`;

    const { rows: templates } = await pool.query('SELECT * FROM recurring_templates');
    let createdCount = 0;

    for (const t of templates) {
      // Check if this recurring template has already been synced for this month
      const existing = await pool.query(
        `SELECT e.id FROM expenses e
         LEFT JOIN expense_items i ON i.expense_id = e.id
         WHERE (lower(i.item_name) = lower($1) OR lower(e.order_reference) = lower($1))
           AND e.date >= $2 AND e.date <= $3
         LIMIT 1`,
        [t.name, startDate, endDate]
      );

      if (existing.rowCount === 0) {
        const expDay = Math.min(Math.max(1, t.expected_day), 28);
        const expectedDate = `${year}-${pad(month)}-${pad(expDay)}`;
        const amountVal = t.type === 'income' ? -Math.abs(t.amount) : t.amount;

        try {
          const expRes = await pool.query(
            `INSERT INTO expenses (id, merchant_id, category_id, total_amount, payment_method, date, status, is_recurring, created_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'Pending', true, now())
             RETURNING id`,
            [t.merchant_id || null, t.category_id || null, amountVal, t.payment_method || 'Cash', expectedDate]
          );

          const newExpenseId = expRes.rows[0].id;

          await pool.query(
            `INSERT INTO expense_items (id, expense_id, item_name, quantity, unit_price)
             VALUES (gen_random_uuid(), $1, $2, 1, $3)`,
            [newExpenseId, t.name, amountVal]
          );

          createdCount++;
        } catch (insertErr) {
          console.error(`Failed to sync recurring template "${t.name}":`, insertErr.message);
        }
      }
    }

    res.json({ ok: true, synced: createdCount });
  }));

  return router;
}