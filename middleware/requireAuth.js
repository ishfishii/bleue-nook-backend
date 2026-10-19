import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const userId = jwt.verify(token, process.env.JWT_SECRET).sub;
    req.userId = userId;
    req.headers['x-user-id'] = userId; // replaces whatever the client sent
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}