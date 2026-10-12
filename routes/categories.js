import { Router } from 'express';
import { wrap, bad } from '../utils/helpers.js';

export default function categoryRoutes(pool) {
  const router = Router();

  // --- Expense Categories ---
  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT id, name, auto_inventory AS "autoInventory", icon FROM categories ORDER BY name');
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
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

  router.put('/:id', wrap(async (req, res) => {
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

  // --- Inventory Categories ---
  router.get('/inventory-categories', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT id, name, icon FROM inventory_categories ORDER BY name');
    res.json(rows);
  }));

  router.post('/inventory-categories', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const icon = String(req.body.icon ?? 'pricetag-outline').trim();
    if (!name) return bad(res, 'Category name is required');

    const created = await pool.query(
      'INSERT INTO inventory_categories (id, name, icon) VALUES (gen_random_uuid(), $1, $2) RETURNING id, name, icon',
      [name, icon]
    );
    res.status(201).json(created.rows[0]);
  }));

  router.put('/inventory-categories/:id', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const icon = String(req.body.icon ?? 'pricetag-outline').trim();
    if (!name) return bad(res, 'Category name is required');

    const updated = await pool.query(
      'UPDATE inventory_categories SET name = $1, icon = $2 WHERE id = $3 RETURNING id, name, icon',
      [name, icon, req.params.id]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    res.json(updated.rows[0]);
  }));

  return router;
}