let selectedEmployeeId = 1;
let dashboardData = null;
let payrollData = null;

// Initialize Telegram WebApp SDK if inside Telegram
try {
  if (window.Telegram && window.Telegram.WebApp) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
  }
} catch {
  // Normal browser mode
}

function formatMoney(val) {
  return Number(val || 0).toLocaleString('ru-RU') + " so'm";
}

function updateClock() {
  const now = new Date();
  const timeEl = document.getElementById('liveClock');
  const dateEl = document.getElementById('liveDate');
  if (timeEl) timeEl.textContent = now.toTimeString().slice(0, 8);
  if (dateEl) dateEl.textContent = now.toLocaleDateString('uz-UZ', { day: '2-digit', month: 'short', year: 'numeric' });
}
setInterval(updateClock, 1000);
updateClock();

async function initFaceCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 400 }, height: { ideal: 400 } },
      audio: false
    });
    const video = document.getElementById('camVideo');
    if (video) video.srcObject = stream;
  } catch {
    // Camera optional if desktop has no webcam
  }
}

function openView(viewName, btnEl) {
  document.querySelectorAll('.view-pane').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add('active');
  if (btnEl) btnEl.classList.add('active');
  refreshAll();
}

function selectEmployee(empId) {
  selectedEmployeeId = Number(empId);
  renderEmployeeChips();
}

function renderEmployeeChips() {
  if (!dashboardData) return;
  const grid = document.getElementById('empSelectorGrid');
  const badge = document.getElementById('selectedEmpBadge');

  const selectedObj = dashboardData.liveRows.find((r) => r.employee.id === selectedEmployeeId) || dashboardData.liveRows[0];
  if (selectedObj && badge) {
    badge.textContent = `👤 ${selectedObj.employee.full_name} (${(selectedObj.employee.base_salary / 1000000).toFixed(0)} mln)`;
  }

  grid.innerHTML = dashboardData.liveRows
    .map(({ employee, record, evaluation }) => {
      const isSel = employee.id === selectedEmployeeId;
      let statusIcon = '⚪️';
      let subText = `${(employee.base_salary / 1000000).toFixed(0)} mln so'm`;
      if (evaluation.isPresent) {
        statusIcon = record.check_out ? '🚪' : '🟢';
        subText = `Keldi: ${record.check_in}`;
      } else if (evaluation.isAbsentUnexcused) {
        statusIcon = '🔴';
        subText = 'Kelmadi';
      }

      return `
        <button type="button" class="emp-chip ${isSel ? 'selected' : ''}" onclick="selectEmployee(${employee.id})">
          <div class="emp-dot" style="background:${employee.avatar_color}">${employee.full_name[0]}</div>
          <div style="overflow:hidden;">
            <div class="emp-chip-name">${statusIcon} ${employee.full_name}</div>
            <div class="emp-chip-sub">${subText}</div>
          </div>
        </button>
      `;
    })
    .join('');
}

