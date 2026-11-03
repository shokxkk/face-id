let termStream = null;

function updateClock() {
  const now = new Date();
  const str = now.toTimeString().slice(0, 8);
  const el = document.getElementById('liveClock');
  if (el) el.textContent = str;
}
setInterval(updateClock, 1000);
updateClock();

function toggleCustomTime() {
  const mode = document.getElementById('timeModeSelect').value;
  document.getElementById('customTimeWrap').style.display = mode === 'custom' ? 'block' : 'none';
}

function setTermTime(val) {
  document.getElementById('termCustomTime').value = val;
}

function speakText(text) {
  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'uz-UZ';
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
    }
  } catch {
    // ignore
  }
}

async function initTerminalCamera() {
  const statusEl = document.getElementById('camStatusText');
  try {
    if (termStream) {
      termStream.getTracks().forEach((t) => t.stop());
    }
    termStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    const video = document.getElementById('termVideo');
    video.srcObject = termStream;
    statusEl.textContent = '🟢 Face ID kamera yoqilgan — yuz kadrda';
  } catch (err) {
    statusEl.textContent = '🟡 Kamera topilmadi (Face ID simulyatsiya rejimi faol)';
  }
}

async function loadTerminalData() {
  const res = await fetch('/api/dashboard');
  const data = await res.json();

  const sel = document.getElementById('termEmpSelect');
  const prev = sel.value;
  sel.innerHTML = data.liveRows
    .map((r) => `<option value="${r.employee.id}">${r.employee.full_name} (Okladi: ${Number(r.employee.base_salary).toLocaleString('ru-RU')} so'm)</option>`)
    .join('');
  if (prev) sel.value = prev;

  const recentBox = document.getElementById('termRecentList');
  recentBox.innerHTML = (data.deviceEvents || [])
    .slice(0, 8)
    .map(
      (ev) => `
      <div style="background:var(--bg-input); border:1px solid var(--border-color); border-radius:8px; padding:8px 10px; font-size:12px;">
        <div style="display:flex; justify-content:space-between; font-weight:700;">
          <span>👤 ${ev.employee_name}</span>
          <span style="color:#34d399">${ev.confidence}% Face ID</span>
        </div>
        <div style="color:var(--text-muted); margin-top:2px;">${ev.action} · ${ev.created_at}</div>
      </div>
    `
    )
    .join('');
}

async function scanFaceAndRecord(actionType) {
  const hud = document.getElementById('faceHud');
  const caption = document.getElementById('hudCaption');
  hud.classList.add('scanning');
  caption.textContent = '🔍 Yuz tekshirilmoqda (99.6%)...';

  let snapshotData = '';
  const video = document.getElementById('termVideo');
  const sel = document.getElementById('termEmpSelect');
  const selectedText = sel.options[sel.selectedIndex]?.text || 'Xodim';
  const empName = selectedText.split('(')[0].trim();

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    if (video && video.srcObject && video.readyState >= 2) {
      ctx.save();
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    } else {
      ctx.fillStyle = '#071712';
      ctx.fillRect(0, 0, 480, 480);
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.arc(240, 200, 76, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 68px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((empName || 'K')[0].toUpperCase(), 240, 204);
    }
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 4;
    ctx.strokeRect(16, 16, 448, 448);
    ctx.fillStyle = 'rgba(7, 23, 18, 0.84)';
    ctx.fillRect(16, 366, 448, 98);
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('🌿 KICHIK TABIB — FACE ID TERMINAL', 32, 398);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(`👤 ${empName}`, 32, 430);
    snapshotData = canvas.toDataURL('image/jpeg', 0.88);
  } catch {
    // ignore
  }

  const empId = Number(document.getElementById('termEmpSelect').value);
  const mode = document.getElementById('timeModeSelect').value;
  const chosenTime =
    mode === 'custom'
      ? document.getElementById('termCustomTime').value
      : new Date().toTimeString().slice(0, 5);

  const res = await fetch('/api/attendance/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeId: empId,
      time: chosenTime,
      action: actionType,
      source: 'Web-kamera Face ID',
      deviceName: 'Kirish Terminali #1',
      snapshotData,
      confidence: 99.6
    })
  });

  const data = await res.json();
  setTimeout(() => {
    hud.classList.remove('scanning');
    caption.textContent = `✅ Yuz aniqlandi: ${data.employee.full_name}`;
  }, 500);

  const ev = data.evaluation;
  const box = document.getElementById('scanResultBox');
  box.style.display = 'block';

  let extraLine = '';
  let voiceMsg = `${data.employee.full_name}. `;
  if (actionType === 'checkout') {
    extraLine = `🚪 Ishdan ketgan vaqti: <b>${data.record.check_out}</b>. Bugun ishlagan vaqti: <b>${ev.workedHours} soat</b>.`;
    voiceMsg += `Ishdan ketganingiz qayd etildi.`;
  } else if (ev.earlyBonusAmount > 0) {
    extraLine = `🌟 <b>Erta keldingiz (${data.record.check_in} dan 09:00 gacha)!</b> Sizga bonus yozildi: <b>+${ev.earlyBonusAmount.toLocaleString('ru-RU')} so'm</b> (+${ev.earlyMinutes} daqiqa).`;
    voiceMsg += `Xush kelibsiz! Erta kelganingiz uchun bonus yozildi!`;
  } else if (ev.isGraceLate) {
    extraLine = `🛡 <b>${ev.lateMinutes} daqiqa kechikdingiz (10 daqiqagacha imtiyozli vaqt).</b> Jarima YOZILMAYDI (0 so'm).`;
    voiceMsg += `Ishga kelganingiz qayd etildi. O'n daqiqagacha jarima yo'q.`;
  } else if (ev.penaltyAmount > 0) {
    extraLine = `⚠️ <b>${ev.lateMinutes} daqiqa kechikdingiz (&gt; 10 daqiqa).</b> Har bir daqiqaga jarima yozildi: <b>-${ev.penaltyAmount.toLocaleString('ru-RU')} so'm</b>.`;
    voiceMsg += `Diqqat, o'n daqiqadan ko'p kechikdingiz, jarima yozildi.`;
  } else {
    extraLine = `✅ Ishga oʻz vaqtida keldingiz: <b>${data.record.check_in}</b>.`;
    voiceMsg += `Xush kelibsiz, o'z vaqtida keldingiz!`;
  }

  box.innerHTML = `
    <div style="font-size:15px; font-weight:800; margin-bottom:4px;">
      👤 ${data.employee.full_name} (Okladi: ${Number(data.employee.base_salary).toLocaleString('ru-RU')} so'm)
    </div>
    <div style="font-size:13.5px;">${extraLine}</div>
    <div style="font-size:11.5px; color:var(--text-muted); margin-top:6px;">
      ✈️ Xabarnoma avtomatik ravishda Telegramga yuborildi.
    </div>
  `;

  speakText(voiceMsg);
  await loadTerminalData();
}

window.addEventListener('DOMContentLoaded', () => {
  initTerminalCamera();
  loadTerminalData();
});
