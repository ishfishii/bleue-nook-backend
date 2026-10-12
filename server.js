import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { pool } from './db/pool.js';
import merchantRoutes from './routes/merchants.js';
import categoryRoutes from './routes/categories.js';
import expenseRoutes from './routes/expenses.js';
import inventoryRoutes from './routes/inventory.js';
import recurringRoutes from './routes/recurring.js';
import inventoryCategoryRoutes from './routes/inventory-categories.js';

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

// Mount modular routes
app.use('/api/merchants', merchantRoutes(pool));
app.use('/api/categories', categoryRoutes(pool));
app.use('/api/expenses', expenseRoutes(pool));
app.use('/api/inventory', inventoryRoutes(pool));
app.use('/api/recurring', recurringRoutes(pool));
app.use('/api/inventory-categories', inventoryCategoryRoutes(pool));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, '0.0.0.0', () => console.log(`Bleue Nook API listening on http://localhost:${port}`));