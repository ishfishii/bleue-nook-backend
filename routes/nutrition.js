// routes/nutrition.js
import express from 'express';
import { calculateMacroGoals } from '../utils/nutrition.js';

export default function nutritionRoutes(pool) {
  const router = express.Router();

  // Helper to resolve the user's UUID from their Google ID (from JWT req.userId)
  const getUserUuid = async (req) => {
    const googleId = req.userId || req.headers['x-user-id'];
    if (!googleId) return null;

    // Look up the internal UUID in the users table using google_id
    const userRes = await pool.query(
      'SELECT id FROM users WHERE google_id = $1 OR id::text = $1',
      [googleId]
    );

    return userRes.rows[0]?.id || null;
  };

  // GET /api/nutrition/profile - Fetch user profile & goals
  router.get('/profile', async (req, res, next) => {
    try {
      const userUuid = await getUserUuid(req);

      if (!userUuid) {
        return res.status(401).json({ error: 'User record not found in database' });
      }

      const result = await pool.query(
        'SELECT * FROM user_profiles WHERE user_id = $1',
        [userUuid]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'Profile not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/nutrition/profile
  router.put('/profile', async (req, res, next) => {
    try {
      const userUuid = await getUserUuid(req);
      if (!userUuid) {
        return res.status(401).json({ error: 'User record not found in database' });
      }

      const { age, gender, weightKg, heightCm, activityLevel, primaryGoal, goalWeightKg, weeklyPaceKg } = req.body;

      const goals = calculateMacroGoals({
        age: Number(age),
        gender,
        weightKg: Number(weightKg),
        heightCm: Number(heightCm),
        activityLevel,
        primaryGoal,
        goalWeightKg: Number(goalWeightKg),
        weeklyPaceKg: Number(weeklyPaceKg) || 0.5,
      });

      const query = `
        INSERT INTO user_profiles (
          user_id, age, gender, height_cm, current_weight_kg, goal_weight_kg, weekly_pace_kg,
          activity_level, primary_goal, target_calories, 
          target_protein_g, target_carbs_g, target_fat_g, target_date, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (user_id) 
        DO UPDATE SET
          age = EXCLUDED.age,
          gender = EXCLUDED.gender,
          height_cm = EXCLUDED.height_cm,
          current_weight_kg = EXCLUDED.current_weight_kg,
          goal_weight_kg = EXCLUDED.goal_weight_kg,
          weekly_pace_kg = EXCLUDED.weekly_pace_kg,
          activity_level = EXCLUDED.activity_level,
          primary_goal = EXCLUDED.primary_goal,
          target_calories = EXCLUDED.target_calories,
          target_protein_g = EXCLUDED.target_protein_g,
          target_carbs_g = EXCLUDED.target_carbs_g,
          target_fat_g = EXCLUDED.target_fat_g,
          target_date = EXCLUDED.target_date,
          updated_at = NOW()
        RETURNING *;
      `;

      const values = [
        userUuid, age, gender, heightCm, weightKg, goalWeightKg, weeklyPaceKg || 0.5,
        activityLevel, primaryGoal, goals.targetCalories,
        goals.targetProteinG, goals.targetCarbsG, goals.targetFatG, goals.targetDate
      ];

      const result = await pool.query(query, values);
      res.json({
        ...result.rows[0],
        weeksToGoal: goals.weeksToGoal
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/nutrition/log?date=YYYY-MM-DD
  router.get('/log', async (req, res, next) => {
    try {
      const userUuid = await getUserUuid(req);

      if (!userUuid) {
        return res.status(401).json({ error: 'User record not found in database' });
      }

      const { date } = req.query;

      if (!date) {
        return res.status(400).json({ error: 'Date query parameter required' });
      }

      // 1. Get or create daily log
      let logResult = await pool.query(
        'SELECT * FROM daily_logs WHERE user_id = $1 AND log_date = $2',
        [userUuid, date]
      );

      let dailyLog = logResult.rows[0];

      if (!dailyLog) {
        const createLog = await pool.query(
          'INSERT INTO daily_logs (user_id, log_date) VALUES ($1, $2) RETURNING *',
          [userUuid, date]
        );
        dailyLog = createLog.rows[0];
      }

      // 2. Fetch associated meal items
      const mealsResult = await pool.query(
        `SELECT m.*, f.name as food_name, f.brand 
         FROM meal_items m
         LEFT JOIN foods f ON m.food_id = f.id
         WHERE m.daily_log_id = $1
         ORDER BY m.created_at ASC`,
        [dailyLog.id]
      );

      res.json({
        dailyLog,
        meals: mealsResult.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}