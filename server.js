const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  db,
  initDb,
  syncFromCloudDb,
  syncToCloudDb,
  resetAllAttendanceData,
  getSettingsMap,
  updateSettingsMap,
  getLocalTodayStr,
  getLocalYearMonthStr,
  getTashkentTimeHHMM
} = require('./src/db');

const {
  evaluateDayAttendance,
  calculateMonthlyPayroll
} = require('./src/payroll');

const {
  sendTelegramNotification,
  notifyAttendanceEvent,
  sendMonthlySummaryToTelegram,
  startTelegramPollingLoop,
  handleSingleTelegramUpdate,
  pushBrandedMenuToAdmin
} = require('./src/telegram');

const {
  parseHikvisionPayload,
  calculateGpsDistanceMeters
} = require('./src/hikvision');

initDb();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getLocalIpAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function readRequestBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return Promise.resolve(req.body);
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf-8'));
    if (typeof req.body === 'object') return Promise.resolve(JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 10 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', reject);
  });
}

function computeAllMonthlyPayrolls(yearMonth) {
  const ym = yearMonth || getLocalYearMonthStr();
  const settings = getSettingsMap();
  const employees = db.prepare(`SELECT * FROM employees WHERE active = 1 ORDER BY id ASC`).all();
  const allRecords = db.prepare(`SELECT * FROM attendance WHERE date LIKE ? ORDER BY date ASC`).all(`${ym}-%`);
  const allAdvances = db.prepare(`SELECT * FROM advances WHERE year_month = ? ORDER BY id DESC`).all(ym);
  const allBonuses = db.prepare(`SELECT * FROM kpi_bonuses WHERE year_month = ? ORDER BY id DESC`).all(ym);

  return employees.map((emp) => {
    const records = allRecords.filter((r) => r.employee_id === emp.id);
    const advances = allAdvances.filter((a) => a.employee_id === emp.id);
    const bonuses = allBonuses.filter((b) => b.employee_id === emp.id);
    return calculateMonthlyPayroll({
      employee: emp,
      records,
      advances,
      bonuses,
      settings,
      yearMonth: ym
    });
  });
}

function getTodayDashboardData(dateOverride) {
  const today = dateOverride || getLocalTodayStr();
  const settings = getSettingsMap();
  const employees = db.prepare(`SELECT * FROM employees WHERE active = 1 ORDER BY id ASC`).all();
  const attRows = db.prepare(`SELECT * FROM attendance WHERE date = ?`).all(today);
  const branches = db.prepare(`SELECT * FROM branches ORDER BY id ASC`).all();
  const tgLogs = db.prepare(`SELECT * FROM telegram_logs ORDER BY id DESC LIMIT 30`).all();
  const deviceEvents = db.prepare(`SELECT * FROM device_events ORDER BY id DESC LIMIT 25`).all();

  let countPresent = 0;
  let countEarlyBonus = 0;
  let countGraceLate = 0;
  let countPenalizedLate = 0;
  let countAbsent = 0;
  let todayBonusesSum = 0;
  let todayPenaltiesSum = 0;
  let todayAbsenceDeductionsSum = 0;

  const liveRows = employees.map((emp) => {
    const rec = attRows.find((r) => r.employee_id === emp.id) || {
      employee_id: emp.id,
      date: today,
      check_in: null,
      check_out: null,
      status: 'absent',
      source: 'Belgilanmagan',
      device_name: '—'
    };

    const evaluation = evaluateDayAttendance(
      {
        checkIn: rec.check_in,
        checkOut: rec.check_out,
        status: rec.status
      },
      settings,
      emp.base_salary
    );

    if (evaluation.isPresent) {
      countPresent++;
      if (evaluation.earlyMinutes > 0) countEarlyBonus++;
      if (evaluation.isGraceLate) countGraceLate++;
      if (evaluation.isPenalizedLate) countPenalizedLate++;
    } else if (evaluation.isAbsentUnexcused) {
      countAbsent++;
    }

    todayBonusesSum += evaluation.earlyBonusAmount;
    todayPenaltiesSum += evaluation.penaltyAmount;
    todayAbsenceDeductionsSum += evaluation.absenceDeduction;

    return {
      employee: emp,
      record: rec,
      evaluation
    };
  });

  return {
    today,
    serverLocalIp: getLocalIpAddress(),
    port: PORT,
    settings,
    branches,
    stats: {
      totalEmployees: employees.length,
      countPresent,
      countEarlyBonus,
      countGraceLate,
      countPenalizedLate,
      countAbsent,
      todayBonusesSum,
      todayPenaltiesSum,
      todayAbsenceDeductionsSum
    },
    liveRows,
    telegramLogs: tgLogs,
    deviceEvents
  };
}

