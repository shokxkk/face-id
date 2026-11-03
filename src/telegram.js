const fs = require('node:fs');
const path = require('node:path');
const { db, getSettingsMap, updateSettingsMap, getLocalTodayStr } = require('./db');

let pollingActive = false;
let lastUpdateId = 0;
let currentToken = '';
let cachedLogoFileId = null;
let publicWebAppUrl = '';

function setPublicWebAppUrl(url) {
  publicWebAppUrl = url || '';
}

function getPublicWebAppUrl() {
  return publicWebAppUrl;
}

function nowTimestampStr() {
  const now = new Date();
  const date = getLocalTodayStr();
  const time = now.toTimeString().slice(0, 8);
  return `${date} ${time}`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildMainReplyKeyboard() {
  const rows = [
    [{ text: '🟢 Keldi / Ketdi belgilash' }, { text: '📊 Bugungi davomat' }],
    [{ text: '💰 Oylik hisob-kitob' }, { text: '💳 Avans berish' }]
  ];
  if (publicWebAppUrl && publicWebAppUrl.startsWith('https://')) {
    rows.unshift([
      {
        text: '🌿 Kichik Tabib Mini App (Ochish)',
        web_app: { url: publicWebAppUrl }
      }
    ]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true
  };
}

/**
 * Helper to get all target Chat IDs (Group Chat ID + Admin Chat ID) so notifications go to the Group!
 */
function getTargetChatIds(explicitChatId, settings) {
  if (explicitChatId) return [String(explicitChatId).trim()];
  const ids = new Set();
  if (settings.telegram_group_chat_id) {
    ids.add(String(settings.telegram_group_chat_id).trim());
  }
  if (settings.telegram_admin_chat_id) {
    ids.add(String(settings.telegram_admin_chat_id).trim());
  }
  return Array.from(ids).filter(Boolean);
}

/**
 * Sends a base64 photo snapshot (`data:image/jpeg;base64,...`) or logo photo to a Telegram chat with HTML caption!
 */
async function sendPhotoToChat({ token, chatId, base64Image, captionHtml, replyMarkup = null }) {
  try {
    let imageBuffer = null;
    let mimeType = 'image/jpeg';
    let filename = 'faceid_snapshot.jpg';

    if (base64Image && base64Image.startsWith('data:image/')) {
      const match = base64Image.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        imageBuffer = Buffer.from(match[2], 'base64');
        filename = mimeType.includes('png') ? 'faceid_snapshot.png' : 'faceid_snapshot.jpg';
      }
    }

    if (!imageBuffer) {
      const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
      if (fs.existsSync(logoPath)) {
        imageBuffer = fs.readFileSync(logoPath);
        mimeType = 'image/png';
        filename = 'kichik_tabib_logo.png';
      }
    }

    if (!imageBuffer) return { ok: false, description: 'Rasm topilmadi' };

    const blob = new Blob([imageBuffer], { type: mimeType });
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', blob, filename);
    form.append('caption', captionHtml);
    form.append('parse_mode', 'HTML');
    if (replyMarkup) {
      form.append('reply_markup', JSON.stringify(replyMarkup));
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form
    });
    return await res.json();
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

/**
 * Sends a formatted HTML message (or Photo if base64Image is passed) to Telegram Group & Admin!
 */
async function sendTelegramNotification({
  eventType,
  recipientLabel,
  chatId,
  text,
  base64Photo = '',
  parseMode = 'HTML',
  replyMarkup = null
}) {
  const settings = getSettingsMap();
  const token = (settings.telegram_bot_token || '').trim();
  const targetChats = getTargetChatIds(chatId, settings);

  let delivered = 0;
  let apiError = null;

  if (token && targetChats.length > 0) {
    for (const targetChatId of targetChats) {
      try {
        if (base64Photo && base64Photo.startsWith('data:image/')) {
          const photoData = await sendPhotoToChat({
            token,
            chatId: targetChatId,
            base64Image: base64Photo,
            captionHtml: text,
            replyMarkup
          });
          if (photoData && photoData.ok) {
            delivered = 1;
            continue;
          }
        }

        const payload = {
          chat_id: targetChatId,
          text
        };
        if (parseMode) payload.parse_mode = parseMode;
        if (replyMarkup) payload.reply_markup = replyMarkup;

        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data && data.ok) {
          delivered = 1;
        } else {
          apiError = data?.description || 'Telegram API xatosi';
        }
      } catch (err) {
        apiError = err.message;
      }
    }
  }

  const cleanLogText = String(text || '').replace(/<[^>]+>/g, '');
  db.prepare(`
    INSERT INTO telegram_logs (created_at, recipient, event_type, message, delivered_api)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    nowTimestampStr(),
    recipientLabel || (targetChats.join(', ') || 'Telegram jurnali'),
    eventType || 'INFO',
    cleanLogText,
    delivered
  );

  return { delivered: Boolean(delivered), apiError };
}

/**
 * Sends the Kichik Tabib Logo Photo with caption and inline keyboard!
 */
async function sendBrandWelcomePhoto(chatId, captionHtml, inlineMarkup) {
  const settings = getSettingsMap();
  const token = (settings.telegram_bot_token || '').trim();
  if (!token || !chatId) return;

  try {
    const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
    if (cachedLogoFileId) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: cachedLogoFileId,
          caption: captionHtml,
          parse_mode: 'HTML',
          reply_markup: inlineMarkup
        })
      });
      const data = await res.json();
      if (data && data.ok) return;
    }

    if (fs.existsSync(logoPath)) {
      const fileBuffer = fs.readFileSync(logoPath);
      const blob = new Blob([fileBuffer], { type: 'image/png' });
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('photo', blob, 'kichik_tabib_logo.png');
      form.append('caption', captionHtml);
      form.append('parse_mode', 'HTML');
      if (inlineMarkup) {
        form.append('reply_markup', JSON.stringify(inlineMarkup));
      }

      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        body: form
      });
      const data = await res.json();
      if (data && data.ok && data.result?.photo?.length) {
        cachedLogoFileId = data.result.photo[data.result.photo.length - 1].file_id;
        return;
      }
    }
  } catch {
    // Fallback to text message
  }

  await sendTelegramNotification({
    eventType: 'WELCOME',
    recipientLabel: `Chat ${chatId}`,
    chatId,
    text: captionHtml,
    replyMarkup: inlineMarkup
  });
}

/**
 * Sends clean, branded notification + LIVE FACE ID PHOTO when an employee checks in or out!
 */
async function notifyAttendanceEvent({ employee, record, evaluation, actionType, settings }) {
  const recipientLabel = `Kichik Tabib Guruhi · ${employee.full_name}`;
  const snapshotPhoto = record.snapshot_data || employee.face_photo || '';

  if (actionType === 'absent') {
    const msg =
      `🌿 <b>KICHIK TABIB — DAVOMAT</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🚨 <b>ISHGA KELMADI!</b>\n` +
      `👤 <b>Xodim:</b> ${escapeHtml(employee.full_name)}\n` +
      `📅 <b>Sana:</b> ${record.date}\n` +
      `💵 <b>Okladi:</b> <code>${Number(employee.base_salary).toLocaleString('ru-RU')} so'm</code>\n` +
      `📉 <b>Ayrildi (1 kunlik):</b> <code>-${evaluation.absenceDeduction.toLocaleString('ru-RU')} so'm</code>`;

    return sendTelegramNotification({
      eventType: 'ABSENT_DEDUCTION',
      recipientLabel,
      text: msg
    });
  }

  if (actionType === 'checkout') {
    let extraLine = '';
    if (evaluation.overtimeBonusAmount > 0) {
      extraLine = `\n🌙 <b>17:00 dan keyingi ish (+${evaluation.overtimeMinutes} min):</b> <code>+${evaluation.overtimeBonusAmount.toLocaleString('ru-RU')} so'm</code>`;
    }

    const msg =
      `🌿 <b>KICHIK TABIB — FACE ID KAMERA</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🚪 <b>ISHDAN KETDI</b>\n` +
      `👤 <b>Xodim:</b> ${escapeHtml(employee.full_name)}\n` +
      `🕗 <b>Keldi:</b> <code>${record.check_in || '--:--'}</code>  ➔  🕕 <b>Ketdi:</b> <code>${record.check_out}</code>\n` +
      `⏱ <b>Bugun ishladi:</b> <b>${evaluation.workedHours} soat</b>` +
      extraLine;

    return sendTelegramNotification({
      eventType: 'CHECK_OUT',
      recipientLabel,
      base64Photo: snapshotPhoto,
      text: msg
    });
  }

  let statusBadge = `🟢 <b>VAQTIDA KELDI</b>`;
  let eventType = 'CHECK_IN';
  let financeRow = `✅ <b>Holati:</b> Oʻz vaqtida (09:00)`;

  if (evaluation.earlyMinutes > 0) {
    statusBadge = `🌟 <b>ERTA KELDI (+BONUS)</b>`;
    eventType = 'EARLY_BONUS';
    financeRow =
      `⏰ <b>09:00 gacha ishladi:</b> +${evaluation.earlyMinutes} daqiqa\n` +
      `💰 <b>Qoʻshilgan bonus:</b> <code>+${evaluation.earlyBonusAmount.toLocaleString('ru-RU')} so'm</code>`;
  } else if (evaluation.isGraceLate) {
    statusBadge = `🛡 <b>IMTIYOZLI KECHIKISH (JARIMA YOʻQ)</b>`;
    eventType = 'GRACE_LATE';
    financeRow =
      `⚠️ <b>Kechikdi:</b> ${evaluation.lateMinutes} daqiqa (10 daqiqagacha)\n` +
      `✅ <b>Jarima:</b> <code>0 so'm</code>`;
  } else if (evaluation.isPenalizedLate) {
    statusBadge = `⚠️ <b>KECH QOLDI (JARIMA YOZILDI)</b>`;
    eventType = 'LATE_PENALTY';
    financeRow =
      `⏰ <b>Kechikdi:</b> ${evaluation.lateMinutes} daqiqa (&gt;10 min)\n` +
      `💸 <b>Jarima (${evaluation.penaltyMinutes} min):</b> <code>-${evaluation.penaltyAmount.toLocaleString('ru-RU')} so'm</code>`;
  }

  const msg =
    `🌿 <b>KICHIK TABIB — FACE ID KAMERA</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${statusBadge}\n` +
    `👤 <b>Xodim:</b> ${escapeHtml(employee.full_name)}\n` +
    `🕘 <b>Kelgan vaqti:</b> <code>${record.check_in}</code> (${record.date})\n` +
    `${financeRow}`;

  return sendTelegramNotification({
    eventType,
    recipientLabel,
    base64Photo: snapshotPhoto,
    text: msg
  });
}

async function sendMonthlySummaryToTelegram(payrollList, yearMonth, targetChatId = null) {
  let totalPayout = 0;
  let totalBonuses = 0;
  let totalPenalties = 0;
  let totalAbsences = 0;

  const lines = payrollList.map((p, idx) => {
    totalPayout += p.finalToPay;
    totalBonuses += p.totalBonuses;
    totalPenalties += p.totalPenalties;
    totalAbsences += p.totalAbsenceDeduction;

    const bonusPart = p.totalEarlyBonusAmount > 0 ? ` 🌟+${(p.totalEarlyBonusAmount / 1000).toFixed(0)}k` : '';
    const finePart = p.totalLatePenaltyAmount > 0 ? ` ⚠️-${(p.totalLatePenaltyAmount / 1000).toFixed(0)}k` : '';
    const absPart = p.totalAbsenceDeduction > 0 ? ` 📉-${p.daysAbsent}kun` : '';
    const advPart = p.totalAdvanceAmount > 0 ? ` 💳-${(p.totalAdvanceAmount / 1000).toFixed(0)}k` : '';

    return (
      `<b>${idx + 1}. ${escapeHtml(p.employee.full_name)}</b> (Oklad: ${(p.employee.base_salary / 1000000).toFixed(1)} mln)\n` +
      `   📅 Keldi: <b>${p.daysPresent} kun</b>${bonusPart}${finePart}${absPart}${advPart}\n` +
      `   💵 Qoʻlga: <code>${p.finalToPay.toLocaleString('ru-RU')} so'm</code>`
    );
  });

  const text =
    `🌿 <b>KICHIK TABIB — OYLIK HISOB-KITOB (${yearMonth})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    lines.join('\n\n') +
    `\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🌟 <b>Jami erta bonuslar:</b> <code>+${totalBonuses.toLocaleString('ru-RU')} so'm</code>\n` +
    `⚠️ <b>Jami jarimalar (&gt;10m):</b> <code>-${totalPenalties.toLocaleString('ru-RU')} so'm</code>\n` +
    `📉 <b>Kelmadi ayrilmasi:</b> <code>-${totalAbsences.toLocaleString('ru-RU')} so'm</code>\n` +
    `🏦 <b>JAMI TOʻLOV:</b> <code>${totalPayout.toLocaleString('ru-RU')} so'm</code>`;

  const empButtons = buildEmployeeGridInline('empcard');

  return sendTelegramNotification({
    eventType: 'MONTHLY_REPORT',
    recipientLabel: 'Kichik Tabib — Oylik Hisobot',
    chatId: targetChatId,
    text,
    replyMarkup: empButtons
  });
}

function buildEmployeeGridInline(prefix = 'empcard') {
  const today = getLocalTodayStr();
  const emps = db.prepare(`SELECT id, full_name FROM employees WHERE active = 1 ORDER BY id ASC`).all();
  const attRows = db.prepare(`SELECT employee_id, check_in, check_out, status FROM attendance WHERE date = ?`).all(today);

  const rows = [];
  for (let i = 0; i < emps.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, emps.length); j++) {
      const e = emps[j];
      const rec = attRows.find((r) => r.employee_id === e.id);
      let icon = '⚪️';
      if (rec?.status === 'present' && rec?.check_in) {
        icon = rec.check_out ? '🚪' : '🟢';
      } else if (rec?.status === 'absent') {
        icon = '🔴';
      }
      row.push({
        text: `${icon} ${e.full_name}`,
        callback_data: `${prefix}:${e.id}`
      });
    }
    rows.push(row);
  }

  if (publicWebAppUrl && publicWebAppUrl.startsWith('https://')) {
    rows.unshift([
      {
        text: '🌿 Kichik Tabib Mini App ni ochish',
        web_app: { url: publicWebAppUrl }
      }
    ]);
  }

  return { inline_keyboard: rows };
}

