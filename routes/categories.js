import { Router } from 'express';
import { wrap, bad } from '../utils/helpers.js';

export default function categoryRoutes(pool) {
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

  // --- Expense Categories ---
  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, name, auto_inventory AS "autoInventory", icon FROM categories WHERE user_id = $1 ORDER BY name',
      [req.userId]
    );
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const autoInventory = Boolean(req.body.autoInventory);
    const icon = String(req.body.icon ?? 'pricetag-outline').trim();

    if (!name) return bad(res, 'Category name is required');

    const created = await pool.query(
      'INSERT INTO categories (id, user_id, name, auto_inventory, icon) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id, name, auto_inventory AS "autoInventory", icon',
      [req.userId, name, autoInventory, icon]
    );
    res.status(201).json(created.rows[0]);
  }));

  router.put('/:id', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const autoInventory = Boolean(req.body.autoInventory);
    const icon = String(req.body.icon ?? 'pricetag-outline').trim();

    if (!name) return bad(res, 'Category name is required');

    const updated = await pool.query(
      'UPDATE categories SET name = $1, auto_inventory = $2, icon = $3 WHERE id = $4 AND user_id = $5 RETURNING id, name, auto_inventory AS "autoInventory", icon',
      [name, autoInventory, icon, req.params.id, req.userId]
    );

    if (updated.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    res.json(updated.rows[0]);
  }));