const assert = require('node:assert');
const { evaluateDayAttendance, calculateMonthlyPayroll } = require('./src/payroll');

const settings = {
  work_start_time: '09:00',
  work_end_time: '17:00',
  grace_period_minutes: '10',
  penalty_per_minute: '1000',
  penalty_calc_mode: 'all_minutes_if_over_grace',
  early_bonus_per_minute: '1000',
  overtime_bonus_per_minute: '1000',
  absent_fixed_penalty: '150000',
  working_days_per_month: '26'
};

const baseSalary = 2000000;

// Test 1: 1 minut erta kelsa har minutiga 1000 so'm (masalan 08:45 da keldi = 15 min erta = +15 000)
const resEarly = evaluateDayAttendance({ checkIn: '08:45', checkOut: '17:00', status: 'present' }, settings, baseSalary);
assert.strictEqual(resEarly.earlyMinutes, 15);
assert.strictEqual(resEarly.earlyBonusAmount, 15000);
assert.strictEqual(resEarly.penaltyAmount, 0);

// Test 2: 09:10 gacha ruxsat (09:07 da keldi = 0 so'm jarima)
const resGrace = evaluateDayAttendance({ checkIn: '09:07', checkOut: '17:00', status: 'present' }, settings, baseSalary);
assert.strictEqual(resGrace.isGraceLate, true);
assert.strictEqual(resGrace.penaltyAmount, 0);

// Test 3: 09:10 dan kech qolsa (09:18 da keldi = 18 min kechikdi = -18 000 jarima)
const resLate = evaluateDayAttendance({ checkIn: '09:18', checkOut: '17:00', status: 'present' }, settings, baseSalary);
assert.strictEqual(resLate.isPenalizedLate, true);
assert.strictEqual(resLate.penaltyMinutes, 18);
assert.strictEqual(resLate.penaltyAmount, 18000);

// Test 4: Ishga umuman kelmasa = 150 000 so'm qat'iy jarima
const resAbsent = evaluateDayAttendance({ checkIn: null, checkOut: null, status: 'absent' }, settings, baseSalary);
assert.strictEqual(resAbsent.absenceDeduction, 150000);

// Test 5: 17:00 dan keyin ham ishlasa (masalan 17:35 da ketdi = 35 min ortiqcha = +35 000 so'm)
const resOvertime = evaluateDayAttendance({ checkIn: '09:00', checkOut: '17:35', status: 'present' }, settings, baseSalary);
assert.strictEqual(resOvertime.overtimeMinutes, 35);
assert.strictEqual(resOvertime.overtimeBonusAmount, 35000);

// Test 6: Ham erta keldi (08:50 = +10k), ham kech ketdi (17:20 = +20k) -> Jami bonus: +30k
const resBoth = evaluateDayAttendance({ checkIn: '08:50', checkOut: '17:20', status: 'present' }, settings, baseSalary);
assert.strictEqual(resBoth.earlyBonusAmount, 10000);
assert.strictEqual(resBoth.overtimeBonusAmount, 20000);
assert.strictEqual(resBoth.totalBonusAmount, 30000);

console.log('✅ BARCHA 5 TA YANGI QOIDA TESTLARDAN 100% MUVAFFAQIYATLI OʻTDI!');
