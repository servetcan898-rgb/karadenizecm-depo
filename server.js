const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Recreate or migrate schema cleanly in data/krdnzecm_depo.db
const dbPath = path.join(DATA_DIR, 'krdnzecm_depo.db');
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode = WAL;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS physical_shelves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL, -- 'SOL' | 'TURKCELL'
    target_logical_shelf TEXT NOT NULL, -- 'SAĞLAM' | 'SAĞLAM DÖNEN' | 'KARANTİNA' | 'ARIZA'
    capacity INTEGER DEFAULT 500,
    last_counted_at TEXT,
    last_counted_qty INTEGER,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS personnel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL DEFAULT '123456',
    full_name TEXT NOT NULL,
    team_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'TEKNİSYEN', -- 'TEKNİSYEN' | 'KARŞILAMA' | 'DEPOCU' | 'YÖNETİCİ'
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    last_vehicle_count_at TEXT,
    vehicle_count_status TEXT DEFAULT 'BEKLİYOR', -- 'BEKLİYOR' | 'TAMAMLANDI' | 'EKSİK_VAR'
    last_hourly_reminder_at TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL, -- 'SOL' | 'TURKCELL'
    model_name TEXT NOT NULL,
    logical_shelf TEXT NOT NULL, -- 'SAĞLAM' | 'SAĞLAM DÖNEN' | 'KARANTİNA' | 'ARIZA'
    previous_logical_shelf TEXT,
    shelf_mismatch_alert INTEGER DEFAULT 0,
    recommended_new_physical_shelf TEXT,
    physical_shelf_code TEXT,
    location_status TEXT NOT NULL DEFAULT 'DEPODA', -- 'DEPODA' | 'TEKNİSYENDE' | 'MÜŞTERİYE_KURULDU' | 'İADE_HAVUZUNDA' | 'ANA_DEPOYA_İADE'
    assigned_personnel_id INTEGER,
    assigned_at TEXT,
    sla_entry_date TEXT NOT NULL,
    sla_max_days INTEGER NOT NULL DEFAULT 90,
    last_sla_notified_date TEXT,
    last_report_seen_at TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS dispatch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no TEXT NOT NULL,
    category TEXT NOT NULL,
    model_name TEXT NOT NULL,
    logical_shelf TEXT NOT NULL,
    from_physical_shelf TEXT,
    personnel_id INTEGER NOT NULL,
    personnel_name TEXT NOT NULL,
    team_name TEXT NOT NULL,
    dispatched_by TEXT NOT NULL,
    dispatched_at TEXT NOT NULL, -- ISO timestamp (YYYY-MM-DDTHH:mm:ss)
    dispatch_type TEXT DEFAULT 'SABAH_DAĞITIM', -- 'SABAH_DAĞITIM' | 'GÜN_İÇİ_EK_TESLİMAT'
    status_after TEXT DEFAULT 'ZİMMETTE' -- 'ZİMMETTE' | 'MÜŞTERİYE_KURULDU'
  );

  CREATE TABLE IF NOT EXISTS shipment_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_code TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL, -- 'SOL' | 'TURKCELL'
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DOĞRULAMA_BEKLİYOR', -- 'DOĞRULAMA_BEKLİYOR' | 'ONAYLANDI'
    recommended_shelf TEXT NOT NULL,
    approved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS shipment_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    serial_no TEXT NOT NULL,
    model_name TEXT NOT NULL,
    in_turkcell_pool INTEGER DEFAULT 1,
    physically_scanned INTEGER DEFAULT 0,
    scanned_at TEXT
  );

  CREATE TABLE IF NOT EXISTS return_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no TEXT NOT NULL,
    category TEXT NOT NULL, -- 'SOL' | 'TURKCELL'
    model_name TEXT NOT NULL,
    source_type TEXT NOT NULL, -- 'KARŞILAMA' | 'TEKNİSYEN'
    reported_by_personnel_id INTEGER,
    reported_by_name TEXT,
    customer_note TEXT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'HAVUZDA_BEKLİYOR', -- 'HAVUZDA_BEKLİYOR' | 'DEPOCU_ONAYLADI'
    physically_scanned INTEGER DEFAULT 0,
    recommended_physical_shelf TEXT,
    approved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS count_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    count_type TEXT NOT NULL, -- 'HAFTALIK_ARAÇ' | 'AYLIK_DEPO_RAF'
    target_ref TEXT NOT NULL,
    target_name TEXT NOT NULL,
    expected_count INTEGER NOT NULL,
    scanned_count INTEGER NOT NULL,
    scanned_serials TEXT,
    missing_serials TEXT,
    extra_serials TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_name TEXT NOT NULL,
    recipient_phone TEXT,
    recipient_email TEXT,
    channel TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    auto_dispatched INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gateway_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transfer_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no TEXT NOT NULL,
    category TEXT NOT NULL,
    model_name TEXT NOT NULL,
    logical_shelf TEXT NOT NULL,
    transfer_type TEXT NOT NULL, -- 'TEKNİSYENDEN_TEKNİSYENE' | 'TEKNİSYENDEN_DEPOYA'
    from_personnel_id INTEGER NOT NULL,
    from_personnel_name TEXT NOT NULL,
    to_personnel_id INTEGER,
    to_personnel_name TEXT,
    recommended_physical_shelf TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'ONAY_BEKLİYOR', -- 'ONAY_BEKLİYOR' | 'ONAYLANDI' | 'REDDEDİLDİ'
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  );
`);

try {
  db.exec(`ALTER TABLE count_logs ADD COLUMN scanned_serials TEXT;`);
} catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    personnel_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function computeSLA(device) {
  const maxDays = device.logical_shelf === 'KARANTİNA' || device.logical_shelf === 'ARIZA' ? 30 : 90;
  const entryMs = new Date(device.sla_entry_date).getTime();
  const nowMs = Date.now();
  const daysElapsed = Math.max(0, Math.floor((nowMs - entryMs) / (1000 * 60 * 60 * 24)));
  const daysRemaining = maxDays - daysElapsed;
  let slaLevel = 'NORMAL';
  if (daysRemaining <= 0) slaLevel = 'AŞILDI';
  else if (daysRemaining <= 10) slaLevel = 'KRİTİK';
  else if (daysRemaining <= 20 && maxDays === 90) slaLevel = 'YAKLAŞTI';
  else if (daysRemaining <= 7 && maxDays === 30) slaLevel = 'KRİTİK';
  return {
    sla_max_days: maxDays,
    days_elapsed: daysElapsed,
    days_remaining: daysRemaining,
    sla_level: slaLevel
  };
}

function recommendPhysicalShelf(category, logicalShelf) {
  const shelves = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM devices d WHERE d.physical_shelf_code = s.code AND d.location_status = 'DEPODA') as current_count
    FROM physical_shelves s
    WHERE s.category = ? AND s.target_logical_shelf = ?
    ORDER BY (s.capacity - (SELECT COUNT(*) FROM devices d WHERE d.physical_shelf_code = s.code AND d.location_status = 'DEPODA')) DESC, s.code ASC
  `).all(category, logicalShelf);

  for (const sh of shelves) {
    if (sh.current_count < (sh.capacity || 500)) return sh.code;
  }
  // All matching shelves are full (or none exist) -> return null instead of overflowing a full shelf!
  return null;
}

function checkShelfCapacity(shelfCode, incomingCount = 1) {
  const code = String(shelfCode || '').trim().toUpperCase();
  if (!code || code === 'RAF_BEKLİYOR') {
    return { ok: false, error: 'Lütfen geçerli bir fiziksel raf seçiniz.' };
  }
  const shelf = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM devices d WHERE d.physical_shelf_code = s.code AND d.location_status = 'DEPODA') as current_count
    FROM physical_shelves s
    WHERE s.code = ?
  `).get(code);
  if (!shelf) {
    return { ok: false, error: `'${code}' fiziksel rafı bulunamadı.` };
  }
  const cap = Number(shelf.capacity) || 500;
  const cur = Number(shelf.current_count) || 0;
  const free = Math.max(0, cap - cur);
  if (cur + incomingCount > cap) {
    return {
      ok: false,
      shelf,
      current: cur,
      capacity: cap,
      free,
      error: `KAPASİTE DOLU: '${code}' rafında şu an ${cur}/${cap} cihaz var (Boş yer: ${free}). ${incomingCount} adet cihaz sığmıyor! Lütfen boş kapasiteli başka bir raf seçin veya 7. sekmeden kapasiteyi artırıp yeni raf açın.`
    };
  }
  return { ok: true, shelf, current: cur, capacity: cap, free };
}

// ==================== ZERO-DEPENDENCY REAL MULTI-SHEET .XLSX GENERATOR ====================
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32Buf(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEscape(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colIndexToLetter(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf);
    const crc = crc32Buf(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compBuf.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function buildMultiSheetXlsxBuffer(sheets) {
  const safeSheets = sheets.map((sh, i) => ({
    ...sh,
    safeName: String(sh.name || `Sayfa${i + 1}`).replace(/[\[\]:*?/\\]/g, '_').slice(0, 31)
  }));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${safeSheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${safeSheets.map((sh, i) => `<sheet name="${xmlEscape(sh.safeName)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${safeSheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n  ')}
  <Relationship Id="rId${safeSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="10"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>`;

  const zipEntries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: stylesXml }
  ];

  safeSheets.forEach((sh, sIdx) => {
    const colsXml = (sh.columns || []).length
      ? `<cols>${sh.columns.map((c, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${c.width || 18}" customWidth="1"/>`).join('')}</cols>`
      : '';

    const rowXmlParts = [];
    let rowNum = 1;

    if (sh.columns && sh.columns.length) {
      const cells = sh.columns.map((c, ci) =>
        `<c r="${colIndexToLetter(ci)}${rowNum}" s="1" t="inlineStr"><is><t>${xmlEscape(c.header)}</t></is></c>`
      ).join('');
      rowXmlParts.push(`<row r="${rowNum}" ht="22" customHeight="1">${cells}</row>`);
      rowNum++;
    }

    for (const row of (sh.rows || [])) {
      const isSection = row && !Array.isArray(row) && row.__section;
      const vals = isSection ? row.values : row;
      const styleId = isSection ? '2' : '0';
      const cells = (vals || []).map((v, ci) => {
        const ref = `${colIndexToLetter(ci)}${rowNum}`;
        if (typeof v === 'number' && Number.isFinite(v)) {
          return `<c r="${ref}" s="${styleId}" t="n"><v>${v}</v></c>`;
        }
        return `<c r="${ref}" s="${styleId}" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
      }).join('');
      rowXmlParts.push(`<row r="${rowNum}">${cells}</row>`);
      rowNum++;
    }

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${colsXml}
  <sheetData>${rowXmlParts.join('')}</sheetData>
</worksheet>`;

    zipEntries.push({ name: `xl/worksheets/sheet${sIdx + 1}.xml`, data: sheetXml });
  });

  return createZipBuffer(zipEntries);
}

// ==================== DEFAULT NOTIFICATION RECIPIENTS ====================
const DEFAULT_SLA_REPORT_TO = 'hasan.kadioglu@bireysel.superonline.net';
const DEFAULT_SLA_REPORT_CC = 'dogancan.aksoy@guraks.com.tr, mehmet.celep@sam.superonline.net, servetcan.kucuksolak@sam.superonline.net';
const DEFAULT_DISPATCH_REPORT_CC = 'hasan.kadioglu@bireysel.superonline.net, servetcan.kucuksolak@sam.superonline.net';
const DEFAULT_VEHICLE_REMINDER_CC = 'hasan.kadioglu@bireysel.superonline.net, servetcan.kucuksolak@sam.superonline.net, mehmet.celep@sam.superonline.net';
const DEFAULT_VEHICLE_FINAL_TO = 'hasan.kadioglu@bireysel.superonline.net';
const DEFAULT_VEHICLE_FINAL_CC = 'servetcan.kucuksolak@sam.superonline.net, meryem.kalafat@bireysel.superonline.net, dogancan.aksoy@guraks.com.tr';
const DEFAULT_DEPOCOUNT_TO = 'hasan.kadioglu@bireysel.superonline.net';
const DEFAULT_DEPOCOUNT_CC = 'dogancan.aksoy@guraks.com.tr, mehmet.celep@sam.superonline.net, servetcan.kucuksolak@sam.superonline.net, meryem.kalafat@bireysel.superonline.net';

function getSettingValue(key, fallback = '') {
  const row = db.prepare(`SELECT value FROM gateway_settings WHERE key = ?`).get(key);
  return (row && row.value && row.value.trim()) ? row.value.trim() : fallback;
}

function setSettingValue(key, value) {
  db.prepare(`
    INSERT INTO gateway_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? '').trim());
}

