import { Router } from 'express';
import { wrap, bad } from '../utils/helpers.js';

export default function merchantRoutes(pool) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT id, name, type, platform_url AS "platformUrl" FROM merchants ORDER BY name');
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const type = String(req.body.type ?? 'Online').trim();
    if (!name) return bad(res, 'Merchant name is required');

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

  return router;
}