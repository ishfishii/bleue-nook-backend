import { Router } from 'express';
import { wrap, bad, tx, calculateExpiryDate } from '../utils/helpers.js';
import { refreshStatus } from '../utils/inventory.js';

const DEFAULT_LOW_STOCK = 2;

const INVENTORY_SELECT = `
  SELECT v.id,
         v.item_name AS "name",
         v.category,
         COALESCE(v.current_qty, 0) AS "quantity",
         COALESCE(v.low_stock_threshold, ${DEFAULT_LOW_STOCK}) AS "lowStockThreshold",
         v.storage_location AS "storageLocation",
         v.status,
         v.date_opened AS "dateOpened",
         v.storage_years AS "storageYears",
         v.storage_months AS "storageMonths",
         v.storage_days AS "storageDays",
         v.expiration_date AS "expirationDate",
         v.is_essential AS "isEssential",
         m.name AS "lastPurchasedFrom",
         v.updated_at AS "updatedAt"
  FROM inventory v
  LEFT JOIN merchants m ON m.id = v.last_purchased_from_id`;

const INVENTORY_FIELDS = {
  name: 'item_name',
  category: 'category',
  quantity: 'current_qty',
  lowStockThreshold: 'low_stock_threshold',
  storageLocation: 'storage_location',
  status: 'status',
  dateOpened: 'date_opened',
  storageYears: 'storage_years',
  storageMonths: 'storage_months',
  storageDays: 'storage_days',
  expirationDate: 'expiration_date',
  isEssential: 'is_essential',
};

export default function inventoryRoutes(pool) {
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
      `${INVENTORY_SELECT} WHERE v.user_id = $1 ORDER BY v.item_name`,
      [req.userId]
    );
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    console.log('Incoming inventory body:', req.body); // <-- Add this to see what arrives in your server console

    const name = String(req.body.name ?? '').trim();
    if (!name) return bad(res, 'Item name is required');

    const category = req.body.category !== undefined ? req.body.category : null;
    const quantity = Math.max(0, Math.round(Number(req.body.quantity ?? 1)));
    const status = req.body.status || 'Active';
    const dateOpened = req.body.dateOpened || null;
    const storageYears = req.body.storageYears ? Number(req.body.storageYears) : null;
    const storageMonths = req.body.storageMonths ? Number(req.body.storageMonths) : null;
    const storageDays = req.body.storageDays ? Number(req.body.storageDays) : null;
    const expirationDate = req.body.expirationDate || calculateExpiryDate(dateOpened, storageYears, storageMonths, storageDays);
    const isEssential = Boolean(req.body.isEssential);
    
    // Fallback checking for storageLocation or location from frontend payload
    const rawLoc = req.body.storageLocation !== undefined ? req.body.storageLocation : req.body.location;
    const storageLocation = rawLoc ? String(rawLoc).trim() : null;

    const created = await pool.query(
      `INSERT INTO public.inventory 
         (id, user_id, item_name, category, current_qty, low_stock_threshold, status, date_opened, storage_years, storage_months, storage_days, expiration_date, is_essential, storage_location, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       RETURNING id`,
      [req.userId, name, category, quantity, DEFAULT_LOW_STOCK, status, dateOpened, storageYears, storageMonths, storageDays, expirationDate, isEssential, storageLocation]
    );

    const id = created.rows[0].id;
    const { rows } = await pool.query(`${INVENTORY_SELECT} WHERE v.id = $1 AND v.user_id = $2`, [id, req.userId]);
    res.status(201).json(rows[0]);
  }));

  router.patch('/:id', wrap(async (req, res) => {
    const sets = [];
    const values = [req.params.id, req.userId]; // $1 = id, $2 = user_id

    if ('dateOpened' in req.body || 'storageYears' in req.body || 'storageMonths' in req.body || 'storageDays' in req.body) {
      if (!('expirationDate' in req.body) || !req.body.expirationDate) {
        req.body.expirationDate = calculateExpiryDate(
          req.body.dateOpened, 
          req.body.storageYears || 0, 
          req.body.storageMonths || 0, 
          req.body.storageDays || 0
        );
      }
    }

    for (const [key, column] of Object.entries(INVENTORY_FIELDS)) {
      if (!(key in req.body)) continue;
      let value = req.body[key];

      if (key === 'name') {
        value = String(value ?? '').trim();
        if (!value) return bad(res, 'Name cannot be empty');
      }
      if (key === 'quantity' || key === 'lowStockThreshold' || key === 'storageYears' || key === 'storageMonths' || key === 'storageDays') {
        value = value !== null ? Math.max(0, Math.round(Number(value))) : null;
      }
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return bad(res, 'Nothing to update');

    const found = await tx(pool, async (db) => {
      const updated = await db.query(
        `UPDATE public.inventory SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`,
        values,
      );
      if (updated.rowCount === 0) return false;

      // Only re-trigger automatic stock status calculation if quantity changed and explicit status wasn't provided
      if ('quantity' in req.body && !('status' in req.body)) {
        await refreshStatus(db, req.params.id);
      }
      return true;
    });

    if (!found) return res.status(404).json({ error: 'Item not found' });
    const { rows } = await pool.query(`${INVENTORY_SELECT} WHERE v.id = $1 AND v.user_id = $2`, [req.params.id, req.userId]);
    res.json(rows[0]);
  }));

  // --- Inventory Categories ---
  router.get('/categories', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, name, icon FROM inventory_categories WHERE user_id = $1 ORDER BY name',
      [req.userId]
    );
    res.json(rows);
  }));

  router.post('/categories', wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const icon = String(req.body.icon ?? 'pricetag-outline').trim();
    if (!name) return bad(res, 'Category name is required');

    const created = await pool.query(
      'INSERT INTO inventory_categories (id, user_id, name, icon) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, name, icon',
      [req.userId, name, icon]
    );
    res.status(201).json(created.rows[0]);
  }));

  // DELETE Inventory Item
  router.delete('/:id', wrap(async (req, res) => {
    const { rowCount } = await pool.query(
      `DELETE FROM public.inventory WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true, id: req.params.id });
  }));

  return router;
}