// Build Full Executive SLA Dashboard Report (HTML + Plain Text + 4-Sheet .xlsx Buffer)
function buildSlaExecutiveReport() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const trDateTime = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  const rawDevices = db.prepare(`
    SELECT d.*, p.full_name as personnel_name, p.team_name as personnel_team, p.phone as personnel_phone, p.email as personnel_email
    FROM devices d
    LEFT JOIN personnel p ON d.assigned_personnel_id = p.id
    WHERE d.location_status IN ('DEPODA', 'TEKNİSYENDE')
  `).all();

  const allActive = rawDevices.map(raw => ({ ...raw, ...computeSLA(raw) }));
  const criticalAll = allActive.filter(d => d.days_remaining <= 10).sort((a, b) => a.days_remaining - b.days_remaining);

  const depodaAll = criticalAll.filter(d => d.location_status === 'DEPODA');
  const depodaSol = depodaAll.filter(d => d.category === 'SOL');
  const depodaTurkcell = depodaAll.filter(d => d.category === 'TURKCELL');
  const techAll = criticalAll.filter(d => d.location_status === 'TEKNİSYENDE');

  const solTotal = criticalAll.filter(d => d.category === 'SOL').length;
  const turkcellTotal = criticalAll.filter(d => d.category === 'TURKCELL').length;
  const exceededTotal = criticalAll.filter(d => d.days_remaining <= 0).length;
  const warningTotal = criticalAll.filter(d => d.days_remaining > 0 && d.days_remaining <= 10).length;

  const logicalOrder = ['SAĞLAM', 'SAĞLAM DÖNEN', 'KARANTİNA', 'ARIZA'];
  const buildCategoryMatrix = (list) => {
    const map = {};
    for (const sh of logicalOrder) map[sh] = { exceeded: 0, warning: 0, total: 0 };
    for (const d of list) {
      const key = map[d.logical_shelf] ? d.logical_shelf : 'SAĞLAM';
      map[key].total++;
      if (d.days_remaining <= 0) map[key].exceeded++;
      else map[key].warning++;
    }
    return map;
  };

  const solMatrix = buildCategoryMatrix(depodaSol);
  const tcellMatrix = buildCategoryMatrix(depodaTurkcell);

  // Per-technician summary
  const techSummaryMap = new Map();
  for (const d of techAll) {
    const key = d.assigned_personnel_id || d.personnel_name || 'Bilinmeyen';
    if (!techSummaryMap.has(key)) {
      techSummaryMap.set(key, {
        name: d.personnel_name || 'Atanmamış',
        team: d.personnel_team || '-',
        phone: d.personnel_phone || '-',
        sol: 0,
        turkcell: 0,
        exceeded: 0,
        warning: 0,
        total: 0,
        minDays: d.days_remaining
      });
    }
    const t = techSummaryMap.get(key);
    if (d.category === 'SOL') t.sol++; else t.turkcell++;
    if (d.days_remaining <= 0) t.exceeded++; else t.warning++;
    t.total++;
    if (d.days_remaining < t.minDays) t.minDays = d.days_remaining;
  }
  const techSummary = Array.from(techSummaryMap.values()).sort((a, b) => b.total - a.total || a.minDays - b.minDays);

  const slaLabel = (d) => d.days_remaining <= 0 ? `SLA AŞILDI (${Math.abs(d.days_remaining)}G Geçti)` : `KRİTİK (Son ${d.days_remaining}G)`;

  // 1. Build 4-Sheet Real Excel (.xlsx)
  const ozetRows = [
    { __section: true, values: ['KARADENİZ EÇM — KRİTİK SLA YÖNETİCİ ÖZETİ', `Rapor Tarihi: ${trDateTime}`, '', '', '', '', ''] },
    ['Toplam Aktif Stok (Depo + Teknisyen)', allActive.length, '', '', '', '', ''],
    ['Toplam SLA Sorunlu Cihaz (≤ 10 Gün / Aşıldı)', criticalAll.length, 'SLA Aşıldı (≤0G):', exceededTotal, 'Kritik (1-10G):', warningTotal, ''],
    ['Depoda SLA Sorunlu Cihaz', depodaAll.length, 'SOL Depo:', depodaSol.length, 'TURKCELL Depo:', depodaTurkcell.length, ''],
    ['Teknisyende SLA Sorunlu Cihaz', techAll.length, 'Toplam SOL SLA:', solTotal, 'Toplam TURKCELL SLA:', turkcellTotal, ''],
    ['', '', '', '', '', '', ''],
    { __section: true, values: ['DEPO STOK SLA DAĞILIMI (ÜRÜN GRUBU VE RAF STATÜSÜ)', 'SLA Limiti', 'SLA Aşıldı (≤0G)', 'Kritik (1-10G)', 'Toplam', '', ''] },
    ...logicalOrder.map(sh => [`SOL — ${sh}`, (sh === 'KARANTİNA' || sh === 'ARIZA') ? '30 Gün' : '90 Gün', solMatrix[sh].exceeded, solMatrix[sh].warning, solMatrix[sh].total, '', '']),
    ['SOL DEPO TOPLAM', '', depodaSol.filter(d => d.days_remaining <= 0).length, depodaSol.filter(d => d.days_remaining > 0).length, depodaSol.length, '', ''],
    ...logicalOrder.map(sh => [`TURKCELL — ${sh}`, (sh === 'KARANTİNA' || sh === 'ARIZA') ? '30 Gün' : '90 Gün', tcellMatrix[sh].exceeded, tcellMatrix[sh].warning, tcellMatrix[sh].total, '', '']),
    ['TURKCELL DEPO TOPLAM', '', depodaTurkcell.filter(d => d.days_remaining <= 0).length, depodaTurkcell.filter(d => d.days_remaining > 0).length, depodaTurkcell.length, '', ''],
    ['', '', '', '', '', '', ''],
    { __section: true, values: ['TEKNİSYEN BAZLI SLA SORUNLU CİHAZ DAĞILIMI', 'Ekip', 'SOL Adet', 'TURKCELL Adet', 'SLA Aşıldı', 'Kritik (1-10G)', 'Toplam'] },
    ...(techSummary.length
      ? techSummary.map(t => [t.name, t.team, t.sol, t.turkcell, t.exceeded, t.warning, t.total])
      : [['Teknisyen zimmetlerinde SLA sorunlu cihaz bulunmamaktadır.', '-', 0, 0, 0, 0, 0]])
  ];

  const deviceCols = [
    { header: 'Seri No', width: 22 },
    { header: 'Model / Kalem Tanımı', width: 32 },
    { header: 'Mantıksal Raf', width: 16 },
    { header: 'Fiziksel Raf', width: 14 },
    { header: 'Son İşlem Tarihi', width: 16 },
    { header: 'SLA Limiti (Gün)', width: 15 },
    { header: 'Geçen Gün', width: 12 },
    { header: 'Kalan Gün', width: 12 },
    { header: 'SLA Durumu', width: 22 },
    { header: 'Açıklama / Not', width: 34 }
  ];

  const toWarehouseRows = (list) => list.map(d => [
    d.serial_no, d.model_name, d.logical_shelf, d.physical_shelf_code || '-',
    d.sla_entry_date, d.sla_max_days, d.days_elapsed, d.days_remaining,
    slaLabel(d), d.notes || '-'
  ]);

  const techCols = [
    { header: 'Teknisyen Adı', width: 24 },
    { header: 'Ekip / Görev', width: 28 },
    { header: 'Telefon', width: 16 },
    { header: 'Seri No', width: 22 },
    { header: 'Kategori', width: 12 },
    { header: 'Model / Kalem Tanımı', width: 30 },
    { header: 'Mantıksal Raf', width: 16 },
    { header: 'Son İşlem Tarihi', width: 16 },
    { header: 'Geçen Gün', width: 12 },
    { header: 'Kalan Gün', width: 12 },
    { header: 'SLA Durumu', width: 22 }
  ];

  const toTechRows = (list) => list.map(d => [
    d.personnel_name || '-', d.personnel_team || '-', d.personnel_phone || '-',
    d.serial_no, d.category, d.model_name, d.logical_shelf,
    d.sla_entry_date, d.days_elapsed, d.days_remaining, slaLabel(d)
  ]);

  const xlsxBuffer = buildMultiSheetXlsxBuffer([
    {
      name: 'Ozet_Dashboard',
      columns: [
        { header: 'Metrik / Kırılım', width: 42 },
        { header: 'Değer / Birim', width: 22 },
        { header: 'Detay 1', width: 16 },
        { header: 'Detay 2', width: 16 },
        { header: 'Detay 3', width: 16 },
        { header: 'Detay 4', width: 16 },
        { header: 'Toplam', width: 14 }
      ],
      rows: ozetRows
    },
    { name: 'Depo_SOL_SLA', columns: deviceCols, rows: toWarehouseRows(depodaSol) },
    { name: 'Depo_TURKCELL_SLA', columns: deviceCols, rows: toWarehouseRows(depodaTurkcell) },
    { name: 'Teknisyen_SLA', columns: techCols, rows: toTechRows(techAll) }
  ]);

  const filename = `KaradenizECM_Kritik_SLA_Raporu_${todayStr}.xlsx`;

  // 2. Build Corporate HTML Dashboard Email
  const renderMatrixRowsHtml = (catLabel, badgeBg, badgeColor, matrix, totalList) => {
    const rows = logicalOrder.map(sh => {
      const m = matrix[sh];
      const limitTxt = (sh === 'KARANTİNA' || sh === 'ARIZA') ? '30 Gün' : '90 Gün';
      return `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;">
            <span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${badgeBg};color:${badgeColor};margin-right:6px;">${catLabel}</span>
            <strong>${sh}</strong> <span style="color:#64748b;font-size:11px;">(${limitTxt})</span>
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px;font-weight:700;color:${m.exceeded > 0 ? '#dc2626' : '#94a3b8'};">${m.exceeded}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px;font-weight:700;color:${m.warning > 0 ? '#d97706' : '#94a3b8'};">${m.warning}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px;font-weight:800;color:#0f172a;">${m.total}</td>
        </tr>`;
    }).join('');
    const totExc = totalList.filter(d => d.days_remaining <= 0).length;
    const totWarn = totalList.filter(d => d.days_remaining > 0).length;
    return rows + `
      <tr style="background:#f8fafc;">
        <td style="padding:8px 10px;border-bottom:2px solid #cbd5e1;font-size:13px;font-weight:800;color:#0f172a;">${catLabel} DEPO TOPLAMI</td>
        <td style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:center;font-size:13px;font-weight:800;color:#dc2626;">${totExc}</td>
        <td style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:center;font-size:13px;font-weight:800;color:#d97706;">${totWarn}</td>
        <td style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:center;font-size:14px;font-weight:800;color:#0f172a;">${totalList.length}</td>
      </tr>`;
  };

  const techRowsHtml = techSummary.length
    ? techSummary.map(t => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#0f172a;">${xmlEscape(t.name)}<div style="font-size:11px;font-weight:400;color:#64748b;">${xmlEscape(t.team)}</div></td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px;color:#0369a1;font-weight:700;">${t.sol}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px;color:#b45309;font-weight:700;">${t.turkcell}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px;color:#dc2626;font-weight:700;">${t.exceeded}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px;color:#d97706;font-weight:700;">${t.warning}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:13px;font-weight:800;color:#0f172a;">${t.total}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" style="padding:14px;text-align:center;font-size:13px;color:#059669;font-weight:600;background:#ecfdf5;">Teknisyen zimmetlerinde SLA kritik veya süresi aşan cihaz bulunmamaktadır.</td></tr>`;

  const htmlBody = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;padding:20px;color:#0f172a;">
    <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #cbd5e1;">
      <!-- Header -->
      <div style="background:#0f172a;padding:22px 26px;border-bottom:4px solid #facc15;">
        <div style="font-size:11px;letter-spacing:1.4px;color:#facc15;font-weight:700;text-transform:uppercase;">KARADENİZ EÇM • DEPO VE ZİMMET YÖNETİM SİSTEMİ</div>
        <div style="font-size:21px;font-weight:800;color:#ffffff;margin-top:4px;">Günlük Kritik SLA Yönetim Raporu</div>
        <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Rapor Tarihi: ${trDateTime} &nbsp;|&nbsp; Kapsam: SLA Süresi Aşılan (≤0G) ve Kritik (1–10G) Cihazlar</div>
      </div>

      <div style="padding:22px 26px;">
        <!-- KPI Cards -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:0 -8px 20px -8px;">
          <tr>
            <td width="25%" style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#991b1b;text-transform:uppercase;">Toplam SLA Sorunlu</div>
              <div style="font-size:26px;font-weight:900;color:#dc2626;margin-top:4px;">${criticalAll.length}</div>
              <div style="font-size:11px;color:#7f1d1d;margin-top:2px;">${exceededTotal} Aşıldı • ${warningTotal} Kritik</div>
            </td>
            <td width="25%" style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#334155;text-transform:uppercase;">Depo Raflarında</div>
              <div style="font-size:26px;font-weight:900;color:#0f172a;margin-top:4px;">${depodaAll.length}</div>
              <div style="font-size:11px;color:#475569;margin-top:2px;">${depodaSol.length} SOL • ${depodaTurkcell.length} TURKCELL</div>
            </td>
            <td width="25%" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#92400e;text-transform:uppercase;">Teknisyen Zimmeti</div>
              <div style="font-size:26px;font-weight:900;color:#d97706;margin-top:4px;">${techAll.length}</div>
              <div style="font-size:11px;color:#78350f;margin-top:2px;">${techSummary.length} Teknisyende</div>
            </td>
            <td width="25%" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#1e40af;text-transform:uppercase;">SOL / TURKCELL</div>
              <div style="font-size:20px;font-weight:900;color:#1d4ed8;margin-top:8px;">${solTotal} / ${turkcellTotal}</div>
              <div style="font-size:11px;color:#1e3a8a;margin-top:4px;">Toplam Aktif: ${allActive.length}</div>
            </td>
          </tr>
        </table>

        <!-- Section 1: Warehouse Breakdown -->
        <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;border-left:4px solid #0284c7;padding-left:10px;">
          1. Depo Stok SLA Dağılımı (SOL ve TURKCELL Ürün Grupları)
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;margin-bottom:22px;">
          <thead>
            <tr style="background:#0f172a;color:#ffffff;">
              <th style="padding:9px 10px;text-align:left;font-size:12px;">Ürün Grubu &amp; Mantıksal Raf</th>
              <th style="padding:9px 10px;text-align:center;font-size:12px;">SLA Aşıldı (≤0G)</th>
              <th style="padding:9px 10px;text-align:center;font-size:12px;">Kritik (1–10G)</th>
              <th style="padding:9px 10px;text-align:center;font-size:12px;">Toplam</th>
            </tr>
          </thead>
          <tbody>
            ${renderMatrixRowsHtml('SOL', '#dbeafe', '#1d4ed8', solMatrix, depodaSol)}
            ${renderMatrixRowsHtml('TURKCELL', '#fef3c7', '#b45309', tcellMatrix, depodaTurkcell)}
          </tbody>
        </table>

        <!-- Section 2: Technician Breakdown -->
        <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:8px;border-left:4px solid #f59e0b;padding-left:10px;">
          2. Teknisyen Zimmeti SLA Dağılımı
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;margin-bottom:20px;">
          <thead>
            <tr style="background:#1e293b;color:#ffffff;">
              <th style="padding:9px 10px;text-align:left;font-size:12px;">Teknisyen / Ekip</th>
              <th style="padding:9px 10px;text-align:center;font-size:12px;">SOL</th>
              <th style="padding:9px 10px;text-align:center;font-size:12px;">TURKCELL</th>
              <th style="padding:9px 10px;text-align:center;font-size:12px;">Aşıldı</th>
              <th style="padding:9px 10px;text-align:center;font-size:12px;">1–10G</th>
              <th style="padding:9px 10px;text-align:center;font-size:12px;">Toplam</th>
            </tr>
          </thead>
          <tbody>
            ${techRowsHtml}
          </tbody>
        </table>

        <!-- Attachment Info -->
        <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:12px 14px;font-size:12px;color:#334155;line-height:1.6;">
          <strong>Ekteki Excel Raporu (${filename}):</strong><br/>
          Seri numarası bazlı tüm detaylar 4 ayrı sekmede sunulmuştur:
          <strong>1) Ozet_Dashboard</strong> &nbsp;•&nbsp;
          <strong>2) Depo_SOL_SLA</strong> (${depodaSol.length} cihaz) &nbsp;•&nbsp;
          <strong>3) Depo_TURKCELL_SLA</strong> (${depodaTurkcell.length} cihaz) &nbsp;•&nbsp;
          <strong>4) Teknisyen_SLA</strong> (${techAll.length} cihaz)
        </div>
      </div>

      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:12px 26px;font-size:11px;color:#64748b;text-align:center;">
        Bu e-posta <strong>KARADENİZ EÇM Depo ve Zimmet Yönetim Sistemi</strong> tarafından otomatik olarak oluşturulmuştur.
      </div>
    </div>
  </div>`;

  const textBody = [
    `KARADENİZ EÇM — GÜNLÜK KRİTİK SLA YÖNETİM RAPORU (${trDateTime})`,
    `================================================================`,
    `Toplam SLA Sorunlu Cihaz (≤10 Gün / Aşıldı): ${criticalAll.length} (${exceededTotal} Aşıldı, ${warningTotal} Kritik)`,
    `- Depo Raflarında: ${depodaAll.length} (${depodaSol.length} SOL, ${depodaTurkcell.length} TURKCELL)`,
    `  * SOL: Sağlam=${solMatrix['SAĞLAM'].total}, Sağlam Dönen=${solMatrix['SAĞLAM DÖNEN'].total}, Karantina=${solMatrix['KARANTİNA'].total}, Arıza=${solMatrix['ARIZA'].total}`,
    `  * TURKCELL: Sağlam=${tcellMatrix['SAĞLAM'].total}, Sağlam Dönen=${tcellMatrix['SAĞLAM DÖNEN'].total}, Karantina=${tcellMatrix['KARANTİNA'].total}, Arıza=${tcellMatrix['ARIZA'].total}`,
    `- Teknisyen Zimmetinde: ${techAll.length} (${techSummary.length} teknisyen)`,
    ``,
    `Seri bazlı tüm detaylar ekteki 4 sekmeli Excel (${filename}) dosyasındadır.`
  ].join('\n');

  const toEmail = getSettingValue('sla_report_to', DEFAULT_SLA_REPORT_TO);
  const ccEmail = getSettingValue('sla_report_cc', DEFAULT_SLA_REPORT_CC);

  return {
    todayStr,
    filename,
    toEmail,
    ccEmail,
    totalCritical: criticalAll.length,
    depodaCount: depodaAll.length,
    techCount: techAll.length,
    solTotal,
    turkcellTotal,
    subject: `[KARADENİZ EÇM] Günlük Kritik SLA Raporu — ${criticalAll.length} Cihaz (${depodaSol.length} SOL / ${depodaTurkcell.length} TURKCELL / ${techAll.length} Teknisyen) | ${todayStr}`,
    textBody,
    htmlBody,
    xlsxBuffer
  };
}

// ==================== BUILT-IN ZERO-COST WHATSAPP ENGINE (BAILEYS QR + ANTI-SPAM QUEUE + DRIVE PERSISTENCE) ====================
const WA_AUTH_DIR = path.join(DATA_DIR, 'wa_auth');
if (!fs.existsSync(WA_AUTH_DIR)) fs.mkdirSync(WA_AUTH_DIR, { recursive: true });

let waSock = null;
let waState = 'DISCONNECTED'; // 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED' | 'MODULE_MISSING'
let waQrDataUrl = null;
let waConnectedPhone = '';
let waLastError = '';
let waQueue = [];
let waQueueBusy = false;
let waReconnectTimer = null;

function normalizeTrPhone(raw) {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('0090')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('05')) digits = '90' + digits.slice(1);
  if (digits.length === 10 && digits.startsWith('5')) digits = '90' + digits;
  return digits.length >= 11 ? digits : '';
}

function exportWaAuthFiles() {
  const out = {};
  try {
    if (!fs.existsSync(WA_AUTH_DIR)) return out;
    for (const f of fs.readdirSync(WA_AUTH_DIR)) {
      if (f.endsWith('.json')) {
        out[f] = fs.readFileSync(path.join(WA_AUTH_DIR, f), 'utf8');
      }
    }
  } catch (_) {}
  return out;
}

function importWaAuthFiles(filesObj) {
  if (!filesObj || typeof filesObj !== 'object') return false;
  try {
    if (!fs.existsSync(WA_AUTH_DIR)) fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
    let count = 0;
    for (const [fname, content] of Object.entries(filesObj)) {
      if (!fname.endsWith('.json') || fname.includes('/') || fname.includes('\\') || fname.includes('..')) continue;
      if (typeof content === 'string') {
        fs.writeFileSync(path.join(WA_AUTH_DIR, fname), content, 'utf8');
        count++;
      }
    }
    return count > 0;
  } catch (_) {
    return false;
  }
}

async function processWaQueue() {
  if (waQueueBusy) return;
  if (!waSock || waState !== 'CONNECTED' || waQueue.length === 0) return;
  waQueueBusy = true;
  try {
    while (waQueue.length > 0 && waSock && waState === 'CONNECTED') {
      const item = waQueue.shift();
      try {
        const jid = `${item.phone}@s.whatsapp.net`;
        await waSock.sendMessage(jid, { text: item.text });
      } catch (err) {
        console.error(`WhatsApp gonderim hatasi (${item.phone}):`, err.message);
      }
      // 2.5 second anti-spam delay between WhatsApp messages
      if (waQueue.length > 0) {
        await new Promise(r => setTimeout(r, 2500));
      }
    }
  } finally {
    waQueueBusy = false;
  }
}

function enqueueWhatsAppMessage(phonesStr, title, message) {
  const rawList = String(phonesStr || '').split(/[,;\n]+/).map(normalizeTrPhone).filter(Boolean);
  const uniquePhones = [...new Set(rawList)];
  if (!uniquePhones.length) return 0;

  const formattedText = `*KARADENİZ EÇM*\n*${title}*\n\n${message}`;
  for (const phone of uniquePhones) {
    waQueue.push({ phone, text: formattedText });
  }
  processWaQueue();
  return uniquePhones.length;
}

async function initWhatsAppConnection(forceFresh = false) {
  if (waReconnectTimer) {
    clearTimeout(waReconnectTimer);
    waReconnectTimer = null;
  }
  if (forceFresh && waSock) {
    try { waSock.end(undefined); } catch (_) {}
    waSock = null;
  }
  if (waSock && (waState === 'CONNECTED' || waState === 'CONNECTING' || waState === 'QR_READY')) {
    return getWhatsAppStatus();
  }

  let baileysMod, pinoMod, QRCodeMod;
  try {
    baileysMod = await import('@whiskeysockets/baileys');
    pinoMod = await import('pino');
    QRCodeMod = await import('qrcode');
  } catch (err) {
    waState = 'MODULE_MISSING';
    waLastError = 'WhatsApp paketi (@whiskeysockets/baileys) henüz kurulu değil (Render dağıtımda otomatik kurulur).';
    return getWhatsAppStatus();
  }

  const makeWASocket = baileysMod.default?.default || baileysMod.default || baileysMod.makeWASocket;
  const useMultiFileAuthState = baileysMod.useMultiFileAuthState || baileysMod.default?.useMultiFileAuthState;
  const DisconnectReason = baileysMod.DisconnectReason || baileysMod.default?.DisconnectReason || { loggedOut: 401 };
  const fetchLatestBaileysVersion = baileysMod.fetchLatestBaileysVersion || baileysMod.default?.fetchLatestBaileysVersion;
  const pino = pinoMod.default || pinoMod;
  const QRCode = QRCodeMod.default || QRCodeMod;

  waState = 'CONNECTING';
  waLastError = '';
  waQrDataUrl = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
    let version;
    try {
      if (fetchLatestBaileysVersion) {
        const vInfo = await fetchLatestBaileysVersion();
        version = vInfo?.version;
      }
    } catch (_) {}

    waSock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Karadeniz ECM Depo', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    waSock.ev.on('creds.update', async () => {
      await saveCreds();
      scheduleCloudDatabaseSync();
    });

    waSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          waQrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 2 });
          waState = 'QR_READY';
        } catch (qErr) {
          waLastError = qErr.message;
        }
      }
      if (connection === 'open') {
        waState = 'CONNECTED';
        waQrDataUrl = null;
        waLastError = '';
        waConnectedPhone = (waSock?.user?.id || '').split(':')[0].split('@')[0];
        console.log(`WhatsApp baglandi: ${waConnectedPhone}`);
        scheduleCloudDatabaseSync();
        processWaQueue();
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        waSock = null;
        waQrDataUrl = null;
        if (loggedOut) {
          waState = 'DISCONNECTED';
          waConnectedPhone = '';
          waLastError = 'WhatsApp oturumu kapatıldı. Tekrar bağlamak için QR okutunuz.';
          try {
            for (const f of fs.readdirSync(WA_AUTH_DIR)) fs.unlinkSync(path.join(WA_AUTH_DIR, f));
          } catch (_) {}
        } else {
          waState = 'CONNECTING';
          waLastError = `Bağlantı koptu (${statusCode || 'net'}), 5 sn içinde yeniden bağlanılıyor...`;
          waReconnectTimer = setTimeout(() => {
            initWhatsAppConnection(false).catch(() => {});
          }, 5000);
        }
      }
    });
  } catch (err) {
    waState = 'DISCONNECTED';
    waLastError = err.message;
  }

  return getWhatsAppStatus();
}

async function logoutWhatsApp() {
  if (waReconnectTimer) {
    clearTimeout(waReconnectTimer);
    waReconnectTimer = null;
  }
  try {
    if (waSock) await waSock.logout();
  } catch (_) {}
  try {
    if (waSock) waSock.end(undefined);
  } catch (_) {}
  waSock = null;
  waState = 'DISCONNECTED';
  waQrDataUrl = null;
  waConnectedPhone = '';
  waLastError = '';
  try {
    if (fs.existsSync(WA_AUTH_DIR)) {
      for (const f of fs.readdirSync(WA_AUTH_DIR)) fs.unlinkSync(path.join(WA_AUTH_DIR, f));
    }
  } catch (_) {}
  scheduleCloudDatabaseSync();
  return getWhatsAppStatus();
}

function getWhatsAppStatus() {
  return {
    state: waState,
    connected: waState === 'CONNECTED',
    phone: waConnectedPhone,
    qrDataUrl: waQrDataUrl,
    queueLength: waQueue.length,
    error: waLastError
  };
}

// Smart Automatic Notification Dispatcher (Supports TO, CC, HTML Dashboard Body, Real .xlsx Attachments & Built-in WhatsApp)
async function dispatchAutoNotification({ recipient_name, recipient_phone, recipient_email, recipient_cc = '', category, title, message, htmlBody = '', attachment = null }) {
  if (!message || !message.trim()) return { ok: false, error: 'Boş mesaj' };
  const now = new Date().toISOString();
  const loggedEmail = recipient_cc ? `TO: ${recipient_email || '-'} | CC: ${recipient_cc}` : (recipient_email || '');

  db.prepare(`
    INSERT INTO notifications_log (recipient_name, recipient_phone, recipient_email, channel, category, title, message, auto_dispatched, created_at)
    VALUES (?, ?, ?, 'OTOMATİK WHATSAPP + E-POSTA', ?, ?, ?, 1, ?)
  `).run(recipient_name, recipient_phone || '', loggedEmail, category, title, message, now);

  let mailSent = false;
  let mailError = '';

  try {
    // 1. Built-in Baileys WhatsApp Engine (0 TL, rate-limited 2.5s queue)
    if (recipient_phone && waState === 'CONNECTED') {
      enqueueWhatsAppMessage(recipient_phone, title, message);
    }
    // 2. Optional external WhatsApp Webhook fallback
    const waWebhook = db.prepare(`SELECT value FROM gateway_settings WHERE key = 'whatsapp_webhook_url'`).get()?.value || process.env.WHATSAPP_WEBHOOK_URL;
    if (waWebhook && recipient_phone) {
      fetch(waWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: recipient_phone, title, message })
      }).catch(() => {});
    }
    const mailWebhook = db.prepare(`SELECT value FROM gateway_settings WHERE key = 'email_webhook_url'`).get()?.value || process.env.CLOUD_DB_URL;
    if (mailWebhook && recipient_email) {
      const payload = {
        action: 'SEND_EMAIL',
        to: recipient_email,
        cc: recipient_cc || '',
        subject: title,
        text: message,
        htmlBody: htmlBody || ''
      };
      if (attachment && attachment.base64) {
        payload.attachment = attachment;
      }
      const res = await fetch(mailWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      mailSent = res.ok;
      if (!res.ok) mailError = `HTTP ${res.status}`;
    } else if (!mailWebhook) {
      mailError = 'E-Posta servis URL (CLOUD_DB_URL) tanımlı değil.';
    }
  } catch (err) {
    mailError = err.message;
    console.error('Bildirim gönderim hatası:', err.message);
  }
  return { ok: mailSent, mail_sent: mailSent, error: mailError };
}

function getIstanbulDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value || '00';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return {
    weekday: get('weekday'), // 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute
  };
}

let slaSendInProgress = false;
async function sendSlaExecutiveDashboardReport(forceSend = false) {
  const tr = getIstanbulDateParts();
  const lastSent = getSettingValue('last_sla_executive_sent_date', '');

  if (!forceSend) {
    // Scheduled strictly at 23:59 Europe/Istanbul time, once per day
    if (!(tr.hour === 23 && tr.minute >= 59)) {
      return { ok: true, skipped: true, reason: 'Saat 23:59 (TR) bekleniyor.' };
    }
    if (lastSent === tr.dateStr) {
      return { ok: true, skipped: true, reason: 'Bugünkü 23:59 raporu zaten gönderildi.' };
    }
    if (slaSendInProgress) {
      return { ok: true, skipped: true, reason: 'Gönderim devam ediyor.' };
    }
  }

  slaSendInProgress = true;
  try {
    const report = buildSlaExecutiveReport();
    if (!forceSend && report.totalCritical === 0) {
      setSettingValue('last_sla_executive_sent_date', tr.dateStr);
      return { ok: true, skipped: true, reason: 'Kritik SLA cihazı yok.' };
    }

    const res = await dispatchAutoNotification({
      recipient_name: 'Hasan İlker Kadıoğlu (TO) | Doğancan Aksoy, Mehmet Salih Celep, Servetcan Küçüksolak (CC)',
      recipient_phone: '905303821619, 905616101203, 905330879563',
      recipient_email: report.toEmail,
      recipient_cc: report.ccEmail,
      category: 'OTOMATİK_SLA_DASHBOARD',
      title: report.subject,
      message: report.textBody,
      htmlBody: report.htmlBody,
      attachment: {
        filename: report.filename,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        base64: report.xlsxBuffer.toString('base64')
      }
    });

    // Only mark scheduled date on automatic 23:59 run (manual test sends during the day won't cancel 23:59 run)
    if (!forceSend && res.mail_sent) {
      setSettingValue('last_sla_executive_sent_date', tr.dateStr);
    }

    return {
      ok: res.mail_sent,
      error: res.error,
      to: report.toEmail,
      cc: report.ccEmail,
      filename: report.filename,
      totalCritical: report.totalCritical,
      depodaCount: report.depodaCount,
      techCount: report.techCount
    };
  } finally {
    slaSendInProgress = false;
  }
}

// ==================== #2 TECHNICIAN DISPATCH EMAIL (HTML + 2-SHEET EXCEL) ====================
function buildTechnicianDispatchEmail(person, batchDevices, dispatchedBy) {
  const now = new Date();
  const tr = getIstanbulDateParts();
  const [yyyy, mm, dd] = tr.dateStr.split('-');
  const trDateOnly = `${dd}.${mm}.${yyyy}`;
  const trDateTime = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  // All active devices currently on this technician (devices dropped from stock / installed to customer are automatically excluded!)
  const allActiveOnTech = db.prepare(`
    SELECT * FROM devices
    WHERE assigned_personnel_id = ? AND location_status = 'TEKNİSYENDE'
  `).all(person.id).map(d => ({ ...d, ...computeSLA(d) })).sort((a, b) => a.days_remaining - b.days_remaining);

  // Batch devices enriched with SLA and from_physical_shelf
  const todayDevices = batchDevices.map(d => ({ ...d, ...computeSLA(d) })).sort((a, b) => a.days_remaining - b.days_remaining);
  const criticalOnTech = allActiveOnTech.filter(d => d.days_remaining <= 10).length;

  const slaLabel = (d) => d.days_remaining <= 0
    ? `SLA AŞILDI (${Math.abs(d.days_remaining)}G Geçti)`
    : (d.days_remaining <= 10 ? `KRİTİK (Son ${d.days_remaining}G)` : `${d.days_remaining} Gün Kaldı`);

  const slaColor = (d) => d.days_remaining <= 10 ? '#dc2626' : (d.days_remaining <= 20 ? '#d97706' : '#059669');

  // 1. Build 2-Sheet Real Excel (.xlsx)
  const sheet1Cols = [
    { header: 'Seri No', width: 22 },
    { header: 'Kategori', width: 12 },
    { header: 'Model / Kalem Tanımı', width: 32 },
    { header: 'Mantıksal Raf', width: 16 },
    { header: 'Çıktığı Fiziksel Raf', width: 18 },
    { header: 'Alım Tarihi', width: 18 },
    { header: 'Son İşlem Tarihi', width: 16 },
    { header: 'SLA Limiti (Gün)', width: 15 },
    { header: 'Geçen Gün', width: 12 },
    { header: 'Kalan SLA (Gün)', width: 15 },
    { header: 'SLA Durumu', width: 22 }
  ];

  const sheet1Rows = todayDevices.map(d => [
    d.serial_no, d.category, d.model_name, d.logical_shelf,
    d.from_physical_shelf || '-', trDateTime, d.sla_entry_date,
    d.sla_max_days, d.days_elapsed, d.days_remaining, slaLabel(d)
  ]);

  const sheet2Cols = [
    { header: 'Seri No', width: 22 },
    { header: 'Kategori', width: 12 },
    { header: 'Model / Kalem Tanımı', width: 32 },
    { header: 'Mantıksal Raf', width: 16 },
    { header: 'Zimmet Tarihi', width: 18 },
    { header: 'Son İşlem Tarihi', width: 16 },
    { header: 'SLA Limiti (Gün)', width: 15 },
    { header: 'Geçen Gün', width: 12 },
    { header: 'Kalan SLA (Gün)', width: 15 },
    { header: 'SLA Durumu', width: 22 }
  ];

  const sheet2Rows = allActiveOnTech.map(d => [
    d.serial_no, d.category, d.model_name, d.logical_shelf,
    d.assigned_at ? new Date(d.assigned_at).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }) : trDateTime,
    d.sla_entry_date, d.sla_max_days, d.days_elapsed, d.days_remaining, slaLabel(d)
  ]);

  const xlsxBuffer = buildMultiSheetXlsxBuffer([
    { name: 'Bugun_Alinan_Cihazlar', columns: sheet1Cols, rows: sheet1Rows },
    { name: 'Uzerimdeki_Tum_Cihazlar', columns: sheet2Cols, rows: sheet2Rows }
  ]);

  const safeName = String(person.full_name || 'Teknisyen')
    .replace(/İ/g, 'I').replace(/ı/g, 'i').replace(/Ş/g, 'S').replace(/ş/g, 's')
    .replace(/Ğ/g, 'G').replace(/ğ/g, 'g').replace(/Ü/g, 'U').replace(/ü/g, 'u')
    .replace(/Ö/g, 'O').replace(/ö/g, 'o').replace(/Ç/g, 'C').replace(/ç/g, 'c')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const filename = `KaradenizECM_Zimmet_${safeName}_${tr.dateStr}.xlsx`;

  // 2. Build Corporate HTML Table Email
  const tableRowsHtml = todayDevices.map(d => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:Consolas,monospace;font-size:12px;font-weight:700;color:#0f172a;">${xmlEscape(d.serial_no)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">
        <span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${d.category === 'SOL' ? '#dbeafe' : '#fef3c7'};color:${d.category === 'SOL' ? '#1d4ed8' : '#b45309'};">${xmlEscape(d.category)}</span>
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#0f172a;">${xmlEscape(d.model_name)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${xmlEscape(d.logical_shelf)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:Consolas,monospace;font-size:12px;color:#0369a1;font-weight:700;">${xmlEscape(d.from_physical_shelf || '-')}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;font-weight:700;color:${slaColor(d)};">${xmlEscape(slaLabel(d))}</td>
    </tr>
  `).join('');

  const htmlBody = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;padding:20px;color:#0f172a;">
    <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #cbd5e1;">
      <div style="background:#0f172a;padding:20px 24px;border-bottom:4px solid #facc15;">
        <div style="font-size:11px;letter-spacing:1.4px;color:#facc15;font-weight:700;text-transform:uppercase;">KARADENİZ EÇM • DEPO VE ZİMMET YÖNETİM SİSTEMİ</div>
        <div style="font-size:19px;font-weight:800;color:#ffffff;margin-top:4px;">Malzeme Alım ve Zimmet Teslimat Bildirimi</div>
        <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Tarih / Saat: ${trDateTime} &nbsp;|&nbsp; Teslim Eden: ${xmlEscape(dispatchedBy || 'Depo Sorumlusu')}</div>
      </div>

      <div style="padding:22px 24px;">
        <p style="font-size:14px;line-height:1.6;color:#0f172a;margin:0 0 18px 0;">
          Sayın <strong>${xmlEscape(person.full_name)}</strong>, <strong>${trDateOnly}</strong> tarihli malzeme alım detaylarınız aşağıda ve ekteki tabloda yer almaktadır.
        </p>

        <!-- KPI Strip -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:0 -8px 20px -8px;">
          <tr>
            <td width="33%" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#1e40af;text-transform:uppercase;">Bugün Alınan Cihaz</div>
              <div style="font-size:24px;font-weight:900;color:#1d4ed8;margin-top:4px;">${todayDevices.length}</div>
            </td>
            <td width="34%" style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#334155;text-transform:uppercase;">Üzerinizdeki Toplam Zimmet</div>
              <div style="font-size:24px;font-weight:900;color:#0f172a;margin-top:4px;">${allActiveOnTech.length}</div>
            </td>
            <td width="33%" style="background:${criticalOnTech > 0 ? '#fef2f2' : '#ecfdf5'};border:1px solid ${criticalOnTech > 0 ? '#fecaca' : '#a7f3d0'};border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:${criticalOnTech > 0 ? '#991b1b' : '#065f46'};text-transform:uppercase;">SLA Öncelikli (≤10G)</div>
              <div style="font-size:24px;font-weight:900;color:${criticalOnTech > 0 ? '#dc2626' : '#059669'};margin-top:4px;">${criticalOnTech}</div>
            </td>
          </tr>
        </table>

        <!-- Today's Dispatched Devices Table -->
        <div style="font-size:13px;font-weight:800;color:#0f172a;margin-bottom:8px;border-left:4px solid #0284c7;padding-left:10px;">
          ${trDateOnly} Tarihli Teslim Alınan Cihazlar (${todayDevices.length} Adet)
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;margin-bottom:18px;">
          <thead>
            <tr style="background:#0f172a;color:#ffffff;">
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Seri No</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Kategori</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Model</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Statü</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Çıktığı Raf</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Kalan SLA</th>
            </tr>
          </thead>
          <tbody>
            ${tableRowsHtml}
          </tbody>
        </table>

        <!-- Attachment Info -->
        <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:12px 14px;font-size:12px;color:#334155;line-height:1.6;">
          <strong>Ekteki Excel Dosyası (${filename}):</strong><br/>
          <strong>1. Sekme (Bugun_Alinan_Cihazlar):</strong> Bugün teslim aldığınız ${todayDevices.length} cihazın seri ve SLA detayları.<br/>
          <strong>2. Sekme (Uzerimdeki_Tum_Cihazlar):</strong> Üzerinizde aktif zimmetli bulunan toplam ${allActiveOnTech.length} cihaz *(müşteriye kurulup stoktan düşen cihazlar otomatik olarak listeden çıkarılmıştır)*.
        </div>
      </div>

      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:12px 24px;font-size:11px;color:#64748b;text-align:center;">
        Bu e-posta <strong>KARADENİZ EÇM Depo ve Zimmet Yönetim Sistemi</strong> tarafından otomatik olarak gönderilmiştir.
      </div>
    </div>
  </div>`;

  const textBody = [
    `Sayın ${person.full_name}, ${trDateOnly} tarihli malzeme alım detaylarınız aşağıda ve ekteki tabloda yer almaktadır.`,
    ``,
    `Bugün Teslim Alınan Cihazlar (${todayDevices.length} Adet):`,
    ...todayDevices.map(d => `- ${d.serial_no} | ${d.category} | ${d.model_name} | ${d.logical_shelf} | Kalan SLA: ${slaLabel(d)}`),
    ``,
    `Üzerinizdeki Toplam Aktif Zimmet: ${allActiveOnTech.length} cihaz (Detaylar ekteki 2 sekmeli Excel dosyasındadır).`
  ].join('\n');

  const ccEmail = getSettingValue('dispatch_report_cc', DEFAULT_DISPATCH_REPORT_CC);

  return {
    filename,
    toEmail: person.email || '',
    ccEmail,
    subject: `[KARADENİZ EÇM] ${trDateOnly} Tarihli Malzeme Alım ve Zimmet Bildirimi — ${person.full_name} (${todayDevices.length} Cihaz)`,
    textBody,
    htmlBody,
    xlsxBuffer
  };
}

// ==================== #4 TECHNICIAN TRANSFER EMAIL (TALEP / ONAY / RED - CORPORATE HTML) ====================
function buildTransferStatusEmail({ stage, items = [], fromPerson, toPerson, targetShelf = '', resolvedBy = '', rejectReason = '', note = '' }) {
  const trDateTime = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const isToWarehouse = !toPerson;
  const fromName = fromPerson ? fromPerson.full_name : 'Teknisyen';
  const toName = toPerson ? `${toPerson.full_name} (${toPerson.team_name || ''})` : `Merkez Depo${targetShelf ? ' (' + targetShelf + ')' : ''}`;
  const defaultCc = getSettingValue('dispatch_report_cc', DEFAULT_DISPATCH_REPORT_CC);

  let accentColor = '#d97706';
  let badgeBg = '#fef3c7';
  let badgeText = '#b45309';
  let stageTitle = 'Onay Bekleyen Cihaz Transfer Talebi';
  let summaryLine = `${fromName}, aşağıdaki ${items.length} adet cihazı ${toName} tarafına devretmek için transfer talebi oluşturdu. Depo onayı beklenmektedir.`;

  if (stage === 'ONAYLANDI') {
    accentColor = '#059669';
    badgeBg = '#d1fae5';
    badgeText = '#065f46';
    stageTitle = 'Cihaz Transferi Onaylandı — Zimmet Devredildi';
    summaryLine = isToWarehouse
      ? `${fromName} tarafından kullanılmadan depoya iade edilen ${items.length} adet cihaz ${resolvedBy} tarafından onaylanarak zimmetten düşülmüş ve ${targetShelf || 'depo'} rafına alınmıştır.`
      : `${fromName} tarafından ${toPerson.full_name} teknisyenine devredilen ${items.length} adet cihaz ${resolvedBy} tarafından onaylanmıştır. İlgili cihaz(lar) devreden teknisyenin zimmetinden düşülerek ${toPerson.full_name} zimmetine aktarılmıştır.`;
  } else if (stage === 'REDDEDİLDİ') {
    accentColor = '#dc2626';
    badgeBg = '#fee2e2';
    badgeText = '#991b1b';
    stageTitle = 'Cihaz Transfer Talebi Reddedildi';
    summaryLine = `${fromName} ➔ ${toName} yönündeki transfer talebi ${resolvedBy} tarafından reddedilmiştir. İlgili cihaz(lar) ${fromName} zimmetinde kalmaya devam etmektedir.${rejectReason ? ' Gerekçe: ' + rejectReason : ''}`;
  }

  const rowsHtml = items.map(it => {
    const slaTxt = typeof it.days_remaining === 'number'
      ? (it.days_remaining <= 0 ? `SLA AŞILDI (${Math.abs(it.days_remaining)}G)` : `${it.days_remaining} Gün`)
      : '-';
    const slaClr = (typeof it.days_remaining === 'number' && it.days_remaining <= 10) ? '#dc2626' : '#059669';
    return `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:Consolas,monospace;font-size:12px;font-weight:700;color:#0f172a;">${xmlEscape(it.serial_no)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">
          <span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${it.category === 'SOL' ? '#dbeafe' : '#fef3c7'};color:${it.category === 'SOL' ? '#1d4ed8' : '#b45309'};">${xmlEscape(it.category || '-')}</span>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#0f172a;">${xmlEscape(it.model_name || '-')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${xmlEscape(fromName)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:700;color:#0f172a;">${xmlEscape(toName)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;font-weight:700;color:${slaClr};">${xmlEscape(slaTxt)}</td>
      </tr>`;
  }).join('');

  const htmlBody = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;padding:20px;color:#0f172a;">
    <div style="max-width:740px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #cbd5e1;">
      <div style="background:#0f172a;padding:20px 24px;border-bottom:4px solid ${accentColor};">
        <div style="font-size:11px;letter-spacing:1.4px;color:#facc15;font-weight:700;text-transform:uppercase;">KARADENİZ EÇM • CİHAZ TRANSFER BİLDİRİMİ</div>
        <div style="font-size:19px;font-weight:800;color:#ffffff;margin-top:4px;">${xmlEscape(stageTitle)}</div>
        <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Tarih / Saat: ${trDateTime}</div>
      </div>
      <div style="padding:20px 24px;">
        <div style="background:${badgeBg};color:${badgeText};padding:12px 14px;border-radius:8px;font-size:13px;font-weight:600;line-height:1.5;margin-bottom:16px;">
          ${xmlEscape(summaryLine)}
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;margin-bottom:14px;">
          <thead>
            <tr style="background:#0f172a;color:#ffffff;">
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Seri No</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Kategori</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Model</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Devreden</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Devralan / Hedef</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Kalan SLA</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${note ? `<div style="font-size:12px;color:#475569;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;"><strong>Açıklama / Not:</strong> ${xmlEscape(note)}</div>` : ''}
      </div>
      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:11px 24px;font-size:11px;color:#64748b;text-align:center;">
        Bu e-posta <strong>KARADENİZ EÇM Depo ve Zimmet Yönetim Sistemi</strong> tarafından otomatik olarak gönderilmiştir.
      </div>
    </div>
  </div>`;

  let toEmail = '';
  let ccEmail = defaultCc;
  let recipientName = '';

  if (stage === 'TALEP') {
    // TO: Devralan Teknisyen (depoya iadede Depo Sorumlusu), CC: Hasan İlker Kadıoğlu, Servetcan Küçüksolak
    if (toPerson && toPerson.email) {
      toEmail = toPerson.email;
      ccEmail = defaultCc;
      recipientName = `${toPerson.full_name} (TO) | Hasan İlker Kadıoğlu, Servetcan Küçüksolak (CC)`;
    } else {
      toEmail = DEFAULT_SLA_REPORT_TO;
      ccEmail = [...new Set([fromPerson?.email, 'servetcan.kucuksolak@sam.superonline.net'].filter(Boolean))].join(', ');
      recipientName = `Hasan İlker Kadıoğlu (TO) | ${fromName}, Servetcan Küçüksolak (CC)`;
    }
  } else {
    // ONAYLANDI veya REDDEDİLDİ -> TO: Devralan + Devreden, CC: Hasan İlker Kadıoğlu, Servetcan Küçüksolak
    const toList = [...new Set([toPerson?.email, fromPerson?.email].filter(Boolean))];
    toEmail = toList.join(', ') || DEFAULT_SLA_REPORT_TO;
    ccEmail = defaultCc;
    const toNames = [...new Set([toPerson?.full_name, fromPerson?.full_name].filter(Boolean))].join(', ');
    recipientName = `${toNames} (TO) | Hasan İlker Kadıoğlu, Servetcan Küçüksolak (CC)`;
  }

  const serialPreview = items.map(i => i.serial_no).join(', ');
  const subject = `[KARADENİZ EÇM] ${stageTitle} (${items.length === 1 ? serialPreview : items.length + ' Cihaz'})`;
  const textBody = `${summaryLine}\nSeri Numaraları: ${serialPreview}`;

  return { toEmail, ccEmail, recipientName, subject, textBody, htmlBody };
}

// ==================== #5 WEEKLY VEHICLE COUNT & MONTHLY WAREHOUSE COUNT EMAILS ====================
function getPendingVehicleCountTechnicians() {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM devices d WHERE d.assigned_personnel_id = p.id AND d.location_status = 'TEKNİSYENDE') as assigned_count
    FROM personnel p
    WHERE p.role = 'TEKNİSYEN' AND p.active = 1 AND p.vehicle_count_status = 'BEKLİYOR'
      AND (SELECT COUNT(*) FROM devices d WHERE d.assigned_personnel_id = p.id AND d.location_status = 'TEKNİSYENDE') > 0
  `).all();
}

async function sendHourlyVehicleCountReminders(forceNow = false) {
  const tr = getIstanbulDateParts();

  // AUTOMATIC MONDAY TRIGGER: Every Monday at 09:00 (TR time), automatically reset pending technicians & activate hourly reminders (no button click needed!)
  if (!forceNow && tr.weekday === 'Mon' && tr.hour >= 9) {
    const lastMondayInit = getSettingValue('last_monday_count_reset_date', '');
    if (lastMondayInit !== tr.dateStr) {
      db.prepare(`
        UPDATE personnel
        SET vehicle_count_status = 'BEKLİYOR'
        WHERE role = 'TEKNİSYEN' AND active = 1
          AND id IN (SELECT DISTINCT assigned_personnel_id FROM devices WHERE location_status = 'TEKNİSYENDE' AND assigned_personnel_id IS NOT NULL)
      `).run();
      setSettingValue('last_monday_count_reset_date', tr.dateStr);
      setSettingValue('vehicle_count_campaign_active', '1');
      setSettingValue('last_vehicle_reminder_sent_ms', '0'); // Send first Monday reminder immediately!
      console.log(`Pazartesi haftalik arac sayimi otomatik olarak baslatildi (${tr.dateStr}).`);
    }
  }

  const isActive = getSettingValue('vehicle_count_campaign_active', '0') === '1';
  if (!isActive && !forceNow) return { ok: true, skipped: true };

  // Avoid spamming overnight (send automatically between 09:00 and 21:59 TR time unless manually forced)
  if (!forceNow && (tr.hour < 9 || tr.hour >= 22)) {
    return { ok: true, skipped: true };
  }

  const lastMs = Number(getSettingValue('last_vehicle_reminder_sent_ms', '0')) || 0;
  const nowMs = Date.now();
  if (!forceNow && (nowMs - lastMs) < 60 * 60 * 1000) {
    return { ok: true, skipped: true };
  }

  const pendingTechs = getPendingVehicleCountTechnicians();
  if (pendingTechs.length === 0) {
    if (isActive) setSettingValue('vehicle_count_campaign_active', '0');
    return { ok: true, sent_count: 0 };
  }

  setSettingValue('last_vehicle_reminder_sent_ms', String(nowMs));
  const trDateTime = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  for (const tech of pendingTechs) {
    if (!tech.email) continue;
    const htmlBody = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;padding:20px;color:#0f172a;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #cbd5e1;">
        <div style="background:#0f172a;padding:18px 24px;border-bottom:4px solid #f59e0b;">
          <div style="font-size:11px;letter-spacing:1.4px;color:#facc15;font-weight:700;text-transform:uppercase;">KARADENİZ EÇM • HAFTALIK ARAÇ SAYIMI</div>
          <div style="font-size:18px;font-weight:800;color:#ffffff;margin-top:4px;">Araç Sayımınız Bekleniyor</div>
          <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Hatırlatma Zamanı: ${trDateTime}</div>
        </div>
        <div style="padding:20px 24px;">
          <p style="font-size:14px;line-height:1.6;color:#0f172a;margin:0 0 14px 0;">
            Sayın <strong>${xmlEscape(tech.full_name)}</strong>,
          </p>
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;font-size:13px;color:#92400e;line-height:1.6;">
            Haftalık araç sayımınız sistemde <strong>BEKLİYOR</strong> durumundadır. Üzerinizde şu an <strong>${tech.assigned_count} adet</strong> aktif zimmetli cihaz bulunmaktadır.<br/><br/>
            Lütfen mobil ekranınızdan kamera ile aracınızdaki cihazları okutarak sayımınızı tamamlayınız.
          </div>
        </div>
        <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:11px 24px;font-size:11px;color:#64748b;text-align:center;">
          Bu hatırlatma sayım tamamlanana kadar saatlik olarak otomatik gönderilmektedir — <strong>KARADENİZ EÇM</strong>
        </div>
      </div>
    </div>`;

    const textBody = `Sayın ${tech.full_name}, haftalık araç sayımınız beklenmektedir. Üzerinizde ${tech.assigned_count} adet aktif cihaz bulunmaktadır. Lütfen mobil ekranınızdan sayımınızı tamamlayınız.`;

    dispatchAutoNotification({
      recipient_name: `${tech.full_name} (TO) | Hasan İlker Kadıoğlu, Servetcan Küçüksolak, Mehmet Salih Celep (CC)`,
      recipient_phone: tech.phone || '',
      recipient_email: tech.email,
      recipient_cc: DEFAULT_VEHICLE_REMINDER_CC,
      category: 'HAFTALIK_SAYIM_HATIRLATMA',
      title: `[KARADENİZ EÇM] Haftalık Araç Sayımı Bekleniyor — Lütfen Sayımınızı Tamamlayınız (${tech.full_name})`,
      message: textBody,
      htmlBody
    });
  }

  return { ok: true, sent_count: pendingTechs.length };
}

