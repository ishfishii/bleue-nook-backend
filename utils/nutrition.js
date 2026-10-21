// utils/nutrition.js

export function calculateMacroGoals(metrics) {
  const { age, gender, weightKg, heightCm, activityLevel, primaryGoal, goalWeightKg, weeklyPaceKg = 0.5 } = metrics;

  const currentW = Number(weightKg);
  const targetW = goalWeightKg ? Number(goalWeightKg) : currentW;
  const pace = Number(weeklyPaceKg);

  // 1. Calculate BMR (Mifflin-St Jeor)
  let bmr = 10 * currentW + 6.25 * Number(heightCm) - 5 * Number(age);
  bmr = gender === 'male' ? bmr + 5 : bmr - 161;

  // 2. Activity Multipliers
  const activityMultipliers = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
  };
  const multiplier = activityMultipliers[activityLevel] || 1.2;
  const tdee = bmr * multiplier;

  // 3. Calorie Deficit/Surplus based on Goal Weight & Weekly Pace
  const dailyCalorieAdjustment = pace * 1100;
  let targetCalories = tdee;

  if (primaryGoal === 'lose' || targetW < currentW) {
    targetCalories -= dailyCalorieAdjustment;
  } else if (primaryGoal === 'gain' || targetW > currentW) {
    targetCalories += dailyCalorieAdjustment;
  }

  // Safety floor
  const minSafeCalories = gender === 'male' ? 1500 : 1200;
  targetCalories = Math.max(minSafeCalories, Math.round(targetCalories));

  // 4. Plan Timeline
  const weightDifference = Math.abs(currentW - targetW);
  const weeksToGoal = pace > 0 ? Math.ceil(weightDifference / pace) : 0;
  
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + weeksToGoal * 7);

  // 5. Macro Splits
  const targetProteinG = Math.round(currentW * 2.0);
  const targetFatG = Math.round((targetCalories * 0.25) / 9);

  const proteinCalories = targetProteinG * 4;
  const fatCalories = targetFatG * 9;
  const remainingCalories = Math.max(0, targetCalories - (proteinCalories + fatCalories));
  const targetCarbsG = Math.round(remainingCalories / 4);

  return { 
    targetCalories, 
    targetProteinG, 
    targetCarbsG, 
    targetFatG,
    weeksToGoal,
    targetDate: weeksToGoal > 0 ? targetDate.toISOString().split('T')[0] : null
  };
}