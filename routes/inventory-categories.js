import { Router } from 'express';
import { wrap, bad } from '../utils/helpers.js';

export default function inventoryCategoryRoutes(pool) {
  const router = Router();

  const requireUser = (req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Missing user ID' });
    }
    req.userId = userId;
    next();
  };

  router.use(requireUser);

  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, name, icon FROM inventory_categories WHERE user_id = $1 ORDER BY name',
      [req.userId]
    );
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const icon = String(req.body.icon ?? 'pricetag-outline').trim();
    if (!name) return bad(res, 'Category name is required');

    const created = await pool.query(
      'INSERT INTO inventory_categories (id, user_id, name, icon) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, name, icon',
      [req.userId, name, icon]
    );
    res.status(201).json(created.rows[0]);
  }));

  // Added PUT route for editing categories
  router.put('/:id', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const icon = String(req.body.icon ?? 'pricetag-outline').trim();
    if (!name) return bad(res, 'Category name is required');

    const updated = await pool.query(
      'UPDATE inventory_categories SET name = $1, icon = $2 WHERE id = $3 AND user_id = $4 RETURNING id, name, icon',
      [name, icon, req.params.id, req.userId]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    res.json(updated.rows[0]);
  }));

  return router;
}