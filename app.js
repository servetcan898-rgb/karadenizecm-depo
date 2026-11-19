let CURRENT_USER = null;

let APP_STATE = {
  role: 'YÖNETİCİ',
  currentUser: null,
  devices: [],
  slaAlerts: [],
  shelfMismatches: [],
  fifoRecommendations: [],
  shelves: [],
  personnel: [],
  returnPool: [],
  shipments: [],
  dispatchHistory: [],
  notifications: [],
  countLogs: []
};

let DISPATCH_BASKET = {};
let KARSILAMA_STAGED = [];
let TECH_RETURN_STAGED = [];
let TECH_COUNT_STAGED = [];
let TECH_TRANSFER_STAGED = [];

let MISMATCH_SLIDE_INDEX = 0;
let ACTIVE_MODAL_SHELF_CODE = null;

let qrScannerInstance = null;
let qrContinuousCount = 0;
let lastQrText = '';
let lastQrTime = 0;
const scannerTimers = new WeakMap();

// ==================== LIVE CLOCK & DATE (EVERY PAGE, FIXED POSITION) ====================
function updateLiveClock() {
  const now = new Date();
  const timeEl = document.getElementById('live-clock-time');
  const dateEl = document.getElementById('live-clock-date');
  if (timeEl) {
    timeEl.textContent = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric', weekday: 'short' });
  }
}
setInterval(updateLiveClock, 1000);

// ==================== DAY / NIGHT THEME ENGINE ====================
function applyTheme(mode) {
  const html = document.documentElement;
  if (mode === 'light') {
    html.classList.remove('dark');
    html.classList.add('light');
  } else {
    html.classList.remove('light');
    html.classList.add('dark');
  }
  localStorage.setItem('krdnz_theme', mode);

  document.querySelectorAll('.theme-icon').forEach(el => {
    el.textContent = mode === 'light' ? '🌙' : '☀️';
  });
  const lbl = document.getElementById('theme-label');
  if (lbl) lbl.textContent = mode === 'light' ? 'Gece Modu' : 'Gündüz Modu';
}

function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light');
  applyTheme(isLight ? 'dark' : 'light');
}

// ==================== NON-BLOCKING TOAST & AUDIO ====================
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const colors = {
    success: 'bg-emerald-600 text-white border-emerald-500',
    warning: 'bg-amber-500 text-slate-950 border-amber-400',
    error: 'bg-red-600 text-white border-red-500',
    info: 'bg-sky-600 text-white border-sky-500'
  };

  const el = document.createElement('div');
  el.className = `px-4 py-2.5 rounded-xl border shadow-lg text-xs font-semibold transition-all duration-300 pointer-events-auto ${colors[type] || colors.info}`;
  el.innerHTML = message;
  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

function playBeep(freq = 920, duration = 70) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.07;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, duration);
  } catch (_) {}
}

// Helper: Format device list for Excel export
function formatDevicesForExcel(deviceList) {
  return deviceList.map(d => ({
    'Seri No': d.serial_no,
    'Başlık': d.category,
    'Cihaz Modeli': d.model_name,
    'Turkcell Rafı (Mantıksal)': d.logical_shelf,
    'Fiziksel Raf': d.physical_shelf_code || '-',
    'Konum Durumu': d.location_status,
    'Zimmetli Personel': d.personnel_name || '-',
    'Ekip': d.team_name || '-',
    'Rafa Giriş Tarihi': d.sla_entry_date,
    'Stokta Geçen Gün': d.days_elapsed,
    'Maksimum SLA (Gün)': d.sla_max_days,
    'Kalan SLA (Gün)': d.days_remaining,
    'SLA Seviyesi': d.sla_level,
    'Açıklama': d.notes || ''
  }));
}

function downloadExcelSheet(rows, sheetName, fileNamePrefix) {
  if (!rows || !rows.length) {
    return showToast('Dışa aktarılacak kayıt bulunamadı.', 'warning');
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const dateStr = new Date().toISOString().split('T')[0];
  XLSX.writeFile(wb, `${fileNamePrefix}_${dateStr}.xlsx`);
  showToast(`${rows.length} kayıt Excel olarak indirildi.`, 'success');
}

// Hands-Free Continuous Barcode/QR Input Handler
function handleAutoScannerInput(inputEl, callback) {
  if (scannerTimers.has(inputEl)) {
    clearTimeout(scannerTimers.get(inputEl));
  }
  const val = (inputEl.value || '').trim();
  if (val.length < 4) return;

  if (val.includes('\n') || val.includes('\r')) {
    const parts = val.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
    inputEl.value = '';
    parts.forEach(sn => callback(sn));
    return;
  }

  const timer = setTimeout(() => {
    const currentVal = (inputEl.value || '').trim();
    if (currentVal.length >= 5) {
      inputEl.value = '';
      callback(currentVal);
    }
  }, 280);
  scannerTimers.set(inputEl, timer);
}

async function apiGet(url) {
  const res = await fetch(url);
  return await res.json();
}

async function apiPost(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'İşlem başarısız');
  return json;
}

// ==================== AUTH & STRICT RBAC ====================
async function quickLogin(username, password) {
  document.getElementById('login-username').value = username;
  document.getElementById('login-password').value = password;
  await submitLogin();
}

async function submitLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errBox = document.getElementById('login-error');
  errBox.classList.add('hidden');

  try {
    const res = await apiPost('/api/auth/login', { username, password });
    CURRENT_USER = res.user;
    localStorage.setItem('krdnz_user', JSON.stringify(CURRENT_USER));
    document.getElementById('login-screen').classList.add('hidden');
    await loadDashboardData();
    applyRoleViewPermissions();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
}

function logoutUser() {
  CURRENT_USER = null;
  localStorage.removeItem('krdnz_user');
  document.getElementById('login-screen').classList.remove('hidden');
}

function applyRoleViewPermissions() {
  if (!CURRENT_USER) return;

  const roleStyles = {
    'YÖNETİCİ': 'bg-yellow-400 text-slate-950',
    'DEPOCU': 'bg-sky-500 text-white',
    'KARŞILAMA': 'bg-emerald-500 text-white',
    'TEKNİSYEN': 'bg-amber-500 text-slate-950'
  };

  document.getElementById('user-badge').innerHTML = `
    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${roleStyles[CURRENT_USER.role] || ''}">${CURRENT_USER.role}</span>
    <span class="font-semibold text-main">${CURRENT_USER.full_name}</span>
    <span class="text-mute text-[11px] hidden md:inline">(${CURRENT_USER.team_name})</span>
  `;

  const mainNav = document.getElementById('main-nav-wrap');
  const btnExportAll = document.getElementById('btn-export-all');
  const tabPersonnel = document.getElementById('tab-personnel');

  const allViews = [
    'view-role-tech',
    'view-role-karsilama',
    'view-dashboard',
    'view-turkcell-sync',
    'view-shipments',
    'view-dispatch',
    'view-returns',
    'view-counts',
    'view-personnel',
    'view-notifications'
  ];
  allViews.forEach(id => document.getElementById(id)?.classList.add('hidden'));

  if (CURRENT_USER.role === 'TEKNİSYEN') {
    mainNav.classList.add('hidden');
    btnExportAll.classList.add('hidden');
    document.getElementById('view-role-tech').classList.remove('hidden');
    renderTechRoleDedicatedView();
    return;
  }

  if (CURRENT_USER.role === 'KARŞILAMA') {
    mainNav.classList.add('hidden');
    btnExportAll.classList.add('hidden');
    document.getElementById('view-role-karsilama').classList.remove('hidden');
    renderKarsilamaRoleDedicatedView();
    setTimeout(() => document.getElementById('karsilama-laser-input')?.focus(), 120);
    return;
  }

  mainNav.classList.remove('hidden');
  btnExportAll.classList.remove('hidden');

  if (CURRENT_USER.role === 'YÖNETİCİ') {
    tabPersonnel.classList.remove('hidden');
  } else {
    tabPersonnel.classList.add('hidden');
  }

  switchTab('dashboard');
}

async function loadDashboardData() {
  if (!CURRENT_USER) return;
  try {
    APP_STATE = await apiGet(`/api/dashboard?user_id=${CURRENT_USER.id}`);
    renderAll();
  } catch (err) {
    console.error('Veri yükleme hatası:', err);
  }
}

function switchTab(tabName) {
  if (CURRENT_USER && (CURRENT_USER.role === 'TEKNİSYEN' || CURRENT_USER.role === 'KARŞILAMA')) {
    return applyRoleViewPermissions();
  }
  if (tabName === 'personnel' && CURRENT_USER?.role !== 'YÖNETİCİ') {
    showToast('Bu bölüme yalnızca Yönetici rolü erişebilir.', 'warning');
    return;
  }

  const tabs = ['dashboard', 'turkcell-sync', 'shipments', 'dispatch', 'returns', 'counts', 'personnel', 'notifications'];
  for (const t of tabs) {
    const view = document.getElementById(`view-${t}`);
    const btn = document.getElementById(`tab-${t}`);
    if (view) view.classList.toggle('hidden', t !== tabName);
    if (btn) btn.classList.toggle('active', t === tabName);
  }

  if (tabName === 'dispatch') {
    setTimeout(() => focusDispatchBarcodeInput(), 100);
  } else if (tabName === 'returns') {
    setTimeout(() => document.getElementById('depocu-return-verify-input')?.focus(), 100);
  }
}

function focusDispatchBarcodeInput() {
  document.getElementById('dispatch-serial-input')?.focus();
}

function renderAll() {
  const badge = document.getElementById('notif-badge');
  if (badge) badge.textContent = (APP_STATE.notifications || []).length;

  if (CURRENT_USER?.role === 'TEKNİSYEN') return renderTechRoleDedicatedView();
  if (CURRENT_USER?.role === 'KARŞILAMA') return renderKarsilamaRoleDedicatedView();

  renderMismatchBanner();
  renderKpiGrid();
  renderSlaAlerts();
  renderShelvesSummary();
  renderDevicesTable();
  renderShipments();
  renderDispatchView();
  renderDispatchHistoryTable();
  renderReturnsView();
  renderCountsView();
  if (CURRENT_USER?.role === 'YÖNETİCİ') {
    renderPersonnelAndShelvesConfig();
  }
  renderNotifications();
}

// ==================== DEDICATED ROLE VIEW A: SAHA TEKNİSYENİ ====================
function renderTechRoleDedicatedView() {
  document.getElementById('tech-welcome-title').textContent = `${CURRENT_USER.full_name} (${CURRENT_USER.team_name})`;

  const myDevices = APP_STATE.devices || [];
  const listEl = document.getElementById('tech-my-devices-list');
  if (!myDevices.length) {
    listEl.innerHTML = `<div class="p-4 rounded-xl subcard text-xs text-mute">Üzerinizde zimmetli cihaz bulunmamaktadır.</div>`;
  } else {
    listEl.innerHTML = myDevices.map(d => `
      <div class="subcard p-3.5 ${d.days_remaining <= 10 ? 'border-red-500/50' : ''} flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <div class="flex items-center gap-2">
            <span class="font-mono font-bold text-main">${d.serial_no}</span>
            <span class="px-2 py-0.5 rounded text-[10px] ${d.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${d.category}</span>
            <span class="text-mute">${d.logical_shelf}</span>
          </div>
          <div class="text-sub text-[11px] mt-1">${d.model_name}</div>
        </div>
        <div class="flex items-center gap-2">
          <div class="px-2.5 py-1 rounded-lg ${d.days_remaining <= 10 ? 'bg-red-500/15 text-red-500 border border-red-500/30' : 'bg-emerald-500/15 text-emerald-500'} font-bold">
            SLA: ${d.days_remaining} Gün
          </div>
          <button onclick="addTechTransferStaged('${d.serial_no}')" class="px-2.5 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 text-sky-500 border border-sky-500/30 font-bold transition" title="Bu cihazı başka teknisyene veya depoya transfer listesine ekle">
            ⇄ Transfer
          </button>
        </div>
      </div>
    `).join('');
  }

  // Populate peer technicians for transfer target
  const peerSel = document.getElementById('tech-transfer-target-person');
  if (peerSel) {
    const curVal = peerSel.value;
    const peers = APP_STATE.peerTechnicians || [];
    peerSel.innerHTML = peers.map(p => `<option value="${p.id}">${p.full_name} (${p.team_name})</option>`).join('');
    if (curVal) peerSel.value = curVal;
  }

  toggleTechTransferTargetSelect();
  renderTechStagedTransfers();
  renderTechStagedReturns();
  renderTechStagedCounts();

  const myTransfers = APP_STATE.transferPool || [];
  const trEl = document.getElementById('tech-my-transfers-list');
  if (trEl) {
    trEl.innerHTML = myTransfers.length === 0
      ? `<div class="text-mute text-xs">Henüz transfer talebiniz bulunmuyor.</div>`
      : myTransfers.map(t => {
        const badgeCls = t.status === 'ONAYLANDI' ? 'bg-emerald-500/15 text-emerald-500' : (t.status === 'REDDEDİLDİ' ? 'bg-red-500/15 text-red-500' : 'bg-amber-500/15 text-amber-500');
        const dirText = t.transfer_type === 'TEKNİSYENDEN_TEKNİSYENE'
          ? `${t.from_personnel_name} ➔ ${t.to_personnel_name} (Saha Transferi)`
          : `${t.from_personnel_name} ➔ Merkez Depo (Kullanılmayan Cihaz İadesi)`;
        return `
          <div class="p-2.5 rounded-lg subcard flex flex-wrap items-center justify-between gap-2 text-xs">
            <div>
              <span class="font-mono font-bold text-main">${t.serial_no}</span>
              <span class="text-sub ml-2">${dirText}</span>
              <div class="text-[11px] text-mute mt-0.5">${t.note || '-'} • ${new Date(t.created_at).toLocaleString('tr-TR')}</div>
            </div>
            <span class="px-2.5 py-0.5 rounded text-[10px] font-bold ${badgeCls}">${t.status}</span>
          </div>
        `;
      }).join('');
  }

  const myRets = APP_STATE.returnPool || [];
  const retEl = document.getElementById('tech-my-returns-list');
  retEl.innerHTML = myRets.length === 0
    ? `<div class="text-mute text-xs">Henüz iade cihaz gönderilmedi.</div>`
    : myRets.map(r => `
      <div class="p-2.5 rounded-lg subcard flex items-center justify-between text-xs">
        <span class="font-mono font-semibold text-main">${r.serial_no}</span>
        <span class="text-mute">${r.customer_note || '-'}</span>
        <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${r.status === 'DEPOCU_ONAYLADI' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}">${r.status}</span>
      </div>
    `).join('');
}

function toggleTechTransferTargetSelect() {
  const typeVal = document.getElementById('tech-transfer-type')?.value;
  const wrap = document.getElementById('tech-transfer-target-wrap');
  const noteInput = document.getElementById('tech-transfer-note');
  if (!wrap) return;
  if (typeVal === 'TEKNİSYENDEN_DEPOYA') {
    wrap.classList.add('opacity-40', 'pointer-events-none');
    if (noteInput && (!noteInput.value || noteInput.value.includes('Sahada'))) {
      noteInput.value = 'Kullanılmadı - Sağlam olarak Merkez Depoya iade';
    }
  } else {
    wrap.classList.remove('opacity-40', 'pointer-events-none');
    if (noteInput && (!noteInput.value || noteInput.value.includes('Merkez Depoya'))) {
      noteInput.value = 'Sahada yakın teknisyene elden teslim';
    }
  }
}

function addTechTransferStaged(rawSn) {
  const sn = (rawSn || '').trim().toUpperCase();
  if (!sn) return;
  const myDevices = APP_STATE.devices || [];
  if (!myDevices.some(d => d.serial_no.toUpperCase() === sn)) {
    playBeep(280, 200);
    return showToast(`${sn} seri numaralı cihaz sizin zimmetinizde görünmüyor!`, 'error');
  }
  if (!TECH_TRANSFER_STAGED.includes(sn)) {
    TECH_TRANSFER_STAGED.push(sn);
    playBeep(960, 70);
    showToast(`${sn} transfer listesine eklendi (${TECH_TRANSFER_STAGED.length}. cihaz)`, 'info');
    renderTechStagedTransfers();
  }
}

function removeTechTransferStaged(sn) {
  TECH_TRANSFER_STAGED = TECH_TRANSFER_STAGED.filter(x => x !== sn);
  renderTechStagedTransfers();
}

function renderTechStagedTransfers() {
  const countEl = document.getElementById('tech-staged-transfer-count');
  const listEl = document.getElementById('tech-staged-transfer-list');
  if (!countEl || !listEl) return;
  countEl.textContent = TECH_TRANSFER_STAGED.length;
  listEl.innerHTML = TECH_TRANSFER_STAGED.length === 0
    ? `<span class="text-[11px] text-mute">Üzerinizdeki cihazlardan '⇄ Transfer' butonuna basın veya kamerayla QR okutun.</span>`
    : TECH_TRANSFER_STAGED.map(sn => `
      <span class="px-2.5 py-1 rounded-lg card font-mono text-xs text-main flex items-center gap-1.5">
        <span>${sn}</span>
        <button onclick="removeTechTransferStaged('${sn}')" class="text-mute hover:text-red-500 font-bold">&times;</button>
      </span>
    `).join('');
}

