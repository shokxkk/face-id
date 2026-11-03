/**
 * Kichik Tabib — Aniq qoidalar asosidagi hisob-kitob dvigateli:
 *
 * 1. Ish vaqti: 09:00 dan 17:00 gacha.
 * 2. Erta kelish: 09:00 dan oldin har 1 minut erta kelgani uchun minutiga 1 000 so'mdan BONUS.
 * 3. Kechikish: 09:10 gacha ruxsat etiladi (09:01–09:10 oralig'ida 0 so'm jarima).
 *    09:10 dan kech qolsa (09:11 va undan keyin) — har bir minut kechikkaniga 1 000 so'mdan JARIMA.
 * 4. Sababsiz umuman ishga kelmasa — bir kuniga 150 000 so'm qat'iy JARIMA (ayrilma).
 * 5. Ortiqcha ishlash (overtime): Soat 17:00 dan keyin ham ishlasa — 17:00 dan keyingi har bir minutiga 1 000 so'mdan qo'shimcha BONUS.
 */

function timeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const clean = timeStr.trim();
  const parts = clean.split(':').map(Number);
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
}

function minutesToTime(totalMinutes) {
  if (totalMinutes === null || totalMinutes === undefined || Number.isNaN(totalMinutes)) return '--:--';
  const clamped = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function evaluateDayAttendance(params, settings, employeeBaseSalary = 0) {
  const workStartStr = settings.work_start_time || '09:00';
  const workEndStr = settings.work_end_time || '17:00';
  const graceMinutes = Number(settings.grace_period_minutes ?? 10); // 09:10 gacha ruxsat
  const penaltyPerMinute = Number(settings.penalty_per_minute ?? 1000); // 1000 so'm/min jarima
  const penaltyMode = settings.penalty_calc_mode || 'all_minutes_if_over_grace';
  const earlyBonusPerMinute = Number(settings.early_bonus_per_minute ?? 1000); // 1000 so'm/min erta bonus
  const overtimeBonusPerMinute = Number(settings.overtime_bonus_per_minute ?? 1000); // 17:00 dan keyin 1000 so'm/min
  const absentFixedPenalty = Number(settings.absent_fixed_penalty ?? 150000); // 150 000 so'm kelmaganlik jarimasi

  const workStartMin = timeToMinutes(workStartStr); // 540 (09:00)
  const workEndMin = timeToMinutes(workEndStr);     // 1020 (17:00)
  const checkInMin = timeToMinutes(params.checkIn);
  const checkOutMin = timeToMinutes(params.checkOut);

  // Sababli ta'til / ruxsat
  if (params.status === 'leave') {
    return {
      status: 'leave',
      statusLabel: 'Ruxsatli / Taʼtil (Sababli)',
      isPresent: false,
      isAbsentUnexcused: false,
      lateMinutes: 0,
      isGraceLate: false,
      isPenalizedLate: false,
      penaltyMinutes: 0,
      penaltyAmount: 0,
      earlyMinutes: 0,
      earlyBonusAmount: 0,
      overtimeMinutes: 0,
      overtimeBonusAmount: 0,
      totalBonusAmount: 0,
      absenceDeduction: 0,
      workedMinutes: 0,
      workedHours: 0,
      note: 'Sababli ruxsat (jarimasiz)'
    };
  }

  // 4-QOIDA: Ishga umuman kelmasa — 150 000 so'm jarima
  if (checkInMin === null || params.status === 'absent') {
    return {
      status: 'absent',
      statusLabel: 'Ishga kelmadi (-150 000 soʻm)',
      isPresent: false,
      isAbsentUnexcused: true,
      lateMinutes: 0,
      isGraceLate: false,
      isPenalizedLate: false,
      penaltyMinutes: 0,
      penaltyAmount: 0,
      earlyMinutes: 0,
      earlyBonusAmount: 0,
      overtimeMinutes: 0,
      overtimeBonusAmount: 0,
      totalBonusAmount: 0,
      absenceDeduction: absentFixedPenalty, // Aniq 150 000 so'm
      workedMinutes: 0,
      workedHours: 0,
      note: `Umuman ishga kelmadi: -${absentFixedPenalty.toLocaleString('ru-RU')} so'm jarima`
    };
  }

  // Xodim ishga kelgan:
  let lateMinutes = 0;
  let isGraceLate = false;
  let isPenalizedLate = false;
  let penaltyMinutes = 0;
  let penaltyAmount = 0;

  let earlyMinutes = 0;
  let earlyBonusAmount = 0;

  // 2-QOIDA: 1 minut erta kelsa ham har bir minutiga 1 000 so'mdan bonus (09:00 gacha)
  if (checkInMin < workStartMin) {
    earlyMinutes = workStartMin - checkInMin;
    earlyBonusAmount = earlyMinutes * earlyBonusPerMinute;
  } else if (checkInMin > workStartMin) {
    // 3-QOIDA: 09:10 gacha ruxsat etiladi (jarima yo'q), 09:10 dan oshsa har minutiga 1000 so'm
    lateMinutes = checkInMin - workStartMin;
    if (lateMinutes <= graceMinutes) {
      isGraceLate = true;
      isPenalizedLate = false;
      penaltyMinutes = 0;
      penaltyAmount = 0;
    } else {
      isGraceLate = false;
      isPenalizedLate = true;
      if (penaltyMode === 'excess_only') {
        penaltyMinutes = lateMinutes - graceMinutes;
      } else {
        penaltyMinutes = lateMinutes; // Barcha kechikkan minutlar uchun
      }
      penaltyAmount = penaltyMinutes * penaltyPerMinute;
    }
  }

  // 5-QOIDA: Soat 17:00 dan keyin ham ishlasa — har bir minutiga 1 000 so'mdan qo'shimcha yoziladi
  let overtimeMinutes = 0;
  let overtimeBonusAmount = 0;

  if (checkOutMin !== null && checkOutMin > workEndMin) {
    overtimeMinutes = checkOutMin - workEndMin;
    overtimeBonusAmount = overtimeMinutes * overtimeBonusPerMinute;
  }

  // Ishlagan vaqti
  let workedMinutes = 0;
  if (checkOutMin !== null && checkOutMin > checkInMin) {
    workedMinutes = checkOutMin - checkInMin;
  } else if (checkOutMin === null) {
    workedMinutes = Math.max(0, workEndMin - checkInMin);
  }
  const workedHours = Number((workedMinutes / 60).toFixed(2));

  const totalBonusAmount = earlyBonusAmount + overtimeBonusAmount;

  // Status matni
  let statusLabel = 'Vaqtida keldi';
  const notes = [];
  if (earlyMinutes > 0) {
    statusLabel = `Erta keldi (+${earlyMinutes} min bonus)`;
    notes.push(`Erta keldi (+${earlyMinutes} min: +${earlyBonusAmount.toLocaleString('ru-RU')} so'm)`);
  } else if (isGraceLate) {
    statusLabel = `${lateMinutes} min kechikdi (Ruxsat: 0 so'm)`;
    notes.push(`${lateMinutes} min kechikdi (09:10 gacha jarima yo'q)`);
  } else if (isPenalizedLate) {
    statusLabel = `${lateMinutes} min kechikdi (Jarima: -${penaltyAmount.toLocaleString('ru-RU')})`;
    notes.push(`${lateMinutes} min kechikdi: -${penaltyAmount.toLocaleString('ru-RU')} so'm jarima`);
  }

  if (overtimeMinutes > 0) {
    statusLabel += ` + 17:00 dan keyin (+${overtimeMinutes} min)`;
    notes.push(`17:00 dan keyin ishladi (+${overtimeMinutes} min: +${overtimeBonusAmount.toLocaleString('ru-RU')} so'm)`);
  }

  return {
    status: 'present',
    statusLabel,
    isPresent: true,
    isAbsentUnexcused: false,
    lateMinutes,
    isGraceLate,
    isPenalizedLate,
    penaltyMinutes,
    penaltyAmount,
    earlyMinutes,
    earlyBonusAmount,
    overtimeMinutes,
    overtimeBonusAmount,
    totalBonusAmount,
    absenceDeduction: 0,
    workedMinutes,
    workedHours,
    note: notes.join(' | ') || 'Vaqtida keldi'
  };
}

function calculateMonthlyPayroll({ employee, records, advances = [], bonuses = [], settings, yearMonth }) {
  const baseSalary = Number(employee.base_salary || 0);
  const scheduledDays = Math.max(1, Number(settings.working_days_per_month ?? 26));

  let daysPresent = 0;
  let daysAbsent = 0;
  let daysLeave = 0;
  let daysGraceLate = 0;
  let daysPenalizedLate = 0;

  let totalWorkedMinutes = 0;
  let totalEarlyMinutes = 0;
  let totalEarlyBonusAmount = 0;
  let totalOvertimeMinutes = 0;
  let totalOvertimeBonusAmount = 0;
  let totalLateMinutes = 0;
  let totalPenaltyMinutes = 0;
  let totalLatePenaltyAmount = 0;
  let totalAbsenceDeduction = 0;

  const dailyBreakdown = [];

  for (const rec of records) {
    const ev = evaluateDayAttendance(
      {
        checkIn: rec.check_in,
        checkOut: rec.check_out,
        status: rec.status
      },
      settings,
      baseSalary
    );

    if (ev.status === 'present') {
      daysPresent++;
      totalWorkedMinutes += ev.workedMinutes;
      totalEarlyMinutes += ev.earlyMinutes;
      totalEarlyBonusAmount += ev.earlyBonusAmount;
      totalOvertimeMinutes += ev.overtimeMinutes;
      totalOvertimeBonusAmount += ev.overtimeBonusAmount;
      totalLateMinutes += ev.lateMinutes;
      totalPenaltyMinutes += ev.penaltyMinutes;
      totalLatePenaltyAmount += ev.penaltyAmount;

      if (ev.isGraceLate) daysGraceLate++;
      else if (ev.isPenalizedLate) daysPenalizedLate++;
    } else if (ev.status === 'absent') {
      daysAbsent++;
      totalAbsenceDeduction += ev.absenceDeduction; // Har bir kelmagan kun uchun 150 000 so'm
    } else if (ev.status === 'leave') {
      daysLeave++;
    }

    dailyBreakdown.push({
      ...rec,
      evaluation: ev
    });
  }

  const totalAdvanceAmount = advances
    .filter((a) => a.status === 'approved' || a.status === 'paid')
    .reduce((sum, a) => sum + Number(a.amount || 0), 0);

  const totalKpiBonus = bonuses
    .filter((b) => b.type === 'bonus' || b.type === 'kpi')
    .reduce((sum, b) => sum + Number(b.amount || 0), 0);

  const totalExtraFine = bonuses
    .filter((b) => b.type === 'fine')
    .reduce((sum, b) => sum + Number(b.amount || 0), 0);

  // Jami bonuslar (Erta kelish + 17:00 dan keyingi ish + KPI)
  const allBonuses = totalEarlyBonusAmount + totalOvertimeBonusAmount + totalKpiBonus;
  // Jami jarimalar (Kechikish jarimalari + Kelmaganlik 150 000 jarimasi + Boshqa jarimalar)
  const allPenaltiesAndDeductions = totalLatePenaltyAmount + totalAbsenceDeduction + totalExtraFine;

  // Yakuniy qo'lga tegadigan summa:
  // Oklad - Kelmagan kunlar jarimasi (har kuniga 150 000) + Erta bonus + 17:00 dan keyingi bonus + KPI - Kechikish jarimasi - Avans
  const finalToPay = Math.max(0, baseSalary - totalAbsenceDeduction + allBonuses - totalLatePenaltyAmount - totalExtraFine - totalAdvanceAmount);

  return {
    employee: {
      id: employee.id,
      full_name: employee.full_name,
      position: employee.position,
      department: employee.department,
      branch: employee.branch,
      phone: employee.phone,
      telegram_username: employee.telegram_username,
      base_salary: baseSalary,
      shift_start: employee.shift_start || settings.work_start_time || '09:00',
      shift_end: employee.shift_end || settings.work_end_time || '17:00'
    },
    yearMonth,
    scheduledDays,
    daysPresent,
    daysAbsent,
    daysLeave,
    daysGraceLate,
    daysPenalizedLate,
    totalWorkedHours: Number((totalWorkedMinutes / 60).toFixed(1)),
    totalEarlyMinutes,
    totalEarlyBonusAmount,
    totalOvertimeMinutes,
    totalOvertimeBonusAmount,
    totalLateMinutes,
    totalPenaltyMinutes,
    totalLatePenaltyAmount,
    totalAbsenceDeduction,
    totalKpiBonus,
    totalAdvanceAmount,
    totalBonuses: allBonuses,
    totalPenalties: totalLatePenaltyAmount + totalExtraFine,
    finalToPay,
    dailyBreakdown
  };
}

module.exports = {
  timeToMinutes,
  minutesToTime,
  evaluateDayAttendance,
  calculateMonthlyPayroll
};