function sendTechnicianVehicleMissingEmail(person, missingDevices, expectedCount, scannedCount) {
  const trDateTime = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const rowsHtml = missingDevices.map(d => {
    const sla = computeSLA(d);
    return `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:Consolas,monospace;font-size:12px;font-weight:700;color:#dc2626;">${xmlEscape(d.serial_no)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:11px;font-weight:700;">${xmlEscape(d.category)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#0f172a;">${xmlEscape(d.model_name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${xmlEscape(d.logical_shelf)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;font-weight:700;color:${sla.days_remaining <= 10 ? '#dc2626' : '#0f172a'};">${sla.days_remaining} Gün</td>
      </tr>`;
  }).join('');

  const htmlBody = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;padding:20px;color:#0f172a;">
    <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #cbd5e1;">
      <div style="background:#0f172a;padding:18px 24px;border-bottom:4px solid #dc2626;">
        <div style="font-size:11px;letter-spacing:1.4px;color:#facc15;font-weight:700;text-transform:uppercase;">KARADENİZ EÇM • HAFTALIK ARAÇ SAYIM EKSİK UYARISI</div>
        <div style="font-size:19px;font-weight:800;color:#ffffff;margin-top:4px;">Araç Sayımında ${missingDevices.length} Adet Eksik Cihaz Tespit Edildi</div>
        <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Sayım Zamanı: ${trDateTime} &nbsp;|&nbsp; Beklenen: ${expectedCount} • Okutulan: ${scannedCount} • Eksik: ${missingDevices.length}</div>
      </div>
      <div style="padding:20px 24px;">
        <p style="font-size:14px;line-height:1.6;color:#0f172a;margin:0 0 14px 0;">
          Sayın <strong>${xmlEscape(person.full_name)}</strong>, haftalık araç sayımınız sonucunda zimmetinizde kayıtlı olan aşağıdaki <strong>${missingDevices.length} adet</strong> seri numaralı cihazınız okutulmamış (eksik) olarak tespit edilmiştir:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;">
          <thead>
            <tr style="background:#991b1b;color:#ffffff;">
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Eksik Seri No</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Kategori</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Model</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Statü</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Kalan SLA</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:11px 24px;font-size:11px;color:#64748b;text-align:center;">
        Bu bildirim <strong>KARADENİZ EÇM Depo ve Zimmet Yönetim Sistemi</strong> tarafından otomatik oluşturulmuştur.
      </div>
    </div>
  </div>`;

  const missingSerialsStr = missingDevices.map(d => d.serial_no).join(', ');
  dispatchAutoNotification({
    recipient_name: `${person.full_name} (TO) | Hasan İlker Kadıoğlu, Servetcan Küçüksolak (CC)`,
    recipient_phone: person.phone || '',
    recipient_email: person.email || DEFAULT_VEHICLE_FINAL_TO,
    recipient_cc: DEFAULT_DISPATCH_REPORT_CC,
    category: 'OTOMATİK_SAYIM_ALARMI',
    title: `[KARADENİZ EÇM] Araç Sayımı Eksik Cihaz Uyarısı — ${person.full_name} (${missingDevices.length} Eksik)`,
    message: `Sayın ${person.full_name}, haftalık araç sayımınızda şu seri numaralı cihazlarınız eksik tespit edilmiştir: ${missingSerialsStr}.`,
    htmlBody
  });
}

async function sendAllVehicleCountsFinalReport() {
  const tr = getIstanbulDateParts();
  const trDateTime = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  const techs = db.prepare(`SELECT * FROM personnel WHERE role = 'TEKNİSYEN' AND active = 1 ORDER BY full_name ASC`).all();
  const summaryRows = [];
  const missingDetailRows = [];
  let totalExpected = 0;
  let totalScanned = 0;
  let totalMissing = 0;
  let okTechCount = 0;
  let missingTechCount = 0;

  for (const t of techs) {
    const activeDevs = db.prepare(`SELECT * FROM devices WHERE assigned_personnel_id = ? AND location_status = 'TEKNİSYENDE'`).all(t.id);
    const lastLog = db.prepare(`SELECT * FROM count_logs WHERE count_type = 'HAFTALIK_ARAÇ' AND target_ref = ? ORDER BY id DESC LIMIT 1`).get(String(t.id));
    if (activeDevs.length === 0 && !lastLog) continue;

    const exp = lastLog ? lastLog.expected_count : activeDevs.length;
    const scn = lastLog ? lastLog.scanned_count : 0;
    const missList = lastLog && lastLog.missing_serials ? lastLog.missing_serials.split(',').map(s => s.trim()).filter(Boolean) : [];
    const st = t.vehicle_count_status || (lastLog ? lastLog.status : 'BEKLİYOR');

    totalExpected += exp;
    totalScanned += scn;
    totalMissing += missList.length;
    if (missList.length > 0) missingTechCount++;
    else if (st === 'TAMAMLANDI' || st === 'TAM') okTechCount++;

    summaryRows.push({
      name: t.full_name,
      team: t.team_name,
      phone: t.phone || '-',
      expected: exp,
      scanned: scn,
      missingCount: missList.length,
      status: st,
      countedAt: t.last_vehicle_count_at ? new Date(t.last_vehicle_count_at).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }) : '-',
      missingSerials: missList.join(', ') || '-'
    });

    for (const sn of missList) {
      const dev = db.prepare(`SELECT * FROM devices WHERE serial_no = ?`).get(sn);
      const sla = dev ? computeSLA(dev) : { days_remaining: '-' };
      missingDetailRows.push([
        t.full_name, t.team_name, t.phone || '-', sn,
        dev ? dev.category : '-', dev ? dev.model_name : '-',
        dev ? dev.logical_shelf : '-', sla.days_remaining
      ]);
    }
  }

  const xlsxBuffer = buildMultiSheetXlsxBuffer([
    {
      name: 'Teknisyen_Sayim_Ozeti',
      columns: [
        { header: 'Teknisyen Adı', width: 24 },
        { header: 'Ekip / Görev', width: 26 },
        { header: 'Telefon', width: 16 },
        { header: 'Beklenen Adet', width: 14 },
        { header: 'Okutulan Adet', width: 14 },
        { header: 'Eksik Adet', width: 12 },
        { header: 'Durum', width: 14 },
        { header: 'Sayım Tarihi', width: 20 },
        { header: 'Eksik Seri Numaraları', width: 38 }
      ],
      rows: summaryRows.map(r => [r.name, r.team, r.phone, r.expected, r.scanned, r.missingCount, r.status, r.countedAt, r.missingSerials])
    },
    {
      name: 'Eksik_Cihaz_Detaylari',
      columns: [
        { header: 'Teknisyen Adı', width: 24 },
        { header: 'Ekip / Görev', width: 26 },
        { header: 'Telefon', width: 16 },
        { header: 'Eksik Seri No', width: 22 },
        { header: 'Kategori', width: 12 },
        { header: 'Model', width: 30 },
        { header: 'Mantıksal Raf', width: 16 },
        { header: 'Kalan SLA (Gün)', width: 15 }
      ],
      rows: missingDetailRows.length ? missingDetailRows : [['Eksik cihaz bulunmamaktadır.', '-', '-', '-', '-', '-', '-', '-']]
    }
  ]);

  const filename = `KaradenizECM_Haftalik_Arac_Sayim_Raporu_${tr.dateStr}.xlsx`;
  const tableHtml = summaryRows.map(r => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:700;color:#0f172a;">${xmlEscape(r.name)}<div style="font-size:11px;font-weight:400;color:#64748b;">${xmlEscape(r.team)}</div></td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;">${r.expected}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;font-weight:700;color:#059669;">${r.scanned}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;font-weight:700;color:${r.missingCount > 0 ? '#dc2626' : '#94a3b8'};">${r.missingCount}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;background:${r.missingCount > 0 ? '#fee2e2' : '#d1fae5'};color:${r.missingCount > 0 ? '#991b1b' : '#065f46'};">${xmlEscape(r.status)}</span>
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:Consolas,monospace;font-size:11px;color:#dc2626;">${xmlEscape(r.missingSerials)}</td>
    </tr>`).join('');

  const htmlBody = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;padding:20px;color:#0f172a;">
    <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #cbd5e1;">
      <div style="background:#0f172a;padding:20px 24px;border-bottom:4px solid ${totalMissing > 0 ? '#dc2626' : '#059669'};">
        <div style="font-size:11px;letter-spacing:1.4px;color:#facc15;font-weight:700;text-transform:uppercase;">KARADENİZ EÇM • HAFTALIK ARAÇ SAYIMI TAMAMLANDI</div>
        <div style="font-size:20px;font-weight:800;color:#ffffff;margin-top:4px;">Tüm Teknisyenler Haftalık Araç Sayım Sonuç Raporu</div>
        <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Tamamlanma Zamanı: ${trDateTime}</div>
      </div>
      <div style="padding:20px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:0 -8px 18px -8px;">
          <tr>
            <td width="25%" style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:10px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#334155;">Sayılan Teknisyen</div>
              <div style="font-size:22px;font-weight:900;color:#0f172a;margin-top:3px;">${summaryRows.length}</div>
            </td>
            <td width="25%" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:10px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#065f46;">Eksiksiz Tamamlayan</div>
              <div style="font-size:22px;font-weight:900;color:#059669;margin-top:3px;">${okTechCount}</div>
            </td>
            <td width="25%" style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#991b1b;">Eksik Çıkan Ekip</div>
              <div style="font-size:22px;font-weight:900;color:#dc2626;margin-top:3px;">${missingTechCount}</div>
            </td>
            <td width="25%" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#92400e;">Toplam Eksik Cihaz</div>
              <div style="font-size:22px;font-weight:900;color:#dc2626;margin-top:3px;">${totalMissing}</div>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;margin-bottom:14px;">
          <thead>
            <tr style="background:#0f172a;color:#ffffff;">
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Teknisyen / Ekip</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Beklenen</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Okutulan</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Eksik</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;">Durum</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;">Eksik Seriler</th>
            </tr>
          </thead>
          <tbody>${tableHtml}</tbody>
        </table>
        <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:10px 14px;font-size:12px;color:#334155;">
          Detaylı teknisyen özeti ve eksik cihaz seri dökümü ekteki <strong>${filename}</strong> dosyasında yer almaktadır.
        </div>
      </div>
    </div>
  </div>`;

  return dispatchAutoNotification({
    recipient_name: 'Hasan İlker Kadıoğlu (TO) | Servetcan Küçüksolak, Meryem Nas Kalafat, Doğancan Aksoy (CC)',
    recipient_phone: '905303821619, 905616101203',
    recipient_email: DEFAULT_VEHICLE_FINAL_TO,
    recipient_cc: DEFAULT_VEHICLE_FINAL_CC,
    category: 'HAFTALIK_ARAÇ_SAYIM_FİNAL',
    title: `[KARADENİZ EÇM] Haftalık Araç Sayımı Tamamlandı — ${summaryRows.length} Teknisyen (${totalMissing} Eksik) | ${tr.dateStr}`,
    message: `Tüm teknisyenlerin haftalık araç sayımları tamamlanmıştır. Toplam ${summaryRows.length} teknisyen, beklenen ${totalExpected}, okutulan ${totalScanned}, eksik ${totalMissing} cihaz. Detaylar ekteki Excel dosyasındadır.`,
    htmlBody,
    attachment: {
      filename,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: xlsxBuffer.toString('base64')
    }
  });
}

function sendWarehouseShelfCountReportEmail({ shelf, expectedCount, actualCount, status, shelfDevices, matchedSerials, missingSerials, extraSerials }) {
  const tr = getIstanbulDateParts();
  const trDateTime = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const hasDiff = status !== 'TAM';

  const verifiedList = matchedSerials.length > 0
    ? matchedSerials.map(m => [m.serial_no, shelf.category, m.model_name, shelf.target_logical_shelf, shelf.code])
    : shelfDevices.map(d => [d.serial_no, d.category, d.model_name, d.logical_shelf, shelf.code]);

  const xlsxBuffer = buildMultiSheetXlsxBuffer([
    {
      name: 'Sayim_Ozeti',
      columns: [{ header: 'Bilgi', width: 32 }, { header: 'Değer', width: 34 }],
      rows: [
        ['Fiziksel Raf Kodu', shelf.code],
        ['Ürün Grubu / Kategori', shelf.category],
        ['Hedef Mantıksal Raf', shelf.target_logical_shelf],
        ['Sayım Tarihi ve Saati', trDateTime],
        ['Sistemde Beklenen Adet', expectedCount],
        ['Fiziksel Sayılan Adet', actualCount],
        ['Eksik Seri Adedi', missingSerials.length],
        ['Fazla / Yanlış Raf Seri Adedi', extraSerials.length],
        ['Sayım Sonucu', status]
      ]
    },
    {
      name: 'Eksik_Seriler',
      columns: [
        { header: 'Eksik Seri No', width: 22 },
        { header: 'Model', width: 32 },
        { header: 'Mantıksal Raf', width: 18 },
        { header: 'Sistemde Kayıtlı Raf', width: 18 }
      ],
      rows: missingSerials.length
        ? missingSerials.map(m => [m.serial_no, m.model_name, m.logical_shelf, shelf.code])
        : [['Eksik seri bulunmamaktadır.', '-', '-', '-']]
    },
    {
      name: 'Fazla_Yanlis_Raf_Seriler',
      columns: [
        { header: 'Fazla / Yanlış Seri No', width: 22 },
        { header: 'Model', width: 32 },
        { header: 'Sistemdeki Mevcut Konumu', width: 42 }
      ],
      rows: extraSerials.length
        ? extraSerials.map(e => [e.serial_no, e.model_name, e.system_location])
        : [['Fazla veya yanlış raf serisi bulunmamaktadır.', '-', '-']]
    },
    {
      name: 'Dogrulanan_Raftaki_Seriler',
      columns: [
        { header: 'Seri No', width: 22 },
        { header: 'Kategori', width: 12 },
        { header: 'Model', width: 32 },
        { header: 'Mantıksal Raf', width: 18 },
        { header: 'Fiziksel Raf', width: 14 }
      ],
      rows: verifiedList.length ? verifiedList : [['Rafta cihaz bulunmamaktadır.', '-', '-', '-', '-']]
    }
  ]);

  const filename = `KaradenizECM_Depo_Sayim_${shelf.code}_${tr.dateStr}.xlsx`;
  const missingHtml = missingSerials.length
    ? missingSerials.map(m => `<tr><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-family:Consolas,monospace;font-size:12px;font-weight:700;color:#dc2626;">${xmlEscape(m.serial_no)}</td><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${xmlEscape(m.model_name)}</td><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${xmlEscape(m.logical_shelf)}</td></tr>`).join('')
    : `<tr><td colspan="3" style="padding:10px;text-align:center;font-size:12px;color:#059669;">Eksik seri bulunmamaktadır.</td></tr>`;

  const extraHtml = extraSerials.length
    ? extraSerials.map(e => `<tr><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-family:Consolas,monospace;font-size:12px;font-weight:700;color:#d97706;">${xmlEscape(e.serial_no)}</td><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${xmlEscape(e.model_name)}</td><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${xmlEscape(e.system_location)}</td></tr>`).join('')
    : `<tr><td colspan="3" style="padding:10px;text-align:center;font-size:12px;color:#059669;">Fazla / yanlış raf serisi bulunmamaktadır.</td></tr>`;

  const htmlBody = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;padding:20px;color:#0f172a;">
    <div style="max-width:740px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #cbd5e1;">
      <div style="background:#0f172a;padding:20px 24px;border-bottom:4px solid ${hasDiff ? '#dc2626' : '#059669'};">
        <div style="font-size:11px;letter-spacing:1.4px;color:#facc15;font-weight:700;text-transform:uppercase;">KARADENİZ EÇM • AYLIK DEPO RAF SAYIM RAPORU</div>
        <div style="font-size:20px;font-weight:800;color:#ffffff;margin-top:4px;">${xmlEscape(shelf.code)} (${xmlEscape(shelf.category)} • ${xmlEscape(shelf.target_logical_shelf)}) — ${hasDiff ? 'FARK TESPİT EDİLDİ' : 'SAYIM EKSİKSİZ TAM'}</div>
        <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Sayım Zamanı: ${trDateTime}</div>
      </div>
      <div style="padding:20px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:0 -8px 18px -8px;">
          <tr>
            <td width="25%" style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:10px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#334155;">Beklenen Adet</div>
              <div style="font-size:22px;font-weight:900;color:#0f172a;margin-top:3px;">${expectedCount}</div>
            </td>
            <td width="25%" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#1e40af;">Fiziksel Sayılan</div>
              <div style="font-size:22px;font-weight:900;color:#1d4ed8;margin-top:3px;">${actualCount}</div>
            </td>
            <td width="25%" style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#991b1b;">Eksik Seri</div>
              <div style="font-size:22px;font-weight:900;color:#dc2626;margin-top:3px;">${missingSerials.length}</div>
            </td>
            <td width="25%" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;text-align:center;">
              <div style="font-size:11px;font-weight:700;color:#92400e;">Fazla / Yanlış Raf</div>
              <div style="font-size:22px;font-weight:900;color:#d97706;margin-top:3px;">${extraSerials.length}</div>
            </td>
          </tr>
        </table>
        ${hasDiff ? `
          <div style="font-size:13px;font-weight:800;color:#991b1b;margin-bottom:6px;">Rafta Bulunmayan (Eksik) Seriler (${missingSerials.length})</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;margin-bottom:14px;">
            <thead><tr style="background:#991b1b;color:#ffffff;"><th style="padding:7px 10px;text-align:left;font-size:11px;">Seri No</th><th style="padding:7px 10px;text-align:left;font-size:11px;">Model</th><th style="padding:7px 10px;text-align:left;font-size:11px;">Statü</th></tr></thead>
            <tbody>${missingHtml}</tbody>
          </table>
          <div style="font-size:13px;font-weight:800;color:#92400e;margin-bottom:6px;">Fazla / Yanlış Raftan Çıkan Seriler (${extraSerials.length})</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;margin-bottom:14px;">
            <thead><tr style="background:#92400e;color:#ffffff;"><th style="padding:7px 10px;text-align:left;font-size:11px;">Seri No</th><th style="padding:7px 10px;text-align:left;font-size:11px;">Model</th><th style="padding:7px 10px;text-align:left;font-size:11px;">Sistemdeki Konumu</th></tr></thead>
            <tbody>${extraHtml}</tbody>
          </table>
        ` : `<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:12px 14px;font-size:13px;color:#065f46;font-weight:600;margin-bottom:14px;">${xmlEscape(shelf.code)} rafındaki ${actualCount} adet cihaz sistem stoğuyla birebir eşleşmiştir.</div>`}
        <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:10px 14px;font-size:12px;color:#334155;">
          Detaylı 4 sekmeli sayım dökümü ekteki <strong>${filename}</strong> dosyasındadır (<em>Sayim_Ozeti, Eksik_Seriler, Fazla_Yanlis_Raf_Seriler, Dogrulanan_Raftaki_Seriler</em>).
        </div>
      </div>
    </div>
  </div>`;

  dispatchAutoNotification({
    recipient_name: 'Hasan İlker Kadıoğlu (TO) | Doğancan Aksoy, Mehmet Salih Celep, Servetcan Küçüksolak, Meryem Nas Kalafat (CC)',
    recipient_phone: '905303821619, 905616101203',
    recipient_email: DEFAULT_DEPOCOUNT_TO,
    recipient_cc: DEFAULT_DEPOCOUNT_CC,
    category: hasDiff ? 'OTOMATİK_DEPO_SAYIM_FARKI' : 'OTOMATİK_DEPO_SAYIM_SONUCU',
    title: `[KARADENİZ EÇM] Depo Raf Sayım Sonucu: ${shelf.code} (${hasDiff ? 'FARK VAR' : 'TAM'} — ${actualCount}/${expectedCount})`,
    message: `${shelf.code} rafı sayımı tamamlandı. Beklenen: ${expectedCount}, Sayılan: ${actualCount}, Eksik: ${missingSerials.length}, Fazla: ${extraSerials.length}. Detaylı Excel ektedir.`,
    htmlBody,
    attachment: {
      filename,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: xlsxBuffer.toString('base64')
    }
  });
}

// ==================== #6 DAILY TECHNICIAN SLA PRIORITY INSTALL REMINDER (23:59 TR) ====================
let techSlaSendInProgress = false;
async function sendDailyTechnicianSlaEmails(forceSend = false) {
  const tr = getIstanbulDateParts();
  const lastSent = getSettingValue('last_tech_sla_sent_date', '');

  if (!forceSend) {
    if (!(tr.hour === 23 && tr.minute >= 59)) return { ok: true, skipped: true };
    if (lastSent === tr.dateStr) return { ok: true, skipped: true };
    if (techSlaSendInProgress) return { ok: true, skipped: true };
  }

  techSlaSendInProgress = true;
  try {
    const rawTechDevices = db.prepare(`
      SELECT d.*, p.full_name as personnel_name, p.team_name as personnel_team, p.phone as personnel_phone, p.email as personnel_email
      FROM devices d
      INNER JOIN personnel p ON d.assigned_personnel_id = p.id
      WHERE d.location_status = 'TEKNİSYENDE' AND p.active = 1
    `).all();

    const byTech = new Map();
    for (const raw of rawTechDevices) {
      const d = { ...raw, ...computeSLA(raw) };
      if (d.days_remaining <= 10) {
        if (!byTech.has(d.assigned_personnel_id)) {
          byTech.set(d.assigned_personnel_id, {
            name: d.personnel_name,
            team: d.personnel_team || '-',
            phone: d.personnel_phone || '',
            email: d.personnel_email || '',
            devices: []
          });
        }
        byTech.get(d.assigned_personnel_id).devices.push(d);
      }
    }

    const trDateTime = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    let sentCount = 0;

    for (const [, info] of byTech.entries()) {
      if (!info.email) continue;
      info.devices.sort((a, b) => a.days_remaining - b.days_remaining);
      const exceededCnt = info.devices.filter(d => d.days_remaining <= 0).length;
      const warnCnt = info.devices.length - exceededCnt;

      const rowsHtml = info.devices.map(d => {
        const isExc = d.days_remaining <= 0;
        const slaTxt = isExc ? `SLA AŞILDI (${Math.abs(d.days_remaining)}G Geçti)` : `Son ${d.days_remaining} Gün`;
        return `
          <tr>
            <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:Consolas,monospace;font-size:12px;font-weight:700;color:#0f172a;">${xmlEscape(d.serial_no)}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">
              <span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${d.category === 'SOL' ? '#dbeafe' : '#fef3c7'};color:${d.category === 'SOL' ? '#1d4ed8' : '#b45309'};">${xmlEscape(d.category)}</span>
            </td>
            <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#0f172a;">${xmlEscape(d.model_name)}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${xmlEscape(d.logical_shelf)}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-family:Consolas,monospace;font-size:11px;color:#475569;">${xmlEscape(d.sla_entry_date)}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">
              <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;background:${isExc ? '#fee2e2' : '#fef3c7'};color:${isExc ? '#991b1b' : '#b45309'};">${xmlEscape(slaTxt)}</span>
            </td>
          </tr>`;
      }).join('');

      const htmlBody = `
      <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;padding:20px;color:#0f172a;">
        <div style="max-width:740px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #cbd5e1;">
          <div style="background:#0f172a;padding:20px 24px;border-bottom:4px solid #dc2626;">
            <div style="font-size:11px;letter-spacing:1.4px;color:#facc15;font-weight:700;text-transform:uppercase;">KARADENİZ EÇM • ÖNCELİKLİ KURULUM (SLA) HATIRLATMASI</div>
            <div style="font-size:19px;font-weight:800;color:#ffffff;margin-top:4px;">Zimmetinizde SLA Süresi Yaklaşan / Geçmiş ${info.devices.length} Cihaz Var</div>
            <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Bildirim Zamanı: ${trDateTime} &nbsp;|&nbsp; SLA Aşıldı: ${exceededCnt} • Kritik (1–10G): ${warnCnt}</div>
          </div>
          <div style="padding:20px 24px;">
            <p style="font-size:14px;line-height:1.6;color:#0f172a;margin:0 0 16px 0;">
              Sayın <strong>${xmlEscape(info.name)}</strong>, üzerinizde SLA süresi yaklaşmış veya geçmiş olan aşağıdaki <strong>${info.devices.length} adet</strong> cihazı kurulumlarınızda <strong>öncelikli olarak</strong> kullanmanız gerekmektedir:
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;">
              <thead>
                <tr style="background:#991b1b;color:#ffffff;">
                  <th style="padding:8px 10px;text-align:left;font-size:11px;">Seri No</th>
                  <th style="padding:8px 10px;text-align:center;font-size:11px;">Kategori</th>
                  <th style="padding:8px 10px;text-align:left;font-size:11px;">Model</th>
                  <th style="padding:8px 10px;text-align:left;font-size:11px;">Statü</th>
                  <th style="padding:8px 10px;text-align:center;font-size:11px;">Son İşlem</th>
                  <th style="padding:8px 10px;text-align:center;font-size:11px;">Kalan SLA</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:11px 24px;font-size:11px;color:#64748b;text-align:center;">
            Bu e-posta <strong>KARADENİZ EÇM Depo ve Zimmet Yönetim Sistemi</strong> tarafından her akşam 23:59'da otomatik gönderilmektedir.
          </div>
        </div>
      </div>`;

      const textBody = `Sayın ${info.name}, üzerinizde SLA süresi yaklaşmış veya geçmiş ${info.devices.length} adet cihaz bulunmaktadır: ${info.devices.map(d => `${d.serial_no} (${d.days_remaining}G)`).join(', ')}. Lütfen kurulumlarınızda öncelikli olarak kullanınız.`;

      await dispatchAutoNotification({
        recipient_name: `${info.name} (TO) | Hasan İlker Kadıoğlu, Servetcan Küçüksolak (CC)`,
        recipient_phone: info.phone,
        recipient_email: info.email,
        recipient_cc: DEFAULT_DISPATCH_REPORT_CC,
        category: 'TEKNİSYEN_SLA_HATIRLATMA',
        title: `[KARADENİZ EÇM] Öncelikli Kurulum (SLA) Hatırlatması — ${info.name} (${info.devices.length} Cihaz)`,
        message: textBody,
        htmlBody
      });
      sentCount++;
    }

    if (!forceSend) {
      setSettingValue('last_tech_sla_sent_date', tr.dateStr);
    }
    return { ok: true, sent_count: sentCount };
  } finally {
    techSlaSendInProgress = false;
  }
}

// Background Automatic SLA (23:59 TR), Technician SLA (23:59 TR) & Monday Hourly Vehicle Count Reminder Engine
function runAutomaticBackgroundChecks() {
  sendSlaExecutiveDashboardReport(false).catch(err => console.error('SLA background check error:', err.message));
  sendDailyTechnicianSlaEmails(false).catch(err => console.error('Tech SLA background check error:', err.message));
  sendHourlyVehicleCountReminders(false).catch(err => console.error('Vehicle reminder check error:', err.message));
}

// ==================== AUTOMATIC ZERO-COST CLOUD DATABASE PERSISTENCE (GOOGLE DRIVE / CLOUD WEBHOOK) ====================
function getFullBackupObject() {
  return {
    exported_at: new Date().toISOString(),
    company: 'KARADENİZ EÇM',
    physical_shelves: db.prepare(`SELECT * FROM physical_shelves`).all(),
    personnel: db.prepare(`SELECT * FROM personnel`).all(),
    devices: db.prepare(`SELECT * FROM devices`).all(),
    dispatch_history: db.prepare(`SELECT * FROM dispatch_history`).all(),
    shipment_batches: db.prepare(`SELECT * FROM shipment_batches`).all(),
    shipment_items: db.prepare(`SELECT * FROM shipment_items`).all(),
    return_pool: db.prepare(`SELECT * FROM return_pool`).all(),
    transfer_pool: db.prepare(`SELECT * FROM transfer_pool`).all(),
    count_logs: db.prepare(`SELECT * FROM count_logs`).all(),
    gateway_settings: db.prepare(`SELECT * FROM gateway_settings`).all(),
    notifications_log: db.prepare(`SELECT * FROM notifications_log ORDER BY id DESC LIMIT 200`).all(),
    wa_auth_files: exportWaAuthFiles()
  };
}

function applyFullBackupObject(data) {
  if (!data || !Array.isArray(data.physical_shelves)) return false;

  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      DELETE FROM devices;
      DELETE FROM dispatch_history;
      DELETE FROM shipment_items;
      DELETE FROM shipment_batches;
      DELETE FROM return_pool;
      DELETE FROM transfer_pool;
      DELETE FROM count_logs;
      DELETE FROM physical_shelves;
      DELETE FROM personnel;
    `);

    const insShelf = db.prepare(`INSERT INTO physical_shelves (id, code, category, target_logical_shelf, capacity, last_counted_at, last_counted_qty, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of (data.physical_shelves || [])) {
      insShelf.run(s.id, s.code, s.category, s.target_logical_shelf, s.capacity || 500, s.last_counted_at || null, s.last_counted_qty ?? null, s.notes || '');
    }

    const insPerson = db.prepare(`INSERT INTO personnel (id, employee_code, username, password, full_name, team_name, role, phone, email, active, last_vehicle_count_at, vehicle_count_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of (data.personnel || [])) {
      insPerson.run(p.id, p.employee_code, p.username || p.employee_code.toLowerCase(), p.password || '123456', p.full_name, p.team_name, p.role, p.phone || '', p.email || '', p.active ?? 1, p.last_vehicle_count_at || null, p.vehicle_count_status || 'BEKLİYOR');
    }

    const insDev = db.prepare(`INSERT INTO devices (id, serial_no, category, model_name, logical_shelf, previous_logical_shelf, shelf_mismatch_alert, recommended_new_physical_shelf, physical_shelf_code, location_status, assigned_personnel_id, assigned_at, sla_entry_date, sla_max_days, last_sla_notified_date, last_report_seen_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const d of (data.devices || [])) {
      insDev.run(d.id, d.serial_no, d.category, d.model_name, d.logical_shelf, d.previous_logical_shelf || d.logical_shelf, d.shelf_mismatch_alert || 0, d.recommended_new_physical_shelf || null, d.physical_shelf_code || null, d.location_status || 'DEPODA', d.assigned_personnel_id || null, d.assigned_at || null, d.sla_entry_date, d.sla_max_days || 90, d.last_sla_notified_date || null, d.last_report_seen_at || null, d.notes || '');
    }

    const insHist = db.prepare(`INSERT INTO dispatch_history (id, serial_no, category, model_name, logical_shelf, from_physical_shelf, personnel_id, personnel_name, team_name, dispatched_by, dispatched_at, dispatch_type, status_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const h of (data.dispatch_history || [])) {
      insHist.run(h.id, h.serial_no, h.category, h.model_name, h.logical_shelf, h.from_physical_shelf || '-', h.personnel_id, h.personnel_name, h.team_name, h.dispatched_by, h.dispatched_at, h.dispatch_type || 'DAĞITIM', h.status_after || 'ZİMMETTE');
    }

    const insShipBatch = db.prepare(`INSERT INTO shipment_batches (id, batch_code, category, created_at, status, recommended_shelf, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const sb of (data.shipment_batches || [])) {
      insShipBatch.run(sb.id, sb.batch_code, sb.category, sb.created_at, sb.status, sb.recommended_shelf, sb.approved_at || null);
    }

    const insShipItem = db.prepare(`INSERT INTO shipment_items (id, batch_id, serial_no, model_name, in_turkcell_pool, physically_scanned, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const si of (data.shipment_items || [])) {
      insShipItem.run(si.id, si.batch_id, si.serial_no, si.model_name, si.in_turkcell_pool ?? 1, si.physically_scanned ?? 0, si.scanned_at || null);
    }

    const insRet = db.prepare(`INSERT INTO return_pool (id, serial_no, category, model_name, source_type, reported_by_personnel_id, reported_by_name, customer_note, created_at, status, physically_scanned, recommended_physical_shelf, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of (data.return_pool || [])) {
      insRet.run(r.id, r.serial_no, r.category, r.model_name, r.source_type, r.reported_by_personnel_id || null, r.reported_by_name || '', r.customer_note || '', r.created_at, r.status, r.physically_scanned || 0, r.recommended_physical_shelf || null, r.approved_at || null);
    }

    const insTr = db.prepare(`INSERT INTO transfer_pool (id, serial_no, category, model_name, logical_shelf, transfer_type, from_personnel_id, from_personnel_name, to_personnel_id, to_personnel_name, recommended_physical_shelf, note, status, created_at, resolved_at, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of (data.transfer_pool || [])) {
      insTr.run(t.id, t.serial_no, t.category, t.model_name, t.logical_shelf, t.transfer_type, t.from_personnel_id, t.from_personnel_name, t.to_personnel_id || null, t.to_personnel_name || '', t.recommended_physical_shelf || null, t.note || '', t.status, t.created_at, t.resolved_at || null, t.resolved_by || null);
    }

    const insClog = db.prepare(`INSERT INTO count_logs (id, count_type, target_ref, target_name, expected_count, scanned_count, scanned_serials, missing_serials, extra_serials, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const cl of (data.count_logs || [])) {
      insClog.run(cl.id, cl.count_type, cl.target_ref, cl.target_name, cl.expected_count, cl.scanned_count, cl.scanned_serials || '', cl.missing_serials || '', cl.extra_serials || '', cl.status, cl.created_at);
    }

    if (Array.isArray(data.gateway_settings)) {
      const insGw = db.prepare(`INSERT INTO gateway_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      for (const gw of data.gateway_settings) {
        if (gw.key) insGw.run(gw.key, gw.value || '');
      }
    }

    if (data.wa_auth_files && typeof data.wa_auth_files === 'object') {
      importWaAuthFiles(data.wa_auth_files);
    }

    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('applyFullBackupObject error:', err.message);
    return false;
  }
}

function getCloudDbUrl() {
  return process.env.CLOUD_DB_URL ||
         db.prepare(`SELECT value FROM gateway_settings WHERE key = 'email_webhook_url'`).get()?.value || '';
}

async function syncDatabaseToCloudNow() {
  const url = getCloudDbUrl();
  if (!url) return { ok: false, error: 'CLOUD_DB_URL veya 8. Sekme E-Posta Servis URL tanımlı değil.' };
  try {
    const payload = getFullBackupObject();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'SAVE_DB_BACKUP', backup: payload })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error('Bulut yedekleme HTTP hatasi:', res.status, txt.slice(0, 200));
      return { ok: false, error: `HTTP ${res.status}` };
    }
    console.log(`Bulut veritabani yedegi guncellendi (${payload.devices.length} cihaz, ${payload.personnel.length} personel).`);
    return { ok: true, devices: payload.devices.length, personnel: payload.personnel.length };
  } catch (err) {
    console.error('Bulut yedekleme baglanti hatasi:', err.message);
    return { ok: false, error: err.message };
  }
}