async function processAttendanceAction({
  employeeId,
  empCode,
  date,
  time,
  action,
  source = 'Face ID Terminal',
  deviceName = 'Face ID Kamera',
  gpsLat = null,
  gpsLng = null,
  snapshotData = '',
  confidence = 99.5
}) {
  const settings = getSettingsMap();
  let emp = null;
  if (employeeId) {
    emp = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(Number(employeeId));
  } else if (empCode) {
    emp = db.prepare(`SELECT * FROM employees WHERE emp_code = ?`).get(String(empCode).trim());
  }
  if (!emp) {
    throw new Error('Xodim topilmadi');
  }

  const targetDate = date || getLocalTodayStr();
  const nowTime = time || getTashkentTimeHHMM();

  let gpsDistance = null;
  if (gpsLat !== null && gpsLng !== null && gpsLat !== undefined && gpsLng !== undefined) {
    const branch = db.prepare(`SELECT * FROM branches WHERE id = ?`).get(emp.branch_id) || {
      lat: Number(settings.office_lat || 41.2858),
      lng: Number(settings.office_lng || 69.2035),
      radius_meters: Number(settings.office_radius_meters || 200)
    };
    gpsDistance = calculateGpsDistanceMeters(gpsLat, gpsLng, branch.lat, branch.lng);
  }

  const existing = db.prepare(`SELECT * FROM attendance WHERE employee_id = ? AND date = ?`).get(emp.id, targetDate);

  let resolvedAction = action || 'auto';
  if (resolvedAction === 'auto') {
    if (!existing || !existing.check_in || existing.status === 'absent') {
      resolvedAction = 'checkin';
    } else {
      resolvedAction = 'checkout';
    }
  }

  let checkIn = existing?.check_in || null;
  let checkOut = existing?.check_out || null;
  let status = 'present';

  if (resolvedAction === 'absent') {
    checkIn = null;
    checkOut = null;
    status = 'absent';
  } else if (resolvedAction === 'leave') {
    checkIn = null;
    checkOut = null;
    status = 'leave';
  } else if (resolvedAction === 'checkin') {
    if (checkIn && source !== 'Admin Panel') {
      // Employee already checked in earlier today; don't overwrite morning arrival time
      if (nowTime >= '14:00') {
        resolvedAction = 'checkout';
        checkOut = nowTime;
      }
    } else {
      checkIn = nowTime;
    }
    status = 'present';
  } else if (resolvedAction === 'checkout') {
    if (!checkIn) checkIn = settings.work_start_time || '09:00';
    checkOut = nowTime;
    status = 'present';
  }

  const evaluation = evaluateDayAttendance(
    { checkIn, checkOut, status },
    settings,
    emp.base_salary
  );

  db.prepare(`
    INSERT INTO attendance (
      employee_id, date, check_in, check_out, status, source, device_name,
      gps_lat, gps_lng, gps_distance_m, snapshot_data, audit_note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_id, date) DO UPDATE SET
      check_in = excluded.check_in,
      check_out = excluded.check_out,
      status = excluded.status,
      source = excluded.source,
      device_name = excluded.device_name,
      gps_lat = COALESCE(excluded.gps_lat, attendance.gps_lat),
      gps_lng = COALESCE(excluded.gps_lng, attendance.gps_lng),
      gps_distance_m = COALESCE(excluded.gps_distance_m, attendance.gps_distance_m),
      snapshot_data = CASE WHEN excluded.snapshot_data != '' THEN excluded.snapshot_data ELSE attendance.snapshot_data END,
      audit_note = excluded.audit_note,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    emp.id,
    targetDate,
    checkIn,
    checkOut,
    status,
    source,
    deviceName,
    gpsLat,
    gpsLng,
    gpsDistance,
    snapshotData || '',
    evaluation.note
  );

  const nowFull = `${targetDate} ${new Date().toTimeString().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO device_events (created_at, device_type, emp_code, employee_name, action, confidence, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowFull,
    `${source} (${deviceName})`,
    emp.emp_code,
    emp.full_name,
    `${resolvedAction.toUpperCase()} (${checkIn || '--:--'} / ${checkOut || '--:--'})`,
    confidence,
    evaluation.note
  );

  const savedRecord = db.prepare(`SELECT * FROM attendance WHERE employee_id = ? AND date = ?`).get(emp.id, targetDate);

  // Sync to Cloud DB immediately before sending Telegram photos so data is always persisted first
  await syncToCloudDb(true);

  const tgResult = await notifyAttendanceEvent({
    employee: emp,
    record: savedRecord,
    evaluation,
    actionType: resolvedAction,
    settings
  });

  return {
    employee: emp,
    record: savedRecord,
    evaluation,
    action: resolvedAction,
    gpsDistance,
    telegram: tgResult
  };
}

function euclideanDistance(arr1, arr2) {
  if (!Array.isArray(arr1) || !Array.isArray(arr2) || arr1.length !== arr2.length || arr1.length === 0) {
    return Infinity;
  }
  let sum = 0;
  for (let i = 0; i < arr1.length; i++) {
    const d = Number(arr1[i]) - Number(arr2[i]);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * O'zbek tilidagi AI Yordamchi
 */
async function answerAiQuestion(questionRaw, yearMonth) {
  const q = (questionRaw || '').toLowerCase();
  const ym = yearMonth || getLocalYearMonthStr();
  const dash = getTodayDashboardData();
  const payrolls = computeAllMonthlyPayrolls(ym);
  const settings = dash.settings;

  // If OpenAI API Key is configured, query ChatGPT with real database context
  const openAiKey = (settings.openai_api_key || '').trim();
  if (openAiKey && openAiKey.startsWith('sk-')) {
    try {
      const contextSummary = payrolls.map((p) =>
        `${p.employee.full_name} (Oklad: ${p.employee.base_salary} so'm): Keldi=${p.daysPresent} kun, Kelmadi=${p.daysAbsent} kun (Ayrilma: -${p.totalAbsenceDeduction}), Erta bonus(08:30)=+${p.totalEarlyBonusAmount} so'm, 5-10min jarimasiz=${p.daysGraceLate} marta, >10min jarima=-${p.totalLatePenaltyAmount} so'm (${p.totalPenaltyMinutes} min), Avans=-${p.totalAdvanceAmount}, Qo'lga tegadigan oylik=${p.finalToPay} so'm`
      ).join('\n');

      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openAiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                `Sen Kichik Tabib HR va Buxgalteriya AI yordamchisisan. Faqat O'zbek tilida aniq javob ber.\n` +
                `Kompaniya qoidalari: Ish vaqti 09:00 dan 17:00 gacha. 09:00 dan oldin har 1 minut erta kelsa har bir minutiga +1 000 so'm bonus. 09:10 gacha ruxsat (0 so'm jarima). 09:10 dan kech qolsa har bir minutiga -1 000 so'm jarima. Sababsiz umuman ishga kelmasa bir kuniga -150 000 so'm jarima. Soat 17:00 dan keyin ham ishlasa har bir minutiga +1 000 so'mdan qo'shimcha yoziladi.\n` +
                `Bazadagi haqiqiy ma'lumotlar (${ym}):\n${contextSummary}`
            },
            { role: 'user', content: questionRaw }
          ],
          temperature: 0.2
        })
      });
      const aiJson = await aiRes.json();
      if (aiJson.choices && aiJson.choices[0]?.message?.content) {
        return { answer: aiJson.choices[0].message.content };
      }
    } catch {
      // Fallback to built-in analyzer below
    }
  }

  if (q.includes('kech') || q.includes('jarima') || q.includes('опозд') || q.includes('штраф')) {
    const sortedLate = [...payrolls].sort((a, b) => b.daysPenalizedLate - a.daysPenalizedLate || b.totalLateMinutes - a.totalLateMinutes);
    const lines = sortedLate.map((p, i) =>
      `${i + 1}. **${p.employee.full_name}** — Jarimali kechikish (>10 min): **${p.daysPenalizedLate} marta** (${p.totalPenaltyMinutes} min, jarima **-${p.totalLatePenaltyAmount.toLocaleString('ru-RU')} so'm**), Imtiyozli (10 min gacha jarimasiz): **${p.daysGraceLate} marta**.`
    );
    return {
      answer:
        `📊 **${ym} oyi boʻyicha kechikishlar va jarimalar hisoboti:**\n\n` +
        `Qoidaga koʻra (ish boshlanishi **${settings.work_start_time}**):\n` +
        `• **${settings.grace_period_minutes} daqiqagacha** kechikish (09:10 gacha) — **0 so'm jarima**.\n` +
        `• **${settings.grace_period_minutes} daqiqadan oshsa** — har bir daqiqaga **-${Number(settings.penalty_per_minute).toLocaleString('ru-RU')} so'm** jarima.\n\n` +
        lines.join('\n')
    };
  }

  if (q.includes('bonus') || q.includes('erta') || q.includes('8:30') || q.includes('бонус')) {
    const sortedEarly = [...payrolls].sort((a, b) => b.totalEarlyBonusAmount - a.totalEarlyBonusAmount);
    const lines = sortedEarly.map((p, i) =>
      `${i + 1}. **${p.employee.full_name}** — Erta kelgan kunlari: **${p.daysEarlyBonus} kun** (+${p.totalEarlyMinutes} min 09:00 gacha), yozilgan bonus: **+${p.totalEarlyBonusAmount.toLocaleString('ru-RU')} so'm**.`
    );
    return {
      answer:
        `🌟 **Erta kelganlik bonusi (${settings.early_bonus_start_time} dan ${settings.work_start_time} gacha ishlaganlik uchun) — ${ym}:**\n\n` +
        lines.join('\n')
    };
  }

  if (q.includes('kelma') || q.includes('bugun') || q.includes('yoʻq') || q.includes('не приш')) {
    const absentToday = dash.liveRows.filter((r) => !r.evaluation.isPresent);
    const presentToday = dash.liveRows.filter((r) => r.evaluation.isPresent);
    const absText = absentToday.length > 0
      ? absentToday.map((r) => `• ❌ **${r.employee.full_name}** — ${r.evaluation.statusLabel}, okladidan ayrildi: **-${r.evaluation.absenceDeduction.toLocaleString('ru-RU')} so'm**`).join('\n')
      : '• Barcha xodimlar bugun ish joyida!';
    const presText = presentToday.map((r) => `• ✅ **${r.employee.full_name}** — soat **${r.record.check_in}** da keldi (${r.evaluation.statusLabel})`).join('\n');

    return {
      answer:
        `📅 **Bugungi davomat maʼlumoti (${dash.today}):**\n` +
        `Ishda: **${presentToday.length}** / **${dash.stats.totalEmployees}** xodim.\n\n` +
        `**Ishga kelganlar:**\n${presText}\n\n` +
        `**Ishga kelmaganlar:**\n${absText}`
    };
  }

  const totalNet = payrolls.reduce((s, p) => s + p.finalToPay, 0);
  const rows = payrolls.map((p, i) =>
    `${i + 1}. **${p.employee.full_name}** (Oklad: ${p.employee.base_salary.toLocaleString('ru-RU')}) — Keldi: **${p.daysPresent} kun**, Kelmadi: **${p.daysAbsent} kun** (-${p.totalAbsenceDeduction.toLocaleString('ru-RU')} so'm), Erta bonus: **+${p.totalEarlyBonusAmount.toLocaleString('ru-RU')} so'm**, Jarima (>10 min): **-${p.totalLatePenaltyAmount.toLocaleString('ru-RU')} so'm**, Avans: **-${p.totalAdvanceAmount.toLocaleString('ru-RU')} so'm** ➔ **Qoʻlga tegishi: ${p.finalToPay.toLocaleString('ru-RU')} so'm**`
  );

  return {
    answer:
      `💰 **${ym} oyi yakuni boʻyicha toʻliq hisob-kitob (kim necha kun keldi va qancha oylik oladi):**\n\n` +
      rows.join('\n') +
      `\n\n🏦 **Jami barcha xodimlarga toʻlanadigan summa:** **${totalNet.toLocaleString('ru-RU')} so'm**.`
  };
}

