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

  const minSafeCalories = gender === 'male' ? 1500 : 1200;
  targetCalories = Math.max(minSafeCalories, Math.round(targetCalories));

  // 4. Plan Timeline & Weeks to Goal
  const weightDifference = Math.abs(currentW - targetW);
  const weeksToGoal = pace > 0 ? Math.ceil(weightDifference / pace) : 0;
  
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + weeksToGoal * 7);

  // 5. Macro Splits & Ratios (e.g., Protein 2g/kg, Fats 25%, Rest Carbs)
  const targetProteinG = Math.round(currentW * 2.0);
  const proteinCals = targetProteinG * 4;

  const targetFatG = Math.round((targetCalories * 0.25) / 9);
  const fatCals = targetFatG * 9;

  const remainingCals = Math.max(0, targetCalories - (proteinCals + fatCals));
  const targetCarbsG = Math.round(remainingCals / 4);
  const carbCals = targetCarbsG * 4;

  // Calculate exact percentage distribution (C:P:F)
  const totalCalsCheck = (carbCals + proteinCals + fatCals) || 1;
  const carbPct = Math.round((carbCals / totalCalsCheck) * 100);
  const proteinPct = Math.round((proteinCals / totalCalsCheck) * 100);
  const fatPct = 100 - (carbPct + proteinPct); // Ensure it sums cleanly to 100%

  return { 
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    targetCalories, 
    targetProteinG, 
    targetCarbsG, 
    targetFatG,
    macroRatioString: `${carbPct}:${proteinPct}:${fatPct}`, // e.g., "57:18:25"
    weeksToGoal,
    targetDate: weeksToGoal > 0 ? targetDate.toISOString().split('T')[0] : null
  };
}