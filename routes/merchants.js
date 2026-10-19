import { Router } from 'express';
import { wrap, bad } from '../utils/helpers.js';

export default function merchantRoutes(pool) {
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

  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, name, type, platform_url AS "platformUrl" FROM merchants WHERE user_id = $1 ORDER BY name',
      [req.userId]
    );
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const type = String(req.body.type ?? 'Online').trim();
    if (!name) return bad(res, 'Merchant name is required');

    const existing = await pool.query(
      'SELECT id, name, type, platform_url AS "platformUrl" FROM merchants WHERE lower(name) = lower($1) AND user_id = $2',
      [name, req.userId]
    );
    if (existing.rowCount > 0) {
      return res.json(existing.rows[0]);
    }

    const created = await pool.query(
      'INSERT INTO merchants (id, user_id, name, type) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, name, type, platform_url AS "platformUrl"',
      [req.userId, name, type]
    );
    res.status(201).json(created.rows[0]);
  }));

  return router;
}