function getBotAppContext() {
  return {
    getCurrentYearMonth: () => getLocalYearMonthStr(),
    getMonthlyPayrolls: () => computeAllMonthlyPayrolls(getLocalYearMonthStr()),
    askAi: (q) => answerAiQuestion(q, getLocalYearMonthStr()),
    recordFromTelegramBot: async ({ employeeId, time, action }) => {
      return processAttendanceAction({
        employeeId,
        time,
        action,
        source: 'Kichik Tabib Bot',
        deviceName: 'Telegram Bot'
      });
    },
    giveAdvanceFromTelegramBot: async ({ employeeId, amount }) => {
      const today = getLocalTodayStr();
      const ym = getLocalYearMonthStr();
      const emp = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(Number(employeeId));
      if (!emp) return;
      db.prepare(`
        INSERT INTO advances (employee_id, year_month, date, amount, reason, status, approved_by)
        VALUES (?, ?, ?, ?, 'Telegram Bot orqali avans', 'approved', 'Rahbar')
      `).run(emp.id, ym, today, Number(amount));

      await sendTelegramNotification({
        eventType: 'ADVANCE_APPROVED',
        recipientLabel: `Kichik Tabib · ${emp.full_name}`,
        chatId: emp.telegram_chat_id,
        text:
          `🌿 <b>KICHIK TABIB — AVANS BERILDI</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>Xodim:</b> ${emp.full_name}\n` +
          `💳 <b>Avans summasi:</b> <code>-${Number(amount).toLocaleString('ru-RU')} so'm</code>\n` +
          `📅 <b>Sana:</b> ${today}`
      });
    },
    getEmployeeCardHtml: (employeeId) => {
      const ym = getLocalYearMonthStr();
      const payrolls = computeAllMonthlyPayrolls(ym);
      const p = payrolls.find((item) => item.employee.id === Number(employeeId)) || payrolls[0];
      const dash = getTodayDashboardData();
      const todayRow = dash.liveRows.find((r) => r.employee.id === p.employee.id);
      const todayStatus = todayRow?.evaluation?.statusLabel || 'Belgilanmagan';
      const todayIn = todayRow?.record?.check_in || '--:--';
      const todayOut = todayRow?.record?.check_out || '--:--';

      return (
        `🌿 <b>KICHIK TABIB — XODIM KARTASI</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Xodim:</b> <b>${p.employee.full_name}</b>\n` +
        `💵 <b>Oylik okladi:</b> <code>${p.employee.base_salary.toLocaleString('ru-RU')} so'm</code>\n\n` +
        `📍 <b>Bugungi holati (${dash.today}):</b>\n` +
        `   • Keldi: <code>${todayIn}</code> | Ketdi: <code>${todayOut}</code>\n` +
        `   • Holat: <b>${todayStatus}</b>\n\n` +
        `📊 <b>Shu oydagi hisob-kitob (${ym}):</b>\n` +
        `   • Ishga kelgan: <b>${p.daysPresent} kun</b> (Kelmadi: ${p.daysAbsent} kun)\n` +
        `   • 🌟 Erta bonus (09:00 gacha): <code>+${p.totalEarlyBonusAmount.toLocaleString('ru-RU')} so'm</code>\n` +
        `   • 🛡 09:10 gacha (jarimasiz): <b>${p.daysGraceLate} marta</b>\n` +
        `   • ⚠️ Kechikish jarimasi (&gt;09:10): <code>-${p.totalLatePenaltyAmount.toLocaleString('ru-RU')} so'm</code>\n` +
        `   • 📉 Kelmaganlik jarimasi: <code>-${p.totalAbsenceDeduction.toLocaleString('ru-RU')} so'm</code>\n` +
        `   • 💳 Olgan avansi: <code>-${p.totalAdvanceAmount.toLocaleString('ru-RU')} so'm</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>QOʻLGA TEGADIGAN OYLIK:</b> <code>${p.finalToPay.toLocaleString('ru-RU')} so'm</code>\n\n` +
        `👇 <b>Kerakli tugmani bosing:</b>`
      );
    },
    getTodayQuickText: () => {
      const d = getTodayDashboardData();
      const lines = d.liveRows.map((r, i) => {
        if (r.evaluation.isPresent) {
          const icon = r.evaluation.earlyMinutes > 0 ? '🌟' : r.evaluation.isPenalizedLate ? '⚠️' : '🟢';
          return `${i + 1}. ${icon} <b>${r.employee.full_name}</b> — <code>${r.record.check_in}</code> (${r.evaluation.statusLabel})`;
        }
        return `${i + 1}. 🔴 <b>${r.employee.full_name}</b> — Kelmadi (<code>-${r.evaluation.absenceDeduction.toLocaleString('ru-RU')} so'm</code>)`;
      });
      return (
        `🌿 <b>KICHIK TABIB — BUGUNGI DAVOMAT (${d.today})</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🟢 Ishda: <b>${d.stats.countPresent}</b> / ${d.stats.totalEmployees} xodim\n\n` +
        lines.join('\n') +
        `\n\n👇 <i>Xodim ustiga bosib oʻzgartirishingiz mumkin:</i>`
      );
    }
  };
}

