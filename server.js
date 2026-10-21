import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { pool } from './db/pool.js';
import { requireAuth } from './middleware/requireAuth.js';
import merchantRoutes from './routes/merchants.js';
import categoryRoutes from './routes/categories.js';
import expenseRoutes from './routes/expenses.js';
import inventoryRoutes from './routes/inventory.js';
import recurringRoutes from './routes/recurring.js';
import inventoryCategoryRoutes from './routes/inventory-categories.js';
import nutritionRoutes from './routes/nutrition.js'; //
import authRoutes from './routes/auth.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();

app.use(
  cors({
    origin: '*',
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
  })
);

app.use(express.json());

// Health check
app.get('/api/health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Public: login
app.use('/api/auth', authRoutes);

// Protected: everything below requires a valid session token
app.use('/api/merchants', requireAuth, merchantRoutes(pool));
app.use('/api/categories', requireAuth, categoryRoutes(pool));
app.use('/api/expenses', requireAuth, expenseRoutes(pool));
app.use('/api/inventory', requireAuth, inventoryRoutes(pool));
app.use('/api/recurring', requireAuth, recurringRoutes(pool));
app.use('/api/inventory-categories', requireAuth, inventoryCategoryRoutes(pool));
app.use('/api/nutrition', requireAuth, nutritionRoutes(pool));

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST || path.resolve(here, '../bleue-nook/dist'); // adjust to your app folder

app.use(express.static(webDist));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, '0.0.0.0', () => console.log(`Bleue Nook API listening on http://localhost:${port}`));