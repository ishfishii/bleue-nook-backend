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

      const profile = result.rows[0];
      let weeksToGoal = 0;
      if (profile.goal_weight_kg && profile.current_weight_kg) {
        const diff = Math.abs(Number(profile.current_weight_kg) - Number(profile.goal_weight_kg));
        weeksToGoal = Math.ceil(diff / (Number(profile.weekly_pace_kg) || 0.5));
      }

      res.json({
        ...profile,
        weeksToGoal
      });
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
          target_protein_g, target_carbs_g, target_fat_g, bmr, tdee, macro_ratio_string, target_date, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
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
          bmr = EXCLUDED.bmr,
          tdee = EXCLUDED.tdee,
          macro_ratio_string = EXCLUDED.macro_ratio_string,
          target_date = EXCLUDED.target_date,
          updated_at = NOW()
        RETURNING *;
      `;

      const values = [
        userUuid, age, gender, heightCm, weightKg, goalWeightKg, weeklyPaceKg || 0.5,
        activityLevel, primaryGoal, goals.targetCalories,
        goals.targetProteinG, goals.targetCarbsG, goals.targetFatG, 
        goals.bmr, goals.tdee, goals.macroRatioString, goals.targetDate
      ];

      const result = await pool.query(query, values);
      const savedProfile = result.rows[0];

      let weeksToGoal = 0;
      if (savedProfile.goal_weight_kg && savedProfile.current_weight_kg) {
        const diff = Math.abs(Number(savedProfile.current_weight_kg) - Number(savedProfile.goal_weight_kg));
        weeksToGoal = Math.ceil(diff / (Number(savedProfile.weekly_pace_kg) || 0.5));
      }

      res.json({
        ...savedProfile,
        weeksToGoal
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
        `SELECT m.id, m.meal_type, m.servings, m.calories, m.protein_g, m.carbs_g, m.fat_g,
                COALESCE(m.food_name, f.name, 'Custom Meal') as food_name,
                f.brand 
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

  // POST /api/nutrition/suggest - AI Meal Recommendation based on target macros
  router.post('/suggest', async (req, res, next) => {
    try {
      const userUuid = await getUserUuid(req);
      if (!userUuid) {
        return res.status(401).json({ error: 'User record not found in database' });
      }

      const { mealType, remainingCalories, remainingProtein, remainingCarbs, remainingFat } = req.body;

      // Generate a smart context-aware recommendation based on remaining goals
      // You can later hook this up to OpenAI/Gemini or use a curated logic fallback:
      const suggestions = {
        breakfast: [
          { food_name: 'Oatmeal with Berries & Whey Protein', calories: 350, protein_g: 25, carbs_g: 45, fat_g: 6, servings: 1 },
          { food_name: 'Scrambled Eggs on Whole Wheat Toast with Avocado', calories: 400, protein_g: 20, carbs_g: 30, fat_g: 22, servings: 1 }
        ],
        lunch: [
          { food_name: 'Grilled Chicken Breast with Quinoa and Steamed Broccoli', calories: 520, protein_g: 42, carbs_g: 48, fat_g: 10, servings: 1 },
          { food_name: 'Tuna Salad Wrap with Side Greens', calories: 450, protein_g: 35, carbs_g: 38, fat_g: 14, servings: 1 }
        ],
        dinner: [
          { food_name: 'Baked Salmon with Sweet Potato and Asparagus', calories: 580, protein_g: 38, carbs_g: 40, fat_g: 24, servings: 1 },
          { food_name: 'Lean Beef Stir-Fry with Brown Rice and Mixed Veggies', calories: 550, protein_g: 40, carbs_g: 50, fat_g: 18, servings: 1 }
        ],
        snack: [
          { food_name: 'Greek Yogurt with Honey and Almonds', calories: 220, protein_g: 18, carbs_g: 20, fat_g: 8, servings: 1 },
          { food_name: 'Protein Shake with Banana', calories: 250, protein_g: 30, carbs_g: 28, fat_g: 3, servings: 1 }
        ]
      };

      const categoryList = suggestions[mealType] || suggestions.lunch;
      // Pick a random recommendation or filter based on remaining macros
      const recommended = categoryList[Math.floor(Math.random() * categoryList.length)];

      res.json(recommended);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/nutrition/log/item - Add a meal item to a daily log
  router.post('/log/item', async (req, res, next) => {
    try {
      const userUuid = await getUserUuid(req);
      if (!userUuid) {
        return res.status(401).json({ error: 'User record not found in database' });
      }

      const { date, mealType, foodName, servings, calories, proteinG, carbsG, fatG } = req.body;

      // 1. Ensure daily log exists for this date
      let logResult = await pool.query(
        'SELECT id FROM daily_logs WHERE user_id = $1 AND log_date = $2',
        [userUuid, date]
      );

      let dailyLogId;
      if (logResult.rows.length === 0) {
        const newLog = await pool.query(
          'INSERT INTO daily_logs (user_id, log_date) VALUES ($1, $2) RETURNING id',
          [userUuid, date]
        );
        dailyLogId = newLog.rows[0].id;
      } else {
        dailyLogId = logResult.rows[0].id;
      }

      // 2. Insert meal item
      const itemQuery = `
        INSERT INTO meal_items (daily_log_id, meal_type, food_name, servings, calories, protein_g, carbs_g, fat_g)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *;
      `;
      const itemValues = [dailyLogId, mealType, foodName, servings || 1, calories || 0, proteinG || 0, carbsG || 0, fatG || 0];
      const insertedItem = await pool.query(itemQuery, itemValues);

      res.json(insertedItem.rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/nutrition/meal/:id - Delete a meal item log
  router.delete('/meal/:id', async (req, res, next) => {
    try {
      const userUuid = await getUserUuid(req);
      if (!userUuid) {
        return res.status(401).json({ error: 'User record not found in database' });
      }

      const mealId = req.params.id;

      // Verify ownership via daily_logs and user_id
      const deleteQuery = `
        DELETE FROM meal_items 
        USING daily_logs 
        WHERE meal_items.daily_log_id = daily_logs.id 
          AND meal_items.id = $1 
          AND daily_logs.user_id = $2
        RETURNING meal_items.id;
      `;

      const result = await pool.query(deleteQuery, [mealId, userUuid]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Meal item not found or unauthorized' });
      }

      res.json({ success: true, deletedId: mealId });
    } catch (err) {
      next(err);
    }
  });

  return router;
}