let cloudSyncTimer = null;
function scheduleCloudDatabaseSync() {
  const url = getCloudDbUrl();
  if (!url) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    syncDatabaseToCloudNow();
  }, 1500);
}

async function restoreDatabaseFromCloudOnBoot() {
  const url = getCloudDbUrl();
  if (!url) return;
  try {
    const res = await fetch(`${url}?action=LOAD_DB_BACKUP`);
    if (res.ok) {
      const json = await res.json();
      if (json && json.backup && Array.isArray(json.backup.physical_shelves)) {
        applyFullBackupObject(json.backup);
        console.log(`Bulut veritabani yedegi (Google Drive) basariyla yuklendi (${(json.backup.devices || []).length} cihaz).`);
      }
    }
  } catch (err) {
    console.error('Bulut yedek geri yukleme hatasi:', err.message);
  }
}

function seedInitialDataIfEmpty() {
  const count = db.prepare(`SELECT COUNT(*) as c FROM physical_shelves`).get().c;
  if (count > 0) return;

  const daysAgo = (n) => {
    const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    return d.toISOString().split('T')[0];
  };

  // 1. Physical Shelves
  const insertShelf = db.prepare(`
    INSERT INTO physical_shelves (code, category, target_logical_shelf, capacity, notes)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertShelf.run('SOL01', 'SOL', 'SAĞLAM', 500, 'SOL Sıfır Kapalı Kutu Cihaz Rafı (SLA: 90 Gün)');
  insertShelf.run('SOL02', 'SOL', 'SAĞLAM DÖNEN', 400, 'SOL Test ve Kozmetik Kontrolleri Tamamlanan Sağlam Dönen Rafı (SLA: 90 Gün)');
  insertShelf.run('SOL03', 'SOL', 'KARANTİNA', 300, 'SOL Müşteri İadesi Test Bekleyen Karantina Rafı (SLA: 30 Gün)');
  insertShelf.run('SOL04', 'SOL', 'ARIZA', 250, 'SOL Ana Depoya İade Bekleyen Arızalı Rafı (SLA: 30 Gün)');
  insertShelf.run('TURKCELL01', 'TURKCELL', 'SAĞLAM', 300, 'Turkcell SPX Sıfır Cihaz Rafı (SLA: 90 Gün)');
  insertShelf.run('TURKCELL02', 'TURKCELL', 'SAĞLAM DÖNEN', 250, 'Turkcell SPX Sağlam Dönen Rafı (SLA: 90 Gün)');
  insertShelf.run('TURKCELL03', 'TURKCELL', 'KARANTİNA', 200, 'Turkcell SPX Karantina Rafı (SLA: 30 Gün)');
  insertShelf.run('TURKCELL04', 'TURKCELL', 'ARIZA', 150, 'Turkcell SPX Arıza Rafı (SLA: 30 Gün)');

  // 2. Personnel (BYS / SBYS with login credentials)
  const insertPerson = db.prepare(`
    INSERT INTO personnel (employee_code, username, password, full_name, team_name, role, phone, email, vehicle_count_status, last_vehicle_count_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPerson.run('BYS-401', 'yonetici', '123456', 'Kemal Özkan', 'Karadeniz EÇM Yönetim', 'YÖNETİCİ', '905326667788', 'yonetim@karadenzecm.com', 'TAMAMLANDI', null);
  insertPerson.run('BYS-301', 'depocu', '123456', 'Hasan Çelik', 'Merkez Depo Yönetimi', 'DEPOCU', '905325556677', 'depo@karadenzecm.com', 'TAMAMLANDI', null);
  insertPerson.run('BYS-201', 'karsilama', '123456', 'Zeynep Aydın', 'Müşteri Karşılama Banko', 'KARŞILAMA', '905324445566', 'karsilama@karadenzecm.com', 'TAMAMLANDI', null);
  insertPerson.run('BYS-101', 'ahmet', '123456', 'Ahmet Yılmaz', 'Trabzon Saha Ekip-1', 'TEKNİSYEN', '905321112233', 'ahmet.yilmaz@karadenzecm.com', 'BEKLİYOR', null);
  insertPerson.run('BYS-102', 'mehmet', '123456', 'Mehmet Kaya', 'Samsun Saha Ekip-2', 'TEKNİSYEN', '905322223344', 'mehmet.kaya@karadenzecm.com', 'TAMAMLANDI', new Date().toISOString());
  insertPerson.run('BYS-103', 'mustafa', '123456', 'Mustafa Demir', 'Rize Saha Ekip-3', 'TEKNİSYEN', '905323334455', 'mustafa.demir@karadenzecm.com', 'EKSİK_VAR', new Date().toISOString());

  // 3. Devices
  const insertDevice = db.prepare(`
    INSERT INTO devices (
      serial_no, category, model_name, logical_shelf, previous_logical_shelf,
      shelf_mismatch_alert, recommended_new_physical_shelf, physical_shelf_code,
      location_status, assigned_personnel_id, assigned_at, sla_entry_date, sla_max_days, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Critical SLA devices
  insertDevice.run('SOL-SN8001', 'SOL', 'Huawei HG8245X6 Wi-Fi 6 HGW', 'SAĞLAM DÖNEN', 'SAĞLAM DÖNEN', 0, null, 'SOL02', 'DEPODA', null, null, daysAgo(82), 90, 'Test ve kozmetik kontrolü tamamlandı, SLA öncelikli çıkış yapılmalı');
  insertDevice.run('SOL-SN8002', 'SOL', 'ZTE ZXHN H3600 Wi-Fi 6 Modem', 'SAĞLAM DÖNEN', 'SAĞLAM DÖNEN', 0, null, 'SOL02', 'DEPODA', null, null, daysAgo(80), 90, '80 gündür stokta - SLA bitimine 10 gün kaldı');
  insertDevice.run('SOL-SN8003', 'SOL', 'Nokia G-010G-Q ONT', 'SAĞLAM DÖNEN', 'SAĞLAM DÖNEN', 0, null, null, 'TEKNİSYENDE', 4, daysAgo(6), daysAgo(81), 90, 'Ahmet Yılmaz zimmetinde - SLA 9 gün kaldı');

  // Fresh Sağlam devices
  insertDevice.run('SOL-SN1001', 'SOL', 'Huawei HG8245X6 Wi-Fi 6 HGW', 'SAĞLAM', 'SAĞLAM', 0, null, 'SOL01', 'DEPODA', null, null, daysAgo(12), 90, 'Sıfır kapalı kutu');
  insertDevice.run('SOL-SN1002', 'SOL', 'Huawei HG8245X6 Wi-Fi 6 HGW', 'SAĞLAM', 'SAĞLAM', 0, null, 'SOL01', 'DEPODA', null, null, daysAgo(8), 90, 'Sıfır kapalı kutu');
  insertDevice.run('SOL-SN1003', 'SOL', 'TV+ 4K Android Kutu', 'SAĞLAM', 'SAĞLAM', 0, null, 'SOL01', 'DEPODA', null, null, daysAgo(5), 90, 'Sıfır kapalı kutu');
  insertDevice.run('SOL-SN1004', 'SOL', 'Nokia G-010G-Q ONT', 'SAĞLAM', 'SAĞLAM', 0, null, null, 'TEKNİSYENDE', 4, daysAgo(1), daysAgo(18), 90, 'Ahmet Yılmaz zimmetinde');
  insertDevice.run('SOL-SN1005', 'SOL', 'ZTE ZXHN H3600 Wi-Fi 6 Modem', 'SAĞLAM', 'SAĞLAM', 0, null, null, 'TEKNİSYENDE', 5, daysAgo(1), daysAgo(10), 90, 'Mehmet Kaya zimmetinde');

  // Karantina & Arıza
  insertDevice.run('SOL-SN3001', 'SOL', 'ZTE H267A VDSL Modem', 'KARANTİNA', 'KARANTİNA', 0, null, 'SOL03', 'DEPODA', null, null, daysAgo(24), 30, 'Test bekliyor - Son 6 gün');
  insertDevice.run('SOL-SN4001', 'SOL', 'Huawei HG255s HGW', 'ARIZA', 'ARIZA', 0, null, 'SOL04', 'DEPODA', null, null, daysAgo(26), 30, 'Ana depoya iade dönemi yaklaştı - Son 4 gün');

  // Madde 3: Logical shelf changed in Turkcell report
  insertDevice.run('SN0001', 'SOL', 'Huawei HG8245X6 Wi-Fi 6 HGW', 'ARIZA', 'SAĞLAM DÖNEN', 1, 'SOL04', 'SOL02', 'DEPODA', null, null, daysAgo(15), 30, 'Turkcell raporunda SAĞLAM DÖNEN -> ARIZA olarak değişti. Fiziksel rafı SOL02 -> SOL04 taşıyın.');

  // Turkcell SPX
  insertDevice.run('SPX-SN9001', 'TURKCELL', 'Turkcell SPX Kurumsal Router', 'SAĞLAM', 'SAĞLAM', 0, null, 'TURKCELL01', 'DEPODA', null, null, daysAgo(76), 90, 'SLA yaklaşıyor (14 gün kaldı)');
  insertDevice.run('SPX-SN9002', 'TURKCELL', 'Turkcell SPX Outdoor CPE', 'SAĞLAM DÖNEN', 'SAĞLAM DÖNEN', 0, null, 'TURKCELL02', 'DEPODA', null, null, daysAgo(40), 90, 'Test edildi sağlam');
  insertDevice.run('SPX-SN9003', 'TURKCELL', 'Turkcell SPX Kurumsal Router', 'SAĞLAM', 'SAĞLAM', 0, null, null, 'TEKNİSYENDE', 6, daysAgo(2), daysAgo(20), 90, 'Mustafa Demir zimmetinde');

  // 4. Historical Dispatch Records (2025, 2026-01, and current month for date-filtered Excel export!)
  const insertHist = db.prepare(`
    INSERT INTO dispatch_history (serial_no, category, model_name, logical_shelf, from_physical_shelf, personnel_id, personnel_name, team_name, dispatched_by, dispatched_at, dispatch_type, status_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertHist.run('SOL-2025-001', 'SOL', 'Huawei HG8245X6 Wi-Fi 6 HGW', 'SAĞLAM', 'SOL01', 4, 'Ahmet Yılmaz', 'Trabzon Saha Ekip-1', 'Hasan Çelik', '2025-05-14T08:30:00.000Z', 'SABAH_DAĞITIM', 'MÜŞTERİYE_KURULDU');
  insertHist.run('SOL-2025-002', 'SOL', 'Nokia G-010G-Q ONT', 'SAĞLAM DÖNEN', 'SOL02', 5, 'Mehmet Kaya', 'Samsun Saha Ekip-2', 'Hasan Çelik', '2025-11-20T08:45:00.000Z', 'SABAH_DAĞITIM', 'MÜŞTERİYE_KURULDU');
  insertHist.run('SPX-2026-010', 'TURKCELL', 'Turkcell SPX Kurumsal Router', 'SAĞLAM', 'TURKCELL01', 4, 'Ahmet Yılmaz', 'Trabzon Saha Ekip-1', 'Hasan Çelik', '2026-01-12T08:30:00.000Z', 'SABAH_DAĞITIM', 'MÜŞTERİYE_KURULDU');
  insertHist.run('SOL-2026-011', 'SOL', 'ZTE ZXHN H3600 Wi-Fi 6 Modem', 'SAĞLAM DÖNEN', 'SOL02', 6, 'Mustafa Demir', 'Rize Saha Ekip-3', 'Hasan Çelik', '2026-01-25T14:15:00.000Z', 'GÜN_İÇİ_EK_TESLİMAT', 'MÜŞTERİYE_KURULDU');
  insertHist.run('SOL-SN8003', 'SOL', 'Nokia G-010G-Q ONT', 'SAĞLAM DÖNEN', 'SOL02', 4, 'Ahmet Yılmaz', 'Trabzon Saha Ekip-1', 'Hasan Çelik', '2026-11-12T08:30:00.000Z', 'SABAH_DAĞITIM', 'ZİMMETTE');
  insertHist.run('SOL-SN1004', 'SOL', 'Nokia G-010G-Q ONT', 'SAĞLAM', 'SOL01', 4, 'Ahmet Yılmaz', 'Trabzon Saha Ekip-1', 'Hasan Çelik', '2026-11-17T08:40:00.000Z', 'SABAH_DAĞITIM', 'ZİMMETTE');
  insertHist.run('SOL-SN1005', 'SOL', 'ZTE ZXHN H3600 Wi-Fi 6 Modem', 'SAĞLAM', 'SOL01', 5, 'Mehmet Kaya', 'Samsun Saha Ekip-2', 'Hasan Çelik', '2026-11-17T08:50:00.000Z', 'SABAH_DAĞITIM', 'ZİMMETTE');
  insertHist.run('SPX-SN9003', 'TURKCELL', 'Turkcell SPX Kurumsal Router', 'SAĞLAM', 'TURKCELL01', 6, 'Mustafa Demir', 'Rize Saha Ekip-3', 'Hasan Çelik', '2026-11-16T13:20:00.000Z', 'GÜN_İÇİ_EK_TESLİMAT', 'ZİMMETTE');

  // 5. Pending New Shipment Batch (Madde 2)
  const batchRes = db.prepare(`
    INSERT INTO shipment_batches (batch_code, category, created_at, status, recommended_shelf)
    VALUES (?, ?, ?, ?, ?)
  `).run('SEVKIYAT-2026-11A', 'SOL', new Date().toISOString(), 'DOĞRULAMA_BEKLİYOR', 'SOL01');
  const batchId = batchRes.lastInsertRowid;

  const insertShipItem = db.prepare(`
    INSERT INTO shipment_items (batch_id, serial_no, model_name, in_turkcell_pool, physically_scanned, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertShipItem.run(batchId, 'SOL-NEW5001', 'Huawei HG8245X6 Wi-Fi 6 HGW', 1, 1, new Date().toISOString());
  insertShipItem.run(batchId, 'SOL-NEW5002', 'Huawei HG8245X6 Wi-Fi 6 HGW', 1, 1, new Date().toISOString());
  insertShipItem.run(batchId, 'SOL-NEW5003', 'Nokia G-010G-Q ONT', 1, 0, null);

  // 6. Pending Return Pool
  const insertReturn = db.prepare(`
    INSERT INTO return_pool (serial_no, category, model_name, source_type, reported_by_personnel_id, reported_by_name, customer_note, created_at, status, physically_scanned, recommended_physical_shelf)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertReturn.run('SOL-RET701', 'SOL', 'ZTE ZXHN H3600 Wi-Fi 6 Modem', 'KARŞILAMA', 3, 'Zeynep Aydın', 'Abonelik İptali - Banko Teslim', new Date().toISOString(), 'HAVUZDA_BEKLİYOR', 0, 'SOL03');
  insertReturn.run('SOL-RET702', 'SOL', 'TV+ 4K Android Kutu', 'KARŞILAMA', 3, 'Zeynep Aydın', 'Kargo İade Teslim', new Date().toISOString(), 'HAVUZDA_BEKLİYOR', 0, 'SOL03');
  insertReturn.run('SOL-RET801', 'SOL', 'Huawei HG8245X6 Wi-Fi 6 HGW', 'TEKNİSYEN', 4, 'Ahmet Yılmaz', 'Müşteri adresinde arıza değişimi (Eski cihaz)', new Date().toISOString(), 'HAVUZDA_BEKLİYOR', 0, 'SOL03');
  insertReturn.run('SPX-RET802', 'TURKCELL', 'Turkcell SPX Kurumsal Router', 'TEKNİSYEN', 5, 'Mehmet Kaya', 'Saha söküm iadesi', new Date().toISOString(), 'HAVUZDA_BEKLİYOR', 0, 'TURKCELL03');
}

seedInitialDataIfEmpty();
// Ensure initial sample count_logs exist if table is empty
if (db.prepare(`SELECT COUNT(*) as c FROM count_logs`).get().c === 0) {
  const insLog = db.prepare(`
    INSERT INTO count_logs (count_type, target_ref, target_name, expected_count, scanned_count, scanned_serials, missing_serials, extra_serials, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insLog.run('HAFTALIK_ARAÇ', '5', 'Mehmet Kaya', 1, 1, 'SOL-SN1005', '', '', 'TAM', new Date().toISOString());
  insLog.run('HAFTALIK_ARAÇ', '6', 'Mustafa Demir', 1, 0, '', 'SPX-SN9003', '', 'EKSİK_VAR', new Date().toISOString());
}
// Ensure initial sample transfer_pool requests exist if table is empty
if (db.prepare(`SELECT COUNT(*) as c FROM transfer_pool`).get().c === 0) {
  const insTr = db.prepare(`
    INSERT INTO transfer_pool (serial_no, category, model_name, logical_shelf, transfer_type, from_personnel_id, from_personnel_name, to_personnel_id, to_personnel_name, recommended_physical_shelf, note, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ONAY_BEKLİYOR', ?)
  `);
  insTr.run('SOL-SN1004', 'SOL', 'Nokia G-010G-Q ONT', 'SAĞLAM', 'TEKNİSYENDEN_TEKNİSYENE', 4, 'Ahmet Yılmaz', 5, 'Mehmet Kaya', null, 'Sahada yakın ekipten (Mehmet Kaya) acil ONT ihtiyacı için elden teslim edildi', new Date().toISOString());
  insTr.run('SPX-SN9003', 'TURKCELL', 'Turkcell SPX Kurumsal Router', 'SAĞLAM', 'TEKNİSYENDEN_DEPOYA', 6, 'Mustafa Demir', null, 'Merkez Depo', 'TURKCELL01', 'Müşteri kurulumu ertelendi, cihaz kullanılmadan sağlam olarak depoya iade', new Date().toISOString());
}
runAutomaticBackgroundChecks();
// Check every 30 seconds so 23:59 Europe/Istanbul scheduled SLA report never misses
setInterval(runAutomaticBackgroundChecks, 30 * 1000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 50 * 1024 * 1024) reject(new Error('Veri boyutu çok yüksek'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}

function getAuthenticatedUser(req, urlObj) {
  const authHeader = String(req.headers['authorization'] || '');
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (urlObj && urlObj.searchParams) {
    token = (urlObj.searchParams.get('token') || '').trim();
  }
  if (!token) return null;
  return db.prepare(`
    SELECT p.id, p.employee_code, p.username, p.full_name, p.team_name, p.role, p.phone, p.email, p.active, s.token
    FROM auth_sessions s
    INNER JOIN personnel p ON p.id = s.personnel_id
    WHERE s.token = ? AND p.active = 1
  `).get(token) || null;
}

async function handleApi(req, res, urlObj) {
  const pathname = urlObj.pathname;
  const method = req.method;

  // AUTH: Login with BYS credentials (Public)
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const identifier = (body.username || '').trim();
    const password = (body.password || '').trim();

    const user = db.prepare(`
      SELECT id, employee_code, username, full_name, team_name, role, phone, email, active
      FROM personnel
      WHERE (LOWER(username) = LOWER(?) OR LOWER(employee_code) = LOWER(?) OR LOWER(email) = LOWER(?))
        AND password = ? AND active = 1
    `).get(identifier, identifier, identifier, password);

    if (!user) {
      return sendJson(res, 401, { error: 'Kullanıcı adı/BYS sicil no veya şifre hatalı ya da personel aktif değil.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare(`INSERT INTO auth_sessions (token, personnel_id, created_at) VALUES (?, ?, ?)`).run(token, user.id, new Date().toISOString());
    return sendJson(res, 200, { ok: true, user, token });
  }

  // GLOBAL SERVER-SIDE SESSION GUARD (Every other /api/* endpoint requires a valid Bearer token!)
  const authUser = getAuthenticatedUser(req, urlObj);
  if (!authUser) {
    return sendJson(res, 401, { error: 'Oturum geçersiz veya süresi doldu. Lütfen tekrar giriş yapınız.' });
  }

  // AUTH: Logout
  if (pathname === '/api/auth/logout' && method === 'POST') {
    db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(authUser.token);
    return sendJson(res, 200, { ok: true });
  }

  // AUTH: User changes their own password (All roles)
  if (pathname === '/api/auth/change-password' && method === 'POST') {
    const body = await readBody(req);
    const currentPwd = String(body.current_password || '').trim();
    const newPwd = String(body.new_password || '').trim();
    if (!currentPwd || !newPwd) return sendJson(res, 400, { error: 'Mevcut şifre ve yeni şifre zorunludur.' });
    if (newPwd.length < 4) return sendJson(res, 400, { error: 'Yeni şifre en az 4 karakter olmalıdır.' });

    const existing = db.prepare(`SELECT id, password FROM personnel WHERE id = ?`).get(authUser.id);
    if (!existing || existing.password !== currentPwd) {
      return sendJson(res, 400, { error: 'Mevcut şifreniz hatalı.' });
    }
    db.prepare(`UPDATE personnel SET password = ? WHERE id = ?`).run(newPwd, authUser.id);
    return sendJson(res, 200, { ok: true });
  }

  // ADMIN: Reset any user's password (YÖNETİCİ ONLY)
  if (pathname === '/api/personnel/reset-password' && method === 'POST') {
    if (authUser.role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Şifre sıfırlama işlemi yalnızca YÖNETİCİ tarafından yapılabilir.' });
    }
    const body = await readBody(req);
    const targetId = Number(body.personnel_id || 0);
    const newPwd = String(body.new_password || '123456').trim();
    if (!targetId || newPwd.length < 4) {
      return sendJson(res, 400, { error: 'Geçerli personel ve en az 4 karakterli şifre giriniz.' });
    }
    db.prepare(`UPDATE personnel SET password = ? WHERE id = ?`).run(newPwd, targetId);
    // Invalidate target user's old sessions so they must re-login with new password
    db.prepare(`DELETE FROM auth_sessions WHERE personnel_id = ?`).run(targetId);
    return sendJson(res, 200, { ok: true });
  }

  // SERVER-SIDE RBAC ENFORCEMENT ON SENSITIVE ENDPOINTS
  const adminOnlyPaths = [
    '/api/shelves/create', '/api/shelves/rename', '/api/shelves/move-devices', '/api/shelves/delete',
    '/api/personnel/import', '/api/settings/gateway', '/api/reports/send-sla-dashboard-email',
    '/api/settings/test-notification', '/api/system/reset-sample-data', '/api/system/backup-json',
    '/api/system/restore-json', '/api/whatsapp/status', '/api/whatsapp/connect',
    '/api/whatsapp/logout', '/api/whatsapp/test'
  ];
  if (adminOnlyPaths.includes(pathname) && authUser.role !== 'YÖNETİCİ') {
    return sendJson(res, 403, { error: 'Yetki Hatası: Bu işlem yalnızca YÖNETİCİ rolü tarafından yapılabilir.' });
  }

  const depoOrAdminPaths = [
    '/api/reports/sync-turkcell', '/api/dispatch/check-fifo', '/api/dispatch/commit',
    '/api/transfers/approve', '/api/transfers/reject', '/api/returns/approve',
    '/api/counts/shelf', '/api/counts/vehicle-campaign/start', '/api/counts/vehicle-campaign/stop',
    '/api/counts/vehicle-campaign/send-final', '/api/shipments/import', '/api/shipments/scan',
    '/api/shipments/approve', '/api/shelves/resolve-mismatch', '/api/shelves/assign-pending',
    '/api/reports/sla-dashboard-xlsx'
  ];
  if (depoOrAdminPaths.includes(pathname) && authUser.role !== 'YÖNETİCİ' && authUser.role !== 'DEPOCU') {
    return sendJson(res, 403, { error: 'Yetki Hatası: Bu işlem yalnızca YÖNETİCİ veya DEPOCU tarafından yapılabilir.' });
  }

  // GET /api/dashboard (Strictly filtered by authenticated server-side user!)
  if (pathname === '/api/dashboard' && method === 'GET') {
    runAutomaticBackgroundChecks();
    const currentUser = db.prepare(`SELECT id, employee_code, username, full_name, team_name, role, phone, email, active, vehicle_count_status, last_vehicle_count_at FROM personnel WHERE id = ?`).get(authUser.id);

    const rawDevices = db.prepare(`
      SELECT d.*, p.full_name as personnel_name, p.team_name, p.phone as personnel_phone, p.email as personnel_email
      FROM devices d
      LEFT JOIN personnel p ON d.assigned_personnel_id = p.id
      ORDER BY d.sla_entry_date ASC
    `).all();

    const allDevices = rawDevices.map(d => ({ ...d, ...computeSLA(d) }));

    // Role-based filtering:
    // If TEKNİSYEN -> Only sees devices assigned to themselves!
    if (currentUser && currentUser.role === 'TEKNİSYEN') {
      const myDevices = allDevices.filter(d => d.assigned_personnel_id === currentUser.id && d.location_status === 'TEKNİSYENDE');
      const myReturns = db.prepare(`SELECT * FROM return_pool WHERE reported_by_personnel_id = ? ORDER BY id DESC`).all(currentUser.id);
      const myTransfers = db.prepare(`
        SELECT * FROM transfer_pool
        WHERE from_personnel_id = ? OR to_personnel_id = ?
        ORDER BY id DESC
      `).all(currentUser.id, currentUser.id);
      const peerTechnicians = db.prepare(`
        SELECT id, full_name, team_name FROM personnel
        WHERE role = 'TEKNİSYEN' AND active = 1 AND id != ?
        ORDER BY full_name ASC
      `).all(currentUser.id);

      return sendJson(res, 200, {
        role: 'TEKNİSYEN',
        currentUser,
        devices: myDevices,
        slaAlerts: myDevices.filter(d => d.days_remaining <= 15),
        returnPool: myReturns,
        transferPool: myTransfers,
        peerTechnicians,
        shelfMismatches: [],
        fifoRecommendations: [],
        shelves: [],
        personnel: [currentUser],
        shipments: [],
        dispatchHistory: [],
        notifications: [],
        countLogs: []
      });
    }

    // If KARŞILAMA -> Only sees return pool items uploaded by KARŞILAMA!
    if (currentUser && currentUser.role === 'KARŞILAMA') {
      const karsilamaReturns = db.prepare(`SELECT * FROM return_pool WHERE source_type = 'KARŞILAMA' ORDER BY id DESC`).all();
      return sendJson(res, 200, {
        role: 'KARŞILAMA',
        currentUser,
        devices: [],
        slaAlerts: [],
        returnPool: karsilamaReturns,
        shelfMismatches: [],
        fifoRecommendations: [],
        shelves: [],
        personnel: [currentUser],
        shipments: [],
        dispatchHistory: [],
        notifications: [],
        countLogs: []
      });
    }

    // DEPOCU and YÖNETİCİ see operational data
    const activeDevices = allDevices.filter(d => d.location_status === 'DEPODA' || d.location_status === 'TEKNİSYENDE');
    const slaAlerts = activeDevices.filter(d => d.days_remaining <= 15).sort((a, b) => a.days_remaining - b.days_remaining);
    const shelfMismatches = activeDevices.filter(d => d.shelf_mismatch_alert === 1);
    const fifoRecommendations = activeDevices
      .filter(d => d.location_status === 'DEPODA' && (d.logical_shelf === 'SAĞLAM' || d.logical_shelf === 'SAĞLAM DÖNEN'))
      .sort((a, b) => a.days_remaining - b.days_remaining);

    const shelves = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM devices d WHERE d.physical_shelf_code = s.code AND d.location_status = 'DEPODA') as current_count
      FROM physical_shelves s
      ORDER BY s.code ASC
    `).all();

    const rawPersonnel = db.prepare(`
      SELECT p.id, p.employee_code, p.username, p.full_name, p.team_name, p.role, p.phone, p.email, p.active, p.last_vehicle_count_at, p.vehicle_count_status,
        (SELECT COUNT(*) FROM devices d WHERE d.assigned_personnel_id = p.id AND d.location_status = 'TEKNİSYENDE') as assigned_device_count
      FROM personnel p
      ORDER BY p.role ASC, p.full_name ASC
    `).all();

    const personnel = rawPersonnel.map(p => {
      const assignedDevs = allDevices.filter(d => d.assigned_personnel_id === p.id && d.location_status === 'TEKNİSYENDE');
      const lastVehicleLog = db.prepare(`
        SELECT * FROM count_logs
        WHERE count_type = 'HAFTALIK_ARAÇ' AND target_ref = ?
        ORDER BY id DESC LIMIT 1
      `).get(String(p.id));

      return {
        ...p,
        assigned_serials: assignedDevs.map(d => d.serial_no),
        assigned_devices_detail: assignedDevs.map(d => ({
          serial_no: d.serial_no,
          model_name: d.model_name,
          category: d.category,
          logical_shelf: d.logical_shelf,
          days_remaining: d.days_remaining
        })),
        last_count_scanned_serials: lastVehicleLog ? (lastVehicleLog.scanned_serials || '') : '',
        last_count_missing_serials: lastVehicleLog ? (lastVehicleLog.missing_serials || '') : '',
        last_count_extra_serials: lastVehicleLog ? (lastVehicleLog.extra_serials || '') : '',
        last_count_expected: lastVehicleLog ? lastVehicleLog.expected_count : assignedDevs.length,
        last_count_scanned: lastVehicleLog ? lastVehicleLog.scanned_count : 0
      };
    });

    const returnPool = db.prepare(`SELECT * FROM return_pool ORDER BY id DESC`).all();
    const transferPool = db.prepare(`SELECT * FROM transfer_pool ORDER BY id DESC`).all();
    const shipments = db.prepare(`SELECT * FROM shipment_batches ORDER BY id DESC`).all().map(b => ({
      ...b,
      items: db.prepare(`SELECT * FROM shipment_items WHERE batch_id = ? ORDER BY id ASC`).all(b.id)
    }));

    const rawHistory = db.prepare(`
      SELECT h.*, d.sla_entry_date as device_sla_entry_date, d.logical_shelf as current_logical_shelf, d.location_status as current_location_status
      FROM dispatch_history h
      LEFT JOIN devices d ON h.serial_no = d.serial_no
      ORDER BY h.dispatched_at DESC
    `).all();

    const dispatchHistory = rawHistory.map(h => {
      const entryDate = h.device_sla_entry_date || (h.dispatched_at ? h.dispatched_at.split('T')[0] : new Date().toISOString().split('T')[0]);
      const shelfForSla = h.current_logical_shelf || h.logical_shelf || 'SAĞLAM';
      const slaInfo = computeSLA({ logical_shelf: shelfForSla, sla_entry_date: entryDate });
      return {
        ...h,
        sla_entry_date: entryDate,
        ...slaInfo
      };
    });
    const notifications = db.prepare(`SELECT * FROM notifications_log ORDER BY id DESC LIMIT 100`).all();
    const countLogs = db.prepare(`SELECT * FROM count_logs ORDER BY id DESC LIMIT 50`).all();

    const pendingPlacementDevices = allDevices.filter(d => d.location_status === 'DEPODA' && (!d.physical_shelf_code || d.physical_shelf_code === 'RAF_BEKLİYOR'));

    return sendJson(res, 200, {
      role: currentUser ? currentUser.role : 'YÖNETİCİ',
      currentUser,
      devices: allDevices,
      slaAlerts,
      shelfMismatches,
      pendingPlacementDevices,
      fifoRecommendations,
      shelves,
      personnel,
      returnPool,
      transferPool,
      shipments,
      dispatchHistory,
      notifications,
      countLogs,
      vehicleCountCampaignActive: getSettingValue('vehicle_count_campaign_active', '0') === '1'
    });
  }

  // POST /api/shelves/resolve-mismatch
  if (pathname === '/api/shelves/resolve-mismatch' && method === 'POST') {
    const body = await readBody(req);
    const { serial_no, new_physical_shelf } = body;
    const device = db.prepare(`SELECT * FROM devices WHERE serial_no = ?`).get(serial_no);
    if (!device) return sendJson(res, 404, { error: 'Cihaz bulunamadı' });

    const targetShelf = new_physical_shelf || device.recommended_new_physical_shelf || recommendPhysicalShelf(device.category, device.logical_shelf);
    const capCheck = checkShelfCapacity(targetShelf, 1);
    if (!capCheck.ok) return sendJson(res, 400, { error: capCheck.error });

    db.prepare(`
      UPDATE devices
      SET physical_shelf_code = ?, shelf_mismatch_alert = 0, previous_logical_shelf = logical_shelf, recommended_new_physical_shelf = NULL,
          notes = 'Fiziksel raf ' || ? || ' olarak güncellendi (' || date('now') || ')'
      WHERE serial_no = ?
    `).run(targetShelf, targetShelf, serial_no);

    return sendJson(res, 200, { ok: true, serial_no, new_physical_shelf: targetShelf });
  }

  // POST /api/shelves/assign-pending -> Depocu/Yönetici approves & places RAF_BEKLİYOR devices into a physical shelf with free capacity
  if (pathname === '/api/shelves/assign-pending' && method === 'POST') {
    const body = await readBody(req);
    const { target_shelf_code, serial_numbers = null, category = null, logical_shelf = null, limit = null } = body;
    const shelfCode = String(target_shelf_code || '').trim().toUpperCase();
    if (!shelfCode) return sendJson(res, 400, { error: 'Hedef fiziksel raf seçiniz.' });

    let candidates = [];
    if (Array.isArray(serial_numbers) && serial_numbers.length > 0) {
      const placeholders = serial_numbers.map(() => '?').join(',');
      candidates = db.prepare(`
        SELECT serial_no FROM devices
        WHERE serial_no IN (${placeholders}) AND location_status = 'DEPODA'
      `).all(...serial_numbers.map(s => String(s).trim().toUpperCase()));
    } else if (category && logical_shelf) {
      candidates = db.prepare(`
        SELECT serial_no FROM devices
        WHERE category = ? AND logical_shelf = ? AND location_status = 'DEPODA'
          AND (physical_shelf_code IS NULL OR physical_shelf_code = '' OR physical_shelf_code = 'RAF_BEKLİYOR')
        ORDER BY sla_entry_date ASC
      `).all(category, logical_shelf);
    } else {
      return sendJson(res, 400, { error: 'Yerleştirilecek cihaz grubu veya seri listesi belirtilmedi.' });
    }

    if (!candidates.length) {
      return sendJson(res, 400, { error: 'Raf onayı bekleyen uygun cihaz bulunamadı.' });
    }

    const shelfInfo = checkShelfCapacity(shelfCode, 1);
    if (!shelfInfo.ok) {
      return sendJson(res, 400, { error: shelfInfo.error });
    }

    const requestedCount = limit ? Math.min(Number(limit), candidates.length) : candidates.length;
    if (requestedCount > shelfInfo.free) {
      return sendJson(res, 400, {
        error: `KAPASİTE YETERSİZ: '${shelfCode}' rafında ${shelfInfo.free} adet boş yer var (${shelfInfo.current}/${shelfInfo.capacity}), ancak ${requestedCount} cihaz yerleştirmeye çalışıyorsunuz. En fazla ${shelfInfo.free} adet yerleştirebilir veya başka bir müsait raf seçebilirsiniz.`
      });
    }

    const toAssign = candidates.slice(0, requestedCount);
    db.exec('BEGIN TRANSACTION');
    try {
      const upd = db.prepare(`
        UPDATE devices
        SET physical_shelf_code = ?, recommended_new_physical_shelf = NULL
        WHERE serial_no = ?
      `);
      for (const row of toAssign) {
        upd.run(shelfCode, row.serial_no);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return sendJson(res, 200, {
      ok: true,
      assigned_count: toAssign.length,
      remaining_in_group: candidates.length - toAssign.length,
      shelf: shelfCode
    });
  }

  // POST /api/shelves/create (ONLY YÖNETİCİ ALLOWED!)
  if (pathname === '/api/shelves/create' && method === 'POST') {
    const body = await readBody(req);
    const { user_role, code, category, target_logical_shelf, capacity, notes } = body;
    if (user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Yeni fiziksel raf tanımlama işlemi yalnızca YÖNETİCİ rolü tarafından yapılabilir.' });
    }
    if (!code || !category || !target_logical_shelf) {
      return sendJson(res, 400, { error: 'Raf kodu, kategori ve hedef statü zorunludur.' });
    }
    db.prepare(`
      INSERT INTO physical_shelves (code, category, target_logical_shelf, capacity, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(code.trim().toUpperCase(), category, target_logical_shelf, Number(capacity) || 500, notes || '');
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/shelves/rename (ONLY YÖNETİCİ ALLOWED - Updates shelf name and automatically updates all devices on that shelf!)
  if (pathname === '/api/shelves/rename' && method === 'POST') {
    const body = await readBody(req);
    const { user_role, old_code, new_code, target_logical_shelf, capacity } = body;
    if (user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Raf düzenleme işlemi yalnızca YÖNETİCİ rolü tarafından yapılabilir.' });
    }
    const cleanOld = (old_code || '').trim().toUpperCase();
    const cleanNew = (new_code || '').trim().toUpperCase();
    if (!cleanOld || !cleanNew) {
      return sendJson(res, 400, { error: 'Eski ve yeni raf kodu zorunludur.' });
    }

    const shelf = db.prepare(`SELECT * FROM physical_shelves WHERE code = ?`).get(cleanOld);
    if (!shelf) return sendJson(res, 404, { error: 'Düzenlenecek raf bulunamadı.' });

    if (cleanOld !== cleanNew) {
      const collision = db.prepare(`SELECT * FROM physical_shelves WHERE code = ?`).get(cleanNew);
      if (collision) return sendJson(res, 400, { error: `${cleanNew} kodlu başka bir raf zaten mevcut.` });
    }

    db.prepare(`
      UPDATE physical_shelves
      SET code = ?, target_logical_shelf = COALESCE(?, target_logical_shelf), capacity = COALESCE(?, capacity)
      WHERE code = ?
    `).run(cleanNew, target_logical_shelf || null, capacity ? Number(capacity) : null, cleanOld);

    if (cleanOld !== cleanNew) {
      db.prepare(`UPDATE devices SET physical_shelf_code = ? WHERE physical_shelf_code = ?`).run(cleanNew, cleanOld);
      db.prepare(`UPDATE return_pool SET recommended_physical_shelf = ? WHERE recommended_physical_shelf = ?`).run(cleanNew, cleanOld);
      db.prepare(`UPDATE shipment_batches SET recommended_shelf = ? WHERE recommended_shelf = ?`).run(cleanNew, cleanOld);
    }

    return sendJson(res, 200, { ok: true, old_code: cleanOld, new_code: cleanNew });
  }

  // POST /api/shelves/move-devices (Move all devices from one physical shelf to another before deleting!)
  if (pathname === '/api/shelves/move-devices' && method === 'POST') {
    const body = await readBody(req);
    const { user_role, from_shelf_code, to_shelf_code } = body;
    if (user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Raf taşıma işlemi yalnızca YÖNETİCİ rolü tarafından yapılabilir.' });
    }
    const fromCode = (from_shelf_code || '').trim().toUpperCase();
    const toCode = (to_shelf_code || '').trim().toUpperCase();
    if (!fromCode || !toCode || fromCode === toCode) {
      return sendJson(res, 400, { error: 'Geçerli bir kaynak ve hedef raf seçiniz.' });
    }

    const targetShelf = db.prepare(`SELECT * FROM physical_shelves WHERE code = ?`).get(toCode);
    if (!targetShelf) return sendJson(res, 404, { error: 'Hedef fiziksel raf bulunamadı.' });

    const devicesToMove = db.prepare(`SELECT * FROM devices WHERE physical_shelf_code = ? AND location_status = 'DEPODA'`).all(fromCode);
    const capCheck = checkShelfCapacity(toCode, devicesToMove.length);
    if (!capCheck.ok) {
      return sendJson(res, 400, { error: capCheck.error });
    }
    db.prepare(`
      UPDATE devices
      SET physical_shelf_code = ?, notes = COALESCE(notes, '') || ' [' || ? || ' -> ' || ? || ' rafına taşındı]'
      WHERE physical_shelf_code = ? AND location_status = 'DEPODA'
    `).run(toCode, fromCode, toCode, fromCode);

    return sendJson(res, 200, { ok: true, moved_count: devicesToMove.length, from_shelf_code: fromCode, to_shelf_code: toCode });
  }

  // POST /api/shelves/delete (ONLY YÖNETİCİ - Blocks deletion if shelf still contains devices!)
  if (pathname === '/api/shelves/delete' && method === 'POST') {
    const body = await readBody(req);
    const { user_role, code } = body;
    if (user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Raf silme işlemi yalnızca YÖNETİCİ rolü tarafından yapılabilir.' });
    }
    const cleanCode = (code || '').trim().toUpperCase();
    const deviceCount = db.prepare(`SELECT COUNT(*) as c FROM devices WHERE physical_shelf_code = ? AND location_status = 'DEPODA'`).get(cleanCode).c;

    if (deviceCount > 0) {
      return sendJson(res, 400, {
        error: `SİLME ENGELLENDİ: ${cleanCode} rafında şu an ${deviceCount} adet cihaz bulunmaktadır! Bu rafı silebilmek için önce içindeki cihazları başka bir fiziksel rafa taşımalısınız.`,
        has_devices: true,
        device_count: deviceCount
      });
    }

    db.prepare(`DELETE FROM physical_shelves WHERE code = ?`).run(cleanCode);
    return sendJson(res, 200, { ok: true, deleted_code: cleanCode });
  }

  // POST /api/shipments/import (Step 1: Import Turkcell Shipment Pool)
  if (pathname === '/api/shipments/import' && method === 'POST') {
    const body = await readBody(req);
    const { batch_code, category = 'SOL', items = [] } = body;
    if (!items.length) return sendJson(res, 400, { error: 'En az 1 seri numarası girmelisiniz.' });

    const code = (batch_code || `SEVKIYAT-${Date.now().toString().slice(-5)}`).toUpperCase();
    const recShelf = recommendPhysicalShelf(category, 'SAĞLAM');

    const resBatch = db.prepare(`
      INSERT INTO shipment_batches (batch_code, category, created_at, status, recommended_shelf)
      VALUES (?, ?, ?, 'DOĞRULAMA_BEKLİYOR', ?)
    `).run(code, category, new Date().toISOString(), recShelf);

    const batchId = resBatch.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO shipment_items (batch_id, serial_no, model_name, in_turkcell_pool, physically_scanned)
      VALUES (?, ?, ?, 1, 0)
    `);

    for (const item of items) {
      const sn = (item.serial_no || '').trim().toUpperCase();
      if (!sn) continue;
      insertItem.run(batchId, sn, item.model_name || (category === 'SOL' ? 'SOL Fiber Modem / ONT' : 'Turkcell SPX Cihaz'));
    }

    return sendJson(res, 200, { ok: true, batch_id: batchId, batch_code: code, recommended_shelf: recShelf });
  }

  // POST /api/shipments/scan-bulk-or-single -> Scan physical serials via barcode/QR reader and compare against Turkcell shipment pool
  if (pathname === '/api/shipments/scan' && method === 'POST') {
    const body = await readBody(req);
    const { batch_id, serial_numbers = [] } = body;
    const list = Array.isArray(serial_numbers) ? serial_numbers : [body.serial_no];
    const cleanList = list.map(s => (s || '').trim().toUpperCase()).filter(Boolean);
    if (!batch_id || !cleanList.length) return sendJson(res, 400, { error: 'Sevkiyat ve seri numarası gerekli.' });

    const matched = [];
    const extra = [];
    const now = new Date().toISOString();

    for (const sn of cleanList) {
      const existing = db.prepare(`SELECT * FROM shipment_items WHERE batch_id = ? AND serial_no = ?`).get(batch_id, sn);
      if (existing) {
        db.prepare(`UPDATE shipment_items SET physically_scanned = 1, scanned_at = ? WHERE id = ?`).run(now, existing.id);
        matched.push(sn);
      } else {
        db.prepare(`
          INSERT INTO shipment_items (batch_id, serial_no, model_name, in_turkcell_pool, physically_scanned, scanned_at)
          VALUES (?, ?, 'Turkcell Havuzunda Olmayan Fazla Cihaz', 0, 1, ?)
        `).run(batch_id, sn, now);
        extra.push(sn);
      }
    }

    if (extra.length > 0) {
      const batch = db.prepare(`SELECT * FROM shipment_batches WHERE id = ?`).get(batch_id);
      dispatchAutoNotification({
        recipient_name: 'Depo Sorumlusu ve Operasyon Yönetimi',
        recipient_phone: '905325556677, 905326667788',
        recipient_email: 'depo@karadenzecm.com, yonetim@karadenzecm.com',
        category: 'SEVKİYAT_FARK_UYARISI',
        title: `Sevkiyat Fark Uyarısı (${batch ? batch.batch_code : ''})`,
        message: `Fiziksel sevkiyat okutması sırasında Turkcell sevkiyat havuzunda bulunmayan şu seri numaraları tespit edildi: ${extra.join(', ')}.`
      });
    }

    return sendJson(res, 200, { ok: true, matched, extra });
  }

  // POST /api/shipments/approve
  if (pathname === '/api/shipments/approve' && method === 'POST') {
    const body = await readBody(req);
    const { batch_id, physical_shelf_code } = body;
    const batch = db.prepare(`SELECT * FROM shipment_batches WHERE id = ?`).get(batch_id);
    if (!batch) return sendJson(res, 404, { error: 'Sevkiyat bulunamadı' });

    const items = db.prepare(`SELECT * FROM shipment_items WHERE batch_id = ?`).all(batch_id);
    const missing = items.filter(i => i.in_turkcell_pool === 1 && i.physically_scanned === 0);
    const extra = items.filter(i => i.in_turkcell_pool === 0 && i.physically_scanned === 1);

    if ((missing.length > 0 || extra.length > 0) && !body.force_approve) {
      return sendJson(res, 400, {
        error: `Seri Uyuşmazlığı Mevcut! Turkcell listesinde olup fiziksel okutulmayan: ${missing.map(m => m.serial_no).join(', ') || 'Yok'} | Fiziksel okutulup Turkcell listesinde olmayan: ${extra.map(e => e.serial_no).join(', ') || 'Yok'}`,
        missing,
        extra
      });
    }

    const shelfCode = physical_shelf_code || batch.recommended_shelf || recommendPhysicalShelf(batch.category, 'SAĞLAM');
    const scannedItems = items.filter(i => i.physically_scanned === 1 && i.in_turkcell_pool === 1);
    const capCheck = checkShelfCapacity(shelfCode, scannedItems.length || 1);
    if (!capCheck.ok) {
      return sendJson(res, 400, { error: capCheck.error });
    }
    const today = new Date().toISOString().split('T')[0];

    const upsertDevice = db.prepare(`
      INSERT INTO devices (serial_no, category, model_name, logical_shelf, previous_logical_shelf, physical_shelf_code, location_status, sla_entry_date, sla_max_days, notes)
      VALUES (?, ?, ?, 'SAĞLAM', 'SAĞLAM', ?, 'DEPODA', ?, 90, ?)
      ON CONFLICT(serial_no) DO UPDATE SET
        physical_shelf_code = excluded.physical_shelf_code,
        location_status = 'DEPODA',
        logical_shelf = 'SAĞLAM'
    `);

    for (const item of scannedItems) {
      upsertDevice.run(item.serial_no, batch.category, item.model_name, shelfCode, today, `Sevkiyat (${batch.batch_code}) doğrulaması ile ${shelfCode} rafına alındı.`);
    }

    db.prepare(`UPDATE shipment_batches SET status = 'ONAYLANDI', approved_at = ?, recommended_shelf = ? WHERE id = ?`)
      .run(new Date().toISOString(), shelfCode, batch_id);

    dispatchAutoNotification({
      recipient_name: 'Operasyon Yönetimi ve Depo Sorumlusu',
      recipient_phone: '905326667788, 905325556677',
      recipient_email: 'yonetim@karadenzecm.com, depo@karadenzecm.com',
      category: 'SEVKİYAT_ONAY',
      title: `Yeni Sevkiyat Depoya Alındı (${batch.batch_code})`,
      message: `${batch.batch_code} kodlu sevkiyattaki ${scannedItems.length} adet sıfır cihaz fiziksel seri kontrolü tamamlanarak ${shelfCode} rafına yerleştirilmiştir.`
    });

    return sendJson(res, 200, { ok: true, added_count: scannedItems.length, shelf: shelfCode });
  }

  // POST /api/dispatch/check-fifo -> Laser Barcode Scanner fast verification
  if (pathname === '/api/dispatch/check-fifo' && method === 'POST') {
    const body = await readBody(req);
    const sn = (body.serial_no || '').trim().toUpperCase();
    const device = db.prepare(`SELECT * FROM devices WHERE serial_no = ?`).get(sn);
    if (!device) {
      return sendJson(res, 404, { error: `${sn} seri numaralı cihaz stokta bulunamadı.` });
    }
    if (device.location_status !== 'DEPODA') {
      return sendJson(res, 400, { error: `${sn} şu an fiziksel depoda değil (Mevcut Durumu: ${device.location_status}).` });
    }
    if (device.logical_shelf === 'KARANTİNA' || device.logical_shelf === 'ARIZA') {
      return sendJson(res, 400, { error: `ENGEL: ${sn} cihazı '${device.logical_shelf}' rafındadır. Teknisyene kurulum için yalnızca SAĞLAM veya SAĞLAM DÖNEN cihaz verilebilir.` });
    }

    const deviceSla = computeSLA(device);
    const allInWarehouse = db.prepare(`
      SELECT * FROM devices
      WHERE category = ? AND location_status = 'DEPODA' AND (logical_shelf = 'SAĞLAM DÖNEN' OR logical_shelf = 'SAĞLAM') AND serial_no != ?
    `).all(device.category, sn).map(d => ({ ...d, ...computeSLA(d) }));

    const urgentAlternatives = allInWarehouse
      .filter(d => d.days_remaining <= 20 && d.days_remaining < deviceSla.days_remaining - 10)
      .sort((a, b) => a.days_remaining - b.days_remaining);

    return sendJson(res, 200, {
      device: { ...device, ...deviceSla },
      fifo_warning: urgentAlternatives.length > 0
        ? `SLA / FIFO ÖNCELİK UYARISI: Okutulan ${sn} cihazının SLA bitimine ${deviceSla.days_remaining} gün var; ancak ${urgentAlternatives[0].physical_shelf_code} rafındaki ${urgentAlternatives[0].serial_no} (${urgentAlternatives[0].logical_shelf}) cihazının SLA süresine ${urgentAlternatives[0].days_remaining} GÜN KALDI. Öncelikle SLA süresi yaklaşan cihazın çıkışı yapılmalıdır.`
        : null,
      urgent_alternatives: urgentAlternatives.slice(0, 5)
    });
  }

  // POST /api/dispatch/commit -> Morning or Intraday Dispatch Save -> Sends Corporate HTML + 2-Sheet Excel to Technician (TO) + Depocu/Teknik Müdür (CC)
  if (pathname === '/api/dispatch/commit' && method === 'POST') {
    const body = await readBody(req);
    const { assignments = [], dispatch_type = 'SABAH_DAĞITIM', dispatched_by = 'Hasan İlker Kadıoğlu' } = body;
    if (!assignments.length) return sendJson(res, 400, { error: 'Kaydedilecek cihaz dağıtım listesi boş.' });

    const now = new Date().toISOString();

    const insertHistory = db.prepare(`
      INSERT INTO dispatch_history (serial_no, category, model_name, logical_shelf, from_physical_shelf, personnel_id, personnel_name, team_name, dispatched_by, dispatched_at, dispatch_type, status_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ZİMMETTE')
    `);

    const notificationsSent = [];
    let totalDevicesDispatched = 0;

    for (const group of assignments) {
      const person = db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(group.personnel_id);
      if (!person || !group.serial_numbers || !group.serial_numbers.length) continue;

      const updatedDevices = [];
      for (const rawSn of group.serial_numbers) {
        const sn = rawSn.trim().toUpperCase();
        const dev = db.prepare(`SELECT * FROM devices WHERE serial_no = ?`).get(sn);
        if (!dev) continue;

        const fromShelf = dev.physical_shelf_code || '-';

        db.prepare(`
          UPDATE devices
          SET location_status = 'TEKNİSYENDE', assigned_personnel_id = ?, assigned_at = ?, physical_shelf_code = NULL
          WHERE serial_no = ?
        `).run(person.id, now, sn);

        insertHistory.run(
          sn,
          dev.category,
          dev.model_name,
          dev.logical_shelf,
          fromShelf,
          person.id,
          person.full_name,
          person.team_name,
          dispatched_by,
          now,
          dispatch_type
        );

        updatedDevices.push({ ...dev, from_physical_shelf: fromShelf, assigned_at: now });
        totalDevicesDispatched++;
      }

      if (updatedDevices.length > 0) {
        const dtStr = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
        const emailPkg = buildTechnicianDispatchEmail(person, updatedDevices, dispatched_by);

        dispatchAutoNotification({
          recipient_name: `${person.full_name} (TO) | Hasan İlker Kadıoğlu, Servetcan Küçüksolak (CC)`,
          recipient_phone: person.phone,
          recipient_email: emailPkg.toEmail,
          recipient_cc: emailPkg.ccEmail,
          category: 'OTOMATİK_ZİMMET_BİLDİRİMİ',
          title: emailPkg.subject,
          message: emailPkg.textBody,
          htmlBody: emailPkg.htmlBody,
          attachment: {
            filename: emailPkg.filename,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            base64: emailPkg.xlsxBuffer.toString('base64')
          }
        });

        notificationsSent.push({
          person: person.full_name,
          count: updatedDevices.length,
          serials: updatedDevices.map(d => d.serial_no),
          timestamp: dtStr
        });
      }
    }

    return sendJson(res, 200, { ok: true, notificationsSent, totalDevicesDispatched });
  }

  // POST /api/returns/add -> Karşılama (Barcode/QR Scanner or Excel) or Teknisyen (Mobile Camera QR) adds return devices -> Automatically notifies Warehouse & Managers!
  if (pathname === '/api/returns/add' && method === 'POST') {
    const body = await readBody(req);
    const { source_type, reported_by_personnel_id, items = [] } = body;
    const validItems = items.map(i => ({
      ...i,
      serial_no: (i.serial_no || '').trim().toUpperCase()
    })).filter(i => i.serial_no);

    if (!validItems.length) return sendJson(res, 400, { error: 'Geçerli bir cihaz seri numarası girilmedi.' });

    const person = reported_by_personnel_id
      ? db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(reported_by_personnel_id)
      : null;

    const reporterName = person ? person.full_name : (source_type === 'KARŞILAMA' ? 'Karşılama Birimi' : 'Saha Teknisyeni');
    const now = new Date().toISOString();

    const insertRet = db.prepare(`
      INSERT INTO return_pool (serial_no, category, model_name, source_type, reported_by_personnel_id, reported_by_name, customer_note, created_at, status, physically_scanned, recommended_physical_shelf)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'HAVUZDA_BEKLİYOR', 0, ?)
    `);

    const addedSerials = [];
    for (const item of validItems) {
      const sn = item.serial_no;
      // Look up real device in devices table first so real SOL/TURKCELL category & model are detected accurately!
      const knownDev = db.prepare(`SELECT category, model_name FROM devices WHERE UPPER(serial_no) = ?`).get(sn);
      const cat = knownDev ? knownDev.category : (item.category || (sn.startsWith('SPX') ? 'TURKCELL' : 'SOL'));
      const modelName = (knownDev && knownDev.model_name) ? knownDev.model_name : (item.model_name || (cat === 'SOL' ? 'SOL İade Cihaz' : 'Turkcell SPX İade Cihaz'));
      const recShelf = recommendPhysicalShelf(cat, 'KARANTİNA');
      insertRet.run(sn, cat, modelName, source_type, person ? person.id : null, reporterName, item.customer_note || '', now, recShelf);
      addedSerials.push(sn);
    }

    // Count total waiting in pool for automatic dynamic notification
    const pendingKarsilama = db.prepare(`SELECT COUNT(*) as c FROM return_pool WHERE source_type = 'KARŞILAMA' AND status = 'HAVUZDA_BEKLİYOR'`).get().c;
    const pendingTeknisyen = db.prepare(`SELECT COUNT(*) as c FROM return_pool WHERE source_type = 'TEKNİSYEN' AND status = 'HAVUZDA_BEKLİYOR'`).get().c;

    dispatchAutoNotification({
      recipient_name: 'Depo Sorumlusu ve Operasyon Yönetimi',
      recipient_phone: '905325556677, 905326667788',
      recipient_email: 'depo@karadenzecm.com, yonetim@karadenzecm.com',
      category: 'OTOMATİK_İADE_HAVUZU',
      title: `${source_type} İade Havuzuna ${addedSerials.length} Cihaz Eklendi`,
      message: `${reporterName} (${source_type}) tarafından ${addedSerials.join(', ')} seri numaralı iade cihaz(lar) sisteme yüklendi. Güncel Bekleyen Havuz Özeti: Karşılamadan ${pendingKarsilama} adet, Teknisyenlerden ${pendingTeknisyen} adet cihaz depo personeli onayını bekliyor.`
    });

    return sendJson(res, 200, { ok: true, added: addedSerials.length, pendingKarsilama, pendingTeknisyen });
  }

  // POST /api/transfers/create -> Technician (or Depocu/Yönetici) initiates a Technician-to-Technician or Technician-to-Warehouse unused device transfer (Goes to Approval Pool!)
  if (pathname === '/api/transfers/create' && method === 'POST') {
    const body = await readBody(req);
    const { from_personnel_id, transfer_type, to_personnel_id, serial_numbers = [], note = '' } = body;
    const cleanSerials = (Array.isArray(serial_numbers) ? serial_numbers : [body.serial_no])
      .map(s => (s || '').trim().toUpperCase())
      .filter(Boolean);

    if (!from_personnel_id || !cleanSerials.length) {
      return sendJson(res, 400, { error: 'Transfer edilecek cihaz seri numarası ve kaynak teknisyen zorunludur.' });
    }

    const fromPerson = db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(Number(from_personnel_id));
    if (!fromPerson) return sendJson(res, 404, { error: 'Kaynak teknisyen bulunamadı.' });

    let toPerson = null;
    if (transfer_type === 'TEKNİSYENDEN_TEKNİSYENE') {
      if (!to_personnel_id || Number(to_personnel_id) === Number(from_personnel_id)) {
        return sendJson(res, 400, { error: 'Transfer yapılacak hedef teknisyeni seçiniz.' });
      }
      toPerson = db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(Number(to_personnel_id));
      if (!toPerson) return sendJson(res, 404, { error: 'Hedef teknisyen bulunamadı.' });
    }

    const now = new Date().toISOString();
    const insertTransfer = db.prepare(`
      INSERT INTO transfer_pool (
        serial_no, category, model_name, logical_shelf, transfer_type,
        from_personnel_id, from_personnel_name, to_personnel_id, to_personnel_name,
        recommended_physical_shelf, note, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ONAY_BEKLİYOR', ?)
    `);

    const createdItems = [];
    for (const sn of cleanSerials) {
      const dev = db.prepare(`SELECT * FROM devices WHERE serial_no = ?`).get(sn);
      if (!dev) {
        return sendJson(res, 404, { error: `${sn} seri numaralı cihaz sistemde bulunamadı.` });
      }
      if (dev.location_status !== 'TEKNİSYENDE' || Number(dev.assigned_personnel_id) !== Number(fromPerson.id)) {
        return sendJson(res, 400, { error: `${sn} seri numaralı cihaz ${fromPerson.full_name} zimmetinde görünmüyor!` });
      }

      const alreadyPending = db.prepare(`SELECT id FROM transfer_pool WHERE serial_no = ? AND status = 'ONAY_BEKLİYOR'`).get(sn);
      if (alreadyPending) {
        return sendJson(res, 400, { error: `${sn} seri numaralı cihaz için zaten onay bekleyen bir transfer talebi mevcut.` });
      }

      const recShelf = transfer_type === 'TEKNİSYENDEN_DEPOYA'
        ? recommendPhysicalShelf(dev.category, dev.logical_shelf)
        : null;

      insertTransfer.run(
        sn,
        dev.category,
        dev.model_name,
        dev.logical_shelf,
        transfer_type,
        fromPerson.id,
        fromPerson.full_name,
        toPerson ? toPerson.id : null,
        toPerson ? toPerson.full_name : 'Merkez Depo',
        recShelf,
        note || (transfer_type === 'TEKNİSYENDEN_TEKNİSYENE' ? 'Saha Teknisyenler Arası Cihaz Transferi' : 'Kullanılmayan Sağlam Cihaz Depo İadesi'),
        now
      );
      createdItems.push({ ...dev, ...computeSLA(dev), recommended_physical_shelf: recShelf });
    }

    const emailPkg = buildTransferStatusEmail({
      stage: 'TALEP',
      items: createdItems,
      fromPerson,
      toPerson,
      targetShelf: createdItems[0]?.recommended_physical_shelf || '',
      note: note || ''
    });

    dispatchAutoNotification({
      recipient_name: emailPkg.recipientName,
      recipient_phone: toPerson ? toPerson.phone : fromPerson.phone,
      recipient_email: emailPkg.toEmail,
      recipient_cc: emailPkg.ccEmail,
      category: 'OTOMATİK_TRANSFER_TALEBİ',
      title: emailPkg.subject,
      message: emailPkg.textBody,
      htmlBody: emailPkg.htmlBody
    });

    const createdSerials = createdItems.map(i => i.serial_no);
    return sendJson(res, 200, { ok: true, created_count: createdSerials.length, serials: createdSerials });
  }

  // POST /api/transfers/approve -> Depocu or Yönetici approves transfer requests from pool & moves zimmet to receiving technician
  if (pathname === '/api/transfers/approve' && method === 'POST') {
    const body = await readBody(req);
    const { transfer_ids = [], resolved_by = 'Depo / Yönetim', physical_shelf_override = null } = body;
    if (!transfer_ids.length) return sendJson(res, 400, { error: 'Onaylanacak transfer kaydı seçilmedi.' });

    const now = new Date().toISOString();
    const approvedList = [];

    for (const id of transfer_ids) {
      const tr = db.prepare(`SELECT * FROM transfer_pool WHERE id = ? AND status = 'ONAY_BEKLİYOR'`).get(id);
      if (!tr) continue;

      const dev = db.prepare(`SELECT * FROM devices WHERE serial_no = ?`).get(tr.serial_no);
      const devSla = dev ? computeSLA(dev) : { days_remaining: '-' };
      const fromPerson = db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(tr.from_personnel_id);

      if (tr.transfer_type === 'TEKNİSYENDEN_TEKNİSYENE') {
        const toPerson = db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(tr.to_personnel_id);
        if (!toPerson) continue;

        // Move device ownership in backend from fromPerson to toPerson
        db.prepare(`
          UPDATE devices
          SET location_status = 'TEKNİSYENDE',
              assigned_personnel_id = ?,
              assigned_at = ?,
              physical_shelf_code = NULL,
              notes = 'Saha Transferi (' || ? || ' -> ' || ? || ') onaylandı'
          WHERE serial_no = ?
        `).run(toPerson.id, now, tr.from_personnel_name, toPerson.full_name, tr.serial_no);

        // Close old technician's dispatch_history record and open new technician's record
        db.prepare(`
          UPDATE dispatch_history
          SET status_after = 'TRANSFER_EDİLDİ'
          WHERE serial_no = ? AND personnel_id = ? AND status_after = 'ZİMMETTE'
        `).run(tr.serial_no, tr.from_personnel_id);

        db.prepare(`
          INSERT INTO dispatch_history (serial_no, category, model_name, logical_shelf, from_physical_shelf, personnel_id, personnel_name, team_name, dispatched_by, dispatched_at, dispatch_type, status_after)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SAHA_TRANSFER', 'ZİMMETTE')
        `).run(
          tr.serial_no,
          tr.category,
          tr.model_name,
          dev ? dev.logical_shelf : tr.logical_shelf,
          `TRANSFER (${tr.from_personnel_name})`,
          toPerson.id,
          toPerson.full_name,
          toPerson.team_name,
          `${resolved_by} (Transfer Onayı)`,
          now
        );

        db.prepare(`
          UPDATE transfer_pool SET status = 'ONAYLANDI', resolved_at = ?, resolved_by = ? WHERE id = ?
        `).run(now, resolved_by, id);

        // Single Corporate HTML Approval Email -> TO: Devralan + Devreden | CC: Hasan İlker Kadıoğlu, Servetcan Küçüksolak
        const emailPkg = buildTransferStatusEmail({
          stage: 'ONAYLANDI',
          items: [{ serial_no: tr.serial_no, category: tr.category, model_name: tr.model_name, days_remaining: devSla.days_remaining }],
          fromPerson,
          toPerson,
          resolvedBy: resolved_by,
          note: tr.note || ''
        });

        dispatchAutoNotification({
          recipient_name: emailPkg.recipientName,
          recipient_phone: [toPerson.phone, fromPerson?.phone].filter(Boolean).join(', '),
          recipient_email: emailPkg.toEmail,
          recipient_cc: emailPkg.ccEmail,
          category: 'OTOMATİK_TRANSFER_ONAYI',
          title: emailPkg.subject,
          message: emailPkg.textBody,
          htmlBody: emailPkg.htmlBody
        });

        approvedList.push({ serial_no: tr.serial_no, type: tr.transfer_type, target: toPerson.full_name });
      } else {
        // TEKNİSYENDEN_DEPOYA (Unused intact device returned to warehouse physical shelf)
        const targetShelf = physical_shelf_override || tr.recommended_physical_shelf || recommendPhysicalShelf(tr.category, dev ? dev.logical_shelf : tr.logical_shelf);
        const capCheck = checkShelfCapacity(targetShelf, 1);
        if (!capCheck.ok) {
          return sendJson(res, 400, { error: capCheck.error });
        }

        db.prepare(`
          UPDATE devices
          SET location_status = 'DEPODA',
              assigned_personnel_id = NULL,
              assigned_at = NULL,
              physical_shelf_code = ?,
              notes = 'Teknisyenden (' || ? || ') kullanılmadan depoya (' || ? || ') iade alındı'
          WHERE serial_no = ?
        `).run(targetShelf, tr.from_personnel_name, targetShelf, tr.serial_no);

        db.prepare(`
          UPDATE dispatch_history
          SET status_after = 'DEPOYA_İADE'
          WHERE serial_no = ? AND personnel_id = ? AND status_after = 'ZİMMETTE'
        `).run(tr.serial_no, tr.from_personnel_id);

        db.prepare(`
          UPDATE transfer_pool
          SET status = 'ONAYLANDI', recommended_physical_shelf = ?, resolved_at = ?, resolved_by = ?
          WHERE id = ?
        `).run(targetShelf, now, resolved_by, id);

        const emailPkg = buildTransferStatusEmail({
          stage: 'ONAYLANDI',
          items: [{ serial_no: tr.serial_no, category: tr.category, model_name: tr.model_name, days_remaining: devSla.days_remaining }],
          fromPerson,
          toPerson: null,
          targetShelf,
          resolvedBy: resolved_by,
          note: tr.note || ''
        });

        dispatchAutoNotification({
          recipient_name: emailPkg.recipientName,
          recipient_phone: fromPerson?.phone || '',
          recipient_email: emailPkg.toEmail,
          recipient_cc: emailPkg.ccEmail,
          category: 'OTOMATİK_DEPO_TRANSFER_ONAYI',
          title: emailPkg.subject,
          message: emailPkg.textBody,
          htmlBody: emailPkg.htmlBody
        });

        approvedList.push({ serial_no: tr.serial_no, type: tr.transfer_type, target: targetShelf });
      }
    }

    return sendJson(res, 200, { ok: true, approvedList });
  }

  // POST /api/transfers/reject -> Depocu or Yönetici rejects a transfer request
  if (pathname === '/api/transfers/reject' && method === 'POST') {
    const body = await readBody(req);
    const { transfer_id, resolved_by = 'Depo / Yönetim', reject_reason = '' } = body;
    const tr = db.prepare(`SELECT * FROM transfer_pool WHERE id = ? AND status = 'ONAY_BEKLİYOR'`).get(transfer_id);
    if (!tr) return sendJson(res, 404, { error: 'Bekleyen transfer talebi bulunamadı.' });

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE transfer_pool
      SET status = 'REDDEDİLDİ', resolved_at = ?, resolved_by = ?, note = COALESCE(note, '') || ' [RED: ' || ? || ']'
      WHERE id = ?
    `).run(now, resolved_by, reject_reason || 'Onaylanmadı', transfer_id);

    const dev = db.prepare(`SELECT * FROM devices WHERE serial_no = ?`).get(tr.serial_no);
    const devSla = dev ? computeSLA(dev) : { days_remaining: '-' };
    const fromPerson = db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(tr.from_personnel_id);
    const toPerson = tr.to_personnel_id ? db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(tr.to_personnel_id) : null;

    const emailPkg = buildTransferStatusEmail({
      stage: 'REDDEDİLDİ',
      items: [{ serial_no: tr.serial_no, category: tr.category, model_name: tr.model_name, days_remaining: devSla.days_remaining }],
      fromPerson,
      toPerson,
      resolvedBy: resolved_by,
      rejectReason: reject_reason || 'Onaylanmadı',
      note: tr.note || ''
    });

    dispatchAutoNotification({
      recipient_name: emailPkg.recipientName,
      recipient_phone: [toPerson?.phone, fromPerson?.phone].filter(Boolean).join(', '),
      recipient_email: emailPkg.toEmail,
      recipient_cc: emailPkg.ccEmail,
      category: 'OTOMATİK_TRANSFER_RED',
      title: emailPkg.subject,
      message: emailPkg.textBody,
      htmlBody: emailPkg.htmlBody
    });

    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/returns/approve' && method === 'POST') {
    const body = await readBody(req);
    const { return_ids = [], physical_shelf_override } = body;
    if (!return_ids.length) return sendJson(res, 400, { error: 'Onaylanacak iade kaydı seçilmedi.' });

    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();
    const approvedItems = [];

    for (const id of return_ids) {
      const ret = db.prepare(`SELECT * FROM return_pool WHERE id = ?`).get(id);
      if (!ret) continue;

      const targetShelf = physical_shelf_override || ret.recommended_physical_shelf || recommendPhysicalShelf(ret.category, 'KARANTİNA');
      const capCheck = checkShelfCapacity(targetShelf, 1);
      if (!capCheck.ok) {
        return sendJson(res, 400, { error: capCheck.error });
      }

      db.prepare(`
        UPDATE return_pool
        SET status = 'DEPOCU_ONAYLADI', physically_scanned = 1, recommended_physical_shelf = ?, approved_at = ?
        WHERE id = ?
      `).run(targetShelf, now, id);

      db.prepare(`
        INSERT INTO devices (serial_no, category, model_name, logical_shelf, previous_logical_shelf, physical_shelf_code, location_status, assigned_personnel_id, sla_entry_date, sla_max_days, notes)
        VALUES (?, ?, ?, 'KARANTİNA', 'KARANTİNA', ?, 'DEPODA', NULL, ?, 30, ?)
        ON CONFLICT(serial_no) DO UPDATE SET
          logical_shelf = 'KARANTİNA',
          physical_shelf_code = excluded.physical_shelf_code,
          location_status = 'DEPODA',
          assigned_personnel_id = NULL,
          sla_entry_date = excluded.sla_entry_date,
          sla_max_days = 30,
          notes = excluded.notes
      `).run(ret.serial_no, ret.category, ret.model_name, targetShelf, today, `${ret.source_type} iade havuzundan fiziksel kontrolle ${targetShelf} rafına alındı.`);

      approvedItems.push({ serial_no: ret.serial_no, shelf: targetShelf });
    }

    return sendJson(res, 200, { ok: true, approvedItems });
  }

  // POST /api/reports/sync-turkcell (Fast Transactional Sync for 5000+ devices from Depo Sol.xlsx & Depo Tsd.xlsx)
  if (pathname === '/api/reports/sync-turkcell' && method === 'POST') {
    const body = await readBody(req);
    const { category = 'SOL', rows = [] } = body;
    if (!rows.length) return sendJson(res, 400, { error: 'Raporda satır bulunamadı.' });

    const normalizeLogicalShelf = (val) => {
      const s = String(val || 'SAĞLAM').trim().toUpperCase()
        .replace(/Ğ/g, 'G').replace(/İ/g, 'I').replace(/Ö/g, 'O').replace(/Ü/g, 'U').replace(/Ş/g, 'S').replace(/Ç/g, 'C');
      if (s.includes('ARIZA')) return 'ARIZA';
      if (s.includes('KARANTINA')) return 'KARANTİNA';
      if (s.includes('DONEN')) return 'SAĞLAM DÖNEN';
      return 'SAĞLAM';
    };

    const now = new Date().toISOString();
    const reportSerials = new Set();

    const existingCategoryDevices = db.prepare(`
      SELECT d.*, p.full_name as tech_name, p.phone as tech_phone, p.email as tech_email
      FROM devices d
      LEFT JOIN personnel p ON d.assigned_personnel_id = p.id
      WHERE d.category = ? AND (d.location_status = 'DEPODA' OR d.location_status = 'TEKNİSYENDE')
    `).all(category);

    const existingMap = new Map(existingCategoryDevices.map(d => [d.serial_no.toUpperCase(), d]));
    const installedDropped = [];
    const shelfChangedAlerts = [];
    const newlyDiscovered = [];

    // Precompute recommended physical shelves per logical shelf for fast lookup
    const defaultShelfMap = {
      'SAĞLAM': recommendPhysicalShelf(category, 'SAĞLAM'),
      'SAĞLAM DÖNEN': recommendPhysicalShelf(category, 'SAĞLAM DÖNEN'),
      'KARANTİNA': recommendPhysicalShelf(category, 'KARANTİNA'),
      'ARIZA': recommendPhysicalShelf(category, 'ARIZA')
    };

    const stmtUpdateMismatch = db.prepare(`
      UPDATE devices
      SET previous_logical_shelf = ?, logical_shelf = ?, shelf_mismatch_alert = 1,
          recommended_new_physical_shelf = ?, sla_max_days = ?, sla_entry_date = ?, last_report_seen_at = ?
      WHERE serial_no = ?
    `);
    const stmtUpdateSeen = db.prepare(`
      UPDATE devices SET last_report_seen_at = ?, sla_entry_date = ? WHERE serial_no = ?
    `);
    const stmtInsertNew = db.prepare(`
      INSERT INTO devices (serial_no, category, model_name, logical_shelf, previous_logical_shelf, physical_shelf_code, recommended_new_physical_shelf, location_status, sla_entry_date, sla_max_days, last_report_seen_at, notes)
      VALUES (?, ?, ?, ?, ?, 'RAF_BEKLİYOR', ?, 'DEPODA', ?, ?, ?, ?)
      ON CONFLICT(serial_no) DO UPDATE SET
        model_name = excluded.model_name,
        logical_shelf = excluded.logical_shelf,
        sla_entry_date = excluded.sla_entry_date,
        sla_max_days = excluded.sla_max_days,
        location_status = 'DEPODA',
        physical_shelf_code = CASE WHEN devices.physical_shelf_code IS NULL OR devices.physical_shelf_code = '' THEN 'RAF_BEKLİYOR' ELSE devices.physical_shelf_code END,
        recommended_new_physical_shelf = CASE WHEN devices.physical_shelf_code IS NULL OR devices.physical_shelf_code = '' OR devices.physical_shelf_code = 'RAF_BEKLİYOR' THEN excluded.recommended_new_physical_shelf ELSE devices.recommended_new_physical_shelf END,
        last_report_seen_at = excluded.last_report_seen_at
    `);
    const stmtDropInstalled = db.prepare(`
      UPDATE devices SET location_status = 'MÜŞTERİYE_KURULDU', physical_shelf_code = NULL, notes = ? WHERE serial_no = ?
    `);
    const stmtUpdateHist = db.prepare(`
      UPDATE dispatch_history SET status_after = 'MÜŞTERİYE_KURULDU' WHERE serial_no = ?
    `);

    db.exec('BEGIN TRANSACTION');
    try {
      for (const r of rows) {
        const sn = String(r.serial_no || '').trim().toUpperCase();
        if (!sn) continue;
        reportSerials.add(sn);

        const incomingShelf = normalizeLogicalShelf(r.logical_shelf);
        const maxDays = (incomingShelf === 'KARANTİNA' || incomingShelf === 'ARIZA') ? 30 : 90;
        const entryDate = r.sla_entry_date || new Date().toISOString().split('T')[0];
        const noteDetail = r.last_action_time ? `Son İşlem: ${r.last_action_time}` : 'Stok Raporundan Güncellendi';

        const existing = existingMap.get(sn);
        if (existing) {
          if (existing.logical_shelf !== incomingShelf) {
            const recNewShelf = defaultShelfMap[incomingShelf];
            stmtUpdateMismatch.run(existing.logical_shelf, incomingShelf, recNewShelf, maxDays, entryDate, now, sn);
            shelfChangedAlerts.push({
              serial_no: sn,
              old_logical: existing.logical_shelf,
              new_logical: incomingShelf,
              current_physical_shelf: existing.physical_shelf_code || 'TEKNİSYENDE',
              recommended_physical_shelf: recNewShelf
            });
          } else {
            stmtUpdateSeen.run(now, entryDate, sn);
          }
        } else {
          const recShelf = defaultShelfMap[incomingShelf];
          stmtInsertNew.run(sn, category, r.model_name || `${category} Cihaz`, incomingShelf, incomingShelf, recShelf, entryDate, maxDays, now, noteDetail);
          newlyDiscovered.push({ serial_no: sn, logical_shelf: incomingShelf, assigned_shelf: recShelf });
        }
      }

      for (const existing of existingCategoryDevices) {
        if (!reportSerials.has(existing.serial_no.toUpperCase())) {
          const noteText = existing.location_status === 'TEKNİSYENDE'
            ? `Turkcell raporundan düştü -> ${existing.tech_name || 'Teknisyen'} zimmetinden otomatik düşüldü (Müşteriye Kuruldu).`
            : `Turkcell raporundan düştü -> Stoktan otomatik düşüldü.`;

          stmtDropInstalled.run(noteText, existing.serial_no);
          stmtUpdateHist.run(existing.serial_no);

          installedDropped.push({
            serial_no: existing.serial_no,
            model_name: existing.model_name,
            technician: existing.tech_name || 'Depo Çıkışı'
          });
        }
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // Raf değişiklikleri yalnızca ekran içi uyarı (1. Sekme ve 2. Sekme) olarak gösterilir; mail gönderilmez.

    runAutomaticBackgroundChecks();

    return sendJson(res, 200, {
      ok: true,
      category,
      total_in_report: reportSerials.size,
      installedDropped,
      shelfChangedAlerts,
      newlyDiscoveredCount: newlyDiscovered.length
    });
  }

  // POST /api/personnel/import (ONLY YÖNETİCİ ALLOWED - Supports Bys Rapor.xlsx & deactivates non-active/non-operational staff!)
  if (pathname === '/api/personnel/import' && method === 'POST') {
    const body = await readBody(req);
    const { user_role, rows = [], deactivate_missing = false } = body;
    if (user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: BYS personel ekleme ve güncelleme işlemi yalnızca YÖNETİCİ rolü tarafından yapılabilir.' });
    }
    if (!rows.length) return sendJson(res, 400, { error: 'Aktarılacak aktif operasyon personeli bulunamadı.' });

    const upsert = db.prepare(`
      INSERT INTO personnel (employee_code, username, password, full_name, team_name, role, phone, email, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(employee_code) DO UPDATE SET
        username = excluded.username,
        full_name = excluded.full_name,
        team_name = excluded.team_name,
        role = excluded.role,
        phone = excluded.phone,
        email = excluded.email,
        active = 1
    `);

    const importedCodes = new Set();
    let count = 0;

    db.exec('BEGIN TRANSACTION');
    try {
      for (const r of rows) {
        if (!r.full_name) continue;
        const code = String(r.employee_code || `BYS-${Math.floor(1000 + Math.random() * 9000)}`).trim();
        const uname = String(r.username || code.toLowerCase()).trim();
        const pwd = String(r.password || '123456').trim();
        let phone = String(r.phone || '').replace(/[^0-9]/g, '');
        if (phone.length === 10 && phone.startsWith('5')) phone = '90' + phone;

        upsert.run(
          code,
          uname,
          pwd,
          String(r.full_name).trim(),
          String(r.team_name || 'Saha Ekibi').trim(),
          String(r.role || 'TEKNİSYEN').trim().toUpperCase(),
          phone,
          String(r.email || '').trim()
        );
        importedCodes.add(code);
        count++;
      }

      if (deactivate_missing) {
        const allStaff = db.prepare(`SELECT id, employee_code, username FROM personnel`).all();
        const deact = db.prepare(`UPDATE personnel SET active = 0 WHERE id = ?`);
        for (const st of allStaff) {
          // Keep the main default admin account active so manager is never locked out
          if (st.username === 'yonetici') continue;
          if (!importedCodes.has(st.employee_code)) {
            deact.run(st.id);
          }
        }
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return sendJson(res, 200, { ok: true, imported_count: count });
  }

  // POST /api/counts/vehicle
  if (pathname === '/api/counts/vehicle' && method === 'POST') {
    const body = await readBody(req);
    const { personnel_id, scanned_serials = [] } = body;
    const person = db.prepare(`SELECT * FROM personnel WHERE id = ?`).get(personnel_id);
    if (!person) return sendJson(res, 404, { error: 'Teknisyen bulunamadı.' });

    const assignedDevices = db.prepare(`
      SELECT * FROM devices WHERE assigned_personnel_id = ? AND location_status = 'TEKNİSYENDE'
    `).all(personnel_id);

    const expectedSet = new Set(assignedDevices.map(d => d.serial_no.toUpperCase()));
    const scannedSet = new Set(scanned_serials.map(s => s.trim().toUpperCase()).filter(Boolean));

    const missing = [...expectedSet].filter(sn => !scannedSet.has(sn));
    const extra = [...scannedSet].filter(sn => !expectedSet.has(sn));

    const status = missing.length === 0 ? 'TAMAMLANDI' : 'EKSİK_VAR';
    const now = new Date().toISOString();

    db.prepare(`UPDATE personnel SET last_vehicle_count_at = ?, vehicle_count_status = ? WHERE id = ?`).run(now, status, personnel_id);
    db.prepare(`
      INSERT INTO count_logs (count_type, target_ref, target_name, expected_count, scanned_count, scanned_serials, missing_serials, extra_serials, status, created_at)
      VALUES ('HAFTALIK_ARAÇ', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(personnel_id), person.full_name, expectedSet.size, scannedSet.size, [...scannedSet].join(', '), missing.join(', '), extra.join(', '), missing.length === 0 ? 'TAM' : 'EKSİK_VAR', now);

    if (missing.length > 0) {
      const missingDevices = assignedDevices.filter(d => missing.includes(d.serial_no.toUpperCase()));
      sendTechnicianVehicleMissingEmail(person, missingDevices, expectedSet.size, scannedSet.size);
    }
    // Eksiksiz (missing.length === 0) çıktığında bireysel mail gönderilmez!

    // Check if ALL technicians with assigned devices have now finished their weekly vehicle count
    const remainingPending = getPendingVehicleCountTechnicians();
    let allCompletedReportSent = false;
    if (remainingPending.length === 0 && getSettingValue('vehicle_count_campaign_active', '0') === '1') {
      setSettingValue('vehicle_count_campaign_active', '0');
      await sendAllVehicleCountsFinalReport();
      allCompletedReportSent = true;
    }

    return sendJson(res, 200, {
      ok: true,
      expected_count: expectedSet.size,
      scanned_count: scannedSet.size,
      missing,
      extra,
      status,
      all_completed_report_sent: allCompletedReportSent
    });
  }

  // POST /api/counts/vehicle-campaign/start -> Starts weekly vehicle count & hourly reminders
  if (pathname === '/api/counts/vehicle-campaign/start' && method === 'POST') {
    const body = await readBody(req);
    if (body.user_role !== 'YÖNETİCİ' && body.user_role !== 'DEPOCU') {
      return sendJson(res, 403, { error: 'Yetki Hatası.' });
    }
    db.prepare(`
      UPDATE personnel
      SET vehicle_count_status = 'BEKLİYOR'
      WHERE role = 'TEKNİSYEN' AND active = 1
        AND id IN (SELECT DISTINCT assigned_personnel_id FROM devices WHERE location_status = 'TEKNİSYENDE' AND assigned_personnel_id IS NOT NULL)
    `).run();
    setSettingValue('vehicle_count_campaign_active', '1');
    const remRes = await sendHourlyVehicleCountReminders(true);
    return sendJson(res, 200, { ok: true, pending_count: remRes.sent_count || 0 });
  }

  // POST /api/counts/vehicle-campaign/stop -> Stops hourly reminders
  if (pathname === '/api/counts/vehicle-campaign/stop' && method === 'POST') {
    setSettingValue('vehicle_count_campaign_active', '0');
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/counts/vehicle-campaign/send-final -> Sends full vehicle count final report + Excel on demand
  if (pathname === '/api/counts/vehicle-campaign/send-final' && method === 'POST') {
    const resMail = await sendAllVehicleCountsFinalReport();
    return sendJson(res, 200, { ok: resMail.mail_sent, error: resMail.error });
  }

  // POST /api/counts/shelf
  if (pathname === '/api/counts/shelf' && method === 'POST') {
    const body = await readBody(req);
    const { shelf_code, counted_qty, scanned_serials = null } = body;
    const shelf = db.prepare(`SELECT * FROM physical_shelves WHERE code = ?`).get(shelf_code);
    if (!shelf) return sendJson(res, 404, { error: 'Fiziksel raf bulunamadı.' });

    const shelfDevices = db.prepare(`SELECT * FROM devices WHERE physical_shelf_code = ? AND location_status = 'DEPODA'`).all(shelf_code);
    const expectedCount = shelfDevices.length;
    const actualCount = scanned_serials !== null ? scanned_serials.length : Number(counted_qty);

    // If count does not match and serials haven't been scanned yet, require serial scan!
    if (actualCount !== expectedCount && scanned_serials === null) {
      return sendJson(res, 200, {
        ok: false,
        require_serial_scan: true,
        shelf_code,
        expectedCount,
        actualCount,
        expected_devices: shelfDevices.map(d => ({ serial_no: d.serial_no, model_name: d.model_name, logical_shelf: d.logical_shelf })),
        message: `${shelf_code} rafında sistemde ${expectedCount} adet cihaz görünürken fiziksel olarak ${actualCount} adet girdiniz! Farkın hangi seride olduğunu tespit etmek için lütfen raftaki cihazların serilerini okutunuz.`
      });
    }

    let missingSerials = [];
    let extraSerials = [];
    let matchedSerials = [];

    if (scanned_serials !== null) {
      const expectedMap = new Map(shelfDevices.map(d => [d.serial_no.toUpperCase(), d]));
      const scannedSet = new Set(scanned_serials.map(s => (s || '').trim().toUpperCase()).filter(Boolean));

      // 1. Missing: In system on this shelf, but not physically scanned
      for (const [sn, dev] of expectedMap.entries()) {
        if (scannedSet.has(sn)) {
          matchedSerials.push({ serial_no: sn, model_name: dev.model_name });
        } else {
          missingSerials.push({ serial_no: sn, model_name: dev.model_name, logical_shelf: dev.logical_shelf });
        }
      }

      // 2. Extra: Physically scanned on this shelf, but in system it is either on ANOTHER shelf, with a technician, or unknown!
      for (const sn of scannedSet) {
        if (!expectedMap.has(sn)) {
          const otherDev = db.prepare(`
            SELECT d.*, p.full_name as tech_name
            FROM devices d
            LEFT JOIN personnel p ON d.assigned_personnel_id = p.id
            WHERE d.serial_no = ?
          `).get(sn);

          let systemLocation = 'Sistemde Kayıtsız Seri';
          if (otherDev) {
            if (otherDev.location_status === 'DEPODA') {
              systemLocation = `Sistemde '${otherDev.physical_shelf_code || 'Başka'}' Rafında Kayıtlı (${otherDev.logical_shelf})`;
            } else if (otherDev.location_status === 'TEKNİSYENDE') {
              systemLocation = `Sistemde '${otherDev.tech_name || 'Teknisyen'}' Zimmetinde Görünüyor`;
            } else {
              systemLocation = `Sistemde '${otherDev.location_status}' Statüsünde`;
            }
          }
          extraSerials.push({
            serial_no: sn,
            model_name: otherDev ? otherDev.model_name : 'Bilinmeyen Model',
            system_location: systemLocation
          });
        }
      }
    }

    const hasDiscrepancy = (actualCount !== expectedCount) || (missingSerials.length > 0) || (extraSerials.length > 0);
    const status = hasDiscrepancy ? 'FARK_VAR' : 'TAM';
    const now = new Date().toISOString();

    const missingText = missingSerials.map(m => `${m.serial_no} (${m.model_name})`).join(', ');
    const extraText = extraSerials.map(e => `${e.serial_no} [${e.system_location}]`).join(', ');

    const scannedText = scanned_serials !== null ? scanned_serials.join(', ') : shelfDevices.map(d => d.serial_no).join(', ');

    db.prepare(`UPDATE physical_shelves SET last_counted_at = ?, last_counted_qty = ? WHERE code = ?`).run(now, actualCount, shelf_code);
    db.prepare(`
      INSERT INTO count_logs (count_type, target_ref, target_name, expected_count, scanned_count, scanned_serials, missing_serials, extra_serials, status, created_at)
      VALUES ('AYLIK_DEPO_RAF', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(shelf_code, `${shelf_code} (${shelf.target_logical_shelf})`, expectedCount, actualCount, scannedText, missingText, extraText, status, now);

    // Depo sayım sonucu (TAM veya FARK_VAR) direkt olarak Hasan İlker Kadıoğlu (TO) ve CC listesine detaylı Excel ekiyle gider!
    sendWarehouseShelfCountReportEmail({
      shelf,
      expectedCount,
      actualCount,
      status,
      shelfDevices,
      matchedSerials,
      missingSerials,
      extraSerials
    });

    return sendJson(res, 200, {
      ok: true,
      require_serial_scan: false,
      shelf_code,
      expectedCount,
      actualCount,
      status,
      matchedSerials,
      missingSerials,
      extraSerials
    });
  }

  // GET /api/settings/gateway (YÖNETİCİ ONLY)
  if (pathname === '/api/settings/gateway' && method === 'GET') {
    const rows = db.prepare(`SELECT key, value FROM gateway_settings`).all();
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    if (!map.sla_report_to) map.sla_report_to = DEFAULT_SLA_REPORT_TO;
    if (!map.sla_report_cc) map.sla_report_cc = DEFAULT_SLA_REPORT_CC;
    return sendJson(res, 200, { ok: true, settings: map });
  }

  // POST /api/settings/gateway (YÖNETİCİ ONLY)
  if (pathname === '/api/settings/gateway' && method === 'POST') {
    const body = await readBody(req);
    if (body.user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Sistem ayarları yalnızca Yönetici tarafından değiştirilebilir.' });
    }
    const upsert = db.prepare(`
      INSERT INTO gateway_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const keys = ['whatsapp_webhook_url', 'whatsapp_api_key', 'email_webhook_url', 'company_title', 'sla_report_to', 'sla_report_cc'];
    for (const k of keys) {
      if (typeof body[k] === 'string') {
        upsert.run(k, body[k].trim());
      }
    }
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/reports/send-sla-dashboard-email (YÖNETİCİ ONLY - Sends Executive HTML Dashboard + 4-Sheet Excel)
  if (pathname === '/api/reports/send-sla-dashboard-email' && method === 'POST') {
    const body = await readBody(req);
    if (body.user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Kritik SLA raporu yalnızca Yönetici tarafından gönderilebilir.' });
    }
    if (typeof body.sla_report_to === 'string' && body.sla_report_to.trim()) {
      setSettingValue('sla_report_to', body.sla_report_to.trim());
    }
    if (typeof body.sla_report_cc === 'string') {
      setSettingValue('sla_report_cc', body.sla_report_cc.trim());
    }
    const result = await sendSlaExecutiveDashboardReport(true);
    return sendJson(res, 200, result);
  }

  // GET /api/reports/sla-dashboard-xlsx -> Direct download of the 4-Sheet SLA Excel report
  if (pathname === '/api/reports/sla-dashboard-xlsx' && method === 'GET') {
    const report = buildSlaExecutiveReport();
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${report.filename}"`,
      'Cache-Control': 'no-store'
    });
    res.end(report.xlsxBuffer);
    return;
  }

  // POST /api/settings/test-notification (YÖNETİCİ ONLY)
  if (pathname === '/api/settings/test-notification' && method === 'POST') {
    const body = await readBody(req);
    const { test_phone, test_email } = body;
    await dispatchAutoNotification({
      recipient_name: 'Karadeniz EÇM Sistem Test Alıcısı',
      recipient_phone: test_phone || '905326667788',
      recipient_email: test_email || 'yonetim@karadenzecm.com',
      category: 'SİSTEM_BAĞLANTI_TESTİ',
      title: 'Karadeniz EÇM Otomatik Bildirim Bağlantı Testi',
      message: `[KARADENİZ EÇM] Otomatik WhatsApp ve E-Posta bildirim servisi başarıyla yapılandırılmıştır. Tarih/Saat: ${new Date().toLocaleString('tr-TR')}.`
    });
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/system/reset-sample-data (YÖNETİCİ ONLY - Clears sample devices/logs to start real production!)
  if (pathname === '/api/system/reset-sample-data' && method === 'POST') {
    const body = await readBody(req);
    if (body.user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Veri sıfırlama işlemi yalnızca Yönetici tarafından yapılabilir.' });
    }
    db.exec(`
      DELETE FROM devices;
      DELETE FROM dispatch_history;
      DELETE FROM shipment_items;
      DELETE FROM shipment_batches;
      DELETE FROM return_pool;
      DELETE FROM transfer_pool;
      DELETE FROM count_logs;
      DELETE FROM notifications_log;
      UPDATE physical_shelves SET last_counted_at = NULL, last_counted_qty = NULL;
    `);
    if (body.also_reset_sample_personnel) {
      db.exec(`DELETE FROM personnel WHERE role != 'YÖNETİCİ';`);
    }
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/system/backup-json -> Full portable database dump
  if (pathname === '/api/system/backup-json' && method === 'GET') {
    return sendJson(res, 200, getFullBackupObject());
  }

  // POST /api/system/restore-json -> Restore full database from portable JSON backup (YÖNETİCİ ONLY)
  if (pathname === '/api/system/restore-json' && method === 'POST') {
    const body = await readBody(req);
    if (body.user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: Yedek geri yükleme işlemi yalnızca Yönetici tarafından yapılabilir.' });
    }
    const ok = applyFullBackupObject(body.backup);
    if (!ok) {
      return sendJson(res, 400, { error: 'Geçersiz yedek dosyası formatı.' });
    }
    scheduleCloudDatabaseSync();
    return sendJson(res, 200, { ok: true });
  }

  // ==================== WHATSAPP QR ENGINE ENDPOINTS (YÖNETİCİ ONLY) ====================
  if (pathname === '/api/whatsapp/status' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...getWhatsAppStatus() });
  }

  if (pathname === '/api/whatsapp/connect' && method === 'POST') {
    const body = await readBody(req);
    if (body.user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası: WhatsApp bağlantısı yalnızca Yönetici tarafından başlatılabilir.' });
    }
    const status = await initWhatsAppConnection(!!body.force_fresh);
    return sendJson(res, 200, { ok: true, ...status });
  }

  if (pathname === '/api/whatsapp/logout' && method === 'POST') {
    const body = await readBody(req);
    if (body.user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası.' });
    }
    const status = await logoutWhatsApp();
    return sendJson(res, 200, { ok: true, ...status });
  }

  if (pathname === '/api/whatsapp/test' && method === 'POST') {
    const body = await readBody(req);
    if (body.user_role !== 'YÖNETİCİ') {
      return sendJson(res, 403, { error: 'Yetki Hatası.' });
    }
    if (waState !== 'CONNECTED') {
      return sendJson(res, 400, { error: 'WhatsApp henüz bağlı değil. Önce QR kodu okutunuz.' });
    }
    const phone = normalizeTrPhone(body.phone);
    if (!phone) {
      return sendJson(res, 400, { error: 'Geçerli bir telefon numarası giriniz (Örn: 5301234567 veya 905301234567).' });
    }
    const trDateTime = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    enqueueWhatsAppMessage(
      phone,
      'WhatsApp Bağlantı Testi',
      `KARADENİZ EÇM Depo ve Zimmet Yönetim Sistemi WhatsApp bildirimi başarıyla bağlandı.\nTarih/Saat: ${trDateTime}`
    );
    return sendJson(res, 200, { ok: true, phone });
  }

  return sendJson(res, 404, { error: 'API uç noktası bulunamadı' });
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (urlObj.pathname.startsWith('/api/')) {
      await handleApi(req, res, urlObj);
      if (req.method === 'POST' && urlObj.pathname !== '/api/auth/login') {
        scheduleCloudDatabaseSync();
      }
      return;
    }

    const reqPath = urlObj.pathname === '/' ? 'index.html' : urlObj.pathname.replace(/^\/+/, '');
    let filePath = path.join(PUBLIC_DIR, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      const rootCandidate = path.join(__dirname, path.basename(reqPath));
      if (fs.existsSync(rootCandidate) && !fs.statSync(rootCandidate).isDirectory() && ['.html', '.js', '.css', '.png', '.svg'].includes(path.extname(rootCandidate))) {
        filePath = rootCandidate;
      } else {
        filePath = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))
          ? path.join(PUBLIC_DIR, 'index.html')
          : path.join(__dirname, 'index.html');
      }
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || 'Sunucu hatası' });
  }
});

server.listen(PORT, async () => {
  console.log(`KARADENIZ ECM Depo ve Zimmet Yonetim Sistemi calisiyor: http://localhost:${PORT}`);
  await restoreDatabaseFromCloudOnBoot();
  // Auto-reconnect WhatsApp if saved session exists (from local disk or restored from Google Drive!)
  if (fs.existsSync(path.join(WA_AUTH_DIR, 'creds.json'))) {
    initWhatsAppConnection(false).catch(err => console.error('WhatsApp auto-connect error:', err.message));
  }
});
