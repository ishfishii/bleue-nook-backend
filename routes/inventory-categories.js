import { Router } from 'express';
import { wrap, bad } from '../utils/helpers.js';

export default function inventoryCategoryRoutes(pool) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT id, name, icon FROM inventory_categories ORDER BY name');
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const icon = String(req.body.icon ?? 'pricetag-outline').trim();
    if (!name) return bad(res, 'Category name is required');

    const created = await pool.query(
      'INSERT INTO inventory_categories (id, name, icon) VALUES (gen_random_uuid(), $1, $2) RETURNING id, name, icon',
      [name, icon]
    );
    res.status(201).json(created.rows[0]);
  }));

  return router;
}