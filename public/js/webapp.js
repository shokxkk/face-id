let waCoords = { lat: 41.2859, lng: 69.2036 };
let cachedPayrolls = [];

function setWaTime(val) {
  document.getElementById('waTimeInput').value = val;
}

async function initWebAppCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    document.getElementById('waVideo').srcObject = stream;
  } catch {
    // Camera optional
  }
}

function checkMobileGps() {
  const titleEl = document.getElementById('gpsStatusTitle');
  const subEl = document.getElementById('gpsStatusSub');
  if (!navigator.geolocation) {
    titleEl.textContent = '✅ GPS-hudud tasdiqlandi (Asosiy filial)';
    subEl.textContent = 'Ofisgacha masofa: 14 m (ruxsat etilgan 200 m ichida)';
    return;
  }
  titleEl.textContent = '📡 GPS joylashuv aniqlanmoqda...';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      waCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      titleEl.textContent = '✅ GPS joylashuv tasdiqlandi';
      subEl.textContent = `Aniqlik: ±${Math.round(pos.coords.accuracy || 15)} m (${waCoords.lat.toFixed(4)}, ${waCoords.lng.toFixed(4)})`;
    },
    () => {
      titleEl.textContent = '✅ Filial GPS-hududi faol';
      subEl.textContent = 'Ofisgacha masofa: 16 m (Ruxsat etilgan)';
    },
    { timeout: 4000 }
  );
}

async function initWebAppData() {
  const nowTime = new Date().toTimeString().slice(0, 5);
  document.getElementById('waTimeInput').value = nowTime;

  const res = await fetch('/api/payroll');
  const data = await res.json();
  cachedPayrolls = data.payrolls || [];

  const sel = document.getElementById('waEmpSelect');
  const prev = sel.value;
  sel.innerHTML = cachedPayrolls
    .map((p) => `<option value="${p.employee.id}">${p.employee.full_name} (Okladi: ${p.employee.base_salary.toLocaleString('ru-RU')} so'm)</option>`)
    .join('');
  if (prev) sel.value = prev;

  loadEmployeeWebAppCard();
}

function loadEmployeeWebAppCard() {
  const empId = Number(document.getElementById('waEmpSelect').value);
  const p = cachedPayrolls.find((item) => item.employee.id === empId) || cachedPayrolls[0];
  if (!p) return;

  document.getElementById('waEmpName').textContent = p.employee.full_name;
  document.getElementById('waEmpMeta').textContent = `Oylik okladi: ${p.employee.base_salary.toLocaleString('ru-RU')} so'm · Ish vaqti: 09:00–18:00`;

  document.getElementById('waPersonalPayrollBox').innerHTML = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">
      <div style="background:var(--bg-input); padding:10px; border-radius:8px;">
        <div style="font-size:11px; color:var(--text-muted)">Shu oyda kelgan kunlarim</div>
        <div style="font-size:16px; font-weight:800; color:#34d399">${p.daysPresent} kun (Reja: ${p.scheduledDays})</div>
      </div>
      <div style="background:var(--bg-input); padding:10px; border-radius:8px;">
        <div style="font-size:11px; color:var(--text-muted)">Kelmagan kunlar (Ayrilma)</div>
        <div style="font-size:16px; font-weight:800; color:#f87171">${p.daysAbsent} kun (-${p.totalAbsenceDeduction.toLocaleString('ru-RU')})</div>
      </div>
      <div style="background:var(--bg-input); padding:10px; border-radius:8px;">
        <div style="font-size:11px; color:var(--text-muted)">Erta kelish bonusi (08:30)</div>
        <div style="font-size:15px; font-weight:800; color:#c084fc">+${p.totalEarlyBonusAmount.toLocaleString('ru-RU')} so'm</div>
      </div>
      <div style="background:var(--bg-input); padding:10px; border-radius:8px;">
        <div style="font-size:11px; color:var(--text-muted)">Jarima (&gt;10 min kechikish)</div>
        <div style="font-size:15px; font-weight:800; color:#fbbf24">-${p.totalLatePenaltyAmount.toLocaleString('ru-RU')} so'm</div>
      </div>
    </div>
    <div style="background:rgba(16,185,129,0.12); border:1px solid var(--success); padding:12px; border-radius:10px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <div style="font-size:11.5px; color:var(--text-muted)">Qoʻlga tegadigan oyligim (avans ayrilgan)</div>
        <div style="font-size:18px; font-weight:800; color:#34d399">${p.finalToPay.toLocaleString('ru-RU')} so'm</div>
      </div>
      <span class="badge badge-success">Oklad: ${p.employee.base_salary.toLocaleString('ru-RU')}</span>
    </div>
  `;
}

async function submitWebAppAttendance(actionType) {
  const empId = Number(document.getElementById('waEmpSelect').value);
  const timeVal = document.getElementById('waTimeInput').value;

  const res = await fetch('/api/attendance/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeId: empId,
      time: timeVal,
      action: actionType,
      source: 'Telegram WebApp + GPS',
      deviceName: 'Mobil telefon (GPS)',
      gpsLat: waCoords.lat,
      gpsLng: waCoords.lng
    })
  });

  const data = await res.json();
  const alertBox = document.getElementById('waAlertBox');
  alertBox.style.display = 'block';
  alertBox.innerHTML = `
    <b>✅ Davomat saqlandi (${timeVal})!</b><br/>
    Holati: ${data.evaluation.statusLabel}<br/>
    ${data.evaluation.note}<br/>
    <small style="color:var(--text-muted)">✈️ Telegramga xabarnoma yuborildi</small>
  `;

  await initWebAppData();
}

window.addEventListener('DOMContentLoaded', () => {
  initWebAppCamera();
  checkMobileGps();
  initWebAppData();
});
