export const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
export const bad = (res, message) => res.status(400).json({ error: message });

export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function cleanItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const out = [];
  for (const it of items) {
    const name = String(it.name ?? '').trim();
    const quantity = Math.round(Number(it.quantity));
    const unitPrice = Number(it.unitPrice);
    
    // 👇 Allow negative prices (for income) and ensure it's not zero
    if (!name || !(quantity > 0) || unitPrice === 0) return null;
    
    out.push({ name, quantity, unitPrice, productLink: it.productLink ? String(it.productLink) : null });
  }
  return out;
}

export const totalOf = (items) => Math.round(items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0) * 100) / 100;

export function calculateExpiryDate(dateOpened, years = 0, months = 0, days = 0) {
  if (!dateOpened) return null;
  const d = new Date(dateOpened);
  if (years) d.setFullYear(d.getFullYear() + Number(years));
  if (months) d.setMonth(d.getMonth() + Number(months));
  if (days) d.setDate(d.getDate() + Number(days));
  return d.toISOString().split('T')[0];
}