function buildSingleEmployeeActionMenu(empId) {
  const rows = [
    [
      { text: '🟢 Hozir keldi', callback_data: `act:${empId}:now_in` },
      { text: '🚪 Hozir ketdi', callback_data: `act:${empId}:now_out` }
    ],
    [
      { text: '🌟 08:30 da keldi (+Bonus)', callback_data: `act:${empId}:0830` },
      { text: '🛡 09:07 da keldi (0 jarima)', callback_data: `act:${empId}:0907` }
    ],
    [
      { text: '⚠️ 09:18 da keldi (-Jarima)', callback_data: `act:${empId}:0918` },
      { text: '🔴 Bugun kelmadi (-Oklad)', callback_data: `act:${empId}:absent` }
    ],
    [
      { text: '💳 +200 000 Avans yozish', callback_data: `adv:${empId}:200000` },
      { text: '💳 +500 000 Avans yozish', callback_data: `adv:${empId}:500000` }
    ],
    [
      { text: '⬅️ Barcha xodimlar roʻyxati', callback_data: `back:list` }
    ]
  ];
  return { inline_keyboard: rows };
}

async function handleSingleTelegramUpdate(upd, getAppContext) {
  const settings = getSettingsMap();
  const token = (settings.telegram_bot_token || '').trim();
  const ctx = getAppContext();

  // 1. Auto-detect when the bot is added to a Telegram Group!
  if (upd.my_chat_member && upd.my_chat_member.chat) {
    const gChat = upd.my_chat_member.chat;
    if (gChat.type === 'group' || gChat.type === 'supergroup') {
      const gId = String(gChat.id);
      updateSettingsMap({ telegram_group_chat_id: gId });
      await sendBrandWelcomePhoto(
        gId,
        `🌿 <b>KICHIK TABIB — GURUH MUVAFFAQIYATLI ULANDI!</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `✅ Guruh ID: <code>${gId}</code> (${escapeHtml(gChat.title || 'Guruh')})\n\n` +
          `📸 Endi <b>Face ID kameradan</b> oʻtgan har bir xodimning <b>rasmi</b>, kelgan-ketgan vaqti, bonusi va jarimasi avtomatik ravishda shu guruhga tushadi!`,
        buildEmployeeGridInline('empcard')
      );
    }
    return;
  }

  // 2. Handle inline button clicks
  if (upd.callback_query) {
    const cb = upd.callback_query;
    const chatId = String(cb.message?.chat?.id || '');
    const parts = (cb.data || '').split(':');
    const cmd = parts[0];

    if (cmd === 'back') {
      await sendTelegramNotification({
        eventType: 'BOT_MENU',
        recipientLabel: 'Xodimlar menyusi',
        chatId,
        text: `🌿 <b>KICHIK TABIB — XODIMNI TANLANG:</b>\n<i>(🟢 Ishda | 🚪 Ketgan | 🔴 Kelmagan)</i>`,
        replyMarkup: buildEmployeeGridInline('empcard')
      });
    } else if (cmd === 'empcard') {
      const empId = Number(parts[1]);
      const cardText = ctx.getEmployeeCardHtml(empId);
      await sendTelegramNotification({
        eventType: 'EMP_CARD',
        recipientLabel: `Xodim kartasi #${empId}`,
        chatId,
        text: cardText,
        replyMarkup: buildSingleEmployeeActionMenu(empId)
      });
    } else if (cmd === 'act') {
      const empId = Number(parts[1]);
      const mode = parts[2];
      let time = null;
      let action = 'checkin';
      if (mode === 'now_in') action = 'checkin';
      else if (mode === 'now_out') action = 'checkout';
      else if (mode === '0830') {
        time = '08:30';
        action = 'checkin';
      } else if (mode === '0907') {
        time = '09:07';
        action = 'checkin';
      } else if (mode === '0918') {
        time = '09:18';
        action = 'checkin';
      } else if (mode === 'absent') {
        action = 'absent';
      }
      await ctx.recordFromTelegramBot({ employeeId: empId, time, action });
    } else if (cmd === 'adv') {
      const empId = Number(parts[1]);
      const amount = Number(parts[2] || 200000);
      await ctx.giveAdvanceFromTelegramBot({ employeeId: empId, amount });
    }

    if (token) {
      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: cb.id,
          text: '✅ Bajarildi!'
        })
      });
    }
    return;
  }

  // 3. Handle messages (from Group or Personal chat)
  const msg = upd.message;
  if (!msg || !msg.chat) return;

  const chatId = String(msg.chat.id);
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const rawText = (msg.text || '').trim();
  const text = rawText.replace(/@faceid_kichiktabibbot/gi, '').trim();

  if (isGroup && settings.telegram_group_chat_id !== chatId) {
    updateSettingsMap({ telegram_group_chat_id: chatId });
    await sendBrandWelcomePhoto(
      chatId,
      `🌿 <b>KICHIK TABIB — GURUH AVTOMATIK ULANDI!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ Guruh: <b>${escapeHtml(msg.chat.title || 'Guruh')}</b> (<code>${chatId}</code>)\n\n` +
        `📸 Endi umumiy <b>Face ID kameradan</b> olingan barcha rasmlar va keldi-ketdi hisobotlari shu guruhga avtomatik tushadi!`,
      buildEmployeeGridInline('empcard')
    );
    if (text === '/start' || text === '/group') return;
  }

  if (!isGroup && !settings.telegram_admin_chat_id) {
    updateSettingsMap({ telegram_admin_chat_id: chatId });
  }

  if (text === '/start' || text === '/group') {
    const welcomeCaption =
      `🌿 <b>KICHIK TABIB — Face ID va Oylik Tizimi</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⏰ <b>Ish vaqti:</b> 09:00 dan 17:00 gacha\n\n` +
      `🌟 <b>09:00 dan erta kelsa:</b> Har minutiga +1 000 so'm BONUS\n` +
      `🛡 <b>09:01–09:10:</b> Ruxsat etiladi (0 so'm jarima)\n` +
      `⚠️ <b>09:10 dan kech qolsa:</b> Har minutiga -1 000 so'm JARIMA\n` +
      `🔴 <b>Ishga umuman kelmasa:</b> -150 000 so'm JARIMA\n` +
      `🌙 <b>17:00 dan keyin ishlasa:</b> Har minutiga +1 000 so'm QOʻSHIMCHA\n\n` +
      `👇 <b>Xodim ustiga bosing (Keldi / Ketdi / Avans):</b>`;

    await sendBrandWelcomePhoto(chatId, welcomeCaption, buildEmployeeGridInline('empcard'));
    if (!isGroup) {
      await sendTelegramNotification({
        eventType: 'KEYBOARD_INIT',
        recipientLabel: `@${msg.from?.username || chatId}`,
        chatId,
        text: `⚡️ Tezkor boshqaruv tugmalari:`,
        replyMarkup: buildMainReplyKeyboard()
      });
    }
  } else if (text === '🟢 Keldi / Ketdi belgilash' || text === '💳 Avans berish') {
    await sendTelegramNotification({
      eventType: 'BOT_MENU',
      recipientLabel: `@${msg.from?.username || chatId}`,
      chatId,
      text: `🌿 <b>KICHIK TABIB — XODIMNI TANLANG:</b>`,
      replyMarkup: buildEmployeeGridInline('empcard')
    });
  } else if (text === '/today' || text === '📊 Bugungi davomat') {
    const summary = ctx.getTodayQuickText();
    await sendTelegramNotification({
      eventType: 'BOT_REPLY',
      recipientLabel: `@${msg.from?.username || chatId}`,
      chatId,
      replyMarkup: buildEmployeeGridInline('empcard'),
      text: summary
    });
  } else if (text === '/month' || text === '/salary' || text === '💰 Oylik hisob-kitob') {
    const payrolls = ctx.getMonthlyPayrolls();
    await sendMonthlySummaryToTelegram(payrolls, ctx.getCurrentYearMonth(), chatId);
  } else if (text && (!isGroup || rawText.toLowerCase().includes('bot') || rawText.startsWith('/'))) {
    const aiReply = await ctx.askAi(text);
    await sendTelegramNotification({
      eventType: 'AI_BOT_REPLY',
      recipientLabel: `@${msg.from?.username || chatId}`,
      chatId,
      replyMarkup: isGroup ? null : buildMainReplyKeyboard(),
      text: `🌿 <b>Kichik Tabib AI:</b>\n\n${escapeHtml((aiReply.answer || '').replace(/\*\*/g, ''))}`
    });
  }
}

