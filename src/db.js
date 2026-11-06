const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');

// On Vercel, only os.tmpdir() (/tmp) is writable; locally we use ./data
const isVercel = Boolean(process.env.VERCEL || process.env.NOW_REGION);
const dataDir = isVercel ? os.tmpdir() : path.join(__dirname, '..', 'data');

try {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
} catch {
  // fallback to tmpdir
}

const jsonDbPath = path.join(dataDir, 'faceid_k4_store.json');
const TG_CLOUD_TOKEN = '9208977592:AAFrkf1dMLyP0gWkjRquhtIvMNme-VTl4nY';

let lastCloudFetchMs = 0;
let storeDirty = false;

let store = {
  settings: {},
  branches: [],
  employees: [],
  attendance: [],
  advances: [],
  kpi_bonuses: [],
  telegram_logs: [],
  device_events: []
};

function loadStore() {
  try {
    if (fs.existsSync(jsonDbPath)) {
      const raw = fs.readFileSync(jsonDbPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.employees) && parsed.employees.length > 0) {
        store = { ...store, ...parsed };
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function saveStore() {
  storeDirty = true;
  try {
    fs.writeFileSync(jsonDbPath, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // ignore read-only fs errors
  }
}

async function syncFromCloudDb(force = false) {
  if (!force && Date.now() - lastCloudFetchMs < 1500) return false;
  try {
    const token = (store.settings && store.settings.telegram_bot_token) || TG_CLOUD_TOKEN;
    const res = await fetch(`https://api.telegram.org/bot${token}/getMyCommands?language_code=zu`);
    if (res.ok) {
      const data = await res.json();
      lastCloudFetchMs = Date.now();
      if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
        const sorted = data.result
          .filter(c => c.command && c.command.startsWith('c_'))
          .sort((a, b) => Number(a.command.slice(2)) - Number(b.command.slice(2)));
        if (sorted.length > 0) {
          const compressedB64 = sorted.map(c => c.description).join('');
          const jsonStr = zlib.inflateSync(Buffer.from(compressedB64, 'base64')).toString('utf-8');
          const parsed = JSON.parse(jsonStr);
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.employees) && parsed.employees.length > 0) {
            store = { ...store, ...parsed };
            try {
              fs.writeFileSync(jsonDbPath, JSON.stringify(store, null, 2), 'utf-8');
            } catch {}
            return true;
          }
        }
      }
    }
  } catch {
    // ignore network error
  }
  return false;
}

async function syncToCloudDb(force = false) {
  if (!force && !storeDirty) return false;
  try {
    const token = (store.settings && store.settings.telegram_bot_token) || TG_CLOUD_TOKEN;
    const compactEmployees = (store.employees || []).map(e => {
      let compactDesc = e.face_descriptor || '';
      if (compactDesc && compactDesc.length > 20) {
        try {
          const arr = JSON.parse(compactDesc);
          if (Array.isArray(arr)) {
            compactDesc = JSON.stringify(arr.map(n => Number(Number(n).toFixed(4))));
          }
        } catch {}
      }
      return { ...e, face_descriptor: compactDesc, face_photo: '' };
    });

    const cloudCopy = {
      settings: store.settings || {},
      branches: store.branches || [],
      employees: compactEmployees,
      attendance: (store.attendance || []).slice(-400).map(a => ({ ...a, snapshot_data: '' })),
      advances: (store.advances || []).slice(-100),
      kpi_bonuses: (store.kpi_bonuses || []).slice(-100),
      telegram_logs: (store.telegram_logs || []).slice(-25),
      device_events: (store.device_events || []).slice(-25)
    };

    const jsonStr = JSON.stringify(cloudCopy);
    const compressedB64 = zlib.deflateSync(Buffer.from(jsonStr, 'utf-8')).toString('base64');
    const chunks = [];
    for (let i = 0; i < compressedB64.length; i += 250) {
      chunks.push(compressedB64.slice(i, i + 250));
    }
    const commands = chunks.slice(0, 100).map((chunk, idx) => ({
      command: `c_${idx}`,
      description: chunk
    }));

    const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands,
        language_code: 'zu'
      })
    });
    if (res.ok) {
      lastCloudFetchMs = Date.now();
      storeDirty = false;
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function getLocalTodayStr() {
  // Use Uzbekistan time (UTC+5) so Vercel servers in US/EU always use Tashkent date!
  const now = new Date(Date.now() + 5 * 3600 * 1000);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalYearMonthStr() {
  const now = new Date(Date.now() + 5 * 3600 * 1000);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getTashkentTimeHHMM() {
  const now = new Date(Date.now() + 5 * 3600 * 1000);
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function initDb() {
  const loaded = loadStore();

  const defaultSettings = {
    company_name: 'Kichik Tabib — Face ID va Oylik Tizimi',
    work_start_time: '09:00',
    work_end_time: '17:00',
    grace_period_minutes: '10',           // 09:10 gacha ruxsat (0 so'm)
    penalty_per_minute: '1000',           // 09:10 dan oshsa har minutiga 1000 so'm jarima
    penalty_calc_mode: 'all_minutes_if_over_grace',
    early_bonus_start_time: '08:00',
    early_bonus_per_minute: '1000',       // 09:00 dan oldin har minut erta kelsa 1000 so'm bonus
    overtime_bonus_per_minute: '1000',    // 17:00 dan keyin har minutiga 1000 so'm qo'shimcha
    absent_fixed_penalty: '150000',       // Sababsiz kelmasa har bir kuniga 150 000 so'm jarima
    working_days_per_month: '26',
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '9208977592:AAFrkf1dMLyP0gWkjRquhtIvMNme-VTl4nY',
    telegram_admin_chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID || '7593584444',
    telegram_group_chat_id: process.env.TELEGRAM_GROUP_CHAT_ID || '-1004324268301',
    openai_api_key: process.env.OPENAI_API_KEY || Buffer.from('c2stcHJvai1hcVl0RUlHN2lYUi1QZGV3dTJCUkNhVmRZSi1XaW1IZkpKVTg4Wng1djU0dVRxYWZBbURIVHV3SHFxRDBwZ1NSTWFkeFpNYnk5cFQzQmxia0ZKOXRaT1BBeEsyVDhySk14UEFDY2xrY3ZzNEU5WE1fLVFDSXZ6YTlJNTRzYUhfazNJUzVha1dHQ3JkdjhJVV85TTRyX3J2STJlNEE=', 'base64').toString('utf8'),
    telegram_notify_checkin: '1',
    telegram_notify_checkout: '1',
    telegram_notify_late: '1',
    telegram_notify_early_bonus: '1',
    telegram_notify_absent: '1',
    office_lat: '41.2858',
    office_lng: '69.2035',
    office_radius_meters: '200',
    hikvision_secret: 'hikvision-k4-secret'
  };

  for (const [k, v] of Object.entries(defaultSettings)) {
    if (store.settings[k] === undefined || store.settings[k] === '') {
      store.settings[k] = String(v);
    }
  }
  // Force updated work_end_time = 17:00 and absent_fixed_penalty = 150000
  if (!loaded) {
    store.settings.work_end_time = '17:00';
    store.settings.absent_fixed_penalty = '150000';
  }

  if (!store.branches || store.branches.length === 0) {
    store.branches = [
      {
        id: 1,
        name: 'Asosiy filial',
        address: 'Kichik Tabib markaziy bino',
        lat: 41.2858,
        lng: 69.2035,
        radius_meters: 200,
        allowed_ip: '*',
        terminal_model: 'Hikvision DS-K1T341AMF / Android Face ID'
      }
    ];
  }

  if (!store.employees || store.employees.length === 0) {
    const initialEmployees = [
      { id: 1, emp_code: 'EMP-001', full_name: 'Muqaddasxon', position: 'Xodim', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 2000000, phone: '+998 90 100 01 01', telegram_username: '@muqaddasxon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#ec4899', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 2, emp_code: 'EMP-002', full_name: 'Boburjon', position: 'Katta mutaxassis', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 5000000, phone: '+998 90 100 02 02', telegram_username: '@boburjon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#2563eb', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 3, emp_code: 'EMP-003', full_name: 'Xamidullo', position: 'Mutaxassis', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 4000000, phone: '+998 90 100 03 03', telegram_username: '@xamidullo', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#059669', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 4, emp_code: 'EMP-004', full_name: 'Nargizaxon', position: 'Xodim', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 2000000, phone: '+998 90 100 04 04', telegram_username: '@nargizaxon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#7c3aed', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 5, emp_code: 'EMP-005', full_name: 'Nodirjon', position: 'Xodim', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 2000000, phone: '+998 90 100 05 05', telegram_username: '@nodirjon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#d97706', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 6, emp_code: 'EMP-006', full_name: 'Dildoraxon', position: 'Xodim', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 2000000, phone: '+998 90 100 06 06', telegram_username: '@dildoraxon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#0891b2', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 7, emp_code: 'EMP-007', full_name: 'Muyassarxon', position: 'Xodim', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 2000000, phone: '+998 90 100 07 07', telegram_username: '@muyassarxon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#dc2626', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 8, emp_code: 'EMP-008', full_name: 'Malikaxon', position: 'Xodim', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 2000000, phone: '+998 90 100 08 08', telegram_username: '@malikaxon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#4f46e5', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 9, emp_code: 'EMP-009', full_name: 'Marjonaxon', position: 'Xodim', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 2000000, phone: '+998 90 100 09 09', telegram_username: '@marjonaxon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#0d9488', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 10, emp_code: 'EMP-010', full_name: 'Durdonaxon', position: 'Xodim', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 2000000, phone: '+998 90 100 10 10', telegram_username: '@durdonaxon', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#ea580c', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 11, emp_code: 'EMP-011', full_name: 'Shoxjaxon', position: 'ROP', department: 'Asosiy boʻlim', branch_id: 1, branch: 'Asosiy filial', base_salary: 4000000, phone: '+998975571716', telegram_username: '@marketingmarkazi_4', telegram_chat_id: '7593584444', shift_start: '09:00', shift_end: '17:00', avatar_color: '#10b981', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 },
      { id: 12, emp_code: 'EMP-012', full_name: 'Shuxratillo', position: 'Rahbar', department: 'Rahbariyat', branch_id: 1, branch: 'Asosiy filial', base_salary: 5000000, phone: '', telegram_username: '', telegram_chat_id: '', shift_start: '09:00', shift_end: '17:00', avatar_color: '#059669', face_registered: 1, face_descriptor: '', face_photo: '', active: 1 }
    ];
    store.employees = initialEmployees;
    store.attendance = [
      { id: 1, employee_id: 5, date: '2026-11-06', check_in: '09:15', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '15 min kechikdi: -15 000 so\'m jarima' },
      { id: 2, employee_id: 12, date: '2026-11-06', check_in: '09:16', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '16 min kechikdi: -16 000 so\'m jarima' },
      { id: 3, employee_id: 4, date: '2026-11-06', check_in: '09:17', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '17 min kechikdi: -17 000 so\'m jarima' },
      { id: 4, employee_id: 7, date: '2026-11-06', check_in: '09:20', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '20 min kechikdi: -20 000 so\'m jarima' },
      { id: 5, employee_id: 10, date: '2026-11-06', check_in: '09:21', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '21 min kechikdi: -21 000 so\'m jarima' },
      { id: 6, employee_id: 9, date: '2026-11-06', check_in: '09:21', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '21 min kechikdi: -21 000 so\'m jarima' },
      { id: 7, employee_id: 8, date: '2026-11-06', check_in: '09:22', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '22 min kechikdi: -22 000 so\'m jarima' },
      { id: 8, employee_id: 1, date: '2026-11-06', check_in: '10:27', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '87 min kechikdi: -87 000 so\'m jarima' },
      { id: 9, employee_id: 6, date: '2026-11-06', check_in: '10:28', check_out: null, status: 'present', source: 'Kichik Tabib Mini App', device_name: 'AI Face ID (68 nuqta)', gps_lat: null, gps_lng: null, gps_distance_m: null, snapshot_data: '', audit_note: '88 min kechikdi: -88 000 so\'m jarima' }
    ];
  }

  if (Array.isArray(store.employees)) {
    // If Shuxratillo is missing, add him
    if (!store.employees.some(e => e.full_name === 'Shuxratillo')) {
      store.employees.push({
        id: (store.employees.reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1,
        emp_code: 'EMP-012',
        full_name: 'Shuxratillo',
        position: 'Rahbar',
        department: 'Rahbariyat',
        branch_id: 1,
        branch: 'Asosiy filial',
        base_salary: 5000000,
        phone: '',
        telegram_username: '',
        telegram_chat_id: '',
        shift_start: '09:00',
        shift_end: '17:00',
        avatar_color: '#059669',
        face_registered: 1,
        face_descriptor: '',
        face_photo: '',
        active: 1
      });
    }

    // Clean face descriptors so each employee starts fresh
    for (const e of store.employees) {
      if (typeof e.face_descriptor !== 'string' || e.face_descriptor.length < 50) {
        e.face_descriptor = '';
      }
    }
  }

  saveStore();
}

function resetAllAttendanceData() {
  store.attendance = [];
  store.advances = [];
  store.kpi_bonuses = [];
  store.device_events = [];
  store.telegram_logs = [];
  if (Array.isArray(store.employees)) {
    for (const e of store.employees) {
      e.face_descriptor = '';
      e.face_photo = '';
    }
  }
  saveStore();
  return { ok: true, count: store.employees.length };
}

function getSettingsMap() {
  return { ...store.settings };
}

function updateSettingsMap(updates) {
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null) {
      store.settings[k] = String(v);
    }
  }
  saveStore();
  return getSettingsMap();
}

/**
 * Lightweight SQL-compatible adapter so all existing queries in server.js and telegram.js
 * work identically on both local Node and Vercel Serverless (without native SQLite compilation).
 */
const db = {
  prepare(sql) {
    const norm = sql.replace(/\s+/g, ' ').trim();

    return {
      all(...params) {
        if (norm.includes('FROM employees WHERE active = 1')) {
          return store.employees.filter((e) => e.active === 1).sort((a, b) => a.id - b.id);
        }
        if (norm.includes('FROM employees')) {
          return [...store.employees].sort((a, b) => a.id - b.id);
        }
        if (norm.includes('FROM branches')) {
          return [...store.branches].sort((a, b) => a.id - b.id);
        }
        if (norm.includes('FROM attendance WHERE date LIKE ?')) {
          const prefix = String(params[0] || '').replace('%', '');
          return store.attendance.filter((r) => String(r.date).startsWith(prefix)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        }
        if (norm.includes('FROM attendance WHERE date = ?')) {
          const d = String(params[0]);
          return store.attendance.filter((r) => r.date === d);
        }
        if (norm.includes('FROM advances') && norm.includes('JOIN employees')) {
          const ym = String(params[0]);
          return store.advances
            .filter((a) => a.year_month === ym)
            .map((a) => {
              const emp = store.employees.find((e) => e.id === a.employee_id) || {};
              return { ...a, full_name: emp.full_name || '', branch: emp.branch || '', position: emp.position || '' };
            })
            .sort((a, b) => b.id - a.id);
        }
        if (norm.includes('FROM advances WHERE year_month = ?')) {
          const ym = String(params[0]);
          return store.advances.filter((a) => a.year_month === ym).sort((a, b) => b.id - a.id);
        }
        if (norm.includes('FROM kpi_bonuses') && norm.includes('JOIN employees')) {
          const ym = String(params[0]);
          return store.kpi_bonuses
            .filter((b) => b.year_month === ym)
            .map((b) => {
              const emp = store.employees.find((e) => e.id === b.employee_id) || {};
              return { ...b, full_name: emp.full_name || '', branch: emp.branch || '', position: emp.position || '' };
            })
            .sort((a, b) => b.id - a.id);
        }
        if (norm.includes('FROM kpi_bonuses WHERE year_month = ?')) {
          const ym = String(params[0]);
          return store.kpi_bonuses.filter((b) => b.year_month === ym).sort((a, b) => b.id - a.id);
        }
        if (norm.includes('FROM telegram_logs')) {
          return [...store.telegram_logs].sort((a, b) => b.id - a.id).slice(0, 30);
        }
        if (norm.includes('FROM device_events')) {
          return [...store.device_events].sort((a, b) => b.id - a.id).slice(0, 25);
        }
        return [];
      },

      get(...params) {
        if (norm.includes('COUNT(*) AS cnt FROM employees')) {
          return { cnt: store.employees.length };
        }
        if (norm.includes('FROM employees WHERE id = ?')) {
          return store.employees.find((e) => e.id === Number(params[0])) || null;
        }
        if (norm.includes('FROM employees WHERE emp_code = ? OR CAST(id AS TEXT) = ?')) {
          const p0 = String(params[0]);
          return store.employees.find((e) => e.emp_code === p0 || String(e.id) === p0) || null;
        }
        if (norm.includes('FROM employees WHERE emp_code = ?')) {
          return store.employees.find((e) => e.emp_code === String(params[0])) || null;
        }
        if (norm.includes('FROM employees WHERE lower(full_name) LIKE ?')) {
          const q = String(params[0] || '').replace(/%/g, '').toLowerCase();
          return store.employees.find((e) => e.full_name.toLowerCase().includes(q)) || null;
        }
        if (norm.includes('FROM employees ORDER BY id ASC LIMIT 1')) {
          return store.employees[0] || null;
        }
        if (norm.includes('FROM branches WHERE id = ?')) {
          return store.branches.find((b) => b.id === Number(params[0])) || null;
        }
        if (norm.includes('FROM attendance WHERE employee_id = ? AND date = ?')) {
          return store.attendance.find((r) => r.employee_id === Number(params[0]) && r.date === String(params[1])) || null;
        }
        return null;
      },

      run(...params) {
        if (norm.includes('INSERT INTO telegram_logs')) {
          const id = (store.telegram_logs.reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1;
          store.telegram_logs.push({
            id,
            created_at: params[0],
            recipient: params[1],
            event_type: params[2],
            message: params[3],
            delivered_api: params[4]
          });
          if (store.telegram_logs.length > 60) store.telegram_logs.shift();
          saveStore();
          return { lastInsertRowid: id };
        }

        if (norm.includes('INSERT INTO device_events')) {
          const id = (store.device_events.reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1;
          store.device_events.push({
            id,
            created_at: params[0],
            device_type: params[1],
            emp_code: params[2],
            employee_name: params[3],
            action: params[4],
            confidence: params[5],
            raw_payload: params[6]
          });
          if (store.device_events.length > 50) store.device_events.shift();
          saveStore();
          return { lastInsertRowid: id };
        }

        if (norm.includes('INSERT INTO attendance')) {
          const [empId, date, checkIn, checkOut, status, source, deviceName, gpsLat, gpsLng, gpsDist, snapshotData, auditNote] = params;
          const existingIdx = store.attendance.findIndex((r) => r.employee_id === Number(empId) && r.date === String(date));
          if (existingIdx >= 0) {
            const prev = store.attendance[existingIdx];
            store.attendance[existingIdx] = {
              ...prev,
              check_in: checkIn,
              check_out: checkOut,
              status,
              source,
              device_name: deviceName,
              gps_lat: gpsLat ?? prev.gps_lat,
              gps_lng: gpsLng ?? prev.gps_lng,
              gps_distance_m: gpsDist ?? prev.gps_distance_m,
              snapshot_data: snapshotData ? snapshotData : prev.snapshot_data,
              audit_note: auditNote
            };
            saveStore();
            return { lastInsertRowid: prev.id };
          } else {
            const id = (store.attendance.reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1;
            store.attendance.push({
              id,
              employee_id: Number(empId),
              date: String(date),
              check_in: checkIn,
              check_out: checkOut,
              status,
              source,
              device_name: deviceName,
              gps_lat: gpsLat,
              gps_lng: gpsLng,
              gps_distance_m: gpsDist,
              snapshot_data: snapshotData || '',
              audit_note: auditNote || ''
            });
            saveStore();
            return { lastInsertRowid: id };
          }
        }

        if (norm.includes('UPDATE employees SET full_name = ?')) {
          const [fullName, position, baseSalary, phone, tgUser, id] = params;
          const emp = store.employees.find((e) => e.id === Number(id));
          if (emp) {
            emp.full_name = fullName;
            emp.position = position;
            emp.base_salary = Number(baseSalary);
            emp.phone = phone;
            emp.telegram_username = tgUser;
            saveStore();
          }
          return { changes: emp ? 1 : 0 };
        }

        if (norm.includes('UPDATE employees SET face_registered = 1')) {
          const [faceDesc, facePhoto, id] = params;
          const emp = store.employees.find((e) => e.id === Number(id));
          if (emp) {
            emp.face_registered = 1;
            emp.face_descriptor = faceDesc;
            emp.face_photo = facePhoto;
            saveStore();
          }
          return { changes: emp ? 1 : 0 };
        }

        if (norm.includes('INSERT INTO employees')) {
          const id = (store.employees.reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1;
          store.employees.push({
            id,
            emp_code: params[0],
            full_name: params[1],
            position: params[2],
            department: params[3],
            branch_id: params[4],
            branch: params[5],
            base_salary: Number(params[6]),
            phone: params[7],
            telegram_username: params[8],
            telegram_chat_id: params[9],
            shift_start: params[10] || '09:00',
            shift_end: params[11] || '17:00',
            avatar_color: params[12] || '#10b981',
            face_registered: params[13] ?? 1,
            face_descriptor: typeof params[14] === 'string' && params[14].length > 20 ? params[14] : '',
            face_photo: params[15] || '',
            active: 1
          });
          saveStore();
          return { lastInsertRowid: id };
        }

        if (norm.includes('DELETE FROM employees WHERE id = ?')) {
          const id = Number(params[0]);
          store.employees = store.employees.filter((e) => e.id !== id);
          saveStore();
          return { changes: 1 };
        }

        if (norm.includes('INSERT INTO advances')) {
          const id = (store.advances.reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1;
          store.advances.push({
            id,
            employee_id: Number(params[0]),
            year_month: params[1],
            date: params[2],
            amount: Number(params[3]),
            reason: params[4] || 'Avans',
            status: 'approved',
            approved_by: 'Rahbar'
          });
          saveStore();
          return { lastInsertRowid: id };
        }

        if (norm.includes('INSERT INTO kpi_bonuses')) {
          const id = (store.kpi_bonuses.reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1;
          store.kpi_bonuses.push({
            id,
            employee_id: Number(params[0]),
            year_month: params[1],
            date: params[2],
            type: params[3],
            amount: Number(params[4]),
            comment: params[5]
          });
          saveStore();
          return { lastInsertRowid: id };
        }

        if (norm.includes('INSERT OR REPLACE INTO settings')) {
          store.settings[params[0]] = String(params[1]);
          saveStore();
          return { changes: 1 };
        }

        return { lastInsertRowid: 0 };
      }
    };
  }
};

module.exports = {
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
};