if (!process.env.VERCEL) {
  startTelegramPollingLoop(getBotAppContext);
}

const appHandler = async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = parsedUrl.searchParams.get('__path') || parsedUrl.pathname;
    if (!pathname.startsWith('/')) pathname = '/' + pathname;

    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/')) {
      await syncFromCloudDb();
    }

    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const dateParam = parsedUrl.searchParams.get('date') || getLocalTodayStr();
      const data = getTodayDashboardData(dateParam);
      sendJson(res, 200, data);
      return;
    }

    if (pathname === '/api/payroll' && req.method === 'GET') {
      const monthParam = parsedUrl.searchParams.get('month') || getLocalYearMonthStr();
      const payrolls = computeAllMonthlyPayrolls(monthParam);
      const settings = getSettingsMap();

      const totals = payrolls.reduce(
        (acc, p) => {
          acc.baseSalary += p.employee.base_salary;
          acc.absenceDeduction += p.totalAbsenceDeduction;
          acc.earlyBonus += p.totalEarlyBonusAmount;
          acc.kpiBonus += p.totalKpiBonus;
          acc.latePenalty += p.totalLatePenaltyAmount;
          acc.advances += p.totalAdvanceAmount;
          acc.finalToPay += p.finalToPay;
          return acc;
        },
        {
          baseSalary: 0,
          absenceDeduction: 0,
          earlyBonus: 0,
          kpiBonus: 0,
          latePenalty: 0,
          advances: 0,
          finalToPay: 0
        }
      );

      sendJson(res, 200, {
        yearMonth: monthParam,
        settings,
        totals,
        payrolls
      });
      return;
    }

    if (pathname === '/api/payroll/export' && req.method === 'GET') {
      const monthParam = parsedUrl.searchParams.get('month') || getLocalYearMonthStr();
      const payrolls = computeAllMonthlyPayrolls(monthParam);

      const headers = [
        'Tabel raqami',
        'Xodim F.I.Sh.',
        'Lavozimi',
        'Filial',
        'Oylik okladi (so\'m)',
        'Rejadagi ish kunlari',
        'Haqiqatda kelgan kunlari',
        'Kelmagan kunlari (Progul)',
        'Kelmaganlik uchun ayrilgan (so\'m)',
        'Erta kelgan kunlari (08:30)',
        'Erta ishlagan daqiqalari (09:00 gacha)',
        'Erta kelganlik bonusi (so\'m)',
        '5-10 min kechikish (jarimasiz)',
        '>10 min kechikishlar soni',
        'Jarimali daqiqalar (>10 min)',
        'Kechikish jarimasi (so\'m)',
        'KPI va mukofotlar (so\'m)',
        'Olgan avansi (so\'m)',
        'QO\'LGA TEGADIGAN OYLIK (so\'m)'
      ];

      const csvRows = [headers.join(';')];
      for (const p of payrolls) {
        const emp = db.prepare(`SELECT emp_code FROM employees WHERE id = ?`).get(p.employee.id);
        csvRows.push([
          emp?.emp_code || `EMP-${p.employee.id}`,
          `"${p.employee.full_name}"`,
          `"${p.employee.position}"`,
          `"${p.employee.branch}"`,
          p.employee.base_salary,
          p.scheduledDays,
          p.daysPresent,
          p.daysAbsent,
          p.totalAbsenceDeduction,
          p.daysEarlyBonus,
          p.totalEarlyMinutes,
          p.totalEarlyBonusAmount,
          p.daysGraceLate,
          p.daysPenalizedLate,
          p.totalPenaltyMinutes,
          p.totalLatePenaltyAmount,
          p.totalKpiBonus,
          p.totalAdvanceAmount,
          p.finalToPay
        ].join(';'));
      }

      const csvContent = '\uFEFF' + csvRows.join('\r\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="FaceID_Tabel_Oylik_${monthParam}.csv"`
      });
      res.end(csvContent);
      return;
    }

    if (pathname === '/api/calculator/preview' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      const settings = getSettingsMap();
      const result = evaluateDayAttendance(
        {
          checkIn: body.checkIn,
          checkOut: body.checkOut || '18:00',
          status: body.status || 'present'
        },
        settings,
        Number(body.baseSalary || 2000000)
      );
      sendJson(res, 200, { result, settings });
      return;
    }

    if (pathname === '/api/attendance/checkin' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      let targetEmpId = body.employeeId;
      const hasValidDescriptor = Array.isArray(body.faceDescriptor) && body.faceDescriptor.length === 128;

      if (hasValidDescriptor) {
        const emps = db.prepare(`SELECT * FROM employees WHERE active = 1 AND face_descriptor != ''`).all();
        let bestMatch = null;
        let bestDist = Infinity;
        for (const e of emps) {
          if (typeof e.face_descriptor !== 'string' || e.face_descriptor.length < 50) continue;
          try {
            const desc = JSON.parse(e.face_descriptor);
            if (!Array.isArray(desc) || desc.length !== 128) continue;
            const dist = euclideanDistance(body.faceDescriptor, desc);
            if (dist < bestDist) {
              bestDist = dist;
              bestMatch = e;
            }
          } catch {
            // ignore
          }
        }

        if (!targetEmpId && bestMatch && bestDist <= 0.55) {
          targetEmpId = bestMatch.id;
        }

        if (targetEmpId) {
          const chosenEmp = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(Number(targetEmpId));
          if (chosenEmp) {
            let validChosenDesc = null;
            if (typeof chosenEmp.face_descriptor === 'string' && chosenEmp.face_descriptor.length > 50) {
              try {
                const parsed = JSON.parse(chosenEmp.face_descriptor);
                if (Array.isArray(parsed) && parsed.length === 128) validChosenDesc = parsed;
              } catch {}
            }
            // 1) If chosen employee already has a registered face descriptor, verify match
            if (validChosenDesc) {
              const chosenDist = euclideanDistance(body.faceDescriptor, validChosenDesc);
              if (chosenDist > 0.55) {
                sendJson(res, 403, {
                  ok: false,
                  antiSpoofBlocked: true,
                  error: `⛔️ DIQQAT! Yuzingiz ${chosenEmp.full_name} ga mos kelmadi! Boshqa odam oʻrniga belgilash taqiqlangan!`
                });
                return;
              }
            } else {
              // 2) If chosen employee has NO face registered yet, check that this face isn't already registered to someone else
              if (bestMatch && bestMatch.id !== chosenEmp.id && bestDist <= 0.50) {
                sendJson(res, 403, {
                  ok: false,
                  antiSpoofBlocked: true,
                  error: `⛔️ DIQQAT! Kameradagi yuz ${bestMatch.full_name} ga biriktirilgan! ${chosenEmp.full_name} nomidan kirish taqiqlangan!`
                });
                return;
              }
              // Auto-enroll 68-point / 128D face signature for this employee on first scan
              db.prepare(`
                UPDATE employees
                SET face_registered = 1,
                    face_descriptor = ?,
                    face_photo = ?
                WHERE id = ?
              `).run(
                JSON.stringify(body.faceDescriptor),
                body.snapshotData || '',
                chosenEmp.id
              );
            }
          }
        }
      }

      const result = await processAttendanceAction({
        employeeId: targetEmpId,
        empCode: body.empCode,
        date: body.date,
        time: body.time,
        action: body.action || 'auto',
        source: body.source || 'Face ID Kamera',
        deviceName: body.deviceName || 'AI Face ID (68 nuqta)',
        gpsLat: body.gpsLat ?? null,
        gpsLng: body.gpsLng ?? null,
        snapshotData: body.snapshotData || '',
        confidence: body.confidence || 99.5
      });

      await syncToCloudDb(true);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === '/api/attendance/reset-data' && req.method === 'POST') {
      const resData = resetAllAttendanceData();
      await syncToCloudDb(true);
      sendJson(res, 200, { ok: true, message: 'Barcha davomat, jarima va test maʼlumotlari 0 qilindi (tozalandi)', ...resData });
      return;
    }

    if (pathname === '/api/hikvision/event' && req.method === 'POST') {
      const rawBody = await readRequestBody(req);
      const parsed = parseHikvisionPayload(rawBody, req.headers['content-type']);

      if (!parsed) {
        sendJson(res, 400, { ok: false, error: 'Hikvision ISAPI paketi tushunarsiz' });
        return;
      }

      let emp = null;
      if (parsed.empCode) {
        emp = db.prepare(`SELECT * FROM employees WHERE emp_code = ? OR CAST(id AS TEXT) = ?`).get(parsed.empCode, parsed.empCode);
      }
      if (!emp && parsed.employeeName) {
        emp = db.prepare(`SELECT * FROM employees WHERE lower(full_name) LIKE ?`).get(`%${parsed.employeeName.toLowerCase()}%`);
      }
      if (!emp) {
        emp = db.prepare(`SELECT * FROM employees ORDER BY id ASC LIMIT 1`).get();
      }

      let eventTime = null;
      let eventDate = getLocalTodayStr();
      if (parsed.dateTime) {
        const matchTime = String(parsed.dateTime).match(/(\d{2}:\d{2})/);
        const matchDate = String(parsed.dateTime).match(/(\d{4}-\d{2}-\d{2})/);
        if (matchTime) eventTime = matchTime[1];
        if (matchDate) eventDate = matchDate[1];
      }

      let mappedAction = 'auto';
      if (parsed.attendanceStatus === 'checkIn' || parsed.attendanceStatus === 'checkin') mappedAction = 'checkin';
      else if (parsed.attendanceStatus === 'checkOut' || parsed.attendanceStatus === 'checkout') mappedAction = 'checkout';

      const result = await processAttendanceAction({
        employeeId: emp.id,
        date: eventDate,
        time: eventTime,
        action: mappedAction,
        source: 'Hikvision Face ID (ISAPI)',
        deviceName: parsed.deviceName || 'Hikvision DS-K1T341AMF',
        confidence: 99.8
      });

      await syncToCloudDb(true);
      sendJson(res, 200, { ok: true, hikvisionParsed: parsed, ...result });
      return;
    }

    if (pathname === '/api/employees' && req.method === 'GET') {
      const employees = db.prepare(`SELECT * FROM employees WHERE active = 1 ORDER BY id ASC`).all();
      const branches = db.prepare(`SELECT * FROM branches ORDER BY id ASC`).all();
      sendJson(res, 200, { employees, branches });
      return;
    }

    if (pathname === '/api/employees' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');

      // Update existing employee if ID passed
      if (body.id) {
        db.prepare(`
          UPDATE employees
          SET full_name = ?,
              position = ?,
              base_salary = ?,
              phone = ?,
              telegram_username = ?
          WHERE id = ?
        `).run(
          body.full_name,
          body.position || 'Xodim',
          Number(body.base_salary || 2000000),
          body.phone || '',
          body.telegram_username || '',
          Number(body.id)
        );
        await syncToCloudDb(true);
        const updated = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(Number(body.id));
        sendJson(res, 200, { ok: true, employee: updated });
        return;
      }

      // Otherwise create new employee
      const count = db.prepare(`SELECT COUNT(*) AS cnt FROM employees`).get().cnt;
      const empCode = body.emp_code || `EMP-0${count + 1}`;
      const colors = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2', '#10b981'];
      const color = colors[count % colors.length];

      const info = db.prepare(`
        INSERT INTO employees (
          emp_code, full_name, position, department, branch_id, branch,
          base_salary, phone, telegram_username, telegram_chat_id,
          shift_start, shift_end, avatar_color, face_registered, face_descriptor, face_photo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        empCode,
        body.full_name || 'Yangi xodim',
        body.position || 'Xodim',
        body.department || 'Asosiy boʻlim',
        Number(body.branch_id || 1),
        body.branch || 'Asosiy filial',
        Number(body.base_salary || 2000000),
        body.phone || '',
        body.telegram_username || '',
        body.telegram_chat_id || '',
        body.shift_start || '09:00',
        body.shift_end || '18:00',
        color,
        1,
        body.face_descriptor ? JSON.stringify(body.face_descriptor) : '',
        body.face_photo || ''
      );

      await syncToCloudDb(true);
      const created = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(info.lastInsertRowid);
      sendJson(res, 201, { ok: true, employee: created });
      return;
    }

    if (pathname.startsWith('/api/employees/') && pathname.endsWith('/face') && req.method === 'POST') {
      const parts = pathname.split('/');
      const empId = Number(parts[3]);
      const body = JSON.parse(await readRequestBody(req) || '{}');

      db.prepare(`
        UPDATE employees
        SET face_registered = 1,
            face_descriptor = ?,
            face_photo = ?
        WHERE id = ?
      `).run(
        body.faceDescriptor ? JSON.stringify(body.faceDescriptor) : '',
        body.facePhoto || '',
        empId
      );

      await syncToCloudDb(true);
      const updated = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(empId);
      sendJson(res, 200, { ok: true, employee: updated });
      return;
    }

    if (pathname.startsWith('/api/employees/') && req.method === 'DELETE') {
      const empId = Number(pathname.split('/')[3]);
      db.prepare(`DELETE FROM employees WHERE id = ?`).run(empId);
      await syncToCloudDb(true);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/finance' && req.method === 'GET') {
      const ym = parsedUrl.searchParams.get('month') || getLocalYearMonthStr();
      const advances = db.prepare(`
        SELECT a.*, e.full_name, e.branch, e.position
        FROM advances a
        JOIN employees e ON e.id = a.employee_id
        WHERE a.year_month = ?
        ORDER BY a.id DESC
      `).all(ym);

      const bonuses = db.prepare(`
        SELECT b.*, e.full_name, e.branch, e.position
        FROM kpi_bonuses b
        JOIN employees e ON e.id = b.employee_id
        WHERE b.year_month = ?
        ORDER BY b.id DESC
      `).all(ym);

      sendJson(res, 200, { yearMonth: ym, advances, bonuses });
      return;
    }

    if (pathname === '/api/advances' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      const today = getLocalTodayStr();
      const ym = body.year_month || getLocalYearMonthStr();
      const emp = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(Number(body.employee_id));

      db.prepare(`
        INSERT INTO advances (employee_id, year_month, date, amount, reason, status, approved_by)
        VALUES (?, ?, ?, ?, ?, 'approved', 'Rahbar')
      `).run(
        Number(body.employee_id),
        ym,
        today,
        Number(body.amount || 500000),
        body.reason || 'Oylik hisobidan avans'
      );

      if (emp) {
        await sendTelegramNotification({
          eventType: 'ADVANCE_APPROVED',
          recipientLabel: `Buxgalteriya + ${emp.full_name}`,
          chatId: emp.telegram_chat_id,
          text:
            `💳 [FaceID Pro] AVANS BERILDI\n` +
            `👤 Xodim: ${emp.full_name}\n` +
            `💵 Avans summasi: ${Number(body.amount).toLocaleString('ru-RU')} so'm\n` +
            `📝 Izoh: ${body.reason || 'Oylik hisobidan avans'}`
        });
      }

      await syncToCloudDb(true);
      sendJson(res, 201, { ok: true });
      return;
    }

    if (pathname === '/api/bonuses' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      const today = getLocalTodayStr();
      const ym = body.year_month || getLocalYearMonthStr();
      db.prepare(`
        INSERT INTO kpi_bonuses (employee_id, year_month, date, type, amount, comment)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        Number(body.employee_id),
        ym,
        today,
        body.type || 'kpi',
        Number(body.amount || 200000),
        body.comment || 'KPI mukofoti'
      );
      await syncToCloudDb(true);
      sendJson(res, 201, { ok: true });
      return;
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      sendJson(res, 200, {
        settings: getSettingsMap(),
        serverLocalIp: getLocalIpAddress(),
        port: PORT
      });
      return;
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      const updated = updateSettingsMap(body);
      await syncToCloudDb(true);
      sendJson(res, 200, { ok: true, settings: updated });
      return;
    }

    if (pathname === '/api/telegram/test' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      if (body.telegram_bot_token !== undefined || body.telegram_admin_chat_id !== undefined) {
        updateSettingsMap({
          telegram_bot_token: body.telegram_bot_token,
          telegram_admin_chat_id: body.telegram_admin_chat_id
        });
      }
      const settings = getSettingsMap();
      const result = await sendTelegramNotification({
        eventType: 'TEST_MESSAGE',
        recipientLabel: 'Telegram bot sinov xabari',
        chatId: settings.telegram_admin_chat_id,
        text:
          `✅ [FaceID Pro K4] Telegram xabarnoma tizimi muvaffaqiyatli ulandi!\n\n` +
          `Oʻrnatilgan qoidalar:\n` +
          `• Ish boshlanish vaqti: ${settings.work_start_time}\n` +
          `• Imtiyozli kechikish (jarimasiz): ${settings.grace_period_minutes} daqiqagacha (09:10 gacha)\n` +
          `• ${settings.grace_period_minutes} daqiqadan oshsa jarima: har bir daqiqaga ${Number(settings.penalty_per_minute).toLocaleString('ru-RU')} so'm\n` +
          `• Erta kelish bonusi (${settings.early_bonus_start_time}–${settings.work_start_time}): har bir daqiqaga +${Number(settings.early_bonus_per_minute).toLocaleString('ru-RU')} so'm\n` +
          `• Ishga kelmasa: 1 kunlik oklad ayriladi (Oklad / ${settings.working_days_per_month} kun)`
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === '/api/telegram/send-monthly-report' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      const ym = body.month || getLocalYearMonthStr();
      const payrolls = computeAllMonthlyPayrolls(ym);
      const result = await sendMonthlySummaryToTelegram(payrolls, ym);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === '/api/telegram/webhook' && req.method === 'POST') {
      const upd = JSON.parse(await readRequestBody(req) || '{}');
      await handleSingleTelegramUpdate(upd, getBotAppContext);
      await syncToCloudDb(true);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/telegram/setup-webhook' && (req.method === 'GET' || req.method === 'POST')) {
      const settings = getSettingsMap();
      const token = (settings.telegram_bot_token || '').trim();
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = `${proto}://${host}`;
      const webhookUrl = `${baseUrl}/api/telegram/webhook`;

      const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl })
      });
      const tgJson = await tgRes.json();

      // Also set Telegram Bot Menu Button to open the Mini App
      try {
        await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            menu_button: {
              type: 'web_app',
              text: '🌿 Face ID Kirish',
              web_app: { url: baseUrl }
            }
          })
        });
      } catch {
        // ignore
      }

      sendJson(res, 200, {
        ok: true,
        webhookUrl,
        miniAppUrl: baseUrl,
        adminPanelUrl: `${baseUrl}/admin`,
        telegramResponse: tgJson
      });
      return;
    }

    if (pathname === '/api/ai/ask' && req.method === 'POST') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      const reply = await answerAiQuestion(body.question, body.month);
      sendJson(res, 200, reply);
      return;
    }

    let fileRoute = pathname;
    if (fileRoute === '/' || fileRoute === '/webapp') fileRoute = '/index.html';
    else if (fileRoute === '/admin' || fileRoute === '/panel') fileRoute = '/admin.html';
    else if (fileRoute === '/terminal') fileRoute = '/terminal.html';

    const safePath = path.normalize(fileRoute).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(PUBLIC_DIR, safePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'Sahifa topilmadi' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Server xatosi' });
  }
};

module.exports = appHandler;

if (!process.env.VERCEL) {
  const server = http.createServer(appHandler);
  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIpAddress();
    console.log(`=============================================================`);
    console.log(`🌿 Kichik Tabib — FaceID va Oylik Mini App ishga tushdi!`);
    console.log(`📱 Mini App (Xodimlar uchun):  http://localhost:${PORT}`);
    console.log(`🛠 Admin Panel (Rahbar uchun): http://localhost:${PORT}/admin`);
    console.log(`📷 Face ID Terminal (Kamera):  http://localhost:${PORT}/terminal`);
    console.log(`📱 Telefon orqali (Wi-Fi):     http://${ip}:${PORT}`);
    console.log(`=============================================================`);
    pushBrandedMenuToAdmin().catch(() => {});
  });
}
