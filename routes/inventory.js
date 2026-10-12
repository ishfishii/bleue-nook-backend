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
         v.location,
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
  location: 'location',
};

export default function inventoryRoutes(pool) {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(`${INVENTORY_SELECT} ORDER BY v.item_name`);
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
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
    const location = req.body.location || req.body.storageLocation ? String(req.body.location || req.body.storageLocation).trim() : null;

    const created = await pool.query(
      `INSERT INTO public.inventory 
         (id, item_name, category, current_qty, low_stock_threshold, status, date_opened, storage_years, storage_months, storage_days, expiration_date, is_essential, location, storage_location, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, now())
       RETURNING id`,
      [name, category, quantity, DEFAULT_LOW_STOCK, status, dateOpened, storageYears, storageMonths, storageDays, expirationDate, isEssential, location]
    );

    const id = created.rows[0].id;
    const { rows } = await pool.query(`${INVENTORY_SELECT} WHERE v.id = $1`, [id]);
    res.status(201).json(rows[0]);
  }));

  router.patch('/:id', wrap(async (req, res) => {
    const sets = [];
    const values = [req.params.id];

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

    // Sync storageLocation into location if provided
    if ('storageLocation' in req.body && !('location' in req.body)) {
      req.body.location = req.body.storageLocation;
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
        `UPDATE public.inventory SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`,
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
    const { rows } = await pool.query(`${INVENTORY_SELECT} WHERE v.id = $1`, [req.params.id]);
    res.json(rows[0]);
  }));

  // --- Inventory Categories ---
  router.get('/categories', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT id, name, icon FROM inventory_categories ORDER BY name');
    res.json(rows);
  }));

  router.post('/categories', wrap(async (req, res) => {
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