function startTelegramPollingLoop(getAppContext) {
  if (pollingActive || process.env.VERCEL) return;
  pollingActive = true;

  setInterval(async () => {
    try {
      const settings = getSettingsMap();
      const token = (settings.telegram_bot_token || '').trim();
      if (!token || token.length < 20) return;

      if (token !== currentToken) {
        currentToken = token;
        lastUpdateId = 0;
      }

      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=2`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.result)) return;

      for (const upd of data.result) {
        lastUpdateId = Math.max(lastUpdateId, upd.update_id);
        await handleSingleTelegramUpdate(upd, getAppContext);
      }
    } catch {
      // Ignore transient errors
    }
  }, 2500);
}

async function pushBrandedMenuToAdmin() {
  const settings = getSettingsMap();
  const chatId = (settings.telegram_group_chat_id || settings.telegram_admin_chat_id || '').trim();
  if (!chatId) return;

  const welcomeCaption =
    `🌿 <b>KICHIK TABIB — Face ID va Oylik Tizimi</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📸 <b>Face ID foto-yuborish moduli yoqildi!</b>\n` +
    `Endi umumiy Face ID kameradan oʻtgan har bir xodimning <b>rasmi</b> shu yerga va Telegram guruhingizga avtomatik tushadi!\n\n` +
    `💡 <b>Telegram guruhga ulash uchun:</b>\n` +
    `Shunchaki <b>@faceid_kichiktabibbot</b> ni oʻz Telegram guruhingizga qoʻshing va guruhda <code>/start</code> deb yozing — bot guruhni oʻzi avtomatik ulaydi!`;

  await sendBrandWelcomePhoto(chatId, welcomeCaption, buildEmployeeGridInline('empcard'));
}

module.exports = {
  sendTelegramNotification,
  notifyAttendanceEvent,
  sendMonthlySummaryToTelegram,
  startTelegramPollingLoop,
  handleSingleTelegramUpdate,
  setPublicWebAppUrl,
  getPublicWebAppUrl,
  pushBrandedMenuToAdmin
};