function renderTodayView() {
  if (!dashboardData) return;
  const st = dashboardData.stats;
  document.getElementById('kpiPresent').textContent = `${st.countPresent}/${st.totalEmployees}`;
  document.getElementById('kpiBonus').textContent = `+${(st.todayBonusesSum / 1000).toFixed(0)}k`;
  document.getElementById('kpiPenalty').textContent = `-${((st.todayPenaltiesSum + st.todayAbsenceDeductionsSum) / 1000).toFixed(0)}k`;

  const container = document.getElementById('todayListContainer');
  container.innerHTML = dashboardData.liveRows
    .map(({ employee, record, evaluation }) => {
      let amountHtml = `<span style="color:#34d399; font-weight:700;">0 so'm</span>`;
      if (evaluation.earlyBonusAmount > 0) {
        amountHtml = `<span style="color:#fbbf24; font-weight:800;">+${formatMoney(evaluation.earlyBonusAmount)}</span>`;
      } else if (evaluation.penaltyAmount > 0) {
        amountHtml = `<span style="color:#f87171; font-weight:800;">-${formatMoney(evaluation.penaltyAmount)}</span>`;
      } else if (evaluation.absenceDeduction > 0) {
        amountHtml = `<span style="color:#f87171; font-weight:800;">-${formatMoney(evaluation.absenceDeduction)}</span>`;
      }

      return `
        <div style="background:rgba(0,0,0,0.25); border:1px solid var(--border-green); border-radius:14px; padding:11px 13px; display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="emp-dot" style="background:${employee.avatar_color}">${employee.full_name[0]}</div>
            <div>
              <div style="font-weight:800; font-size:14px;">${employee.full_name}</div>
              <div style="font-size:11.5px; color:#a7f3d0;">${evaluation.statusLabel}</div>
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:13px; font-weight:700;">${record.check_in || '--:--'} ➔ ${record.check_out || '--:--'}</div>
            <div style="font-size:12px; margin-top:2px;">${amountHtml}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderPayrollView() {
  if (!payrollData) return;
  document.getElementById('totalCompanyPay').textContent = formatMoney(payrollData.totals.finalToPay);

  const box = document.getElementById('payrollCardsContainer');
  box.innerHTML = payrollData.payrolls
    .map((p) => {
      return `
        <div class="pay-card">
          <div class="pay-card-top">
            <div style="display:flex; align-items:center; gap:10px;">
              <div class="emp-dot" style="background:#10b981">${p.employee.full_name[0]}</div>
              <div>
                <div style="font-size:15px; font-weight:800;">${p.employee.full_name}</div>
                <div style="font-size:11.5px; color:#a7f3d0;">Oylik okladi: <b>${formatMoney(p.employee.base_salary)}</b></div>
              </div>
            </div>
            <button class="btn-small-act" onclick="quickGiveAdvance(${p.employee.id}, '${p.employee.full_name}')">💳 +Avans</button>
          </div>

          <div class="pay-metrics">
            <div class="pay-metric-item">
              <span style="color:var(--text-muted)">📅 Kelgan kunlari:</span>
              <b style="color:#34d399">${p.daysPresent} kun</b>
            </div>
            <div class="pay-metric-item">
              <span style="color:var(--text-muted)">🔴 Kelmagan:</span>
              <b style="color:#f87171">${p.daysAbsent} kun (-${(p.totalAbsenceDeduction / 1000).toFixed(0)}k)</b>
            </div>
            <div class="pay-metric-item">
              <span style="color:var(--text-muted)">🌟 Erta bonus (8:30):</span>
              <b style="color:#fbbf24">+${formatMoney(p.totalEarlyBonusAmount)}</b>
            </div>
            <div class="pay-metric-item">
              <span style="color:var(--text-muted)">⚠️ Jarima (&gt;10m):</span>
              <b style="color:#f87171">-${formatMoney(p.totalLatePenaltyAmount)}</b>
            </div>
            <div class="pay-metric-item">
              <span style="color:var(--text-muted)">🛡 5–10m jarimasiz:</span>
              <b style="color:#38bdf8">${p.daysGraceLate} marta (0 so'm)</b>
            </div>
            <div class="pay-metric-item">
              <span style="color:var(--text-muted)">💳 Olgan avansi:</span>
              <b style="color:#cbd5e1">-${formatMoney(p.totalAdvanceAmount)}</b>
            </div>
          </div>

          <div class="pay-final-bar">
            <span style="font-size:12px; font-weight:700; color:#d1fae5;">💵 QOʻLGA TEGADIGAN OYLIK:</span>
            <span style="font-size:17px; font-weight:900; color:var(--brand-gold-light);">${formatMoney(p.finalToPay)}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

async function refreshAll() {
  const [dRes, pRes] = await Promise.all([
    fetch('/api/dashboard'),
    fetch('/api/payroll')
  ]);
  dashboardData = await dRes.json();
  payrollData = await pRes.json();

  renderEmployeeChips();
  renderTodayView();
  renderPayrollView();
}

function captureFaceSnapshot(empName, timeStr, actionType) {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  const video = document.getElementById('camVideo');

  // 1. Draw live webcam frame if active, or styled dark-emerald background
  if (video && video.srcObject && video.readyState >= 2) {
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  } else {
    const grad = ctx.createLinearGradient(0, 0, 480, 480);
    grad.addColorStop(0, '#071712');
    grad.addColorStop(1, '#13352a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 480, 480);

    // Draw employee avatar circle
    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc(240, 200, 76, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 68px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((empName || 'K')[0].toUpperCase(), 240, 204);
  }

  // 2. Draw Face ID green scanning corners
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 4;
  ctx.strokeRect(16, 16, 448, 448);

  // 3. Draw bottom Kichik Tabib watermark bar with Employee Name & Timestamp
  ctx.fillStyle = 'rgba(7, 23, 18, 0.84)';
  ctx.fillRect(16, 366, 448, 98);

  ctx.fillStyle = '#fbbf24';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`🌿 KICHIK TABIB — FACE ID`, 32, 398);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(`👤 ${empName || 'Xodim'}`, 32, 430);

  const nowDate = new Date().toISOString().slice(0, 10);
  const actLabel = actionType === 'checkout' ? 'KETDI' : 'KELDI';
  ctx.fillStyle = '#34d399';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(`🕒 ${nowDate} | ${timeStr || '--:--'} (${actLabel})`, 32, 454);

  return canvas.toDataURL('image/jpeg', 0.88);
}

async function markAttendanceNow(actionType) {
  const nowTime = new Date().toTimeString().slice(0, 5);
  await markAttendanceCustom(nowTime, actionType);
}

async function markAttendanceCustom(timeVal, actionType) {
  const selectedObj = dashboardData?.liveRows?.find((r) => r.employee.id === selectedEmployeeId);
  const empName = selectedObj?.employee?.full_name || 'Xodim';
  const effectiveTime = timeVal || new Date().toTimeString().slice(0, 5);
  const snapshotData = actionType === 'absent' ? '' : captureFaceSnapshot(empName, effectiveTime, actionType);

  const res = await fetch('/api/attendance/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeId: selectedEmployeeId,
      time: timeVal,
      action: actionType,
      source: 'Kichik Tabib Face ID',
      deviceName: 'Umumiy Face ID Kamera',
      snapshotData
    })
  });
  const data = await res.json();
  const ev = data.evaluation;

  const toast = document.getElementById('actionToast');
  toast.style.display = 'block';
  toast.innerHTML = `
    <div style="font-weight:800; font-size:14px; color:#fbbf24; margin-bottom:3px;">
      ✅ ${data.employee.full_name} — ${ev.statusLabel}
    </div>
    <div>${ev.note}</div>
    <div style="font-size:11px; color:#a7f3d0; margin-top:4px;">📸 Rasm va hisobot Telegram guruhga yuborildi!</div>
  `;

  await refreshAll();
}

async function quickGiveAdvance(empId, empName) {
  const str = prompt(`${empName} uchun avans summasini kiriting (so'm):`, '300000');
  if (!str) return;
  const amount = Number(str.replace(/\D/g, ''));
  if (!amount || amount <= 0) return;

  await fetch('/api/advances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employee_id: empId,
      amount,
      reason: 'Kichik Tabib Mini App orqali avans'
    })
  });

  await refreshAll();
  alert(`✅ ${empName} ga ${formatMoney(amount)} avans yozildi va Telegramga yuborildi!`);
}

async function sendReportToTelegram() {
  await fetch('/api/telegram/send-monthly-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  alert('✈️ Oy yakuni boʻyicha hisobot @faceid_kichiktabibbot ga yuborildi!');
}

async function askQuickAi(q) {
  document.getElementById('aiInput').value = q;
  await sendAiMessage(q);
}

async function submitAiChat(e) {
  e.preventDefault();
  const input = document.getElementById('aiInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  await sendAiMessage(q);
}

async function sendAiMessage(question) {
  const box = document.getElementById('aiMessages');
  box.innerHTML += `<div style="align-self:flex-end; background:#059669; padding:9px 12px; border-radius:12px; max-width:85%;">${question}</div>`;
  box.scrollTop = box.scrollHeight;

  const res = await fetch('/api/ai/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  });
  const data = await res.json();
  const formatted = (data.answer || '').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br/>');
  box.innerHTML += `<div style="align-self:flex-start; background:var(--bg-card-soft); border:1px solid var(--border-green); padding:10px 12px; border-radius:12px; max-width:90%;">${formatted}</div>`;
  box.scrollTop = box.scrollHeight;
}

window.addEventListener('DOMContentLoaded', () => {
  initFaceCamera();
  refreshAll();
});
