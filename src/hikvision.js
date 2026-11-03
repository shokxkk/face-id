/**
 * Hikvision Face ID Terminal Integration Module (ISAPI HTTP Listening / Webhook + ISUP)
 *
 * Поддерживает реальные терминалы распознавания лиц Hikvision:
 * - DS-K1T341AMF / DS-K1T341BMI-T
 * - DS-K1T342 / DS-K1T343
 * - DS-K1T671M / DS-K1T673
 *
 * В настройках терминала Hikvision (Сеть -> Доп. настройки -> Сервер тревог / HTTP Listening):
 * URL назначения: /api/hikvision/event
 * Протокол: HTTP, Порт: 3000
 */

function parseHikvisionPayload(rawBodyStr, contentType = '') {
  if (!rawBodyStr) return null;

  // 1. Try direct JSON parse
  try {
    const parsed = JSON.parse(rawBodyStr);
    return extractEventDetails(parsed);
  } catch {
    // Not plain JSON; could be multipart/form-data from Hikvision ISAPI HTTP Listening
  }

  // 2. Try extracting JSON block inside multipart/form-data (Hikvision sends `name="event_log"` with JSON inside)
  const jsonMatch = rawBodyStr.match(/\{[\s\S]*"AccessControllerEvent"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return extractEventDetails(parsed);
    } catch {
      // continue
    }
  }

  // 3. Try simple XML tag extraction if older firmware sends XML EventNotificationAlert
  const empNoMatch = rawBodyStr.match(/<employeeNoString>([^<]+)<\/employeeNoString>/i);
  const nameMatch = rawBodyStr.match(/<name>([^<]+)<\/name>/i);
  const timeMatch = rawBodyStr.match(/<dateTime>([^<]+)<\/dateTime>/i);
  if (empNoMatch || nameMatch) {
    return {
      empCode: empNoMatch ? empNoMatch[1].trim() : null,
      employeeName: nameMatch ? nameMatch[1].trim() : null,
      dateTime: timeMatch ? timeMatch[1].trim() : new Date().toISOString(),
      attendanceStatus: 'auto',
      deviceName: 'Hikvision Face Terminal (XML)',
      subEventType: 75
    };
  }

  return null;
}

function extractEventDetails(obj) {
  const ace = obj.AccessControllerEvent || obj.event_log?.AccessControllerEvent || obj;
  const empCode =
    ace.employeeNoString ||
    ace.employeeNo ||
    obj.emp_code ||
    obj.employeeNoString ||
    null;

  const employeeName =
    ace.name ||
    obj.employee_name ||
    obj.name ||
    null;

  const dateTime =
    obj.dateTime ||
    ace.dateTime ||
    obj.timestamp ||
    new Date().toISOString();

  const attendanceStatus =
    ace.attendanceStatus ||
    obj.attendanceStatus ||
    obj.action ||
    'auto'; // 'checkIn' | 'checkOut' | 'auto'

  const deviceName =
    ace.deviceName ||
    obj.deviceName ||
    'Hikvision DS-K1T341AMF';

  const subEventType = Number(ace.subEventType ?? 75); // 75 = Face Authentication Passed

  return {
    empCode: empCode ? String(empCode).trim() : null,
    employeeName: employeeName ? String(employeeName).trim() : null,
    dateTime,
    attendanceStatus,
    deviceName,
    subEventType
  };
}

/**
 * Calculates distance in meters between two GPS coordinates using the Haversine formula.
 */
function calculateGpsDistanceMeters(lat1, lng1, lat2, lng2) {
  if (
    lat1 === null || lat1 === undefined ||
    lng1 === null || lng1 === undefined ||
    lat2 === null || lat2 === undefined ||
    lng2 === null || lng2 === undefined
  ) {
    return null;
  }
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

module.exports = {
  parseHikvisionPayload,
  calculateGpsDistanceMeters
};