async function commitTechStagedTransfers() {
  if (!TECH_TRANSFER_STAGED.length) return showToast('Önce transfer edilecek cihazları seçin veya okutun.', 'warning');
  const transfer_type = document.getElementById('tech-transfer-type').value;
  const to_personnel_id = transfer_type === 'TEKNİSYENDEN_TEKNİSYENE'
    ? Number(document.getElementById('tech-transfer-target-person').value)
    : null;
  const note = document.getElementById('tech-transfer-note').value.trim();

  try {
    await apiPost('/api/transfers/create', {
      from_personnel_id: CURRENT_USER.id,
      transfer_type,
      to_personnel_id,
      serial_numbers: TECH_TRANSFER_STAGED,
      note
    });
    showToast(`${TECH_TRANSFER_STAGED.length} adet cihaz transfer onay havuzuna gönderildi (Depocu/Yönetici onayı bekleniyor).`, 'success');
    TECH_TRANSFER_STAGED = [];
    renderTechStagedTransfers();
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function addTechReturnStaged(rawSn) {
  const sn = (rawSn || '').trim().toUpperCase();
  if (!sn) return;
  if (!TECH_RETURN_STAGED.includes(sn)) {
    TECH_RETURN_STAGED.push(sn);
    playBeep(960, 70);
    showToast(`${sn} listeye eklendi (${TECH_RETURN_STAGED.length}. cihaz)`, 'info');
    renderTechStagedReturns();
  }
}

function removeTechReturnStaged(sn) {
  TECH_RETURN_STAGED = TECH_RETURN_STAGED.filter(x => x !== sn);
  renderTechStagedReturns();
}

function renderTechStagedReturns() {
  const countEl = document.getElementById('tech-staged-ret-count');
  const listEl = document.getElementById('tech-staged-ret-list');
  if (!countEl || !listEl) return;
  countEl.textContent = TECH_RETURN_STAGED.length;
  listEl.innerHTML = TECH_RETURN_STAGED.length === 0
    ? `<span class="text-[11px] text-mute">Cihazları peş peşe okutun; burada birikecektir.</span>`
    : TECH_RETURN_STAGED.map(sn => `
      <span class="px-2.5 py-1 rounded-lg card font-mono text-xs text-main flex items-center gap-1.5">
        <span>${sn}</span>
        <button onclick="removeTechReturnStaged('${sn}')" class="text-mute hover:text-red-500 font-bold">&times;</button>
      </span>
    `).join('');
}

async function commitTechStagedReturns() {
  if (!TECH_RETURN_STAGED.length) return showToast('Önce iade cihazları okutunuz.', 'warning');
  const note = document.getElementById('tech-only-ret-note')?.value.trim() || 'Saha Cihaz Değişimi';
  try {
    const items = TECH_RETURN_STAGED.map(serial_no => ({ serial_no, customer_note: note }));
    await apiPost('/api/returns/add', {
      source_type: 'TEKNİSYEN',
      reported_by_personnel_id: CURRENT_USER.id,
      items
    });
    showToast(`${TECH_RETURN_STAGED.length} adet iade cihaz havuza gönderildi.`, 'success');
    TECH_RETURN_STAGED = [];
    renderTechStagedReturns();
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function addTechOnlyCountStaged(rawSn) {
  const sn = (rawSn || '').trim().toUpperCase();
  if (!sn) return;
  if (!TECH_COUNT_STAGED.includes(sn)) {
    TECH_COUNT_STAGED.push(sn);
    playBeep(980, 70);
    showToast(`${sn} sayım listesine eklendi (${TECH_COUNT_STAGED.length}. cihaz)`, 'info');
    renderTechStagedCounts();
  }
}

function removeTechOnlyCountStaged(sn) {
  TECH_COUNT_STAGED = TECH_COUNT_STAGED.filter(x => x !== sn);
  renderTechStagedCounts();
}

function renderTechStagedCounts() {
  const numEl = document.getElementById('tech-staged-count-num');
  const listEl = document.getElementById('tech-staged-count-list');
  if (!numEl || !listEl) return;
  numEl.textContent = TECH_COUNT_STAGED.length;
  listEl.innerHTML = TECH_COUNT_STAGED.length === 0
    ? `<span class="text-[11px] text-mute">Araçtaki cihazları peş peşe okutun.</span>`
    : TECH_COUNT_STAGED.map(sn => `
      <span class="px-2.5 py-1 rounded-lg card font-mono text-xs text-main flex items-center gap-1.5">
        <span>${sn}</span>
        <button onclick="removeTechOnlyCountStaged('${sn}')" class="text-mute hover:text-red-500 font-bold">&times;</button>
      </span>
    `).join('');
}

async function submitTechOnlyVehicleCount() {
  try {
    const res = await apiPost('/api/counts/vehicle', { personnel_id: CURRENT_USER.id, scanned_serials: TECH_COUNT_STAGED });
    const fb = document.getElementById('tech-only-count-feedback');
    fb.classList.remove('hidden');
    if (res.missing.length === 0) {
      fb.className = 'p-3 rounded-xl text-xs bg-emerald-500/15 border border-emerald-500/30 text-emerald-500 font-semibold';
      fb.innerHTML = `✔ Araç sayımınız eksiksiz (${res.scanned_count}/${res.expected_count}) tamamlandı.`;
    } else {
      fb.className = 'p-3 rounded-xl text-xs bg-red-500/15 border border-red-500/30 text-red-500 font-semibold';
      fb.innerHTML = `⚠️ Okutulmayan eksik seriler: <strong>${res.missing.join(', ')}</strong>. Durum otomatik olarak raporlandı.`;
    }
    TECH_COUNT_STAGED = [];
    renderTechStagedCounts();
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==================== DEDICATED ROLE VIEW B: KARŞILAMA ====================
function renderKarsilamaRoleDedicatedView() {
  renderKarsilamaStagedList();
  const listEl = document.getElementById('karsilama-only-list');
  const rets = APP_STATE.returnPool || [];
  if (!rets.length) {
    listEl.innerHTML = `<div class="p-4 text-xs text-mute">Henüz iade cihaz kaydı bulunmuyor.</div>`;
    return;
  }
  listEl.innerHTML = rets.map(r => `
    <div class="subcard p-3 flex items-center justify-between text-xs">
      <div>
        <span class="font-mono font-bold text-main">${r.serial_no}</span>
        <div class="text-mute text-[11px] mt-0.5">${r.customer_note || '-'} • ${new Date(r.created_at).toLocaleString('tr-TR')}</div>
      </div>
      <span class="px-2.5 py-1 rounded-md text-[10px] font-semibold ${r.status === 'DEPOCU_ONAYLADI' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}">${r.status}</span>
    </div>
  `).join('');
}

function addKarsilamaStaged(rawSn) {
  const sn = (rawSn || '').trim().toUpperCase();
  if (!sn) return;
  if (!KARSILAMA_STAGED.includes(sn)) {
    KARSILAMA_STAGED.push(sn);
    playBeep(940, 65);
    renderKarsilamaStagedList();
  }
  document.getElementById('karsilama-laser-input')?.focus();
}

function removeKarsilamaStaged(sn) {
  KARSILAMA_STAGED = KARSILAMA_STAGED.filter(x => x !== sn);
  renderKarsilamaStagedList();
}

function clearKarsilamaStaged() {
  KARSILAMA_STAGED = [];
  renderKarsilamaStagedList();
}

function renderKarsilamaStagedList() {
  const countEl = document.getElementById('karsilama-staged-count');
  const listEl = document.getElementById('karsilama-staged-list');
  if (!countEl || !listEl) return;
  countEl.textContent = KARSILAMA_STAGED.length;
  listEl.innerHTML = KARSILAMA_STAGED.length === 0
    ? `<span class="text-[11px] text-mute">Okutucu ile cihazları peş peşe okutun; tamamı burada listelenir.</span>`
    : KARSILAMA_STAGED.map(sn => `
      <span class="px-2.5 py-1 rounded-lg card font-mono text-xs text-main flex items-center gap-1.5">
        <span>${sn}</span>
        <button onclick="removeKarsilamaStaged('${sn}')" class="text-mute hover:text-red-500 font-bold">&times;</button>
      </span>
    `).join('');
}

async function commitKarsilamaStaged() {
  if (!KARSILAMA_STAGED.length) return showToast('Önce iade cihazları okutunuz.', 'warning');
  const note = document.getElementById('karsilama-only-note')?.value.trim() || 'Karşılama Banko İade';
  try {
    const items = KARSILAMA_STAGED.map(serial_no => ({ serial_no, customer_note: note }));
    await apiPost('/api/returns/add', {
      source_type: 'KARŞILAMA',
      reported_by_personnel_id: CURRENT_USER.id,
      items
    });
    showToast(`${KARSILAMA_STAGED.length} adet cihaz iade havuzuna gönderildi.`, 'success');
    KARSILAMA_STAGED = [];
    renderKarsilamaStagedList();
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function handleKarsilamaOnlyExcel(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    rows.forEach(r => {
      const sn = String(r['Seri No'] || r['SeriNo'] || Object.values(r)[0] || '').trim();
      if (sn) addKarsilamaStaged(sn);
    });
    showToast('Excel içerisindeki seriler listeye eklendi; kontrol edip gönderebilirsiniz.', 'info');
  };
  reader.readAsArrayBuffer(file);
}

// ==================== TAB 1: DASHBOARD (SLIDER ALERTS, KPI EXPORTS, SHELF MODAL & FILTERED EXPORT) ====================

// 1. Horizontal Slider / Carousel for Red Shelf Mismatch Alerts
function renderMismatchBanner() {
  const banner = document.getElementById('mismatch-banner');
  const list = APP_STATE.shelfMismatches || [];
  if (list.length === 0) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }

  if (MISMATCH_SLIDE_INDEX >= list.length) MISMATCH_SLIDE_INDEX = 0;
  if (MISMATCH_SLIDE_INDEX < 0) MISMATCH_SLIDE_INDEX = list.length - 1;

  const d = list[MISMATCH_SLIDE_INDEX];

  banner.classList.remove('hidden');
  banner.innerHTML = `
    <div class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 text-red-500 font-bold text-xs">
          <span>Raf Statü Değişikliği Uyarısı</span>
          <span class="px-2 py-0.5 rounded bg-red-500 text-white text-[11px] font-mono">${MISMATCH_SLIDE_INDEX + 1} / ${list.length}</span>
        </div>

        <div class="flex items-center gap-1.5">
          <button onclick="exportMismatchesToExcel()" class="export-icon-btn px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1" title="Excel'e Aktar">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"/></svg>
            <span>Excel</span>
          </button>
          <button onclick="prevMismatchSlide()" class="px-2.5 py-1 rounded-md card hover:border-red-500/50 text-main font-bold text-xs transition" title="Önceki">
            &#8592;
          </button>
          <button onclick="nextMismatchSlide()" class="px-2.5 py-1 rounded-md card hover:border-red-500/50 text-main font-bold text-xs transition" title="Sonraki">
            &#8594;
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 subcard p-3.5 text-xs border-red-500/30">
        <div class="space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono font-extrabold text-sm text-main">${d.serial_no}</span>
            <span class="px-2 py-0.5 rounded text-[10px] ${d.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${d.category}</span>
            <span class="text-sub font-medium">${d.model_name}</span>
          </div>
          <div class="text-mute">
            Önceki Raf: <strong class="text-sub">${d.previous_logical_shelf || '-'}</strong> &rarr;
            Yeni Raf: <strong class="text-red-500">${d.logical_shelf}</strong>
            <span class="mx-1.5">•</span>
            Mevcut Fiziksel Raf: <strong class="text-amber-500 font-mono">${d.physical_shelf_code || '-'}</strong> &rarr;
            Hedef Fiziksel Raf: <strong class="text-emerald-500 font-mono">${d.recommended_new_physical_shelf || 'SOL04'}</strong>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="resolveShelfMismatch('${d.serial_no}', '${d.recommended_new_physical_shelf || ''}')" class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow transition">
            Fiziksel Rafı Güncelle (${d.recommended_new_physical_shelf || 'Yeni Raf'})
          </button>
        </div>
      </div>
    </div>
  `;
}

function prevMismatchSlide() {
  MISMATCH_SLIDE_INDEX--;
  renderMismatchBanner();
}

function nextMismatchSlide() {
  MISMATCH_SLIDE_INDEX++;
  renderMismatchBanner();
}

function exportMismatchesToExcel() {
  const rows = (APP_STATE.shelfMismatches || []).map(d => ({
    'Seri No': d.serial_no,
    'Başlık': d.category,
    'Model': d.model_name,
    'Önceki Turkcell Rafı': d.previous_logical_shelf || '-',
    'Yeni Turkcell Rafı': d.logical_shelf,
    'Mevcut Fiziksel Raf': d.physical_shelf_code || '-',
    'Taşınması Gereken Fiziksel Raf': d.recommended_new_physical_shelf || 'SOL04',
    'Kalan SLA Günü': d.days_remaining
  }));
  downloadExcelSheet(rows, 'Raf_Uyumsuzluk_Uyarilari', 'KaradenizECM_Raf_Degisiklik_Uyarilari');
}

async function resolveShelfMismatch(serialNo, newShelf) {
  try {
    await apiPost('/api/shelves/resolve-mismatch', { serial_no: serialNo, new_physical_shelf: newShelf });
    showToast(`${serialNo} fiziksel rafı güncellendi.`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 2. KPI Cards with Individual Excel Export Icons
function renderKpiGrid() {
  const active = APP_STATE.devices.filter(d => d.location_status === 'DEPODA' || d.location_status === 'TEKNİSYENDE');
  const inWarehouse = APP_STATE.devices.filter(d => d.location_status === 'DEPODA');
  const withTechs = APP_STATE.devices.filter(d => d.location_status === 'TEKNİSYENDE');
  const criticalSla = APP_STATE.slaAlerts.length;
  const pendingReturns = APP_STATE.returnPool.filter(r => r.status === 'HAVUZDA_BEKLİYOR').length;
  const installedCount = APP_STATE.devices.filter(d => d.location_status === 'MÜŞTERİYE_KURULDU').length;

  const cards = [
    { key: 'ACTIVE', label: 'Aktif Stok (SOL + SPX)', val: active.length, sub: `Depo: ${inWarehouse.length} • Saha: ${withTechs.length}`, color: 'text-main' },
    { key: 'WAREHOUSE', label: 'Fiziksel Raflarda', val: inWarehouse.length, sub: `${APP_STATE.shelves.length} Fiziksel Raf`, color: 'text-sky-500' },
    { key: 'TECHNICIAN', label: 'Teknisyen Zimmetinde', val: withTechs.length, sub: 'Sahada aktif', color: 'text-amber-500' },
    { key: 'SLA', label: 'Kritik SLA (≤15 Gün)', val: criticalSla, sub: 'Acil çıkış / iade', color: criticalSla > 0 ? 'text-red-500' : 'text-emerald-500' },
    { key: 'RETURNS', label: 'Bekleyen İade Havuzu', val: pendingReturns, sub: 'Karşılama + Saha', color: 'text-amber-500' },
    { key: 'INSTALLED', label: 'Müşteriye Kurulan', val: installedCount, sub: 'Rapordan otomatik düşen', color: 'text-emerald-500' }
  ];

  document.getElementById('kpi-grid').innerHTML = cards.map(c => `
    <div class="card p-3.5 flex flex-col justify-between relative group">
      <div class="flex items-start justify-between gap-1">
        <div class="text-[11px] text-mute font-medium leading-tight">${c.label}</div>
        <button onclick="exportKpiCardToExcel('${c.key}')" class="export-icon-btn w-6 h-6 shrink-0" title="${c.label} Listesini Excel'e Aktar">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"/>
          </svg>
        </button>
      </div>
      <div class="text-xl font-extrabold mt-1.5 ${c.color}">${c.val}</div>
      <div class="text-[10px] text-mute mt-0.5">${c.sub}</div>
    </div>
  `).join('');
}

function exportKpiCardToExcel(kpiKey) {
  if (kpiKey === 'ACTIVE') {
    const list = APP_STATE.devices.filter(d => d.location_status === 'DEPODA' || d.location_status === 'TEKNİSYENDE');
    return downloadExcelSheet(formatDevicesForExcel(list), 'Aktif_Stok', 'KaradenizECM_Aktif_Stok');
  }
  if (kpiKey === 'WAREHOUSE') {
    const list = APP_STATE.devices.filter(d => d.location_status === 'DEPODA');
    return downloadExcelSheet(formatDevicesForExcel(list), 'Fiziksel_Raflardaki_Stok', 'KaradenizECM_Depo_Raflardaki_Cihazlar');
  }
  if (kpiKey === 'TECHNICIAN') {
    const list = APP_STATE.devices.filter(d => d.location_status === 'TEKNİSYENDE');
    return downloadExcelSheet(formatDevicesForExcel(list), 'Teknisyen_Zimmetleri', 'KaradenizECM_Teknisyen_Zimmetindeki_Cihazlar');
  }
  if (kpiKey === 'SLA') {
    return exportSlaAlertsToExcel();
  }
  if (kpiKey === 'RETURNS') {
    const pending = APP_STATE.returnPool.filter(r => r.status === 'HAVUZDA_BEKLİYOR').map(r => ({
      'Seri No': r.serial_no,
      'Başlık': r.category,
      'Model': r.model_name,
      'Geldiği Birim': r.source_type,
      'Kaydeden Personel': r.reported_by_name || '-',
      'Açıklama': r.customer_note || '-',
      'Önerilen Fiziksel Raf': r.recommended_physical_shelf,
      'Durum': r.status,
      'Tarih': new Date(r.created_at).toLocaleString('tr-TR')
    }));
    return downloadExcelSheet(pending, 'Bekleyen_Iade_Havuzu', 'KaradenizECM_Bekleyen_Iade_Havuzu');
  }
  if (kpiKey === 'INSTALLED') {
    const list = APP_STATE.devices.filter(d => d.location_status === 'MÜŞTERİYE_KURULDU');
    return downloadExcelSheet(formatDevicesForExcel(list), 'Musteriye_Kurulanlar', 'KaradenizECM_Musteriye_Kurulan_Cihazlar');
  }
}

// 3. SLA Approaching Devices & Export
function renderSlaAlerts() {
  const box = document.getElementById('sla-alerts-list');
  if (!APP_STATE.slaAlerts.length) {
    box.innerHTML = `<div class="p-4 text-xs text-emerald-500">Kritik SLA seviyesinde cihaz bulunmamaktadır.</div>`;
    return;
  }

  box.innerHTML = APP_STATE.slaAlerts.map(d => {
    const loc = d.location_status === 'DEPODA'
      ? `<span class="px-2 py-0.5 rounded bg-sky-500/15 text-sky-500 font-semibold">Raf: ${d.physical_shelf_code}</span>`
      : `<span class="px-2 py-0.5 rounded bg-amber-500/15 text-amber-500 font-semibold">${d.personnel_name || 'Teknisyen'}</span>`;

    return `
      <div class="subcard p-3 flex items-center justify-between gap-2 text-xs">
        <div>
          <div class="flex items-center gap-2">
            <span class="font-mono font-bold text-main">${d.serial_no}</span>
            <span class="px-1.5 py-0.5 rounded text-[10px] ${d.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${d.category}</span>
            <span class="text-sub font-medium">${d.logical_shelf}</span>
            ${loc}
          </div>
          <div class="text-mute text-[11px] mt-1">
            ${d.model_name} • ${d.days_elapsed}/${d.sla_max_days} Gün
          </div>
        </div>
        <span class="px-2.5 py-1 rounded-lg ${d.days_remaining <= 10 ? 'bg-red-500/15 text-red-500 border border-red-500/30' : 'bg-amber-500/15 text-amber-500'} font-bold text-xs">
          ${d.days_remaining} Gün Kaldı
        </span>
      </div>
    `;
  }).join('');
}

function exportSlaAlertsToExcel() {
  downloadExcelSheet(
    formatDevicesForExcel(APP_STATE.slaAlerts),
    'Kritik_SLA_Cihazlar',
    'KaradenizECM_SLA_Suresi_Yaklasan_Cihazlar'
  );
}

// 4. Clickable Physical Shelves + Per-Shelf Detail Modal & Excel Export
function renderShelvesSummary() {
  const grid = document.getElementById('shelves-summary-grid');
  grid.innerHTML = APP_STATE.shelves.map(s => {
    const pct = Math.min(100, Math.round((s.current_count / (s.capacity || 500)) * 100));
    const slaDays = (s.target_logical_shelf === 'KARANTİNA' || s.target_logical_shelf === 'ARIZA') ? '30G SLA' : '90G SLA';
    return `
      <div onclick="openShelfDetailModal('${s.code}')" class="subcard p-3 space-y-2 text-xs cursor-pointer hover:border-yellow-500/50 transition group">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-mono font-extrabold text-main group-hover:text-yellow-500 transition">${s.code}</span>
            <span class="px-2 py-0.5 rounded text-[10px] ${s.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${s.category}</span>
          </div>
          <button onclick="event.stopPropagation(); exportSingleShelfToExcel('${s.code}')" class="export-icon-btn w-6 h-6" title="${s.code} Rafındaki Cihazları Excel'e Aktar">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"/>
            </svg>
          </button>
        </div>
        <div class="flex items-center justify-between text-sub text-[11px]">
          <span class="font-medium">${s.target_logical_shelf}</span>
          <span class="text-mute">${slaDays}</span>
        </div>
        <div class="w-full bg-slate-500/15 h-1.5 rounded-full overflow-hidden">
          <div class="bg-emerald-500 h-full" style="width:${pct}%"></div>
        </div>
        <div class="flex items-center justify-between text-[11px] text-mute">
          <span>Mevcut: <strong class="text-main">${s.current_count}</strong> / ${s.capacity} Cihaz</span>
          <span class="text-sky-500 font-medium">Detay Gör ➔</span>
        </div>
      </div>
    `;
  }).join('');
}

let MODAL_SHELF_RENDER_LIMIT = 200;

function openShelfDetailModal(shelfCode) {
  ACTIVE_MODAL_SHELF_CODE = shelfCode;
  MODAL_SHELF_RENDER_LIMIT = 200;
  const shelf = APP_STATE.shelves.find(s => s.code === shelfCode);
  if (!shelf) return;

  document.getElementById('modal-shelf-title').textContent = `${shelf.code} Fiziksel Raf Detayı`;
  const badge = document.getElementById('modal-shelf-badge');
  badge.textContent = `${shelf.category} • ${shelf.target_logical_shelf}`;
  badge.className = `px-2 py-0.5 rounded text-xs font-semibold ${shelf.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}`;
  document.getElementById('modal-shelf-subtitle').textContent = `${shelf.notes || ''} — Toplam ${shelf.current_count} Cihaz (Kapasite: ${shelf.capacity})`;
  document.getElementById('modal-shelf-search').value = '';

  renderShelfDetailModalTable();

  const modal = document.getElementById('shelf-detail-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function loadMoreShelfModalRows() {
  MODAL_SHELF_RENDER_LIMIT += 250;
  renderShelfDetailModalTable(true);
}

function closeShelfDetailModal() {
  const modal = document.getElementById('shelf-detail-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  ACTIVE_MODAL_SHELF_CODE = null;
}

function getShelfDevices(shelfCode, searchQuery = '') {
  const q = searchQuery.trim().toLowerCase();
  return APP_STATE.devices.filter(d => {
    if (d.location_status !== 'DEPODA' || d.physical_shelf_code !== shelfCode) return false;
    if (q) {
      const hay = `${d.serial_no} ${d.model_name} ${d.logical_shelf} ${d.notes || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderShelfDetailModalTable(keepLimit = false) {
  if (!ACTIVE_MODAL_SHELF_CODE) return;
  if (!keepLimit) MODAL_SHELF_RENDER_LIMIT = 200;
  const q = document.getElementById('modal-shelf-search')?.value || '';
  const list = getShelfDevices(ACTIVE_MODAL_SHELF_CODE, q);
  const tbody = document.getElementById('modal-shelf-tbody');

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-mute">Bu fiziksel rafta kriterlere uygun cihaz bulunmuyor.</td></tr>`;
    return;
  }

  const visible = list.slice(0, MODAL_SHELF_RENDER_LIMIT);
  let html = visible.map(d => `
    <tr class="hover:bg-slate-500/[0.04]">
      <td class="py-2.5 px-3 font-mono font-bold text-main">${d.serial_no}</td>
      <td class="py-2.5 px-3"><span class="px-2 py-0.5 rounded text-[10px] ${d.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${d.category}</span></td>
      <td class="py-2.5 px-3 text-sub">${d.model_name}</td>
      <td class="py-2.5 px-3 font-medium text-sub">${d.logical_shelf}</td>
      <td class="py-2.5 px-3 font-mono text-mute text-[11px]">${d.sla_entry_date}</td>
      <td class="py-2.5 px-3 text-sub">${d.days_elapsed} Gün</td>
      <td class="py-2.5 px-3">
        <span class="px-2 py-0.5 rounded text-[11px] font-bold ${d.days_remaining <= 10 ? 'bg-red-500/15 text-red-500' : 'bg-emerald-500/15 text-emerald-500'}">
          ${d.days_remaining} Gün (${d.days_elapsed}/${d.sla_max_days}G)
        </span>
      </td>
      <td class="py-2.5 px-3 text-mute">${d.notes || '-'}</td>
    </tr>
  `).join('');

  if (list.length > MODAL_SHELF_RENDER_LIMIT) {
    const remaining = list.length - MODAL_SHELF_RENDER_LIMIT;
    html += `
      <tr>
        <td colspan="8" class="py-3 text-center">
          <button onclick="loadMoreShelfModalRows()" class="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs transition">
            Daha Fazla Göster (${remaining} cihaz daha var — Excel İndir tüm ${list.length} cihazı aktarır)
          </button>
        </td>
      </tr>
    `;
  }

  tbody.innerHTML = html;
}

function exportSingleShelfToExcel(shelfCode) {
  const list = getShelfDevices(shelfCode);
  downloadExcelSheet(
    formatDevicesForExcel(list),
    `${shelfCode}_Cihazlar`,
    `KaradenizECM_${shelfCode}_Raf_Detayi`
  );
}

function exportCurrentModalShelfToExcel() {
  if (!ACTIVE_MODAL_SHELF_CODE) return;
  const q = document.getElementById('modal-shelf-search')?.value || '';
  const list = getShelfDevices(ACTIVE_MODAL_SHELF_CODE, q);
  downloadExcelSheet(
    formatDevicesForExcel(list),
    `${ACTIVE_MODAL_SHELF_CODE}_Cihazlar`,
    `KaradenizECM_${ACTIVE_MODAL_SHELF_CODE}_Raf_Detayi`
  );
}

function exportAllShelvesDetailToExcel() {
  const wb = XLSX.utils.book_new();
  let hasAny = false;

  for (const s of APP_STATE.shelves) {
    const list = getShelfDevices(s.code);
    const rows = list.length > 0
      ? formatDevicesForExcel(list)
      : [{ 'Bilgi': `${s.code} (${s.target_logical_shelf}) rafında şu an cihaz bulunmamaktadır.` }];
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, s.code);
    hasAny = true;
  }

  if (!hasAny) return showToast('Raf verisi bulunamadı.', 'warning');
  XLSX.writeFile(wb, `KaradenizECM_Tum_Fiziksel_Raflar_Detay_${new Date().toISOString().split('T')[0]}.xlsx`);
  showToast('Tüm fiziksel rafların seri bazlı detayları ayrı sekmeler halinde Excel olarak indirildi.', 'success');
}

// 5. Filtered Inventory Table & Filtered Excel Export
function getFilteredInventoryDevices() {
  const q = (document.getElementById('filter-search')?.value || '').trim().toLowerCase();
  const cat = document.getElementById('filter-category')?.value || 'ALL';
  const log = document.getElementById('filter-logical')?.value || 'ALL';
  const loc = document.getElementById('filter-location')?.value || 'ACTIVE';

  return APP_STATE.devices.filter(d => {
    if (cat !== 'ALL' && d.category !== cat) return false;
    if (log !== 'ALL' && d.logical_shelf !== log) return false;
    if (loc === 'ACTIVE' && !(d.location_status === 'DEPODA' || d.location_status === 'TEKNİSYENDE')) return false;
    if (loc !== 'ALL' && loc !== 'ACTIVE' && d.location_status !== loc) return false;
    if (q) {
      const hay = `${d.serial_no} ${d.model_name} ${d.physical_shelf_code || ''} ${d.personnel_name || ''} ${d.logical_shelf}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

let INVENTORY_RENDER_LIMIT = 150;
let PENDING_TURKCELL_SYNC_ROWS = null;

// Parse Excel serial date-time (e.g. 46318.6783680556) or string date-time into { isoDate, displayDateTime }
function parseExcelDateValue(rawVal) {
  if (rawVal === null || rawVal === undefined || rawVal === '') {
    const today = new Date().toISOString().split('T')[0];
    return { isoDate: today, displayDateTime: today };
  }
  if (typeof rawVal === 'number' && rawVal > 20000) {
    // Excel epoch (1899-12-30 UTC)
    const utcMs = Math.round((rawVal - 25569) * 86400 * 1000);
    const dt = new Date(utcMs);
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const mi = String(dt.getUTCMinutes()).padStart(2, '0');
    return { isoDate: `${yyyy}-${mm}-${dd}`, displayDateTime: `${dd}.${mm}.${yyyy} ${hh}:${mi}` };
  }
  const str = String(rawVal).trim();
  // DD.MM.YYYY [HH:mm:ss]
  const trMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}:\d{2}))?/);
  if (trMatch) {
    const dd = trMatch[1].padStart(2, '0');
    const mm = trMatch[2].padStart(2, '0');
    const yyyy = trMatch[3];
    const timePart = trMatch[4] ? ` ${trMatch[4]}` : '';
    return { isoDate: `${yyyy}-${mm}-${dd}`, displayDateTime: `${dd}.${mm}.${yyyy}${timePart}` };
  }
  // YYYY-MM-DD [HH:mm:ss]
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}:\d{2}))?/);
  if (isoMatch) {
    const yyyy = isoMatch[1];
    const mm = isoMatch[2].padStart(2, '0');
    const dd = isoMatch[3].padStart(2, '0');
    const timePart = isoMatch[4] ? ` ${isoMatch[4]}` : '';
    return { isoDate: `${yyyy}-${mm}-${dd}`, displayDateTime: `${dd}.${mm}.${yyyy}${timePart}` };
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const isoDate = parsed.toISOString().split('T')[0];
    return { isoDate, displayDateTime: parsed.toLocaleString('tr-TR') };
  }
  const fallback = new Date().toISOString().split('T')[0];
  return { isoDate: fallback, displayDateTime: str };
}

function loadMoreInventoryRows() {
  INVENTORY_RENDER_LIMIT += 200;
  renderDevicesTable();
}

function renderDevicesTable() {
  const filtered = getFilteredInventoryDevices();
  const countBadge = document.getElementById('filtered-inv-count');
  if (countBadge) countBadge.textContent = filtered.length;

  const visibleRows = filtered.slice(0, INVENTORY_RENDER_LIMIT);
  const tbody = document.getElementById('devices-tbody');
  let html = visibleRows.map(d => {
    let locBadge = '';
    if (d.location_status === 'DEPODA') {
      locBadge = `<button onclick="openShelfDetailModal('${d.physical_shelf_code}')" class="px-2 py-0.5 rounded bg-sky-500/15 hover:bg-sky-500/25 text-sky-500 font-mono font-semibold transition">${d.physical_shelf_code || '-'}</button>`;
    } else if (d.location_status === 'TEKNİSYENDE') {
      locBadge = `<span class="px-2 py-0.5 rounded bg-amber-500/15 text-amber-500 font-semibold">${d.personnel_name || 'Teknisyen'}</span>`;
    } else {
      locBadge = `<span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-500 font-semibold">Müşteriye Kuruldu</span>`;
    }

    let slaBadge = `<span class="text-emerald-500 font-medium">${d.days_remaining} gün (${d.days_elapsed}/${d.sla_max_days}G)</span>`;
    if (d.location_status === 'MÜŞTERİYE_KURULDU') {
      slaBadge = `<span class="text-mute">Tamamlandı</span>`;
    } else if (d.days_remaining <= 10) {
      slaBadge = `<span class="px-2 py-0.5 rounded bg-red-500/15 text-red-500 font-bold">Son ${d.days_remaining} Gün (${d.days_elapsed}/${d.sla_max_days}G)</span>`;
    } else if (d.days_remaining <= 20) {
      slaBadge = `<span class="text-amber-500 font-semibold">${d.days_remaining} gün (${d.days_elapsed}/${d.sla_max_days}G)</span>`;
    }

    return `
      <tr>
        <td class="font-mono font-semibold text-main">${d.serial_no}</td>
        <td><span class="px-2 py-0.5 rounded text-[10px] ${d.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${d.category}</span></td>
        <td class="text-sub">${d.model_name}</td>
        <td class="text-sub font-medium">${d.logical_shelf}</td>
        <td>${locBadge}</td>
        <td class="text-mute font-mono text-[11px]">${d.sla_entry_date}</td>
        <td>${slaBadge}</td>
        <td class="text-mute">${d.notes || '-'}</td>
      </tr>
    `;
  }).join('');

  if (filtered.length > visibleRows.length) {
    html += `
      <tr>
        <td colspan="8" class="text-center py-3">
          <button onclick="loadMoreInventoryRows()" class="px-4 py-1.5 rounded-lg subcard hover:border-sky-500/50 text-sky-500 font-semibold text-xs transition">
            Daha Fazla Göster (${visibleRows.length} / ${filtered.length} Cihaz Görüntüleniyor)
          </button>
        </td>
      </tr>
    `;
  }

  tbody.innerHTML = html;
}

function exportFilteredInventoryToExcel() {
  const filtered = getFilteredInventoryDevices();
  downloadExcelSheet(
    formatDevicesForExcel(filtered),
    'Filtrelenen_Envanter',
    'KaradenizECM_Filtrelenen_Envanter_Listesi'
  );
}

// ==================== TAB 2: TURKCELL REPORT SYNC (Depo Sol.xlsx & Depo Tsd.xlsx EXACT HEADERS) ====================
function handleTurkcellExcelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    let detectedCategory = null;
    const parsedRows = [];
    const statusCounts = { SAĞLAM: 0, 'SAĞLAM DÖNEN': 0, KARANTİNA: 0, ARIZA: 0 };

    for (const r of jsonRows) {
      const sn = String(r['Seri No'] || r['SeriNo'] || r['SERI_NO'] || r['serial_no'] || '').trim();
      if (!sn) continue;

      if (!detectedCategory && r['Sirket']) {
        const comp = String(r['Sirket']).trim().toUpperCase();
        if (comp.includes('TSATIS') || comp.includes('TURKCELL')) detectedCategory = 'TURKCELL';
        else if (comp.includes('SUPERONLINE') || comp.includes('SOL')) detectedCategory = 'SOL';
      }

      const kalemTanimi = String(r['Kalem Tanimi'] || r['Model'] || r['Malzeme Adı'] || r['model_name'] || '').trim();
      const kalemKod = String(r['Kalem Kod'] || '').trim();
      const modelName = kalemTanimi || kalemKod || 'Cihaz';

      const rawShelf = String(r['Adres Statusu'] || r['Raf'] || r['Statü'] || r['logical_shelf'] || 'SAGLAM').trim().toUpperCase();
      let normShelf = 'SAĞLAM';
      if (rawShelf.includes('ARIZA')) normShelf = 'ARIZA';
      else if (rawShelf.includes('KARANT')) normShelf = 'KARANTİNA';
      else if (rawShelf.includes('DONEN') || rawShelf.includes('DÖNEN')) normShelf = 'SAĞLAM DÖNEN';
      statusCounts[normShelf] = (statusCounts[normShelf] || 0) + 1;

      const rawDate = r['Son Islem Tarihi'] !== undefined && r['Son Islem Tarihi'] !== ''
        ? r['Son Islem Tarihi']
        : (r['Tarih'] || r['Giriş Tarihi'] || r['sla_entry_date'] || '');
      const { isoDate, displayDateTime } = parseExcelDateValue(rawDate);

      parsedRows.push({
        serial_no: sn,
        model_name: modelName,
        logical_shelf: normShelf,
        sla_entry_date: isoDate,
        last_action_time: displayDateTime
      });
    }

    if (detectedCategory) {
      const catSel = document.getElementById('sync-category');
      if (catSel) catSel.value = detectedCategory;
    }

    PENDING_TURKCELL_SYNC_ROWS = parsedRows;

    // Show clean preview in textarea (first 15 rows + summary so 4444 rows don't lag the browser!)
    const previewLines = parsedRows.slice(0, 15).map(r => `${r.serial_no}\t${r.model_name}\t${r.logical_shelf}\t${r.last_action_time}`);
    if (parsedRows.length > 15) {
      previewLines.push(`... ve toplam ${parsedRows.length - 15} cihaz daha (Bellekte hazır)`);
    }
    document.getElementById('sync-paste-area').value = previewLines.join('\n');

    const box = document.getElementById('sync-results-box');
    if (box) {
      box.innerHTML = `
        <div class="p-3 rounded-lg bg-sky-500/15 border border-sky-500/30 text-main space-y-1.5">
          <div class="font-bold text-sky-500">Dosya Okundu: ${file.name} (${parsedRows.length} Cihaz — ${detectedCategory || document.getElementById('sync-category').value})</div>
          <div class="text-sub text-[11px]">
            Sağlam: <strong>${statusCounts['SAĞLAM']}</strong> •
            Sağlam Dönen: <strong>${statusCounts['SAĞLAM DÖNEN']}</strong> •
            Karantina: <strong>${statusCounts['KARANTİNA']}</strong> •
            Arızalı: <strong>${statusCounts['ARIZA']}</strong>
          </div>
          <div class="text-mute text-[11px]">Sol taraftaki "Raporu İçeri Aktar ve Eşleştir" butonuna basarak işlemi tamamlayabilirsiniz.</div>
        </div>
      `;
    }
    showToast(`${file.name} okundu: ${parsedRows.length} cihaz eşleştirmeye hazır.`, 'info');
  };
  reader.readAsArrayBuffer(file);
}

async function runTurkcellSyncFromTextarea() {
  const category = document.getElementById('sync-category').value;
  let rows = [];

  if (PENDING_TURKCELL_SYNC_ROWS && PENDING_TURKCELL_SYNC_ROWS.length > 0) {
    rows = PENDING_TURKCELL_SYNC_ROWS;
  } else {
    const raw = document.getElementById('sync-paste-area').value.trim();
    if (!raw) return showToast('Lütfen Excel seçin veya rapor satırlarını yapıştırın.', 'warning');

    rows = raw.split('\n').map(line => {
      const parts = line.split(/\t|,|;/).map(s => s.trim());
      const { isoDate, displayDateTime } = parseExcelDateValue(parts[3] || '');
      return {
        serial_no: parts[0],
        model_name: parts[1] || `${category} Cihaz`,
        logical_shelf: parts[2] || 'SAĞLAM',
        sla_entry_date: isoDate,
        last_action_time: displayDateTime
      };
    }).filter(r => r.serial_no);
  }

  try {
    showToast(`${rows.length} cihaz eşleştiriliyor, lütfen bekleyin...`, 'info');
    const res = await apiPost('/api/reports/sync-turkcell', { category, rows });
    PENDING_TURKCELL_SYNC_ROWS = null;
    renderSyncResult(res);
    showToast(`${res.total_in_report} cihaz başarıyla eşleştirildi.`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function simulateEveningReportSync() {
  const solDevices = APP_STATE.devices.filter(d => d.category === 'SOL' && (d.location_status === 'DEPODA' || d.location_status === 'TEKNİSYENDE'));
  const simulatedLines = [];

  for (const d of solDevices) {
    if (d.serial_no === 'SOL-SN1004') continue;
    let shelf = d.logical_shelf;
    if (d.serial_no === 'SOL-SN1002') shelf = 'ARIZA';
    simulatedLines.push(`${d.serial_no}\t${d.model_name}\t${shelf}\t${d.sla_entry_date}`);
  }

  document.getElementById('sync-category').value = 'SOL';
  document.getElementById('sync-paste-area').value = simulatedLines.join('\n');
  await runTurkcellSyncFromTextarea();
}

function renderSyncResult(res) {
  const box = document.getElementById('sync-results-box');
  box.innerHTML = `
    <div class="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-500 font-semibold">
      ✔ ${res.category} Stok Raporu Eşleştirildi (${res.total_in_report} Seri)
    </div>
    <div class="space-y-1.5">
      <div class="font-semibold text-main">Teknisyen Zimmetinden Otomatik Düşülenler (${res.installedDropped.length}):</div>
      ${res.installedDropped.length === 0 ? '<p class="text-mute">Yok</p>' : res.installedDropped.map(i => `
        <div class="p-2 rounded-lg card text-sub">
          <strong class="font-mono text-emerald-500">${i.serial_no}</strong> (${i.model_name}) — ${i.technician} zimmetinden düşüldü.
        </div>
      `).join('')}
    </div>
    <div class="space-y-1.5">
      <div class="font-semibold text-red-500">Manuel Raf Değişikliği Algılananlar (${res.shelfChangedAlerts.length}):</div>
      ${res.shelfChangedAlerts.length === 0 ? '<p class="text-mute">Yok</p>' : res.shelfChangedAlerts.map(a => `
        <div class="p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-main">
          <strong class="font-mono text-red-500">${a.serial_no}</strong>: ${a.old_logical} ➔ ${a.new_logical} (Önerilen Fiziksel Raf: ${a.recommended_physical_shelf})
        </div>
      `).join('')}
    </div>
  `;
}

function downloadSampleTurkcellExcel() {
  const rows = [
    { 'Seri No': 'SOL-SN8001', 'Model': 'Huawei HG8245X6 Wi-Fi 6 HGW', 'Raf': 'SAĞLAM DÖNEN', 'Tarih': '2026-08-28' },
    { 'Seri No': 'SOL-SN8002', 'Model': 'ZTE ZXHN H3600 Wi-Fi 6 Modem', 'Raf': 'SAĞLAM DÖNEN', 'Tarih': '2026-08-30' },
    { 'Seri No': 'SOL-SN1001', 'Model': 'Huawei HG8245X6 Wi-Fi 6 HGW', 'Raf': 'SAĞLAM', 'Tarih': '2026-11-06' }
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'SOL_Stok_Raporu');
  XLSX.writeFile(wb, 'KaradenizECM_Ornek_SOL_Stok_Raporu.xlsx');
}

// ==================== TAB 3: NEW SHIPMENT POOL ====================
function handleShipmentExcelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const serials = rows.map(r => r['Seri No'] || r['SeriNo'] || Object.values(r)[0]).filter(Boolean);
    document.getElementById('ship-serials').value = serials.join('\n');
  };
  reader.readAsArrayBuffer(file);
}

async function createShipmentBatch() {
  const batch_code = document.getElementById('ship-code').value.trim();
  const category = document.getElementById('ship-category').value;
  const model_name = document.getElementById('ship-model').value.trim();
  const rawSerials = document.getElementById('ship-serials').value.trim();

  if (!rawSerials) return showToast('Lütfen sevkiyat seri numaralarını girin.', 'warning');
  const items = rawSerials.split('\n').map(s => ({ serial_no: s.trim(), model_name })).filter(i => i.serial_no);

  try {
    await apiPost('/api/shipments/import', { batch_code, category, items });
    document.getElementById('ship-serials').value = '';
    showToast('Sevkiyat havuzu oluşturuldu.', 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderShipments() {
  const box = document.getElementById('shipments-list');
  if (!APP_STATE.shipments.length) {
    box.innerHTML = `<p class="text-xs text-mute">Bekleyen sevkiyat kaydı bulunmamaktadır.</p>`;
    return;
  }

  box.innerHTML = APP_STATE.shipments.map(b => {
    const missing = b.items.filter(i => i.in_turkcell_pool === 1 && i.physically_scanned === 0);
    const extra = b.items.filter(i => i.in_turkcell_pool === 0 && i.physically_scanned === 1);
    const matched = b.items.filter(i => i.in_turkcell_pool === 1 && i.physically_scanned === 1);
    const isReady = missing.length === 0 && extra.length === 0 && matched.length > 0;

    return `
      <div class="subcard p-4 space-y-3.5 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5" style="border-color: var(--border-main);">
          <div class="flex items-center gap-2">
            <span class="font-mono font-bold text-main">${b.batch_code}</span>
            <span class="px-2 py-0.5 rounded text-[10px] ${b.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${b.category}</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${b.status === 'ONAYLANDI' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}">${b.status}</span>
          </div>
          <div class="text-mute">
            Önerilen Raf: <strong class="font-mono text-emerald-500">${b.recommended_shelf}</strong>
          </div>
        </div>

        ${b.status !== 'ONAYLANDI' ? `
          <div class="flex flex-wrap items-center gap-2">
            <input id="scan-ship-${b.id}" oninput="handleAutoScannerInput(this, sn => scanShipmentItem(${b.id}, sn))" onkeydown="if(event.key==='Enter'){ scanShipmentItem(${b.id}, this.value); this.value=''; }" type="text" placeholder="Fiziksel gelen cihazları peş peşe okutun (Örn: SOL-NEW5003)..." class="theme-input flex-1 px-3.5 py-2 font-mono" />
            <button onclick="approveShipmentBatch(${b.id}, '${b.recommended_shelf}')" class="px-4 py-2 rounded-xl ${isReady ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'card text-main'} font-bold transition">
              Onayla ve ${b.recommended_shelf} Rafına Al
            </button>
          </div>
        ` : ''}

        <div class="grid grid-cols-1 md:grid-cols-3 gap-2.5">
          <div class="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <div class="font-semibold text-emerald-500 mb-1">✔ Eşleşen (${matched.length})</div>
            <div class="space-y-0.5 font-mono text-[11px] text-main max-h-28 overflow-y-auto">
              ${matched.map(i => `<div>${i.serial_no}</div>`).join('') || '<div class="text-mute">-</div>'}
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <div class="font-semibold text-amber-500 mb-1">⏳ Okutulmayan Eksik (${missing.length})</div>
            <div class="space-y-0.5 font-mono text-[11px] text-main max-h-28 overflow-y-auto">
              ${missing.map(i => `<div>${i.serial_no}</div>`).join('') || '<div class="text-emerald-500">Eksik yok ✔</div>'}
            </div>
          </div>
          <div class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/25">
            <div class="font-semibold text-red-500 mb-1">🚨 Raporda Olmayan Fazla (${extra.length})</div>
            <div class="space-y-0.5 font-mono text-[11px] text-main max-h-28 overflow-y-auto">
              ${extra.map(i => `<div>${i.serial_no}</div>`).join('') || '<div class="text-emerald-500">Fazla yok ✔</div>'}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function scanShipmentItem(batchId, rawSn) {
  const sn = (rawSn || document.getElementById(`scan-ship-${batchId}`)?.value || '').trim().toUpperCase();
  if (!sn) return;
  try {
    const res = await apiPost('/api/shipments/scan', { batch_id: batchId, serial_numbers: [sn] });
    if (res.extra && res.extra.length > 0) {
      playBeep(300, 200);
      showToast(`FARK UYARISI: ${sn} Turkcell sevkiyat listesinde yok!`, 'error');
    } else {
      playBeep(960, 70);
      showToast(`${sn} doğrulandı.`, 'success');
    }
    await loadDashboardData();
    setTimeout(() => document.getElementById(`scan-ship-${batchId}`)?.focus(), 60);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function approveShipmentBatch(batchId, shelf) {
  try {
    const res = await apiPost('/api/shipments/approve', { batch_id: batchId, physical_shelf_code: shelf });
    showToast(`${res.added_count} adet cihaz ${res.shelf} rafına alındı.`, 'success');
    await loadDashboardData();
  } catch (err) {
    if (confirm(`${err.message}\n\nYine de sadece eşleşen fiziksel cihazları içeri almak ister misiniz?`)) {
      await apiPost('/api/shipments/approve', { batch_id: batchId, physical_shelf_code: shelf, force_approve: true });
      await loadDashboardData();
    }
  }
}

// ==================== TAB 4: HANDS-FREE CONTINUOUS DISPATCH + HISTORY EXPORT ====================
function updateDispatchCounters() {
  const techId = document.getElementById('dispatch-tech-select')?.value;
  const activeCount = (techId && DISPATCH_BASKET[techId]) ? DISPATCH_BASKET[techId].length : 0;
  const totalCount = Object.values(DISPATCH_BASKET).reduce((acc, list) => acc + (list ? list.length : 0), 0);

  const activeEl = document.getElementById('counter-active-tech-serials');
  const totalEl = document.getElementById('counter-total-basket-serials');
  const inlineEl = document.getElementById('basket-inline-count');

  if (activeEl) activeEl.textContent = `${activeCount} Seri`;
  if (totalEl) totalEl.textContent = `${totalCount} Seri`;
  if (inlineEl) inlineEl.textContent = totalCount;
}

function renderDispatchView() {
  const techs = APP_STATE.personnel.filter(p => p.role === 'TEKNİSYEN');
  const sel = document.getElementById('dispatch-tech-select');
  if (sel) {
    const currentVal = sel.value;
    sel.innerHTML = techs.map(t => `<option value="${t.id}">${t.full_name} (${t.team_name}) — Mevcut Zimmet: ${t.assigned_device_count} Cihaz</option>`).join('');
    if (currentVal) sel.value = currentVal;
  }

  const histTechSel = document.getElementById('hist-tech-filter');
  if (histTechSel && histTechSel.options.length <= 1) {
    histTechSel.innerHTML = `<option value="ALL">Tüm Teknisyenler</option>` +
      techs.map(t => `<option value="${t.id}">${t.full_name} (${t.team_name})</option>`).join('');
  }

  const fifoBox = document.getElementById('fifo-priority-list');
  if (fifoBox) {
    fifoBox.innerHTML = APP_STATE.fifoRecommendations.slice(0, 12).map(d => `
      <div class="subcard p-2.5 flex items-center justify-between text-xs">
        <div>
          <div class="flex items-center gap-1.5">
            <button onclick="exportSingleShelfToExcel('${d.physical_shelf_code}')" title="${d.physical_shelf_code} Rafını Excel'e Aktar" class="px-1.5 py-0.5 rounded bg-sky-500/15 hover:bg-sky-500/30 text-sky-500 font-mono font-semibold text-[11px] flex items-center gap-1 transition">
              <span>${d.physical_shelf_code}</span>
              <span>📥</span>
            </button>
            <span class="font-mono font-bold text-main">${d.serial_no}</span>
          </div>
          <div class="text-[11px] text-mute mt-0.5">${d.model_name}</div>
        </div>
        <div class="text-right">
          <div class="${d.days_remaining <= 15 ? 'text-red-500 font-bold' : 'text-amber-500 font-semibold'} text-[11px]">SLA: ${d.days_remaining}G</div>
          <button onclick="addDeviceToDispatchBasket('${d.serial_no}')" class="mt-1 px-2 py-0.5 rounded bg-yellow-400 text-slate-950 font-bold text-[10px]">
            + Listeye Ekle
          </button>
        </div>
      </div>
    `).join('');
  }

  updateDispatchCounters();
  renderDispatchBasket();
}

function exportFifoRecommendationsToExcel() {
  downloadExcelSheet(
    formatDevicesForExcel(APP_STATE.fifoRecommendations),
    'SLA_Oncelikli_Cihazlar',
    'KaradenizECM_SLA_Oncelikli_Dagitim_Listesi'
  );
}

async function addDeviceToDispatchBasket(passedSerial) {
  const techId = document.getElementById('dispatch-tech-select')?.value;
  const input = document.getElementById('dispatch-serial-input');
  const sn = (passedSerial || input?.value || '').trim().toUpperCase();
  if (!techId || !sn) return;

  if (input) {
    input.value = '';
    input.focus();
  }

  try {
    const check = await apiPost('/api/dispatch/check-fifo', { serial_no: sn });
    const warnBox = document.getElementById('dispatch-fifo-warning');

    if (check.fifo_warning) {
      playBeep(440, 160);
      warnBox.classList.remove('hidden');
      warnBox.innerHTML = `${check.fifo_warning}`;
    } else {
      playBeep(980, 65);
      warnBox.classList.add('hidden');
    }

    if (!DISPATCH_BASKET[techId]) DISPATCH_BASKET[techId] = [];
    if (!DISPATCH_BASKET[techId].some(x => x.serial_no === sn)) {
      DISPATCH_BASKET[techId].push(check.device);
    }
    const totalCount = Object.values(DISPATCH_BASKET).reduce((acc, list) => acc + list.length, 0);
    document.getElementById('last-scanned-badge').textContent = `Son Okutulan: ${sn} • Seçili Personel: ${DISPATCH_BASKET[techId].length} Seri (Toplam: ${totalCount} Seri)`;
    updateDispatchCounters();
    renderDispatchBasket();
  } catch (err) {
    playBeep(260, 200);
    showToast(err.message, 'error');
  }
}

function renderDispatchBasket() {
  const box = document.getElementById('dispatch-basket-view');
  const entries = Object.entries(DISPATCH_BASKET).filter(([, list]) => list.length > 0);
  updateDispatchCounters();

  if (entries.length === 0) {
    box.innerHTML = `<div class="subcard p-3.5 text-xs text-mute">Henüz cihaz okutulmadı. Okutucu ile peş peşe okuttukça cihazlar ve SLA süreleri burada birikecektir.</div>`;
    return;
  }

  box.innerHTML = entries.map(([techId, list]) => {
    const person = APP_STATE.personnel.find(p => String(p.id) === String(techId));
    return `
      <div class="subcard p-3.5 space-y-2 text-xs">
        <div class="flex items-center justify-between">
          <div class="font-bold text-main">${person ? person.full_name : 'Teknisyen'} (${person ? person.team_name : ''}) — <span class="text-amber-500 font-mono">${list.length} Seri Okutuldu</span></div>
          <span class="text-[11px] text-mute">${person?.phone || ''}</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${list.map(d => {
            const slaColor = d.days_remaining <= 10 ? 'text-red-500 font-bold' : (d.days_remaining <= 20 ? 'text-amber-500 font-semibold' : 'text-emerald-500');
            return `
              <span class="px-2.5 py-1 rounded-lg card font-mono text-main flex items-center gap-1.5">
                <span>${d.serial_no} <span class="text-mute">(${d.physical_shelf_code})</span> <span class="${slaColor}">[SLA: ${d.days_remaining}G]</span></span>
                <button onclick="removeFromDispatchBasket('${techId}', '${d.serial_no}')" class="text-mute hover:text-red-500 font-bold">&times;</button>
              </span>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function removeFromDispatchBasket(techId, sn) {
  if (!DISPATCH_BASKET[techId]) return;
  DISPATCH_BASKET[techId] = DISPATCH_BASKET[techId].filter(x => x.serial_no !== sn);
  renderDispatchBasket();
}

async function commitDailyDispatch() {
  const assignments = Object.entries(DISPATCH_BASKET)
    .filter(([, list]) => list.length > 0)
    .map(([personnel_id, list]) => ({
      personnel_id: Number(personnel_id),
      serial_numbers: list.map(d => d.serial_no)
    }));

  if (!assignments.length) return showToast('Önce dağıtılacak cihazları okutunuz.', 'warning');

  try {
    const res = await apiPost('/api/dispatch/commit', {
      assignments,
      dispatched_by: CURRENT_USER ? CURRENT_USER.full_name : 'Depo Sorumlusu'
    });

    const summaryEl = document.getElementById('last-commit-summary');
    if (summaryEl) {
      const dtNow = new Date().toLocaleString('tr-TR');
      const perPersonText = (res.notificationsSent || []).map(n => `${n.person}: ${n.count} Seri`).join(' • ');
      summaryEl.classList.remove('hidden');
      summaryEl.innerHTML = `✔ <strong>Son Tamamlanan Okuma & Dağıtım (${dtNow}):</strong> Toplam <strong>${res.totalDevicesDispatched} Seri</strong> kaydedildi (${perPersonText}). Otomatik bildirimler gönderildi.`;
    }

    document.getElementById('last-scanned-badge').textContent = `Tamamlandı: Toplam ${res.totalDevicesDispatched} Seri Kaydedildi ✔`;
    DISPATCH_BASKET = {};
    document.getElementById('dispatch-fifo-warning').classList.add('hidden');
    updateDispatchCounters();
    showToast(`Toplam ${res.totalDevicesDispatched} seri kaydedildi; teknisyen ve yöneticilere otomatik bildirim gönderildi.`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function onYearOrMonthFilterChange() {
  // When user picks Year or Month dropdown, clear custom date range inputs so Year+Month takes effect cleanly
  const startEl = document.getElementById('hist-date-start');
  const endEl = document.getElementById('hist-date-end');
  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';
  renderDispatchHistoryTable();
}

function onCustomDateRangeChange() {
  renderDispatchHistoryTable();
}

function clearCustomDateRange() {
  const startEl = document.getElementById('hist-date-start');
  const endEl = document.getElementById('hist-date-end');
  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';
  renderDispatchHistoryTable();
}

function getFilteredDispatchHistory() {
  const yearVal = document.getElementById('hist-year-filter')?.value || 'ALL';
  const monthVal = document.getElementById('hist-month-filter')?.value || 'ALL';
  const startVal = document.getElementById('hist-date-start')?.value || '';
  const endVal = document.getElementById('hist-date-end')?.value || '';
  const techId = document.getElementById('hist-tech-filter')?.value || 'ALL';

  return (APP_STATE.dispatchHistory || []).filter(h => {
    const datePart = (h.dispatched_at || '').split('T')[0]; // YYYY-MM-DD
    const [rYear, rMonth] = datePart.split('-');

    if (startVal || endVal) {
      if (startVal && datePart < startVal) return false;
      if (endVal && datePart > endVal) return false;
    } else {
      if (yearVal !== 'ALL' && rYear !== yearVal) return false;
      if (monthVal !== 'ALL' && rMonth !== monthVal) return false;
    }

    if (techId !== 'ALL' && String(h.personnel_id) !== String(techId)) return false;
    return true;
  });
}

function renderDispatchHistoryTable() {
  const tbody = document.getElementById('dispatch-history-tbody');
  if (!tbody) return;
  const rows = getFilteredDispatchHistory();

  const countEl = document.getElementById('hist-filtered-count');
  if (countEl) countEl.textContent = rows.length;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="py-4 px-3 text-center text-mute">Seçili tarih veya filtrede kayıt bulunamadı.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    let slaCell = `<span class="text-emerald-500 font-medium">${r.days_remaining} Gün Kaldı (${r.days_elapsed}/${r.sla_max_days}G)</span>`;
    if (r.status_after === 'MÜŞTERİYE_KURULDU') {
      slaCell = `<span class="text-mute">Kuruldu (SLA Kapandı)</span>`;
    } else if (r.days_remaining <= 10) {
      slaCell = `<span class="px-2 py-0.5 rounded bg-red-500/15 text-red-500 font-bold">⚠️ Son ${r.days_remaining} Gün (${r.days_elapsed}/${r.sla_max_days}G)</span>`;
    } else if (r.days_remaining <= 20) {
      slaCell = `<span class="px-2 py-0.5 rounded bg-amber-500/15 text-amber-500 font-semibold">${r.days_remaining} Gün Kaldı (${r.days_elapsed}/${r.sla_max_days}G)</span>`;
    }

    return `
      <tr class="hover:bg-slate-500/[0.04]">
        <td class="py-2.5 px-3 text-sub font-mono text-[11px]">${new Date(r.dispatched_at).toLocaleString('tr-TR')}</td>
        <td class="py-2.5 px-3 font-mono font-bold text-main">${r.serial_no}</td>
        <td class="py-2.5 px-3"><span class="px-2 py-0.5 rounded text-[10px] ${r.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${r.category}</span></td>
        <td class="py-2.5 px-3 text-sub">${r.model_name}</td>
        <td class="py-2.5 px-3 font-mono text-sky-500 font-semibold">${r.from_physical_shelf || '-'}</td>
        <td class="py-2.5 px-3 font-semibold text-main">${r.personnel_name}</td>
        <td class="py-2.5 px-3 text-mute">${r.team_name}</td>
        <td class="py-2.5 px-3">${slaCell}</td>
        <td class="py-2.5 px-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${r.status_after === 'MÜŞTERİYE_KURULDU' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}">${r.status_after}</span>
        </td>
      </tr>
    `;
  }).join('');
}

function exportFilteredDispatchHistoryToExcel() {
  const rows = getFilteredDispatchHistory();
  if (!rows.length) return showToast('Dışa aktarılacak kayıt bulunamadı.', 'warning');

  const yearVal = document.getElementById('hist-year-filter')?.value || 'TUM_YILLAR';
  const monthVal = document.getElementById('hist-month-filter')?.value || 'TUM_AYLAR';
  const sheetData = rows.map(r => ({
    'Dağıtım Tarihi ve Saati': new Date(r.dispatched_at).toLocaleString('tr-TR'),
    'Seri No': r.serial_no,
    'Başlık': r.category,
    'Model': r.model_name,
    'Turkcell Rafı': r.logical_shelf,
    'Çıktığı Fiziksel Raf': r.from_physical_shelf || '-',
    'Teslim Alan Teknisyen': r.personnel_name,
    'Ekip': r.team_name,
    'Teslim Eden Depocu': r.dispatched_by,
    'Rafa Giriş Tarihi': r.sla_entry_date || '-',
    'Geçen SLA Günü': r.days_elapsed,
    'Kalan SLA Günü': r.status_after === 'MÜŞTERİYE_KURULDU' ? 'Kuruldu' : r.days_remaining,
    'Güncel Durum': r.status_after
  }));

  downloadExcelSheet(sheetData, 'Teknisyen_Cihaz_Dagitim', `KaradenizECM_Teknisyen_Zimmet_${yearVal}_${monthVal}`);
}

// ==================== TAB 5: TRANSFER POOL APPROVAL & CUSTOMER RETURN POOL APPROVAL ====================
function renderReturnsView() {
  // 1. Render Transfer Approval Pool (Technician -> Technician & Technician -> Warehouse Unused Return)
  populateAdminTransferDropdowns();
  const trWrap = document.getElementById('transfer-pool-table-wrap');
  const transfers = APP_STATE.transferPool || [];

  if (trWrap) {
    if (!transfers.length) {
      trWrap.innerHTML = `<p class="text-xs text-mute">Transfer havuzunda kayıt bulunmamaktadır.</p>`;
    } else {
      trWrap.innerHTML = `
        <table class="w-full text-left border-collapse text-xs corp-table">
          <thead>
            <tr>
              <th>Seç</th>
              <th>Seri No</th>
              <th>Model / Raf</th>
              <th>Transfer Türü</th>
              <th>Veren Teknisyen</th>
              <th>Alan Teknisyen / Hedef Depo Rafı</th>
              <th>Açıklama & Tarih</th>
              <th>Durum</th>
              <th>İşlem</th>
            </tr>
          </thead>
          <tbody>
            ${transfers.map(tr => {
              const isTechToTech = tr.transfer_type === 'TEKNİSYENDEN_TEKNİSYENE';
              const typeBadge = isTechToTech
                ? `<span class="px-2 py-0.5 rounded bg-sky-500/15 text-sky-500 text-[10px] font-bold">TEKNİSYEN &rarr; TEKNİSYEN</span>`
                : `<span class="px-2 py-0.5 rounded bg-purple-500/15 text-purple-500 text-[10px] font-bold">TEKNİSYEN &rarr; DEPO</span>`;

              const targetBadge = isTechToTech
                ? `<span class="font-bold text-main">${tr.to_personnel_name}</span>`
                : `<span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-500 font-mono font-bold">Raf: ${tr.recommended_physical_shelf || 'SOL01'}</span>`;

              let statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-500">ONAY BEKLİYOR</span>`;
              if (tr.status === 'ONAYLANDI') statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-500">ONAYLANDI</span>`;
              if (tr.status === 'REDDEDİLDİ') statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/15 text-red-500">REDDEDİLDİ</span>`;

              return `
                <tr>
                  <td>
                    ${tr.status === 'ONAY_BEKLİYOR' ? `<input type="checkbox" class="tr-check" value="${tr.id}" checked />` : '✓'}
                  </td>
                  <td class="font-mono font-bold text-main">${tr.serial_no}</td>
                  <td class="text-sub">${tr.model_name} <span class="text-mute">(${tr.logical_shelf})</span></td>
                  <td>${typeBadge}</td>
                  <td class="font-semibold text-main">${tr.from_personnel_name}</td>
                  <td>${targetBadge}</td>
                  <td class="text-mute">
                    <div>${tr.note || '-'}</div>
                    <div class="text-[10px] font-mono">${new Date(tr.created_at).toLocaleString('tr-TR')}</div>
                  </td>
                  <td>${statusBadge}</td>
                  <td>
                    ${tr.status === 'ONAY_BEKLİYOR' ? `
                      <div class="flex items-center gap-1.5">
                        <button onclick="approveSingleTransfer(${tr.id})" class="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">
                          Onayla
                        </button>
                        <button onclick="rejectSingleTransfer(${tr.id})" class="px-2 py-1 rounded-md bg-red-500/15 hover:bg-red-500/30 text-red-500 font-semibold">
                          Reddet
                        </button>
                      </div>
                    ` : `<span class="text-mute text-[11px]">${tr.resolved_by || 'Tamamlandı'}</span>`}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    }
  }

  // 2. Render Customer Return Pool (Karşılama & Teknisyen Söküm -> Karantina)
  const pendingKarsilama = APP_STATE.returnPool.filter(r => r.source_type === 'KARŞILAMA' && r.status === 'HAVUZDA_BEKLİYOR').length;
  const pendingTech = APP_STATE.returnPool.filter(r => r.source_type === 'TEKNİSYEN' && r.status === 'HAVUZDA_BEKLİYOR').length;

  const kEl = document.getElementById('pool-count-karsilama');
  const tEl = document.getElementById('pool-count-teknisyen');
  if (kEl) kEl.textContent = `${pendingKarsilama} Cihaz`;
  if (tEl) tEl.textContent = `${pendingTech} Cihaz`;

  const wrap = document.getElementById('return-pool-table-wrap');
  if (!APP_STATE.returnPool.length) {
    wrap.innerHTML = `<p class="text-xs text-mute">İade havuzunda kayıt bulunmamaktadır.</p>`;
    return;
  }

  wrap.innerHTML = `
    <table class="w-full text-left border-collapse text-xs corp-table">
      <thead>
        <tr>
          <th>Seç</th>
          <th>Seri No</th>
          <th>Geldiği Birim</th>
          <th>Kaydeden Personel</th>
          <th>Açıklama</th>
          <th>Önerilen Fiziksel Raf</th>
          <th>Durum</th>
          <th>İşlem</th>
        </tr>
      </thead>
      <tbody>
        ${APP_STATE.returnPool.map(r => `
          <tr>
            <td>
              ${r.status === 'HAVUZDA_BEKLİYOR' ? `<input type="checkbox" class="ret-check" value="${r.id}" checked />` : '✓'}
            </td>
            <td class="font-mono font-semibold text-main">${r.serial_no}</td>
            <td>
              <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${r.source_type === 'KARŞILAMA' ? 'bg-sky-500/15 text-sky-500' : 'bg-amber-500/15 text-amber-500'}">${r.source_type}</span>
            </td>
            <td class="text-sub">${r.reported_by_name || '-'}</td>
            <td class="text-mute">${r.customer_note || '-'}</td>
            <td>
              <span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-500 font-mono font-semibold">${r.recommended_physical_shelf}</span>
            </td>
            <td>
              <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${r.status === 'DEPOCU_ONAYLADI' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}">${r.status}</span>
            </td>
            <td>
              ${r.status === 'HAVUZDA_BEKLİYOR' ? `
                <button onclick="approveSingleReturn(${r.id})" class="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">
                  Onayla (${r.recommended_physical_shelf})
                </button>
              ` : `<span class="text-mute">Depoya Alındı</span>`}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function populateAdminTransferDropdowns() {
  const fromSel = document.getElementById('admin-tr-from');
  const targetSel = document.getElementById('admin-tr-target');
  if (!fromSel || !targetSel) return;

  const techs = APP_STATE.personnel.filter(p => p.role === 'TEKNİSYEN');
  const curFrom = fromSel.value;
  fromSel.innerHTML = techs.map(t => `<option value="${t.id}">Veren: ${t.full_name} (${t.assigned_device_count})</option>`).join('');
  if (curFrom) fromSel.value = curFrom;

  const curTarget = targetSel.value;
  targetSel.innerHTML =
    `<option value="DEPO">Hedef: Merkez Depoya İade (Kullanılmayan)</option>` +
    techs.map(t => `<option value="${t.id}">Hedef Teknisyen: ${t.full_name}</option>`).join('');
  if (curTarget) targetSel.value = curTarget;

  populateAdminTransferSerials();
}

function populateAdminTransferSerials() {
  const fromId = Number(document.getElementById('admin-tr-from')?.value);
  const serialSel = document.getElementById('admin-tr-serial');
  if (!serialSel) return;

  const assigned = APP_STATE.devices.filter(d => d.location_status === 'TEKNİSYENDE' && d.assigned_personnel_id === fromId);
  if (!assigned.length) {
    serialSel.innerHTML = `<option value="">Zimmetli cihaz yok</option>`;
  } else {
    serialSel.innerHTML = assigned.map(d => `<option value="${d.serial_no}">${d.serial_no} (${d.model_name})</option>`).join('');
  }
}

async function createAdminTransferRequest() {
  const fromId = Number(document.getElementById('admin-tr-from')?.value);
  const sn = document.getElementById('admin-tr-serial')?.value;
  const targetVal = document.getElementById('admin-tr-target')?.value;
  if (!fromId || !sn) return showToast('Kaynak teknisyen ve cihaz seçiniz.', 'warning');

  const transfer_type = targetVal === 'DEPO' ? 'TEKNİSYENDEN_DEPOYA' : 'TEKNİSYENDEN_TEKNİSYENE';
  const to_personnel_id = targetVal === 'DEPO' ? null : Number(targetVal);

  try {
    await apiPost('/api/transfers/create', {
      from_personnel_id: fromId,
      transfer_type,
      to_personnel_id,
      serial_numbers: [sn],
      note: 'Merkezden oluşturulan transfer talebi'
    });
    showToast(`${sn} transfer havuzuna eklendi.`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function verifyAndApproveTransferBySerial(rawSn) {
  const sn = (rawSn || '').trim().toUpperCase();
  if (!sn) return;
  const found = (APP_STATE.transferPool || []).find(t => t.serial_no.toUpperCase() === sn && t.status === 'ONAY_BEKLİYOR');
  if (!found) {
    playBeep(280, 200);
    return showToast(`${sn} seri numaralı cihaz için onay bekleyen transfer talebi bulunamadı!`, 'error');
  }
  playBeep(960, 70);
  await approveSingleTransfer(found.id);
}

async function approveSingleTransfer(id) {
  try {
    const res = await apiPost('/api/transfers/approve', {
      transfer_ids: [id],
      resolved_by: CURRENT_USER ? CURRENT_USER.full_name : 'Depo Sorumlusu'
    });
    const item = res.approvedList && res.approvedList[0];
    showToast(`Transfer onaylandı: ${item ? item.serial_no + ' ➔ ' + item.target : 'Tamamlandı'}.`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function approveSelectedTransfers() {
  const checked = [...document.querySelectorAll('.tr-check:checked')].map(el => Number(el.value));
  if (!checked.length) return showToast('Onaylanacak transfer talebi seçilmedi.', 'warning');
  try {
    const res = await apiPost('/api/transfers/approve', {
      transfer_ids: checked,
      resolved_by: CURRENT_USER ? CURRENT_USER.full_name : 'Depo Sorumlusu'
    });
    showToast(`${res.approvedList.length} adet cihaz transferi onaylandı ve zimmet/raf kayıtları güncellendi.`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function rejectSingleTransfer(id) {
  try {
    await apiPost('/api/transfers/reject', {
      transfer_id: id,
      resolved_by: CURRENT_USER ? CURRENT_USER.full_name : 'Depo Sorumlusu',
      reject_reason: 'Depo/Yönetim tarafından iptal edildi'
    });
    showToast('Transfer talebi reddedildi; cihaz mevcut teknisyenin zimmetinde bırakıldı.', 'warning');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function exportTransferPoolToExcel() {
  const rows = (APP_STATE.transferPool || []).map(tr => ({
    'Seri No': tr.serial_no,
    'Başlık': tr.category,
    'Cihaz Modeli': tr.model_name,
    'Turkcell Rafı': tr.logical_shelf,
    'Transfer Türü': tr.transfer_type === 'TEKNİSYENDEN_TEKNİSYENE' ? 'Teknisyenden Teknisyene Saha Transferi' : 'Teknisyenden Depoya Kullanılmayan Cihaz İadesi',
    'Veren Teknisyen': tr.from_personnel_name,
    'Alan Teknisyen / Hedef': tr.to_personnel_name || 'Merkez Depo',
    'Depo Hedef Fiziksel Rafı': tr.recommended_physical_shelf || '-',
    'Açıklama': tr.note || '-',
    'Onay Durumu': tr.status,
    'Onaylayan / İşlem Yapan': tr.resolved_by || '-',
    'Talep Tarihi': new Date(tr.created_at).toLocaleString('tr-TR'),
    'Onay Tarihi': tr.resolved_at ? new Date(tr.resolved_at).toLocaleString('tr-TR') : '-'
  }));
  downloadExcelSheet(rows, 'Transfer_Havuzu', 'KaradenizECM_Teknisyen_ve_Depo_Transfer_Kayitlari');
}

function exportReturnPoolToExcel() {
  const rows = (APP_STATE.returnPool || []).map(r => ({
    'Seri No': r.serial_no,
    'Başlık': r.category,
    'Cihaz Modeli': r.model_name,
    'Geldiği Birim': r.source_type,
    'Kaydeden Personel': r.reported_by_name || '-',
    'Açıklama': r.customer_note || '-',
    'Önerilen Fiziksel Raf': r.recommended_physical_shelf || '-',
    'Onay Durumu': r.status,
    'Kayıt Tarihi': new Date(r.created_at).toLocaleString('tr-TR'),
    'Onay Tarihi': r.approved_at ? new Date(r.approved_at).toLocaleString('tr-TR') : '-'
  }));
  downloadExcelSheet(rows, 'Musteri_Iade_Havuzu', 'KaradenizECM_Musteri_Iade_Havuzu_Kayitlari');
}

async function verifyAndApproveReturnBySerial(rawSn) {
  const sn = (rawSn || '').trim().toUpperCase();
  if (!sn) return;
  const found = APP_STATE.returnPool.find(r => r.serial_no.toUpperCase() === sn && r.status === 'HAVUZDA_BEKLİYOR');
  if (!found) {
    playBeep(280, 200);
    return showToast(`${sn} seri numaralı cihaz bekleyen iade havuzunda bulunamadı!`, 'error');
  }
  playBeep(960, 70);
  await approveSingleReturn(found.id);
}

async function approveSingleReturn(id) {
  try {
    const res = await apiPost('/api/returns/approve', { return_ids: [id] });
    showToast(`Cihaz onaylandı ve ${res.approvedItems[0]?.shelf} fiziksel rafına alındı.`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function approveAllPendingReturns() {
  const checked = [...document.querySelectorAll('.ret-check:checked')].map(el => Number(el.value));
  if (!checked.length) return showToast('Onaylanacak cihaz seçilmedi.', 'warning');
  try {
    const res = await apiPost('/api/returns/approve', { return_ids: checked });
    showToast(`${res.approvedItems.length} adet iade cihaz önerilen Karantina raflarına alındı.`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==================== TAB 6: MONTHLY SHELF COUNT (WITH SERIAL DISCREPANCY DETECTOR) & TECH VEHICLE COUNT MONITOR ====================
// Holds active serial scan session when physical shelf count != system count:
// { [shelfCode]: { targetPhysicalQty: number, scannedSerials: string[], lastResult: object|null } }
let SHELF_DISCREPANCY_SCAN = {};

function renderCountsView() {
  const shelfList = document.getElementById('monthly-shelf-count-list');
  if (shelfList) {
    shelfList.innerHTML = APP_STATE.shelves.map(s => {
      const scanSession = SHELF_DISCREPANCY_SCAN[s.code];
      const shelfDevices = APP_STATE.devices.filter(d => d.physical_shelf_code === s.code && d.location_status === 'DEPODA');
      const expectedSet = new Set(shelfDevices.map(d => d.serial_no.toUpperCase()));

      let discrepancyHtml = '';
      if (scanSession) {
        const scannedList = scanSession.scannedSerials || [];
        const scannedSet = new Set(scannedList);

        // Live serial diff calculation
        const missingDevices = shelfDevices.filter(d => !scannedSet.has(d.serial_no.toUpperCase()));
        const matchedDevices = shelfDevices.filter(d => scannedSet.has(d.serial_no.toUpperCase()));
        const extraSerials = scannedList.filter(sn => !expectedSet.has(sn)).map(sn => {
          const otherDev = APP_STATE.devices.find(d => d.serial_no.toUpperCase() === sn);
          let locInfo = 'Sistemde Kayıtsız Seri!';
          if (otherDev) {
            if (otherDev.location_status === 'DEPODA') locInfo = `Sistemde '${otherDev.physical_shelf_code}' rafında kayıtlı (${otherDev.model_name})`;
            else if (otherDev.location_status === 'TEKNİSYENDE') locInfo = `Sistemde '${otherDev.personnel_name || 'Teknisyen'}' zimmetinde kayıtlı (${otherDev.model_name})`;
            else locInfo = `Sistemde '${otherDev.location_status}' durumunda (${otherDev.model_name})`;
          }
          return { serial_no: sn, locInfo };
        });

        discrepancyHtml = `
          <div class="mt-3 pt-3 border-t border-red-500/30 space-y-3">
            <div class="p-3 rounded-xl bg-red-500/15 border border-red-500/40 text-xs space-y-1">
              <div class="font-bold text-red-500 flex items-center justify-between">
                <span>🚨 ADET UYUŞMAZLIĞI ALGILANDI (${s.code})</span>
                <span class="font-mono">Sistemdeki: ${s.current_count} ≠ Fiziksel Girilen: ${scanSession.targetPhysicalQty}</span>
              </div>
              <p class="text-sub text-[11px]">
                ${scanSession.targetPhysicalQty === 0
                  ? 'Fiziksel rafta 0 cihaz olduğunu belirttiniz. Sistemde bu rafta kayıtlı olup fiziksel rafta çıkmayan eksik seri(ler) aşağıda tespit edilmiştir:'
                  : 'Farkın hangi cihaz serisinden kaynaklandığını tespit etmek için fiziksel rafta gördüğünüz cihazların barkodlarını/QR kodlarını okutunuz:'}
              </p>
            </div>

            ${scanSession.targetPhysicalQty > 0 ? `
              <div class="space-y-1.5">
                <div class="flex items-center justify-between text-[11px]">
                  <span class="font-semibold text-main">🔫 Fiziksel Raftaki Cihazları Peş Peşe Okutun:</span>
                  <span class="font-mono text-amber-500 font-bold">Okutulan: ${scannedList.length} / Fiziksel Hedef: ${scanSession.targetPhysicalQty} Seri</span>
                </div>
                <input id="shelf-serial-input-${s.code}"
                  oninput="handleAutoScannerInput(this, sn => addShelfDiscrepancySerial('${s.code}', sn))"
                  onkeydown="if(event.key==='Enter'){ addShelfDiscrepancySerial('${s.code}', this.value); this.value=''; }"
                  type="text"
                  placeholder="${s.code} rafında fiziksel bulunan cihazların serilerini okutun..."
                  class="theme-input w-full px-3.5 py-2 text-xs font-mono border-amber-500/60" />
              </div>

              ${scannedList.length > 0 ? `
                <div class="flex flex-wrap gap-1.5">
                  ${scannedList.map(sn => `
                    <span class="px-2 py-0.5 rounded-lg card font-mono text-[11px] text-main flex items-center gap-1">
                      <span>${sn}</span>
                      <button onclick="removeShelfDiscrepancySerial('${s.code}', '${sn}')" class="text-mute hover:text-red-500 font-bold">&times;</button>
                    </span>
                  `).join('')}
                </div>
              ` : ''}
            ` : ''}

            <!-- Live Serial Difference Breakdown (Tells exact missing and extra serials!) -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
              <div class="p-3 rounded-xl bg-red-500/10 border border-red-500/30 space-y-1.5">
                <div class="font-bold text-red-500">❌ Bu Rafta Eksik Çıkan Seriler (${missingDevices.length} Adet)</div>
                <div class="text-[11px] text-mute">Sistemde ${s.code} rafında kayıtlı olup fiziksel okutulmayanlar:</div>
                <div class="space-y-1 font-mono text-[11px]">
                  ${missingDevices.length === 0
                    ? '<div class="text-emerald-500 font-sans font-semibold">✔ Bu rafta kayıtlı tüm seriler doğrulandı (Eksik seri yok).</div>'
                    : missingDevices.map(d => `<div class="p-1.5 rounded bg-red-500/15 text-main"><strong>${d.serial_no}</strong> — <span class="text-sub font-sans">${d.model_name} (${d.logical_shelf})</span></div>`).join('')}
                </div>
              </div>

              <div class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-1.5">
                <div class="font-bold text-amber-500">⚠️ Bu Raftan Fazla / Yanlış Çıkan Seriler (${extraSerials.length} Adet)</div>
                <div class="text-[11px] text-mute">Fiziksel olarak ${s.code} rafından çıkıp sistemde başka yerde olanlar:</div>
                <div class="space-y-1 font-mono text-[11px]">
                  ${extraSerials.length === 0
                    ? '<div class="text-mute font-sans">Fazla veya başka rafa ait seri okutulmadı.</div>'
                    : extraSerials.map(e => `<div class="p-1.5 rounded bg-amber-500/15 text-main"><strong>${e.serial_no}</strong> ➔ <span class="text-sub font-sans">${e.locInfo}</span></div>`).join('')}
                </div>
              </div>
            </div>

            <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
              <button onclick="cancelShelfDiscrepancyScan('${s.code}')" class="px-3 py-1.5 rounded-lg subcard text-mute hover:text-main text-xs">
                İptal
              </button>
              <button onclick="submitShelfDiscrepancyScan('${s.code}')" class="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow">
                ✓ Seri Fark Raporunu Kaydet ve Otomatik Bildir
              </button>
            </div>
          </div>
        `;
      }

      return `
        <div class="subcard p-3.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-2">
                <span class="font-mono font-bold text-sm text-main">${s.code}</span>
                <span class="px-2 py-0.5 rounded text-[10px] ${s.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${s.category}</span>
                <span class="text-sub font-medium">${s.target_logical_shelf}</span>
              </div>
              <div class="text-mute text-[11px] mt-1">
                Sistemde Kayıtlı: <strong class="text-emerald-500 text-xs">${s.current_count} Adet</strong>
                ${s.last_counted_at ? `<span class="ml-1.5 text-mute">(Son Sayım: ${new Date(s.last_counted_at).toLocaleDateString('tr-TR')} — Fiziksel: ${s.last_counted_qty} ✔)</span>` : ''}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button onclick="exportSingleShelfToExcel('${s.code}')" class="export-icon-btn px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1" title="${s.code} Rafındaki Cihazları Excel'e Aktar">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"/></svg>
                <span>Excel</span>
              </button>
              <label class="text-[11px] text-mute">Fiziksel Adet:</label>
              <input id="shelf-qty-${s.code}" type="number" min="0" value="${scanSession ? scanSession.targetPhysicalQty : s.current_count}" class="theme-input w-16 px-2 py-1.5 font-bold text-center" />
              <button onclick="confirmMonthlyShelfCount('${s.code}')" class="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">
                Sayımı Onayla
              </button>
            </div>
          </div>
          ${discrepancyHtml}
        </div>
      `;
    }).join('');
  }

  const techStatusList = document.getElementById('tech-vehicle-status-list');
  if (techStatusList) {
    const techs = APP_STATE.personnel.filter(p => p.role === 'TEKNİSYEN');
    techStatusList.innerHTML = techs.map(t => {
      let badgeCls = 'bg-amber-500/15 text-amber-500';
      if (t.vehicle_count_status === 'TAMAMLANDI') badgeCls = 'bg-emerald-500/15 text-emerald-500';
      if (t.vehicle_count_status === 'EKSİK_VAR') badgeCls = 'bg-red-500/15 text-red-500';

      const assignedStr = (t.assigned_serials && t.assigned_serials.length) ? t.assigned_serials.join(', ') : 'Zimmetli cihaz yok';
      const scannedStr = t.last_count_scanned_serials ? t.last_count_scanned_serials : (t.last_vehicle_count_at ? 'Hiçbir seri okutulmadı (0)' : 'Henüz sayım yapılmadı');
      const missingStr = t.last_count_missing_serials ? t.last_count_missing_serials : (t.vehicle_count_status === 'TAMAMLANDI' ? 'Eksik seri yok ✔' : '-');

      return `
        <div class="subcard p-3.5 space-y-2.5 text-xs">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="font-bold text-main text-sm">${t.full_name} <span class="text-mute font-normal text-xs">(${t.team_name})</span></div>
              <div class="text-[11px] text-mute mt-0.5">
                Zimmetli: <strong class="text-main">${t.assigned_device_count} Cihaz</strong> •
                Son Sayım: ${t.last_vehicle_count_at ? new Date(t.last_vehicle_count_at).toLocaleString('tr-TR') : 'Henüz Sayım Yapmadı'}
              </div>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="px-2.5 py-1 rounded-lg text-[10px] font-bold ${badgeCls}">${t.vehicle_count_status}</span>
              <button onclick="exportSingleTechVehicleCountToExcel(${t.id})" class="export-icon-btn px-2 py-1 text-[11px] font-semibold flex items-center gap-1" title="${t.full_name} Araç Sayım ve Zimmet Detayını Excel'e Aktar">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"/></svg>
                <span>Excel</span>
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-1.5 pt-1 border-t text-[11px]" style="border-color: var(--border-main);">
            <div class="flex flex-wrap items-baseline gap-1.5">
              <span class="text-mute font-medium">Zimmetindeki Seriler:</span>
              <span class="font-mono text-sub font-semibold">${assignedStr}</span>
            </div>
            <div class="flex flex-wrap items-baseline gap-1.5">
              <span class="text-mute font-medium">✔ Sayımda Okuttuğu Seriler:</span>
              <span class="font-mono text-emerald-500 font-semibold">${scannedStr}</span>
            </div>
            <div class="flex flex-wrap items-baseline gap-1.5">
              <span class="text-mute font-medium">❌ Eksik Çıkan (Okutulmayan) Seriler:</span>
              <span class="font-mono ${t.last_count_missing_serials ? 'text-red-500 font-bold bg-red-500/10 px-1.5 py-0.5 rounded' : 'text-emerald-500 font-semibold'}">${missingStr}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  renderCountLogsTable();
}

function exportSingleTechVehicleCountToExcel(techId) {
  const t = APP_STATE.personnel.find(p => p.id === techId);
  if (!t) return;

  const scannedSet = new Set((t.last_count_scanned_serials || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
  const missingSet = new Set((t.last_count_missing_serials || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

  const details = (t.assigned_devices_detail || []).map(d => {
    const sn = d.serial_no.toUpperCase();
    let countResult = 'Henüz Sayım Yapılmadı';
    if (t.last_vehicle_count_at) {
      if (scannedSet.has(sn)) countResult = 'OKUTULDU (Doğrulandı ✔)';
      else if (missingSet.has(sn)) countResult = 'EKSİK ÇIKTI (Okutulmadı ❌)';
      else countResult = 'Sayımdan Sonra Zimmetlendi';
    }
    return {
      'Teknisyen': t.full_name,
      'Ekip': t.team_name,
      'Sayım Durumu': t.vehicle_count_status,
      'Son Sayım Tarihi': t.last_vehicle_count_at ? new Date(t.last_vehicle_count_at).toLocaleString('tr-TR') : 'Yapılmadı',
      'Zimmetli Cihaz Seri No': d.serial_no,
      'Başlık': d.category,
      'Cihaz Modeli': d.model_name,
      'Turkcell Rafı': d.logical_shelf,
      'Kalan SLA (Gün)': d.days_remaining,
      'Araç Sayımında Okutulma Durumu': countResult
    };
  });

  if (details.length === 0) {
    details.push({
      'Teknisyen': t.full_name,
      'Ekip': t.team_name,
      'Sayım Durumu': t.vehicle_count_status,
      'Son Sayım Tarihi': t.last_vehicle_count_at ? new Date(t.last_vehicle_count_at).toLocaleString('tr-TR') : 'Yapılmadı',
      'Okutulan Seriler': t.last_count_scanned_serials || '-',
      'Eksik Seriler': t.last_count_missing_serials || '-'
    });
  }

  downloadExcelSheet(details, 'Arac_Sayim_Detay', `KaradenizECM_${t.full_name.replace(/\s+/g, '_')}_Arac_Sayim_Detayi`);
}

function exportAllTechVehicleCountsToExcel() {
  const techs = APP_STATE.personnel.filter(p => p.role === 'TEKNİSYEN');
  const rows = [];

  for (const t of techs) {
    const scannedSet = new Set((t.last_count_scanned_serials || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
    const missingSet = new Set((t.last_count_missing_serials || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

    if (t.assigned_devices_detail && t.assigned_devices_detail.length > 0) {
      for (const d of t.assigned_devices_detail) {
        const sn = d.serial_no.toUpperCase();
        let countResult = 'Henüz Sayım Yapılmadı';
        if (t.last_vehicle_count_at) {
          if (scannedSet.has(sn)) countResult = 'OKUTULDU (Doğrulandı ✔)';
          else if (missingSet.has(sn)) countResult = 'EKSİK ÇIKTI (Okutulmadı ❌)';
          else countResult = 'Sayımdan Sonra Zimmetlendi';
        }
        rows.push({
          'Teknisyen': t.full_name,
          'Ekip': t.team_name,
          'Genel Sayım Durumu': t.vehicle_count_status,
          'Son Sayım Tarihi': t.last_vehicle_count_at ? new Date(t.last_vehicle_count_at).toLocaleString('tr-TR') : 'Yapılmadı',
          'Cihaz Seri No': d.serial_no,
          'Başlık': d.category,
          'Model': d.model_name,
          'Kalan SLA (Gün)': d.days_remaining,
          'Bu Seri Okutuldu Mu?': countResult,
          'Teknisyenin Okuttuğu Tüm Seriler': t.last_count_scanned_serials || '-',
          'Teknisyenin Eksik Çıkan Tüm Serileri': t.last_count_missing_serials || '-'
        });
      }
    } else {
      rows.push({
        'Teknisyen': t.full_name,
        'Ekip': t.team_name,
        'Genel Sayım Durumu': t.vehicle_count_status,
        'Son Sayım Tarihi': t.last_vehicle_count_at ? new Date(t.last_vehicle_count_at).toLocaleString('tr-TR') : 'Yapılmadı',
        'Cihaz Seri No': 'Zimmetli Cihaz Yok',
        'Başlık': '-',
        'Model': '-',
        'Kalan SLA (Gün)': '-',
        'Bu Seri Okutuldu Mu?': '-',
        'Teknisyenin Okuttuğu Tüm Seriler': t.last_count_scanned_serials || '-',
        'Teknisyenin Eksik Çıkan Tüm Serileri': t.last_count_missing_serials || '-'
      });
    }
  }

  downloadExcelSheet(rows, 'Tum_Teknisyen_Arac_Sayimlari', 'KaradenizECM_Tum_Teknisyen_Haftalik_Arac_Sayimlari');
}

function clearCountLogsDateFilter() {
  const s = document.getElementById('clog-date-start');
  const e = document.getElementById('clog-date-end');
  if (s) s.value = '';
  if (e) e.value = '';
  renderCountLogsTable();
}

function getFilteredCountLogs() {
  const q = (document.getElementById('clog-filter-search')?.value || '').trim().toLowerCase();
  const typeVal = document.getElementById('clog-filter-type')?.value || 'ALL';
  const statusVal = document.getElementById('clog-filter-status')?.value || 'ALL';
  const startVal = document.getElementById('clog-date-start')?.value || '';
  const endVal = document.getElementById('clog-date-end')?.value || '';

  return (APP_STATE.countLogs || []).filter(l => {
    if (typeVal !== 'ALL' && l.count_type !== typeVal) return false;
    if (statusVal === 'TAM' && l.status !== 'TAM') return false;
    if (statusVal === 'DISCREPANCY' && l.status === 'TAM') return false;

    const datePart = (l.created_at || '').split('T')[0];
    if (startVal && datePart < startVal) return false;
    if (endVal && datePart > endVal) return false;

    if (q) {
      const hay = `${l.target_name} ${l.count_type} ${l.scanned_serials || ''} ${l.missing_serials || ''} ${l.extra_serials || ''} ${l.status}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderCountLogsTable() {
  const logsWrap = document.getElementById('count-logs-wrap');
  if (!logsWrap) return;

  const filtered = getFilteredCountLogs();
  const numEl = document.getElementById('count-logs-filtered-num');
  if (numEl) numEl.textContent = filtered.length;

  if (!filtered.length) {
    logsWrap.innerHTML = `<div class="p-4 text-center text-xs text-mute">Seçili filtre kriterlerine uygun sayım kaydı bulunamadı.</div>`;
    return;
  }

  logsWrap.innerHTML = `
    <table class="w-full text-left border-collapse text-xs corp-table">
      <thead>
        <tr>
          <th>Tür</th>
          <th>Raf / Teknisyen</th>
          <th>Sistemdeki</th>
          <th>Fiziksel Sayılan</th>
          <th>Okutulan (Doğrulanan) Seriler</th>
          <th>Çıkmayan (Eksik) Seriler</th>
          <th>Fazla / Yanlış Raftan Çıkanlar</th>
          <th>Durum</th>
          <th>Tarih</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(l => `
          <tr>
            <td class="text-sub">${l.count_type}</td>
            <td class="font-semibold text-main">${l.target_name}</td>
            <td class="font-mono">${l.expected_count}</td>
            <td class="font-mono font-bold">${l.scanned_count}</td>
            <td class="font-mono text-emerald-500">${l.scanned_serials || '-'}</td>
            <td class="font-mono text-red-500 font-semibold">${l.missing_serials || '-'}</td>
            <td class="font-mono text-amber-500">${l.extra_serials || '-'}</td>
            <td>
              <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${l.status === 'TAM' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-red-500/15 text-red-500'}">${l.status}</span>
            </td>
            <td class="text-mute text-[11px]">${new Date(l.created_at).toLocaleString('tr-TR')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function confirmMonthlyShelfCount(shelfCode) {
  const counted_qty = Number(document.getElementById(`shelf-qty-${shelfCode}`).value);
  const shelf = APP_STATE.shelves.find(s => s.code === shelfCode);
  if (!shelf) return;

  // If physical count doesn't match system count, open the Serial Discrepancy Scanner immediately!
  if (counted_qty !== shelf.current_count) {
    playBeep(340, 220);
    SHELF_DISCREPANCY_SCAN[shelfCode] = {
      targetPhysicalQty: counted_qty,
      scannedSerials: []
    };
    renderCountsView();
    showToast(`UYARI: ${shelfCode} rafında sistemde ${shelf.current_count} cihaz var ancak fiziksel ${counted_qty} girdiniz! Lütfen farkı bulmak için serileri okutun.`, 'warning');
    setTimeout(() => document.getElementById(`shelf-serial-input-${shelfCode}`)?.focus(), 80);
    return;
  }

  // Exact match: save directly
  try {
    delete SHELF_DISCREPANCY_SCAN[shelfCode];
    const res = await apiPost('/api/counts/shelf', { shelf_code: shelfCode, counted_qty });
    playBeep(960, 70);
    showToast(`${shelfCode} raf sayımı eşleşti ve onaylandı (${res.actualCount}/${res.expectedCount}).`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function addShelfDiscrepancySerial(shelfCode, rawSn) {
  const sn = (rawSn || '').trim().toUpperCase();
  if (!sn || !SHELF_DISCREPANCY_SCAN[shelfCode]) return;

  const list = SHELF_DISCREPANCY_SCAN[shelfCode].scannedSerials;
  if (!list.includes(sn)) {
    list.push(sn);
    playBeep(940, 65);
  }
  renderCountsView();
  setTimeout(() => document.getElementById(`shelf-serial-input-${shelfCode}`)?.focus(), 50);
}

function removeShelfDiscrepancySerial(shelfCode, sn) {
  if (!SHELF_DISCREPANCY_SCAN[shelfCode]) return;
  SHELF_DISCREPANCY_SCAN[shelfCode].scannedSerials = SHELF_DISCREPANCY_SCAN[shelfCode].scannedSerials.filter(x => x !== sn);
  renderCountsView();
}

function cancelShelfDiscrepancyScan(shelfCode) {
  delete SHELF_DISCREPANCY_SCAN[shelfCode];
  renderCountsView();
}

async function submitShelfDiscrepancyScan(shelfCode) {
  const session = SHELF_DISCREPANCY_SCAN[shelfCode];
  if (!session) return;

  try {
    const res = await apiPost('/api/counts/shelf', {
      shelf_code: shelfCode,
      counted_qty: session.targetPhysicalQty,
      scanned_serials: session.scannedSerials
    });

    delete SHELF_DISCREPANCY_SCAN[shelfCode];
    const missingNames = (res.missingSerials || []).map(m => m.serial_no).join(', ') || 'Yok';
    const extraNames = (res.extraSerials || []).map(e => `${e.serial_no} (${e.system_location})`).join(', ') || 'Yok';

    showToast(`${shelfCode} Fark Raporu Kaydedildi! Eksik: ${missingNames} | Fazla: ${extraNames}`, 'warning');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function exportCountLogsToExcel() {
  const filtered = getFilteredCountLogs();
  const rows = filtered.map(l => ({
    'Sayım Türü': l.count_type,
    'Raf / Teknisyen': l.target_name,
    'Sistemde Beklenen Adet': l.expected_count,
    'Fiziksel Sayılan Adet': l.scanned_count,
    'Okutulan (Doğrulanan) Seriler': l.scanned_serials || '-',
    'Eksik (Çıkmayan) Seriler': l.missing_serials || '-',
    'Fazla / Yanlış Raftan Çıkan Seriler': l.extra_serials || '-',
    'Sayım Durumu': l.status,
    'Tarih ve Saat': new Date(l.created_at).toLocaleString('tr-TR')
  }));
  downloadExcelSheet(rows, 'Sayim_ve_Fark_Kayitlari', 'KaradenizECM_Filtrelenen_Sayim_Raporu');
}

// ==================== TAB 7: BYS PERSONNEL & PHYSICAL SHELVES (RENAME, MOVE DEVICES & SAFE DELETE) ====================
let SHELF_EDIT_STATE = {}; // { [code]: true }
let SHELF_MOVE_BEFORE_DELETE = {}; // { [code]: true }

function renderPersonnelAndShelvesConfig() {
  const pWrap = document.getElementById('personnel-table-wrap');
  if (pWrap) {
    pWrap.innerHTML = `
      <table class="w-full text-left border-collapse text-xs corp-table">
        <thead>
          <tr>
            <th>Sicil</th>
            <th>Kullanıcı</th>
            <th>Rol</th>
            <th>Ad Soyad</th>
            <th>Ekip</th>
            <th>Telefon</th>
            <th>Zimmet</th>
          </tr>
        </thead>
        <tbody>
          ${APP_STATE.personnel.map(p => `
            <tr>
              <td class="font-mono text-mute">${p.employee_code}</td>
              <td class="font-mono text-sky-500 font-semibold">${p.username}</td>
              <td class="font-bold text-amber-500">${p.role}</td>
              <td class="font-semibold text-main">${p.full_name}</td>
              <td class="text-sub">${p.team_name}</td>
              <td class="font-mono text-emerald-500">${p.phone}</td>
              <td class="font-bold text-main">${p.assigned_device_count}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  const sWrap = document.getElementById('shelves-config-list');
  if (sWrap) {
    sWrap.innerHTML = APP_STATE.shelves.map(s => {
      const isEditing = !!SHELF_EDIT_STATE[s.code];
      const isMoving = !!SHELF_MOVE_BEFORE_DELETE[s.code];
      const otherShelves = APP_STATE.shelves.filter(other => other.code !== s.code);

      return `
        <div class="subcard p-3 space-y-2.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span class="font-mono font-bold text-sm text-main">${s.code}</span>
              <span class="ml-2 px-1.5 py-0.5 rounded text-[10px] ${s.category === 'SOL' ? 'badge-sol' : 'badge-turkcell'}">${s.category}</span>
              <span class="ml-2 text-sub font-medium">${s.target_logical_shelf}</span>
              <span class="ml-2 text-mute">(<strong class="text-main">${s.current_count}</strong> / ${s.capacity} Cihaz)</span>
            </div>
            <div class="flex items-center gap-1.5">
              <button onclick="exportSingleShelfToExcel('${s.code}')" class="export-icon-btn px-2 py-1 text-[11px] font-semibold" title="${s.code} Rafını Excel'e Aktar">
                Excel
              </button>
              <button onclick="toggleEditShelfMode('${s.code}')" class="px-2.5 py-1 rounded-md card hover:border-sky-500/50 text-sky-500 font-semibold text-[11px] transition">
                İsmi Değiştir
              </button>
              <button onclick="attemptDeleteShelf('${s.code}', ${s.current_count})" class="px-2.5 py-1 rounded-md card hover:border-red-500/50 text-red-500 font-semibold text-[11px] transition">
                Sil
              </button>
            </div>
          </div>

          ${isEditing ? `
            <div class="p-2.5 rounded-xl card border-sky-500/40 flex flex-wrap items-center gap-2">
              <span class="text-[11px] text-sub font-medium">Yeni Raf İsmi:</span>
              <input id="rename-input-${s.code}" type="text" value="${s.code}" class="theme-input px-2.5 py-1 font-mono font-bold text-xs w-28" />
              <select id="rename-logical-${s.code}" class="theme-input px-2 py-1 text-xs">
                <option value="SAĞLAM" ${s.target_logical_shelf === 'SAĞLAM' ? 'selected' : ''}>SAĞLAM (90G)</option>
                <option value="SAĞLAM DÖNEN" ${s.target_logical_shelf === 'SAĞLAM DÖNEN' ? 'selected' : ''}>SAĞLAM DÖNEN (90G)</option>
                <option value="KARANTİNA" ${s.target_logical_shelf === 'KARANTİNA' ? 'selected' : ''}>KARANTİNA (30G)</option>
                <option value="ARIZA" ${s.target_logical_shelf === 'ARIZA' ? 'selected' : ''}>ARIZA (30G)</option>
              </select>
              <button onclick="saveShelfRename('${s.code}')" class="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs">
                Kaydet
              </button>
              <button onclick="toggleEditShelfMode('${s.code}')" class="px-2.5 py-1 rounded-lg subcard text-mute text-xs">
                İptal
              </button>
            </div>
          ` : ''}

          ${isMoving ? `
            <div class="p-3 rounded-xl bg-amber-500/15 border border-amber-500/40 space-y-2">
              <div class="font-bold text-amber-500 text-xs">
                ⚠️ ${s.code} rafında şu an ${s.current_count} adet cihaz bulunmaktadır!
              </div>
              <p class="text-[11px] text-sub">
                Bu rafı silebilmek için önce içindeki ${s.current_count} adet cihazı başka bir fiziksel rafa taşımalısınız. Lütfen cihazların taşınacağı hedef rafı seçin:
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <select id="move-target-${s.code}" class="theme-input px-3 py-1.5 text-xs font-mono font-semibold">
                  ${otherShelves.map(o => `<option value="${o.code}">${o.code} (${o.category} - ${o.target_logical_shelf}) [Mevcut: ${o.current_count}]</option>`).join('')}
                </select>
                <button onclick="moveDevicesAndDeleteShelf('${s.code}', false)" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs">
                  Sadece Cihazları Taşı
                </button>
                <button onclick="moveDevicesAndDeleteShelf('${s.code}', true)" class="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold text-xs">
                  Cihazları Taşı ve ${s.code} Rafını Sil
                </button>
                <button onclick="cancelMoveBeforeDelete('${s.code}')" class="px-2.5 py-1.5 rounded-lg subcard text-mute text-xs">
                  Vazgeç
                </button>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }
}

function toggleEditShelfMode(code) {
  SHELF_EDIT_STATE[code] = !SHELF_EDIT_STATE[code];
  delete SHELF_MOVE_BEFORE_DELETE[code];
  renderPersonnelAndShelvesConfig();
}

async function saveShelfRename(oldCode) {
  const newCode = (document.getElementById(`rename-input-${oldCode}`)?.value || '').trim().toUpperCase();
  const newLogical = document.getElementById(`rename-logical-${oldCode}`)?.value;
  if (!newCode) return showToast('Yeni raf ismi boş olamaz.', 'warning');

  try {
    await apiPost('/api/shelves/rename', {
      user_role: CURRENT_USER?.role,
      old_code: oldCode,
      new_code: newCode,
      target_logical_shelf: newLogical
    });
    delete SHELF_EDIT_STATE[oldCode];
    showToast(`Raf '${oldCode}' ➔ '${newCode}' olarak güncellendi (İçindeki cihazlar yeni raf adına aktarıldı).`, 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function attemptDeleteShelf(code, currentCount) {
  if (CURRENT_USER?.role !== 'YÖNETİCİ') return showToast('Sadece Yönetici raf silebilir.', 'warning');

  // If shelf has devices, block direct delete and open the Move Devices wizard!
  if (currentCount > 0) {
    playBeep(340, 200);
    SHELF_MOVE_BEFORE_DELETE[code] = true;
    delete SHELF_EDIT_STATE[code];
    renderPersonnelAndShelvesConfig();
    showToast(`${code} rafında ${currentCount} adet cihaz var! Önce cihazların taşınacağı hedef rafı seçiniz.`, 'warning');
    return;
  }

  try {
    await apiPost('/api/shelves/delete', { user_role: CURRENT_USER.role, code });
    showToast(`${code} fiziksel rafı silindi.`, 'success');
    await loadDashboardData();
  } catch (err) {
    if (err.message.includes('SİLME ENGELLENDİ')) {
      SHELF_MOVE_BEFORE_DELETE[code] = true;
      renderPersonnelAndShelvesConfig();
    }
    showToast(err.message, 'error');
  }
}

function cancelMoveBeforeDelete(code) {
  delete SHELF_MOVE_BEFORE_DELETE[code];
  renderPersonnelAndShelvesConfig();
}

async function moveDevicesAndDeleteShelf(fromCode, alsoDelete) {
  const toCode = document.getElementById(`move-target-${fromCode}`)?.value;
  if (!toCode) return showToast('Hedef raf seçiniz.', 'warning');

  try {
    const moveRes = await apiPost('/api/shelves/move-devices', {
      user_role: CURRENT_USER?.role,
      from_shelf_code: fromCode,
      to_shelf_code: toCode
    });

    if (alsoDelete) {
      await apiPost('/api/shelves/delete', {
        user_role: CURRENT_USER?.role,
        code: fromCode
      });
      showToast(`${moveRes.moved_count} adet cihaz ${toCode} rafına taşındı ve ${fromCode} rafı silindi.`, 'success');
    } else {
      showToast(`${moveRes.moved_count} adet cihaz ${fromCode} rafından ${toCode} rafına taşındı.`, 'success');
    }

    delete SHELF_MOVE_BEFORE_DELETE[fromCode];
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function addSinglePersonnel() {
  if (CURRENT_USER?.role !== 'YÖNETİCİ') return showToast('Sadece Yönetici işlem yapabilir.', 'warning');
  const employee_code = document.getElementById('p-code').value.trim();
  const username = document.getElementById('p-uname').value.trim();
  const password = document.getElementById('p-pass').value.trim();
  const role = document.getElementById('p-role').value;
  const full_name = document.getElementById('p-name').value.trim();
  const team_name = document.getElementById('p-team').value.trim();
  const phone = document.getElementById('p-phone').value.trim();
  const email = document.getElementById('p-email').value.trim();
  if (!full_name) return showToast('Ad Soyad zorunludur.', 'warning');

  try {
    await apiPost('/api/personnel/import', {
      user_role: CURRENT_USER.role,
      rows: [{ employee_code, username, password, role, full_name, team_name, phone, email }]
    });
    showToast('Personel kaydedildi.', 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function normalizeBysHeader(h) {
  return String(h || '')
    .trim()
    .toUpperCase()
    .replace(/İ/g, 'I')
    .replace(/Ş/g, 'S')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .replace(/\s+/g, ' ');
}

function mapBysGorevToSystemRole(rawGorev) {
  const g = normalizeBysHeader(rawGorev);
  if (!g) return null;
  // Direct system role names (for manual/simple Excel uploads)
  if (g === 'YONETICI') return 'YÖNETİCİ';
  if (g === 'DEPOCU') return 'DEPOCU';
  if (g === 'TEKNISYEN') return 'TEKNİSYEN';
  if (g === 'KARSILAMA') return 'KARŞILAMA';

  // Exact Bys Rapor.xlsx operational role mapping
  if (g.includes('STOK YONETIM') || g.includes('DEPO')) return 'DEPOCU';
  if (g.includes('GENEL KOORDINATOR') || g.includes('MUDUR')) return 'YÖNETİCİ';
  if (g.includes('TEKNIK')) return 'TEKNİSYEN';
  if (g.includes('HIZMET DANISMAN') || g.includes('SATIS DESTEK')) return 'KARŞILAMA';

  // Non-operational roles (Satis / Yeni Musteri, Protokol, Idari Isler, etc.) are excluded
  return null;
}

function handleBysExcelUpload(event) {
  if (CURRENT_USER?.role !== 'YÖNETİCİ') return showToast('Sadece Yönetici işlem yapabilir.', 'warning');
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      // Read as 2D array so Row 1 merged title ("PERSONEL RAPORU") does not break Row 2 headers
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      let headerRowIdx = matrix.findIndex(row =>
        Array.isArray(row) && row.some(cell => {
          const n = normalizeBysHeader(cell);
          return n === 'SICIL NO' || n === 'AD SOYAD' || n === 'KULLANICI ADI';
        })
      );
      if (headerRowIdx === -1) headerRowIdx = 0;

      const headers = (matrix[headerRowIdx] || []).map(normalizeBysHeader);
      const findCol = (...names) => headers.findIndex(h => names.includes(h));

      const idxSicil = findCol('SICIL NO', 'SICIL', 'BYS NO', 'EMPLOYEE_CODE');
      const idxUname = findCol('KULLANICI ADI', 'USERNAME');
      const idxName = findCol('AD SOYAD', 'PERSONEL', 'FULL_NAME');
      const idxGorev = findCol('GOREVI', 'GOREV', 'ROL', 'ROLE');
      const idxEmail = findCol('SIRKET E-MAIL', 'E-MAIL', 'MAIL', 'E-POSTA', 'EMAIL');
      const idxPhone1 = findCol('CEP TELEFONU', 'TELEFON', 'CEP', 'PHONE');
      const idxPhone2 = findCol('KISISEL CEP TELEFONU');
      const idxStatus = findCol('DURUMU', 'DURUM', 'STATUS');
      const idxSolAile = findCol('SOL IS AILESI', 'EKIP', 'BIRIM', 'TEAM_NAME');

      const rows = [];
      const roleCounts = { 'TEKNİSYEN': 0, 'KARŞILAMA': 0, 'DEPOCU': 0, 'YÖNETİCİ': 0 };
      let skippedInactive = 0;
      let skippedOtherRole = 0;

      for (let i = headerRowIdx + 1; i < matrix.length; i++) {
        const r = matrix[i];
        if (!Array.isArray(r)) continue;
        const fullName = String(idxName >= 0 ? r[idxName] : '').trim();
        if (!fullName) continue;

        // 1. Strict Active check (if DURUMU column exists)
        if (idxStatus >= 0) {
          const statusVal = normalizeBysHeader(r[idxStatus]);
          if (statusVal !== 'AKTIF') {
            skippedInactive++;
            continue;
          }
        }

        // 2. Strict Operational Role check
        const rawGorev = String(idxGorev >= 0 ? r[idxGorev] : '').trim();
        const mappedRole = mapBysGorevToSystemRole(rawGorev);
        if (!mappedRole) {
          skippedOtherRole++;
          continue;
        }

        const empCode = String(idxSicil >= 0 ? r[idxSicil] : '').trim();
        const uname = String(idxUname >= 0 ? r[idxUname] : '').trim() || empCode;
        const phonePrimary = String(idxPhone1 >= 0 ? r[idxPhone1] : '').trim();
        const phoneFallback = String(idxPhone2 >= 0 ? r[idxPhone2] : '').trim();
        const phone = phonePrimary || phoneFallback;
        const email = String(idxEmail >= 0 ? r[idxEmail] : '').trim();
        const solAile = String(idxSolAile >= 0 ? r[idxSolAile] : '').trim();

        rows.push({
          employee_code: empCode || `BYS-${i}`,
          username: uname,
          full_name: fullName,
          team_name: rawGorev || solAile || 'Saha Ekibi',
          phone,
          email,
          role: mappedRole
        });
        roleCounts[mappedRole] = (roleCounts[mappedRole] || 0) + 1;
      }

      if (!rows.length) {
        showToast('Excel dosyasında sisteme uygun aktif operasyon personeli bulunamadı.', 'error');
        return;
      }

      await apiPost('/api/personnel/import', {
        user_role: CURRENT_USER.role,
        rows,
        deactivate_missing: true
      });

      showToast(
        `${rows.length} aktif operasyon personeli aktarıldı (${roleCounts['TEKNİSYEN']} Teknisyen, ${roleCounts['KARŞILAMA']} Karşılama, ${roleCounts['DEPOCU']} Depocu, ${roleCounts['YÖNETİCİ']} Yönetici). ${skippedInactive} deaktif ve ${skippedOtherRole} diğer birim personeli hariç tutuldu.`,
        'success'
      );
      await loadDashboardData();
    } catch (err) {
      showToast(`BYS Excel okuma/aktarım hatası: ${err.message}`, 'error');
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function createPhysicalShelf() {
  if (CURRENT_USER?.role !== 'YÖNETİCİ') return showToast('Sadece Yönetici işlem yapabilir.', 'warning');
  const code = document.getElementById('sh-code').value.trim();
  const category = document.getElementById('sh-cat').value;
  const target_logical_shelf = document.getElementById('sh-logical').value;
  if (!code) return showToast('Raf kodu giriniz.', 'warning');
  try {
    await apiPost('/api/shelves/create', { user_role: CURRENT_USER.role, code, category, target_logical_shelf, capacity: 500 });
    document.getElementById('sh-code').value = '';
    showToast('Fiziksel raf eklendi.', 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==================== TAB 8: NOTIFICATIONS & GATEWAY SETTINGS ====================
async function renderNotifications() {
  const gwCard = document.getElementById('notif-gateway-config-card');
  if (gwCard) {
    if (CURRENT_USER?.role === 'YÖNETİCİ') {
      gwCard.classList.remove('hidden');
      try {
        const res = await apiGet('/api/settings/gateway');
        if (res.settings) {
          const emailIn = document.getElementById('gw-email-url');
          const waIn = document.getElementById('gw-wa-url');
          if (emailIn && !emailIn.value) emailIn.value = res.settings.email_webhook_url || '';
          if (waIn && !waIn.value) waIn.value = res.settings.whatsapp_webhook_url || '';
        }
      } catch (_) {}
    } else {
      gwCard.classList.add('hidden');
    }
  }

  const box = document.getElementById('notifications-list');
  if (!box) return;
  box.innerHTML = APP_STATE.notifications.map(n => `
    <div class="subcard p-3.5 space-y-1 text-xs">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-500 font-semibold text-[10px]">✓ ${n.channel}</span>
          <span class="px-2 py-0.5 rounded card text-amber-500 font-semibold text-[10px]">${n.category}</span>
          <span class="font-bold text-main">${n.title}</span>
        </div>
        <span class="text-mute text-[11px]">${new Date(n.created_at).toLocaleString('tr-TR')}</span>
      </div>
      <div class="text-sub leading-relaxed">${n.message}</div>
      <div class="text-[11px] text-mute">Alıcı: <span class="text-main font-medium">${n.recipient_name}</span> • Tel: ${n.recipient_phone || '-'} • Mail: ${n.recipient_email || '-'}</div>
    </div>
  `).join('');
}

function toggleAppsScriptGuide() {
  const box = document.getElementById('apps-script-guide-box');
  if (box) box.classList.toggle('hidden');
}

async function saveGatewaySettings() {
  if (CURRENT_USER?.role !== 'YÖNETİCİ') return showToast('Sadece Yönetici ayarları kaydedebilir.', 'warning');
  const email_webhook_url = document.getElementById('gw-email-url')?.value.trim() || '';
  const whatsapp_webhook_url = document.getElementById('gw-wa-url')?.value.trim() || '';
  try {
    await apiPost('/api/settings/gateway', {
      user_role: CURRENT_USER.role,
      email_webhook_url,
      whatsapp_webhook_url
    });
    showToast('Otomatik WhatsApp ve E-Posta servis bağlantı ayarları kaydedildi.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function sendTestGatewayNotification() {
  try {
    await apiPost('/api/settings/test-notification', {
      test_phone: CURRENT_USER?.phone,
      test_email: CURRENT_USER?.email
    });
    showToast('Test bildirimi tetiklendi ve kayıt listesine eklendi.', 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function exportNotificationsToExcel() {
  const rows = (APP_STATE.notifications || []).map(n => ({
    'Tarih ve Saat': new Date(n.created_at).toLocaleString('tr-TR'),
    'Kanal': n.channel,
    'Kategori': n.category,
    'Başlık': n.title,
    'Mesaj İçeriği': n.message,
    'Alıcılar': n.recipient_name,
    'Alıcı Telefonlar': n.recipient_phone || '-',
    'Alıcı E-Postalar': n.recipient_email || '-'
  }));
  downloadExcelSheet(rows, 'Otomatik_Bildirimler', 'KaradenizECM_Otomatik_Bildirim_Kayitlari');
}

async function downloadFullDatabaseBackupJson() {
  try {
    const data = await apiGet('/api/system/backup-json');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `KaradenizECM_Tam_Veritabani_Yedek_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Tam veritabanı yedeği (.JSON) indirildi.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function handleRestoreDatabaseBackupJson(event) {
  if (CURRENT_USER?.role !== 'YÖNETİCİ') return showToast('Sadece Yönetici yedek geri yükleyebilir.', 'warning');
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backup = JSON.parse(e.target.result);
      await apiPost('/api/system/restore-json', {
        user_role: CURRENT_USER.role,
        backup
      });
      showToast('Veritabanı yedeği başarıyla geri yüklendi.', 'success');
      await loadDashboardData();
    } catch (err) {
      showToast('Yedek geri yükleme hatası: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

async function resetSampleDataForProduction(alsoResetPersonnel) {
  if (CURRENT_USER?.role !== 'YÖNETİCİ') return showToast('Sadece Yönetici bu işlemi yapabilir.', 'warning');
  const msg = alsoResetPersonnel
    ? 'DİKKAT: Sistemdeki tüm örnek cihazlar, hareketler ve örnek personeller silinecek (Tanımlı fiziksel raflar ve Yönetici hesabınız korunacaktır). Gerçek BYS ve Turkcell Excel raporlarınızı yüklemek için sıfırlamayı onaylıyor musunuz?'
    : 'DİKKAT: Sistemdeki tüm örnek cihazlar, iade/transfer havuzları ve hareket geçmişi sıfırlanacak (Fiziksel raflar ve mevcut personel listesi korunacaktır). Onaylıyor musunuz?';

  if (!confirm(msg)) return;

  try {
    await apiPost('/api/system/reset-sample-data', {
      user_role: CURRENT_USER.role,
      also_reset_sample_personnel: alsoResetPersonnel
    });
    showToast('Sistem verileri sıfırlandı. Gerçek stok ve personel raporlarınızı yükleyebilirsiniz.', 'success');
    await loadDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==================== CONTINUOUS MULTI-SCAN CAMERA QR READER ====================
function openContinuousQrScanner(onEachScanCallback) {
  const modal = document.getElementById('qr-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  qrContinuousCount = 0;
  lastQrText = '';
  lastQrTime = 0;
  document.getElementById('qr-scanned-counter').textContent = '0 Adet';
  document.getElementById('qr-last-scanned').textContent = 'Kameraya QR kod gösterin...';

  if (qrScannerInstance) {
    qrScannerInstance.clear().catch(() => {});
  }

  qrScannerInstance = new Html5QrcodeScanner('qr-reader', { fps: 12, qrbox: { width: 240, height: 150 } }, false);
  qrScannerInstance.render((decodedText) => {
    const clean = (decodedText || '').trim().toUpperCase();
    const now = Date.now();
    if (!clean || (clean === lastQrText && now - lastQrTime < 1800)) return;

    lastQrText = clean;
    lastQrTime = now;
    qrContinuousCount++;

    document.getElementById('qr-scanned-counter').textContent = `${qrContinuousCount} Adet`;
    document.getElementById('qr-last-scanned').textContent = `Son Okutulan: ${clean} ✔`;

    if (onEachScanCallback) onEachScanCallback(clean);
  }, () => {});
}

function closeQrScanner() {
  const modal = document.getElementById('qr-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  if (qrScannerInstance) {
    qrScannerInstance.clear().catch(() => {});
    qrScannerInstance = null;
  }
}

// ==================== EXPORT ALL DATA TO EXCEL ====================
function exportAllToExcel() {
  const wb = XLSX.utils.book_new();

  const devicesSheet = XLSX.utils.json_to_sheet(formatDevicesForExcel(APP_STATE.devices));
  XLSX.utils.book_append_sheet(wb, devicesSheet, 'Tum_Envanter_ve_SLA');

  const dispatchSheet = XLSX.utils.json_to_sheet((APP_STATE.dispatchHistory || []).map(h => ({
    'Veriliş Tarihi': h.dispatched_at,
    'Seri No': h.serial_no,
    'Başlık': h.category,
    'Model': h.model_name,
    'Çıktığı Raf': h.from_physical_shelf,
    'Teknisyen': h.personnel_name,
    'Ekip': h.team_name,
    'Dağıtım Türü': h.dispatch_type,
    'Durum': h.status_after
  })));
  XLSX.utils.book_append_sheet(wb, dispatchSheet, 'Teknisyen_Zimmet_Gecmisi');

  const shelvesSheet = XLSX.utils.json_to_sheet(APP_STATE.shelves);
  XLSX.utils.book_append_sheet(wb, shelvesSheet, 'Fiziksel_Raflar');

  const returnsSheet = XLSX.utils.json_to_sheet(APP_STATE.returnPool);
  XLSX.utils.book_append_sheet(wb, returnsSheet, 'Iade_Havuzu');

  XLSX.writeFile(wb, `KaradenizECM_Depo_Raporu_${new Date().toISOString().split('T')[0]}.xlsx`);
}

window.addEventListener('DOMContentLoaded', async () => {
  updateLiveClock();
  const savedTheme = localStorage.getItem('krdnz_theme') || 'dark';
  applyTheme(savedTheme);

  const savedUser = localStorage.getItem('krdnz_user');
  if (savedUser) {
    try {
      CURRENT_USER = JSON.parse(savedUser);
      document.getElementById('login-screen').classList.add('hidden');
      await loadDashboardData();
      applyRoleViewPermissions();
    } catch (_) {}
  }
});
