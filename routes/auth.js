import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';

const router = express.Router();

// Must be the Web application client ID, same one the app uses
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post('/google', async (req, res) => {
  const { token: googleToken } = req.body;
  try {
    const ticket = await client.verifyIdToken({
      idToken: googleToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, name, picture, sub: googleId } = payload;

    const user = { email, name, picture, googleId };

    const sessionToken = jwt.sign({ sub: googleId }, process.env.JWT_SECRET, {
      expiresIn: '30d',
    });

    return res.json({ success: true, user, token: sessionToken });
  } catch (error) {
    console.error('Google Auth Verification Error:', error);
    return res.status(401).json({ error: 'Invalid Google token' });
  }
});

export default router;