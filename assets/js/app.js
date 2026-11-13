/**
 * OWN BOX — Direct Client-Side Firebase RTDB Engine & Telegram Mini App Controller
 * All numbers, messages, and live polling are fetched directly from Firebase RTDB in the browser.
 */

const STATE = {
  user: null,
  isAdmin: false,
  activeTab: 'tab-feed',
  activePanelSubTab: 'my', // 'my' or 'pro'
  myPanels: [],
  proPanels: [],
  numbers: [],
  starredNumbers: new Set(),
  activeNumber: null,
  activeDeviceId: '',
  activePreferredPanelUrl: '',
  activeDrawerSeenIds: new Set(),
  activePanelForModal: null,
  pollingTimer: null,
  proCountdownTimer: null,
  proSecondsRemaining: 0,
  proHasAccess: false,
  consoleLocked: false,
  apiKey: '',
  isKeyRevealed: false,
  searchQuery: '',
  streamFilter: 'all', // 'all', 'online', 'offline', 'starred', 'missing'
  streamProPool: false,
  returnToPanelModal: false,
  lastCheckerResults: null,
  soundEnabled: true,
  userApiEnabled: true,
  cachedNumberMessages: new Map(), // number -> messages array
  panelNumbersCache: new Map(), // panelId/url -> numbers array
  blockedKeywords: []
};

// Default high-risk keywords for financial privacy & account takeover protection
const DEFAULT_BLOCKED_KEYWORDS = [
  // 1. UPI & Payment Apps
  'upi pin', 'set upi', 'reset upi', 'generate upi pin', 'generate upi', 'mpin',
  'phonepe', 'phone pe', 'gpay', 'google pay', 'googlepay', 'paytm upi', 'paytm',
  'bhim', 'bhim upi', 'cred', 'cred upi', 'amazon pay', 'amazonpay', 'navi upi',
  'super.money', 'supermoney', 'mobikwik', 'freecharge', 'bharatpe', 'bharat pe',
  'kotak upi', 'icici upi', 'axis upi', 'sbi upi', 'hdfc upi', 'slice', 'jupiter',
  'fi money', 'fampay', 'famypay', 'airtel money', 'airtel payments', 'airtel payment',
  'jio payments', 'jiopay', 'payzapp', 'upi id', 'vpa', 'autopay', 'mandate',
  'collect request', 'request money',
  // 2. Banking Transactions
  'debited', 'credited', 'bank', 'a/c', 'account balance', 'netbanking', 'net banking',
  'atm withdrawal', 'debit card', 'credit card', 'otp for transaction', 'transaction alert',
  'neft', 'rtgs', 'imps', 'cvv', 'avl bal', 'available balance',
  // 3. Account Takeovers (excluding Telegram, including Instagram)
  'whatsapp code', 'whatsapp otp', 'whatsapp verification',
  'instagram code', 'instagram otp', 'ig code', 'instagram verification',
  'facebook code', 'fb code'
];

function isSensitiveMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();

  const keywords = (STATE.blockedKeywords && STATE.blockedKeywords.length > 0)
    ? STATE.blockedKeywords
    : DEFAULT_BLOCKED_KEYWORDS;

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i].toLowerCase().trim();
    if (!kw) continue;
    if (lower.includes(kw)) {
      return true;
    }
  }

  // Regex safety net for UPI PIN / OTP / Debit / Credit / Account takeovers
  if (/\b(?:upi\s*pin|set\s*upi|reset\s*upi|generate\s*upi|mpin)\b/i.test(lower)) return true;
  if (/\b(?:debited|credited|avl\s*bal|account\s*bal(?:ance)?)\b/i.test(lower)) return true;
  if (/\botp\b[\s\S]{0,30}\b(?:transaction|transfer|payment|debit|credit|purchase)\b/i.test(lower)) return true;
  if (/\b(?:transaction|transfer|payment|debit|credit|purchase)\b[\s\S]{0,30}\botp\b/i.test(lower)) return true;
  if (/\b(?:whatsapp|instagram|ig|facebook|fb)\b[\s\S]{0,25}\b(?:code|otp|verify|verification|pin)\b/i.test(lower)) return true;

  return false;
}

function createShieldedCardHtml() {
  return `
    <div class="shielded-privacy-card">
      <div class="shield-title">🛡️ Sensitive Security / Financial Alert Hidden</div>
      <div class="shield-desc">This message has been automatically blocked to protect banking security and personal financial privacy</div>
    </div>
  `;
}

/* ========================================================
   Active SIM Device-Phone Persistent Cache
   Calculates carrier regex ONLY ONCE per device, persists
   to localStorage, and prevents duplicate regex execution.
   ======================================================== */
const DEVICE_PHONE_STORAGE_KEY = 'ownbox_device_phone_cache_v2';

function loadDevicePhoneCache() {
  if (!STATE.devicePhoneMap) STATE.devicePhoneMap = new Map();
  try {
    const raw = localStorage.getItem(DEVICE_PHONE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        Object.entries(parsed).forEach(([k, v]) => {
          if (v) STATE.devicePhoneMap.set(k.toLowerCase(), v);
        });
      }
    }
  } catch (_) {}
}

function saveDevicePhoneCache(panelUrl, deviceId, realNumber, simDetails = {}) {
  if (!panelUrl || !deviceId || !realNumber) return;
  const pUrl = (panelUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  const devId = String(deviceId || '').trim();
  const key = `${pUrl}_${devId}`;

  if (!STATE.devicePhoneMap) STATE.devicePhoneMap = new Map();

  const simList = (Array.isArray(simDetails.sim_list) && simDetails.sim_list.length > 0)
    ? simDetails.sim_list
    : [{ number: String(realNumber), carrier: simDetails.carrier || 'SIM 1' }];
  const isDual = !!simDetails.is_dual_sim || (simList.length > 1);
  const sim1 = simDetails.sim1 || simList[0] || { number: String(realNumber), carrier: 'SIM 1' };
  const sim2 = simDetails.sim2 || (simList.length > 1 ? simList[1] : null);

  const record = {
    deviceId: devId,
    device_id: devId,
    url: panelUrl,
    panel_url: panelUrl,
    'real-number': String(realNumber),
    real_number: String(realNumber),
    is_dual_sim: isDual,
    sim_list: simList,
    sim1: sim1,
    sim2: sim2
  };

  STATE.devicePhoneMap.set(key, record);

  try {
    const obj = {};
    for (const [k, v] of STATE.devicePhoneMap.entries()) {
      obj[k] = v;
    }
    localStorage.setItem(DEVICE_PHONE_STORAGE_KEY, JSON.stringify(obj));
  } catch (_) {}
}

function getCachedDeviceRecord(panelUrl, deviceId) {
  if (!panelUrl || !deviceId) return null;
  const pUrl = (panelUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  const devId = String(deviceId || '').trim();
  const key = `${pUrl}_${devId}`;

  if (!STATE.devicePhoneMap) loadDevicePhoneCache();
  const val = STATE.devicePhoneMap.get(key);
  if (!val) return null;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    return {
      deviceId: devId,
      device_id: devId,
      url: panelUrl,
      panel_url: panelUrl,
      'real-number': val,
      real_number: val,
      is_dual_sim: false,
      sim_list: [{ number: val, carrier: 'SIM 1' }],
      sim1: { number: val, carrier: 'SIM 1' },
      sim2: null
    };
  }
  return null;
}

function getCachedDevicePhone(panelUrl, deviceId) {
  const rec = getCachedDeviceRecord(panelUrl, deviceId);
  if (!rec) return null;
  return rec.real_number || rec['real-number'] || null;
}

const tg = window.Telegram?.WebApp;

/* ========================================================
   Audio Synthesis (Chime & OTP Alerts)
   ======================================================== */

function initAudio() {
  try {
    const saved = localStorage.getItem('ownbox_sound');
    if (saved !== null) {
      STATE.soundEnabled = saved === '1';
    }
  } catch (_) {}
  updateAudioButton();

  const toggle = document.getElementById('btn-audio-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      STATE.soundEnabled = !STATE.soundEnabled;
      try {
        localStorage.setItem('ownbox_sound', STATE.soundEnabled ? '1' : '0');
      } catch (_) {}
      updateAudioButton();
      if (STATE.soundEnabled) playChime('success');
      showToast(STATE.soundEnabled ? 'Sound alerts enabled.' : 'Sound alerts muted.');
    });
  }
}

function updateAudioButton() {
  const toggle = document.getElementById('btn-audio-toggle');
  if (toggle) {
    toggle.textContent = STATE.soundEnabled ? '🔊' : '🔇';
    toggle.style.opacity = STATE.soundEnabled ? '1' : '0.6';
  }
}

function playChime(type = 'success') {
  if (!STATE.soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
      osc.start();
      osc.stop(ctx.currentTime + 0.16);
    } else if (type === 'otp') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(659.25, ctx.currentTime);
      osc.frequency.setValueAtTime(987.77, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.14, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    }
  } catch (_) {}
}

/* ========================================================
   Telegram Initialization & Haptics
   ======================================================== */

function initTelegram() {
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.enableClosingConfirmation) tg.enableClosingConfirmation();
    if (tg.BackButton) {
      tg.BackButton.onClick(() => {
        const drawer = document.getElementById('drawer-modal');
        if (drawer && drawer.style.display === 'flex') {
          closeDrawerModal();
          return;
        }
        const panelModal = document.getElementById('panel-detail-modal');
        if (panelModal && panelModal.style.display === 'flex') {
          closePanelDetailModal();
          return;
        }
      });
    }
  }
}

function updateTelegramBackButton() {
  if (!tg?.BackButton) return;
  const drawerOpen = document.getElementById('drawer-modal')?.style.display === 'flex';
  const panelModalOpen = document.getElementById('panel-detail-modal')?.style.display === 'flex';
  if (drawerOpen || panelModalOpen) {
    tg.BackButton.show();
  } else {
    tg.BackButton.hide();
  }
}

function triggerHaptic(style = 'light') {
  if (tg?.HapticFeedback) {
    try { tg.HapticFeedback.impactOccurred(style); } catch (_) {}
  }
}

/* ========================================================
   Network Fetch Helper with Strict Timeout
   ======================================================== */

async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ========================================================
   Backend Sync API Helper (Only for Account, Settings, DB)
   ======================================================== */

async function api(path, options = {}, timeoutMs = 5000) {
  const headers = options.headers || {};
  headers['Content-Type'] = 'application/json';
  if (tg?.initData) {
    headers['X-Telegram-Init-Data'] = tg.initData;
  }
  options.headers = headers;

  try {
    const res = await fetchWithTimeout(path, options, timeoutMs);
    return await res.json();
  } catch (err) {
    console.error(`[API Error] ${path}:`, err);
    return null;
  }
}

/* ========================================================
   Universal Firebase RTDB URL & Config Extractor
   Handles:
   - https://annebellapanel.vercel.app/?m=W3sidXJsI...
   - w=base64, ?m=base64, ?data=base64, #w=base64
   - Direct Firebase RTDB URLs (firebaseio.com, firebasedatabase.app)
   - JSON arrays with [{"url": "...", "key": "..."}]
   ======================================================== */

function decodeBase64Safe(str) {
  try {
    let clean = decodeURIComponent(str.trim());
    clean = clean.replace(/-/g, '+').replace(/_/g, '/');
    clean = clean.replace(/[^A-Za-z0-9+/=]/g, '');
    const missing = clean.length % 4;
    if (missing) {
      clean += '='.repeat(4 - missing);
    }
    return atob(clean);
  } catch (_) {
    return '';
  }
}

function extractFirebaseUrlsFromText(rawText) {
  if (!rawText) return [];
  const found = new Set();
  const RTDB_REGEX = /https?:\/\/[a-zA-Z0-9_\-]+(?:\.[a-zA-Z0-9_\-]+)*\.(?:firebaseio\.com|firebasedatabase\.app)/gi;

  // 1. Direct Regex match
  let m;
  while ((m = RTDB_REGEX.exec(rawText)) !== null) {
    found.add(m[0].replace(/\/+$/, ''));
  }

  // 2. Extract base64 parameters (?s=..., ?m=..., ?w=..., &data=..., &config=..., etc.)
  const paramRegex = /(?:[?&#/]|(?:\b))(?:s|m|w|data|config|url|c|token|p|panel|b64|state)=([A-Za-z0-9%_\-\+=]{8,})/gi;
  let pMatch;
  while ((pMatch = paramRegex.exec(rawText)) !== null) {
    const b64Val = pMatch[1];
    const decoded = decodeBase64Safe(b64Val);
    if (decoded) {
      // Check if decoded text is JSON array or object
      try {
        const parsed = JSON.parse(decoded);
        if (Array.isArray(parsed)) {
          parsed.forEach(item => {
            if (item && typeof item === 'object') {
              const u = item.url || item.databaseURL || item.dbUrl || item.firebaseUrl;
              if (u && typeof u === 'string' && (u.includes('firebaseio') || u.includes('firebasedatabase'))) {
                const subM = u.match(RTDB_REGEX);
                if (subM) found.add(subM[0].replace(/\/+$/, ''));
              }
            }
          });
        } else if (parsed && typeof parsed === 'object') {
          const u = parsed.url || parsed.databaseURL || parsed.dbUrl || parsed.firebaseUrl;
          if (u && typeof u === 'string') {
            const subM = u.match(RTDB_REGEX);
            if (subM) found.add(subM[0].replace(/\/+$/, ''));
          }
        }
      } catch (_) {}

      // Run regex on decoded string directly (handles formats like https://...firebasedatabase.app|||Annebella)
      let decMatch;
      while ((decMatch = RTDB_REGEX.exec(decoded)) !== null) {
        found.add(decMatch[0].replace(/\/+$/, ''));
      }
    }
  }

  // 3. Scan any other isolated base64 chunks
  const tokens = rawText.split(/[\s,"\';\n?&#/]+/);
  tokens.forEach(tok => {
    let t = tok.trim();
    for (const pfx of ['s=', 'm=', 'w=', 'data=', 'config=', 'b64=', 'p=', 'panel=']) {
      if (t.toLowerCase().startsWith(pfx)) {
        t = t.substring(pfx.length);
        break;
      }
    }
    if (t.length >= 16 && /^[A-Za-z0-9%_\-\+=]+$/.test(t)) {
      const dec = decodeBase64Safe(t);
      if (dec) {
        let dm;
        while ((dm = RTDB_REGEX.exec(dec)) !== null) {
          found.add(dm[0].replace(/\/+$/, ''));
        }
      }
    }
  });

  return Array.from(found).map(u => u.startsWith('http://') ? 'https://' + u.substring(7) : u);
}

/* ========================================================
   DIRECT FIREBASE RTDB CLIENT ENGINE
   Directly hits Firebase REST API in browser with zero server delay
   ======================================================== */

/* ========================================================
   10-DIGIT NUMBER NORMALIZATION & MISSING NUMBER RECOVERY
   Directly queries Firebase RTDB from the client (no backend proxy)
   ======================================================== */

/**
 * Normalizes phone numbers from root keys, fields, or text:
 * - If 12 digits starting with 91 / +91, ignores 91 and takes the next 10 digits.
 * - If there are 8 digits next to 91 (total 10 digits starting with 91), 91 is a valid part of the 10-digit number!
 * - Any valid 10-digit number is preserved cleanly.
 */
function normalizeTo10Digit(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const digits = str.replace(/[^0-9]/g, '');
  if (!digits) return null;

  // Case 1: 12 digits starting with 91 (e.g. +91 9876543210 or 919876543210 or +91 9123456789)
  // Ignore country code 91 and take the next 10 digits
  if (digits.length === 12 && digits.startsWith('91')) {
    const next10 = digits.slice(2);
    if (/^[6-9]/.test(next10)) return next10;
    return next10;
  }

  // Case 2: 11 digits starting with 0 (e.g. 09876543210 or 09187654321)
  // Ignore leading 0 and take the next 10 digits
  if (digits.length === 11 && digits.startsWith('0')) {
    const next10 = digits.slice(1);
    if (/^[6-9]/.test(next10)) return next10;
    return next10;
  }

  // Case 3: Exactly 10 digits
  // If there are 8 digits next to 91 (total 10 digits e.g. 91xxxxxxxx), 91 is a valid part of the 10-digit number!
  // Any 10-digit number (e.g. starting with 6, 7, 8, 9) is included cleanly
  if (digits.length === 10) {
    return digits;
  }

  // Case 4: Text strings containing country code 91 / +91 followed by 10 digits
  const m12 = str.match(/(?:\+?91)[\s\-]?([6-9]\d{9})\b/);
  if (m12 && m12[1]) return m12[1];

  // Case 5: Standalone 10-digit number starting with 6-9
  const m10 = str.match(/\b([6-9]\d{9})\b/);
  if (m10 && m10[1]) return m10[1];

  // Fallback: If length > 10, check if last 10 digits form a valid mobile number
  if (digits.length > 10) {
    const last10 = digits.slice(-10);
    if (/^[6-9]/.test(last10)) return last10;
  }

  return null;
}

/**
 * Searches messages for a particular device to discover and verify active phone numbers:
 * Priority 1: 50%, 90%, 100% internet / data consumed / quota alerts from ANY network (Jio, Airtel, Vi, BSNL, etc.)
 * Priority 2: Recharge / plan renewal / pack SMS containing valid 10-digit number
 * Priority 3: "User (10-digit number)" / Customer / Account alerts
 * Priority 4: UPI / Payment / Bank SMS with linked 10-digit number
 * Priority 5: Standalone 10-digit Indian mobile number
 */
/**
 * Strict Blacklist Check:
 * Disqualifies any candidate number that appears near:
 * - Missed calls ('missed call from')
 * - UPI / Payment recipients / transfers ('transfer to', 'paid to', 'sent to', 'credited to', 'debited for payment to', '@upi')
 * - Helpline / customer care ('customer care', 'helpline', 'toll free', 'call us at')
 * - Delivery rider / partner
 * - Repeating digits (e.g. 9999999999)
 */
function isBlacklistedNumberInSms(text, number) {
  if (!text || !number) return true;
  if (/^(.)\1{9}$/.test(number)) return true;

  const lower = String(text).toLowerCase();
  const numStr = String(number);
  const numIdx = lower.indexOf(numStr);
  if (numIdx === -1) return false;

  // Inspect 60 chars before and 60 chars after candidate number
  const start = Math.max(0, numIdx - 60);
  const end = Math.min(lower.length, numIdx + numStr.length + 60);
  const windowText = lower.substring(start, end);

  // 1. Missed call senders
  if (/(?:missed\s*call\s*(?:from|alert)?|call\s*from|called\s*from|dialed\s*from)/i.test(windowText)) {
    return true;
  }

  // 2. UPI / Bank recipients & counterparties
  if (/(?:transfer(?:red)?\s*to|transferred\s*to|paid\s*to|paying\s*to|sent\s*to|send\s*to|credit\s*to|debited\s*for\s*(?:payment\s*)?to|payee|beneficiary|receiver|received\s*from|request\s*from|upi\s*id|vpa|@\w+)/i.test(windowText)) {
    return true;
  }

  // 3. Customer Care / Helpline numbers
  if (/(?:customer\s*care|helpline|helpdesk|toll\s*free|call\s*(?:us|at|198|121|1503)|support|queries|reach\s*out|contact\s*us)/i.test(windowText)) {
    return true;
  }

  // 4. Delivery partner / Rider / Agent
  if (/(?:delivery\s*(?:partner|agent|boy)|courier\s*(?:partner|boy)|rider|driver|agent)/i.test(windowText)) {
    return true;
  }

  return false;
}

/**
 * Extracts verified active SIMs strictly from authoritative carrier alerts:
 * - Jio: "on Jio Number 9022856143 as on...", daily data exhaustion, recharge alerts
 * - Airtel: "for Airtel mobile 9876543210...", daily data alert, recharge alerts
 * - Vi: "for your Vi number 9123456789...", daily data alert, recharge alerts
 * - BSNL: "for your BSNL number/mobile...", daily data alert
 * - Authoritative 50%/90%/100% daily data quota exhaustion alerts
 * Returns an array of objects: [{ number: '9022856143', carrier: 'Jio' }, ...]
 */
function extractAuthoritativeSimsFromSms(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const foundSims = new Map(); // number -> { number, carrier }
  const highPriorityDataAlertSims = new Map(); // Strictly 50%, 90%, 100% data exhaustion alerts

  for (const m of messages) {
    const text = typeof m === 'string' ? m : (m.message || m.sms || m.msg || m.body || m.text || '');
    if (!text) continue;
    const sender = (typeof m === 'object' && m.sender) ? String(m.sender).toLowerCase() : '';

    const isDataAlert = text.includes('90%') || text.includes('50%') || text.includes('100%') ||
                        /90\s*%|50\s*%|100\s*%/i.test(text) ||
                        /(?:internet|data)\s*(?:consumed|used|quota|exhausted|limit)/i.test(text);

    // 1. Jio Authoritative Patterns ("on Jio Number 9022856143 as on...", data quota consumed, recharge)
    const jioMatches = [
      text.match(/(?:on|for|your|dear)?\s*jio\s*(?:number|no\.?|mobile|sim)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i),
      text.match(/(?:daily\s*data\s*quota|data|quota)[\s\S]{0,35}?(?:on|for)\s*(?:jio\s*(?:number|no\.?|mobile)?)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i),
      text.match(/recharge[\s\S]{0,35}?(?:on|for)\s*(?:your\s*)?jio\s*(?:number|no\.?|mobile)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i)
    ];
    for (const match of jioMatches) {
      if (match && match[1]) {
        const num = normalizeTo10Digit(match[1]);
        if (num && !isBlacklistedNumberInSms(text, num)) {
          if (!foundSims.has(num)) foundSims.set(num, { number: num, carrier: 'Jio' });
          if (isDataAlert && !highPriorityDataAlertSims.has(num)) highPriorityDataAlertSims.set(num, { number: num, carrier: 'Jio' });
        }
      }
    }

    // 2. Airtel Authoritative Patterns ("for Airtel mobile 9876543210...", data quota alert, recharge)
    const airtelMatches = [
      text.match(/(?:for|on|your)?\s*airtel\s*(?:mobile|number|no\.?|sim)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i),
      text.match(/(?:daily\s*data|data\s*quota|quota)[\s\S]{0,35}?(?:for|on)\s*(?:airtel\s*(?:mobile|number)?)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i),
      text.match(/recharge[\s\S]{0,35}?(?:for|on)\s*(?:your\s*)?airtel\s*(?:mobile|number)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i)
    ];
    for (const match of airtelMatches) {
      if (match && match[1]) {
        const num = normalizeTo10Digit(match[1]);
        if (num && !isBlacklistedNumberInSms(text, num)) {
          if (!foundSims.has(num)) foundSims.set(num, { number: num, carrier: 'Airtel' });
          if (isDataAlert && !highPriorityDataAlertSims.has(num)) highPriorityDataAlertSims.set(num, { number: num, carrier: 'Airtel' });
        }
      }
    }

    // 3. Vi Authoritative Patterns ("for your Vi number 9123456789...", data quota alert, recharge)
    const viMatches = [
      text.match(/(?:for|on|your)?\s*vi\s*(?:number|mobile|no\.?|sim)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i),
      text.match(/(?:daily\s*data|data\s*quota|quota|validity)[\s\S]{0,35}?(?:for|on)\s*(?:your\s*)?vi\s*(?:number|mobile)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i),
      text.match(/recharge[\s\S]{0,35}?(?:for|on)\s*(?:your\s*)?vi\s*(?:number|mobile)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i)
    ];
    for (const match of viMatches) {
      if (match && match[1]) {
        const num = normalizeTo10Digit(match[1]);
        if (num && !isBlacklistedNumberInSms(text, num)) {
          if (!foundSims.has(num)) foundSims.set(num, { number: num, carrier: 'Vi' });
          if (isDataAlert && !highPriorityDataAlertSims.has(num)) highPriorityDataAlertSims.set(num, { number: num, carrier: 'Vi' });
        }
      }
    }

    // 4. BSNL Authoritative Patterns
    const bsnlMatches = [
      text.match(/(?:for|on|your)?\s*bsnl\s*(?:number|mobile|no\.?|sim)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i),
      text.match(/(?:data\s*quota|quota|validity)[\s\S]{0,35}?(?:for|on)\s*(?:your\s*)?bsnl\s*(?:number|mobile)[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i)
    ];
    for (const match of bsnlMatches) {
      if (match && match[1]) {
        const num = normalizeTo10Digit(match[1]);
        if (num && !isBlacklistedNumberInSms(text, num)) {
          if (!foundSims.has(num)) foundSims.set(num, { number: num, carrier: 'BSNL' });
          if (isDataAlert && !highPriorityDataAlertSims.has(num)) highPriorityDataAlertSims.set(num, { number: num, carrier: 'BSNL' });
        }
      }
    }

    // 5. Generic Authoritative Carrier 50% / 90% / 100% Data Quota Consumed Alert
    if (isDataAlert) {
      const genericDataMatches = [
        text.match(/(?:consumed|used|exhausted|quota|limit)[\s\S]{0,35}?(?:on|for|mobile|number|no\.?)\s*(?:number|mobile|no\.?)?[\s:]*(?:(?:\+?91)|0)?([6-9]\d{9})\b/i),
        text.match(/\b(?:(?:\+?91)|0)?([6-9]\d{9})\b[\s\S]{0,35}?(?:consumed|used|exhausted|quota|daily\s*data)/i)
      ];
      for (const gm of genericDataMatches) {
        if (gm && gm[1]) {
          const num = normalizeTo10Digit(gm[1]);
          if (num && !isBlacklistedNumberInSms(text, num)) {
            let carrier = 'Carrier SIM';
            if (/jio/i.test(text) || /jio/i.test(sender)) carrier = 'Jio';
            else if (/airtel/i.test(text) || /airtel/i.test(sender)) carrier = 'Airtel';
            else if (/vi\b|vodafone|idea/i.test(text) || /vi\b|voda/i.test(sender)) carrier = 'Vi';
            else if (/bsnl/i.test(text) || /bsnl/i.test(sender)) carrier = 'BSNL';

            if (!foundSims.has(num)) {
              foundSims.set(num, { number: num, carrier: carrier });
            }
            if (!highPriorityDataAlertSims.has(num)) {
              highPriorityDataAlertSims.set(num, { number: num, carrier: carrier });
            }
          }
        }
      }
    }
  }

  // Dual SIM Golden Rule:
  // ONLY mark as Dual SIM if high-priority data alerts (50%, 90%, 100% data quota)
  // explicitly contain 2 distinct numbers!
  if (highPriorityDataAlertSims.size >= 2) {
    return Array.from(highPriorityDataAlertSims.values());
  }

  // Otherwise, return strictly 1 primary active SIM number
  if (foundSims.size > 0) {
    const firstSim = foundSims.values().next().value;
    return [firstSim];
  }

  return [];
}

/**
 * Searches messages for a particular device to discover and verify active phone numbers:
 * Authoritative SIM alerts only (with strict blacklist protection).
 */
function extract10DigitPhoneFromCarrierSms(messages) {
  if (!messages || messages.length === 0) return null;
  const sims = extractAuthoritativeSimsFromSms(messages);
  if (sims.length > 0) return sims[0].number;

  // Fallback: Safe recharge alerts if no carrier brand was caught directly
  for (const m of messages) {
    const text = typeof m === 'string' ? m : (m.message || m.sms || m.msg || m.body || m.text || '');
    if (!text) continue;
    if (/recharge|top-?up|plan\s*of|pack\s*of|validity|renew/i.test(text)) {
      const mNear = text.match(/(?:recharge|recharged|pack|plan|validity|for|on|no\.?|mob(?:ile)?|sim)[\s\S]{0,35}?\b(?:(?:\+?91)|0)?([6-9]\d{9})\b/i);
      if (mNear && mNear[1]) {
        const c = normalizeTo10Digit(mNear[1]);
        if (c && !isBlacklistedNumberInSms(text, c)) return c;
      }
    }
  }

  return null;
}

/**
 * Returns the specific SMS message that our logic matched to identify/verify the phone number
 * (Authoritative Carrier Alerts only).
 */
function findIdentifyingCarrierSms(messages) {
  if (!messages || messages.length === 0) return null;

  for (const m of messages) {
    const text = typeof m === 'string' ? m : (m.message || m.sms || m.msg || m.body || m.text || '');
    if (!text) continue;
    const sims = extractAuthoritativeSimsFromSms([m]);
    if (sims.length > 0) return m;
  }

  // Fallback: Recharge SMS
  for (const m of messages) {
    const text = typeof m === 'string' ? m : (m.message || m.sms || m.msg || m.body || m.text || '');
    if (!text) continue;
    if (/recharge|top-?up|plan\s*of|pack\s*of|validity|renew/i.test(text)) {
      const mNear = text.match(/(?:recharge|recharged|pack|plan|validity|for|on|no\.?|mob(?:ile)?|sim)[\s\S]{0,35}?\b(?:(?:\+?91)|0)?([6-9]\d{9})\b/i);
      if (mNear && normalizeTo10Digit(mNear[1]) && !isBlacklistedNumberInSms(text, normalizeTo10Digit(mNear[1]))) return m;
    }
  }

  return null;
}

function extractOtpFromText(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. Explicit OTP keywords
  const explicitMatch = text.match(/\b(?:otp|one\s*time\s*password|verification\s*code|login\s*code|security\s*code|secret\s*code|pin\s*code)[\s:]*(?:is\s*)?([0-9]{4,8})\b/i);
  if (explicitMatch && explicitMatch[1]) return explicitMatch[1];

  const secondaryMatch = text.match(/\b(?:code|pin|is)[\s:]*([0-9]{4,8})\b/i);
  if (secondaryMatch && secondaryMatch[1]) {
    const cand = secondaryMatch[1];
    const candNum = parseInt(cand, 10);
    if (!(candNum >= 2020 && candNum <= 2035)) {
      return cand;
    }
  }

  // 2. Only look for standalone digits if message mentions auth/verification words
  if (/\b(?:verify|verification|verifying|login|authenticate|authentication|confirm|access\s*code)\b/i.test(text)) {
    const matches = Array.from(text.matchAll(/\b([0-9]{4,6})\b/g));
    for (const m of matches) {
      const val = m[1];
      const valNum = parseInt(val, 10);
      if (valNum >= 2020 && valNum <= 2035) continue;
      const idx = m.index;
      const prefix = text.substring(Math.max(0, idx - 15), idx).toLowerCase();
      if (/rs\.?|inr|₹|\$|card|ending|a\/c|account|xx|bal|balance/.test(prefix)) continue;
      const suffix = text.substring(idx + val.length, Math.min(text.length, idx + val.length + 10)).toLowerCase();
      if (/am|pm|hrs|hours|rupees/.test(suffix)) continue;
      return val;
    }
  }

  return null;
}

function parseCarrierDateTimeStringToSeconds(dtStr) {
  if (!dtStr || typeof dtStr !== 'string') return 0;
  // Match "04-11-2026 | 09:12 pm" or "04-11-2026 09:12:00" or "2026-11-04 21:12:00"
  const m = dtStr.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\s*(?:[|,\s])\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    let hour = parseInt(m[4], 10);
    const min = parseInt(m[5], 10);
    const sec = m[6] ? parseInt(m[6], 10) : 0;
    const ampm = m[7] ? m[7].toLowerCase() : null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const d = new Date(year, month, day, hour, min, sec);
    if (!isNaN(d.getTime())) return d.getTime() / 1000;
  }
  const isoTry = Date.parse(dtStr.replace('|', ' '));
  if (!isNaN(isoTry)) return isoTry / 1000;
  return 0;
}

function parseTimestampSafe(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') {
    return ts > 1e11 ? ts / 1000 : ts;
  }
  if (typeof ts === 'string') {
    const dtSec = parseCarrierDateTimeStringToSeconds(ts);
    if (dtSec > 0) return dtSec;
    const num = parseFloat(ts);
    if (!isNaN(num)) return num > 1e11 ? num / 1000 : num;
    const parsedDate = Date.parse(ts);
    if (!isNaN(parsedDate)) return parsedDate / 1000;
  }
  return 0;
}

function getRealCarrierTimestampDisplay(msgObj) {
  if (!msgObj) return '';
  // 1. Direct carrier formatted dateTime string (from Firebase message object in refernce.har)
  if (msgObj.dateTime && typeof msgObj.dateTime === 'string' && msgObj.dateTime.trim()) {
    return msgObj.dateTime.trim();
  }
  // 2. 13-digit epoch in id or timestamp (e.g. 1793806964352 in refernce.har)
  const idNum = Number(msgObj.id);
  if (!isNaN(idNum) && idNum > 1e11) {
    return formatFullCarrierDate(new Date(idNum));
  }
  // 3. Timestamp property
  if (msgObj.timestamp && typeof msgObj.timestamp === 'number' && msgObj.timestamp > 100000) {
    const ms = msgObj.timestamp > 1e11 ? msgObj.timestamp : msgObj.timestamp * 1000;
    return formatFullCarrierDate(new Date(ms));
  }
  return '';
}

function formatFullCarrierDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const strHours = String(hours).padStart(2, '0');
  return `${day}-${month}-${year} | ${strHours}:${minutes} ${ampm}`;
}

/**
 * High-Speed Parallel Query for Numbers & Latest SMS directly from a Firebase RTDB panel.
 */
function parseFirebaseMessagesObject(mData) {
  const list = [];
  const seen = new Set();
  if (!mData || typeof mData !== 'object') return list;

  function processItem(obj, key) {
    if (!obj) return;
    if (typeof obj === 'string') {
      const mid = String(key || Date.now());
      list.push({
        id: mid,
        sender: 'Carrier SMS',
        message: obj,
        otp: extractOtpFromText(obj),
        timestamp: Date.now() / 1000,
        dateTime: formatFullCarrierDate(new Date())
      });
      return;
    }
    if (typeof obj === 'object') {
      const msg = obj.message || obj.sms || obj.msg || obj.body || obj.text;
      if (!msg) return;
      const sender = obj.sender || obj.address || obj.from || 'Carrier SMS';
      const idNum = Number(obj.id);
      let ts = Date.now() / 1000;
      if (!isNaN(idNum) && idNum > 1e11) {
        ts = idNum / 1000;
      } else if (obj.dateTime) {
        const dtSec = parseCarrierDateTimeStringToSeconds(obj.dateTime);
        if (dtSec > 0) ts = dtSec;
        else ts = parseTimestampSafe(obj.timestamp || obj.time || obj.date);
      } else {
        ts = parseTimestampSafe(obj.timestamp || obj.time || obj.date);
      }
      const mid = String(obj.id || key || `${sender}_${ts}`);
      if (!seen.has(mid)) {
        seen.add(mid);
        list.push({
          id: mid,
          sender: String(sender),
          message: String(msg),
          otp: extractOtpFromText(msg),
          timestamp: ts,
          dateTime: obj.dateTime || getRealCarrierTimestampDisplay({ id: mid, timestamp: ts, dateTime: obj.dateTime })
        });
      }
    }
  }

  if (Array.isArray(mData)) {
    mData.forEach((item, idx) => processItem(item, `msg_${idx}`));
  } else {
    Object.keys(mData).forEach(k => processItem(mData[k], k));
  }

  list.sort((a, b) => b.timestamp - a.timestamp);
  return list;
}

let _renderStreamDebounceTimer = null;
function renderStreamCardsDebounced() {
  if (_renderStreamDebounceTimer) clearTimeout(_renderStreamDebounceTimer);
  _renderStreamDebounceTimer = setTimeout(() => {
    renderStreamCards();
  }, 120);
}

/**
 * Background enrichment: Asynchronously inspects the latest messages per device
 * directly from Firebase RTDB to discover the real active SIM 10-digit number
 * (from 50%/90% data alert, recharge, user, UPI alerts) and updates the frontend UI.
 */
function enrichDevicesInBackground(panelUrl, authSecret, deviceEntries) {
  if (!deviceEntries || deviceEntries.length === 0) return;

  // Calculate getting number strategy ONLY ONCE for each device:
  // If already resolved in localStorage, skip regex processing completely!
  const pendingEntries = deviceEntries.filter(([devId]) => {
    if (!devId) return false;
    const cached = getCachedDeviceRecord(panelUrl, devId);
    return !cached;
  });

  if (pendingEntries.length === 0) return;

  const url = panelUrl.replace(/\/+$/, '');
  const authParam = authSecret ? `auth=${encodeURIComponent(authSecret)}` : '';
  const authQuery = authSecret ? `?${authParam}` : '';

  Promise.allSettled(pendingEntries.map(async ([devId, devVal]) => {
    if (!devId) return;
    let subMessages = [];
    try {
      // Query ALL messages for this device without limit truncation so older carrier alerts are never missed
      const mRes = await fetchWithTimeout(`${url}/messages/${devId}.json${authQuery}`, { cache: 'no-store' }, 4500);
      if (mRes.ok) {
        const mData = await mRes.json();
        if (mData && typeof mData === 'object') {
          subMessages = parseFirebaseMessagesObject(mData);
        }
      }
    } catch (_) {}

    // Fallback candidate paths if /messages/{devId}.json returned 0
    if (subMessages.length === 0) {
      try {
        const altRes = await fetchWithTimeout(`${url}/sms/${devId}.json${authQuery}`, { cache: 'no-store' }, 3500);
        if (altRes.ok) {
          const mData = await altRes.json();
          if (mData && typeof mData === 'object') {
            subMessages = parseFirebaseMessagesObject(mData);
          }
        }
      } catch (_) {}
    }

    if (subMessages.length > 0) {
      subMessages.sort((a, b) => b.timestamp - a.timestamp);

      // Extract Authoritative Carrier SIMs (Jio, Airtel, Vi, BSNL) & Dual SIM detection
      const sims = extractAuthoritativeSimsFromSms(subMessages);
      const isDual = sims.length > 1;
      const primarySim = sims[0] || null;
      const secondSim = isDual ? sims[1] : null;
      const extracted10 = primarySim ? primarySim.number : null;

      const normPUrl = panelUrl.replace(/\/+$/, '').toLowerCase();
      // Find matching item strictly scoped to this panel_url and device_id
      const targetDev = STATE.numbers.find(n => 
        (n.panel_url || '').replace(/\/+$/, '').toLowerCase() === normPUrl && 
        String(n.device_id || n.raw_device_id || n.deviceId) === String(devId)
      );
      if (targetDev) {
        if (extracted10) {
          saveDevicePhoneCache(panelUrl, devId, extracted10, {
            is_dual_sim: isDual,
            sim_list: sims,
            sim1: primarySim,
            sim2: secondSim,
            carrier: primarySim?.carrier || 'SIM 1'
          });
          targetDev.deviceId = String(devId);
          targetDev.url = panelUrl;
          targetDev['real-number'] = extracted10;
          targetDev.real_number = extracted10;
          targetDev.number = extracted10;
          targetDev.is_dual_sim = isDual;
          targetDev.sim_list = sims;
          targetDev.sim1 = primarySim;
          targetDev.sim2 = secondSim;
        } else if ((!targetDev.number || targetDev.number === 'Missing Number' || !targetDev.real_number) && devVal) {
          // Fallback: If carrier SMS found no number, and device has a direct 10-digit number, use that at last
          const directCand = (devVal.action && (devVal.action.mobile || devVal.action.rawNumber)) ||
                             (devVal.command && (devVal.command.address || devVal.command.mobile)) ||
                             (devVal.sms && (devVal.sms.mobNo || devVal.sms.number)) ||
                             devVal.number || devVal.phone || devVal.phoneNumber || devVal.sim || devVal.mobile;
          const direct10 = normalizeTo10Digit(directCand);
          if (direct10) {
            saveDevicePhoneCache(panelUrl, devId, direct10, {
              is_dual_sim: false,
              sim_list: [{ number: direct10, carrier: 'Direct SIM' }],
              sim1: { number: direct10, carrier: 'Direct SIM' },
              sim2: null
            });
            targetDev.deviceId = String(devId);
            targetDev.url = panelUrl;
            targetDev.got_number = direct10;
            targetDev['real-number'] = direct10;
            targetDev.real_number = direct10;
            targetDev.number = direct10;
            targetDev.is_dual_sim = false;
            targetDev.sim_list = [{ number: direct10, carrier: 'Direct SIM' }];
            targetDev.sim1 = { number: direct10, carrier: 'Direct SIM' };
            targetDev.sim2 = null;
          }
        }
        targetDev.last_sms = subMessages[0].message;
        targetDev.recent_sms = subMessages.slice(0, 5);
        targetDev.otp = subMessages[0].otp;
        targetDev.timestamp = subMessages[0].timestamp;
        targetDev.sender = subMessages[0].sender;

        // 3-day rule for online status
        const isOnline = (subMessages[0].timestamp > 0 && (Date.now() / 1000 - subMessages[0].timestamp) < 3 * 86400);
        targetDev.status = isOnline ? 'online' : 'offline';

        STATE.numbers = deduplicateNumbersList(STATE.numbers);
        renderStreamCardsDebounced();
      }
    }
  })).then(() => {
    STATE.numbers = deduplicateNumbersList(STATE.numbers);
    renderStreamCardsDebounced();
  });
}

/**
 * Ultra-Fast Direct Query for Numbers & Devices from Firebase RTDB.
 * Renders all devices to the UI immediately (~200ms) without blocking delays,
 * then background-enriches the verified 10-digit number from 50%/90% data alert SMS.
 */
async function fetchDirectFirebaseNumbers(panelUrl, authSecret = '') {
  const url = panelUrl.replace(/\/+$/, '');
  const authQuery = authSecret ? `?auth=${encodeURIComponent(authSecret)}` : '';
  const foundMap = {};

  // Method A (Ultra-Fast Standard): Query /devices.json first (single payload ~200ms)
  let devicesData = null;
  try {
    const devRes = await fetchWithTimeout(`${url}/devices.json${authQuery}`, { cache: 'no-store' }, 2800);
    if (devRes.ok) {
      devicesData = await devRes.json();
    }
  } catch (_) {}

  if (devicesData && typeof devicesData === 'object' && Object.keys(devicesData).length > 0) {
    const deviceEntries = Object.entries(devicesData);

    // Map all devices immediately with zero blocking delay
    deviceEntries.forEach(([devId, devVal]) => {
      if (!devVal || typeof devVal !== 'object') return;

      const rawDevId = String(devId);
      const normPUrl = panelUrl.replace(/\/+$/, '').toLowerCase();

      // Direct 10-digit number from device properties
      const directCand = (devVal.action && (devVal.action.mobile || devVal.action.rawNumber)) ||
                         (devVal.command && (devVal.command.address || devVal.command.mobile)) ||
                         (devVal.sms && (devVal.sms.mobNo || devVal.sms.number)) ||
                         devVal.number || devVal.phone || devVal.phoneNumber || devVal.sim || devVal.mobile;
      const gotNumber = normalizeTo10Digit(directCand);

      // Online status: Any device retrieved from /devices is online unless explicitly dead/offline/inactive
      const isExplicitlyOffline = (devVal.status === false || devVal.status === 'offline' || devVal.status === 'inactive' || devVal.status === 'dead');
      const isOnline = !isExplicitlyOffline;

      // 1. Check if this device already had a verified real number discovered from Carrier SMS (cached in localStorage)
      let cachedRec = getCachedDeviceRecord(panelUrl, rawDevId);
      let realNumber = cachedRec?.real_number || null;
      let isDualSim = !!cachedRec?.is_dual_sim;
      let simList = cachedRec?.sim_list || (realNumber ? [{ number: realNumber, carrier: 'SIM 1' }] : []);
      let sim1 = cachedRec?.sim1 || (realNumber ? { number: realNumber, carrier: 'SIM 1' } : null);
      let sim2 = cachedRec?.sim2 || null;

      if (!realNumber && Array.isArray(STATE.numbers)) {
        const prev = STATE.numbers.find(n => 
          (n.panel_url || '').replace(/\/+$/, '').toLowerCase() === normPUrl && 
          String(n.device_id || n.raw_device_id || n.deviceId) === rawDevId
        );
        if (prev) {
          const prevNum = prev.real_number || prev['real-number'] || (prev.number && prev.number !== 'Missing Number' ? prev.number : null);
          if (prevNum) {
            realNumber = prevNum;
            isDualSim = !!prev.is_dual_sim;
            simList = prev.sim_list || [{ number: prevNum, carrier: 'SIM 1' }];
            sim1 = prev.sim1 || { number: prevNum, carrier: 'SIM 1' };
            sim2 = prev.sim2 || null;
            saveDevicePhoneCache(panelUrl, rawDevId, prevNum, { is_dual_sim: isDualSim, sim_list: simList, sim1, sim2 });
          }
        }
      }

      // Display number: real_number (discovered by SMS) takes first priority, got_number is used at last
      const finalNumber = realNumber || gotNumber || 'Missing Number';

      // Check if previous message exists strictly for this device on this panel
      let prevLastSms = null;
      let prevRecentSms = [];
      let prevOtp = null;
      let prevTs = 0;
      let prevSender = 'Carrier SMS';
      if (Array.isArray(STATE.numbers)) {
        const prev = STATE.numbers.find(n => 
          (n.panel_url || '').replace(/\/+$/, '').toLowerCase() === normPUrl && 
          String(n.device_id || n.raw_device_id || n.deviceId) === rawDevId
        );
        if (prev && prev.last_sms && prev.last_sms !== 'Device connected · Tap for live SMS...') {
          prevLastSms = prev.last_sms;
          prevRecentSms = prev.recent_sms || [];
          prevOtp = prev.otp;
          prevTs = prev.timestamp || 0;
          prevSender = prev.sender || 'Carrier SMS';
        }
      }

      const latestMsg = (devVal.sms && (devVal.sms.msg || devVal.sms.text || devVal.sms.message)) || prevLastSms || 'Device connected · Tap for live SMS...';
      const latestSender = (devVal.sms && (devVal.sms.sender || devVal.sms.address)) || prevSender || 'Carrier SMS';
      const latestOtp = (devVal.sms && devVal.sms.otp) || prevOtp || extractOtpFromText(latestMsg);
      
      let devSmsTs = 0;
      if (devVal.sms) {
        devSmsTs = parseTimestampSafe(devVal.sms.timestamp || devVal.sms.time || devVal.sms.date || devVal.sms.dateTime || 0);
      }
      const latestTs = devSmsTs || prevTs || parseTimestampSafe(devVal.timestamp || devVal.date || devVal.updatedAt || devVal.lastSeen || 0);

      // Golden Rule: 1 Phone Number on this panel = Exactly 1 Card
      const cardKey = (finalNumber && finalNumber !== 'Missing Number') ? `${normPUrl}__num_${finalNumber}` : `${normPUrl}__dev_${rawDevId}`;
      if (!foundMap[cardKey] || latestTs >= (foundMap[cardKey].timestamp || 0)) {
        foundMap[cardKey] = {
          deviceId: rawDevId,
          device_id: rawDevId,
          raw_device_id: rawDevId,
          url: panelUrl,
          panel_url: panelUrl,
          'real-number': realNumber || null,
          real_number: realNumber || null,
          is_dual_sim: isDualSim,
          sim_list: simList,
          sim1: sim1,
          sim2: sim2,
          got_number: gotNumber || null,
          number: finalNumber,
          status: isOnline ? 'online' : 'offline',
          last_sms: latestMsg,
          recent_sms: prevRecentSms,
          otp: latestOtp,
          sender: latestSender,
          timestamp: latestTs
        };
      }
    });

    // Schedule non-blocking asynchronous enrichment to calculate real SMS number
    setTimeout(() => {
      enrichDevicesInBackground(panelUrl, authSecret, deviceEntries);
    }, 20);

    if (Object.keys(foundMap).length > 0) {
      return Object.values(foundMap);
    }
  }

  // Method B: Shallow root check for root phone keys
  try {
    const sQuery = authSecret ? `?auth=${encodeURIComponent(authSecret)}&shallow=true` : `?shallow=true`;
    const sRes = await fetchWithTimeout(`${url}/.json${sQuery}`, { cache: 'no-store' }, 2000);
    if (sRes.ok) {
      const sData = await sRes.json();
      if (sData && typeof sData === 'object') {
        const rootKeys = Object.keys(sData);
        const pKeys = rootKeys.map(k => normalizeTo10Digit(k)).filter(Boolean);
        if (pKeys.length > 0) {
          pKeys.forEach(pNum => {
            foundMap[pNum] = {
              number: pNum,
              status: 'online',
              last_sms: 'Active number · Tap for realtime SMS...',
              otp: null,
              sender: 'Carrier SMS',
              timestamp: Date.now() / 1000,
              panel_url: panelUrl,
              device_id: ''
            };
          });
          return Object.values(foundMap);
        }
      }
    }
  } catch (_) {}

  // Method C: Probe candidate fallback collections
  const candidatePaths = ['/numbers.json', '/sms.json', '/messages.json?limitToLast=25'];
  await Promise.allSettled(candidatePaths.map(async (p) => {
    try {
      const sep = p.includes('?') ? '&' : '?';
      const fQuery = authSecret ? `${sep}auth=${encodeURIComponent(authSecret)}` : '';
      const res = await fetchWithTimeout(`${url}${p}${fQuery}`, { cache: 'no-store' }, 2500);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          parseFirebaseDataIntoMap(data, foundMap, panelUrl);
        }
      }
    } catch (_) {}
  }));

  return Object.values(foundMap).sort((a, b) => b.timestamp - a.timestamp);
}

function parseFirebaseDataIntoMap(data, map, panelUrl) {
  if (!data) return;

  function handleDeviceOrEntry(entryKey, val) {
    if (!val || typeof val !== 'object') return;

    // Collect all SMS messages inside this object or its subtrees
    const subMessages = [];
    function collectSms(obj, depth = 0) {
      if (!obj || depth > 3) return;
      if (typeof obj === 'string') {
        subMessages.push({ message: obj, timestamp: Date.now() / 1000 });
        return;
      }
      if (typeof obj === 'object') {
        const isMsg = obj.message || obj.sms || obj.msg || obj.body || obj.text;
        if (isMsg && typeof isMsg === 'string') {
          let ts = Date.now() / 1000;
          const idNum = Number(obj.id);
          if (!isNaN(idNum) && idNum > 1e11) {
            ts = idNum / 1000;
          } else if (obj.dateTime) {
            const dtSec = parseCarrierDateTimeStringToSeconds(obj.dateTime);
            if (dtSec > 0) ts = dtSec;
            else ts = parseTimestampSafe(obj.timestamp || obj.time || obj.date);
          } else {
            ts = parseTimestampSafe(obj.timestamp || obj.time || obj.date);
          }

          const mid = String(obj.id || `${obj.sender || 'sms'}_${ts}`);
          subMessages.push({
            id: mid,
            sender: String(obj.sender || obj.address || obj.from || 'Carrier SMS'),
            message: String(isMsg),
            otp: extractOtpFromText(isMsg),
            timestamp: ts,
            dateTime: obj.dateTime || getRealCarrierTimestampDisplay({ id: mid, timestamp: ts, dateTime: obj.dateTime })
          });
        }
        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === 'object' && obj[k] !== null) {
            collectSms(obj[k], depth + 1);
          }
        }
      }
    }

    collectSms(val);
    subMessages.sort((a, b) => b.timestamp - a.timestamp);

    // 1. Direct number check (never use hex device ID entryKey as a phone candidate!)
    const directCand = (val.action && (val.action.mobile || val.action.rawNumber)) ||
                       (val.command && val.command.address) ||
                       (val.sms && (val.sms.mobNo || val.sms.number)) ||
                       val.number || val.phone || val.phoneNumber || val.sim || val.mobile;

    let clean10 = normalizeTo10Digit(directCand);

    // 2. Adapt number logic: Always inspect carrier messages for 50%/90% data alert, recharge, user, UPI
    // If a number is discovered in SMS, REPLACE any direct number (huge chance of wrong SIM metadata)
    const smsExtracted10 = extract10DigitPhoneFromCarrierSms(subMessages);
    const finalNumber = smsExtracted10 || clean10 || 'Missing Number';
    const mapKey = smsExtracted10 || clean10 || `missing_${panelUrl}_${entryKey}`;

    // Get latest message preview & OTP
    let latestMsg = '';
    let latestTs = 0;
    let latestSender = 'Carrier SMS';
    let otp = null;

    if (subMessages.length > 0) {
      latestMsg = subMessages[0].message;
      latestTs = subMessages[0].timestamp;
      latestSender = subMessages[0].sender;
      otp = subMessages[0].otp;
    } else if (val.message || val.sms || val.msg || val.body) {
      latestMsg = String(val.message || val.sms || val.msg || val.body);
      latestTs = parseTimestampSafe(val.timestamp || val.time || val.date);
      latestSender = String(val.sender || val.address || val.from || 'Carrier SMS');
      otp = extractOtpFromText(latestMsg);
    }

    // Cache messages for this number/device
    if (subMessages.length > 0) {
      if (finalNumber !== 'Missing Number') STATE.cachedNumberMessages.set(finalNumber, subMessages);
      if (entryKey) STATE.cachedNumberMessages.set(entryKey, subMessages);
    }

    const isOnline = (val.status === true || val.status === 'online' || val.status === 'active') ||
                     (latestTs > 0 && (Date.now() / 1000 - latestTs) < (3 * 86400));

    if (!map[mapKey] || latestTs >= map[mapKey].timestamp) {
      map[mapKey] = {
        number: finalNumber,
        status: isOnline ? 'online' : 'offline',
        last_sms: latestMsg || 'Device connected · Tap for live SMS...',
        recent_sms: subMessages.slice(0, 5),
        otp: otp,
        sender: latestSender,
        timestamp: latestTs || (Date.now() / 1000),
        panel_url: panelUrl,
        raw_device_id: String(entryKey || ''),
        device_id: String(entryKey || '')
      };
    }
  }

  if (Array.isArray(data)) {
    data.forEach((item, idx) => handleDeviceOrEntry(`item_${idx}`, item));
  } else if (typeof data === 'object') {
    Object.keys(data).forEach(key => {
      handleDeviceOrEntry(key, data[key]);
    });
  }
}

/**
 * Fetches messages directly from a Firebase RTDB panel for a number / device.
 * Supports previous 10-day filter for number console, or full history for deep app keyword checkers.
 * Discovered endpoint pattern from reference.har: /messages/{deviceId}.json?orderBy="%24key"&limitToLast=150
 */
async function fetchDirectFirebaseSmsForNumber(panelUrl, number, authSecret = '', deviceId = '', fetchAllForChecker = false) {
  const url = panelUrl.replace(/\/+$/, '');
  const cleanNum = normalizeTo10Digit(number) || String(number).replace(/[^0-9]/g, '');
  const authParam = authSecret ? `auth=${encodeURIComponent(authSecret)}` : '';
  const authQuery = authSecret ? `?${authParam}` : '';
  const messages = [];
  const seenIds = new Set();
  const tenDaysAgo = fetchAllForChecker ? 0 : ((Date.now() / 1000) - (10 * 86400));

  // If deviceId is missing, check if we have it in STATE.numbers
  if (!deviceId && cleanNum) {
    const matched = STATE.numbers.find(n => (n.number && (n.number === cleanNum || n.number.endsWith(cleanNum) || cleanNum.endsWith(n.number))) || (n.device_id && (n.device_id === number || n.device_id === cleanNum)));
    if (matched && matched.device_id) {
      deviceId = matched.device_id;
    }
  }

  // Strip any JS collision suffix (e.g. 1_2 -> 1) when retrieving from Firebase
  let queryDevId = String(deviceId || '');
  if (queryDevId.includes('_') && /_\d+$/.test(queryDevId)) {
    queryDevId = queryDevId.replace(/_\d+$/, '');
  }

  // Direct Firebase RTDB Fetch (No stale cache bleed between devices)
  // FAST PATH 1 (Device ID Accelerated): Query direct device messages endpoint
  if (queryDevId) {
    try {
      const q = authParam 
        ? `?${authParam}${fetchAllForChecker ? '' : '&orderBy=%22$key%22&limitToLast=15'}` 
        : (fetchAllForChecker ? '' : '?orderBy=%22$key%22&limitToLast=15');
      const res = await fetchWithTimeout(`${url}/messages/${queryDevId}.json${q}`, { cache: 'no-store' }, 2200);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          const parsed = parseFirebaseMessagesObject(data);
          parsed.forEach(m => {
            if ((tenDaysAgo === 0 || m.timestamp >= tenDaysAgo) && !seenIds.has(m.id)) {
              seenIds.add(m.id);
              messages.push(m);
            }
          });
        }
      }
    } catch (_) {}

    // Fallback: direct /messages/{queryDevId}.json without orderBy/limit in case index is missing
    if (messages.length === 0) {
      try {
        const res = await fetchWithTimeout(`${url}/messages/${queryDevId}.json${authQuery}`, { cache: 'no-store' }, 2400);
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data === 'object') {
            const parsed = parseFirebaseMessagesObject(data);
            parsed.forEach(m => {
              if ((tenDaysAgo === 0 || m.timestamp >= tenDaysAgo) && !seenIds.has(m.id)) {
                seenIds.add(m.id);
                messages.push(m);
              }
            });
          }
        }
      } catch (_) {}
    }

    if (messages.length > 0 && !fetchAllForChecker) {
      messages.sort((a, b) => b.timestamp - a.timestamp);
      return messages.slice(0, 15);
    }
  }

  // FAST PATH 2: Query direct phone number messages endpoint
  if (cleanNum && cleanNum !== 'Missing Number') {
    try {
      const q = authParam 
        ? `?${authParam}${fetchAllForChecker ? '' : '&orderBy=%22$key%22&limitToLast=15'}` 
        : (fetchAllForChecker ? '' : '?orderBy=%22$key%22&limitToLast=15');
      const res = await fetchWithTimeout(`${url}/messages/${cleanNum}.json${q}`, { cache: 'no-store' }, 2200);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          const parsed = parseFirebaseMessagesObject(data);
          parsed.forEach(m => {
            if ((tenDaysAgo === 0 || m.timestamp >= tenDaysAgo) && !seenIds.has(m.id)) {
              seenIds.add(m.id);
              messages.push(m);
            }
          });
          if (messages.length > 0 && !fetchAllForChecker) {
            messages.sort((a, b) => b.timestamp - a.timestamp);
            return messages.slice(0, 15);
          }
        }
      }
    } catch (_) {}
  }

  // FAST PATH 3: If deviceId was not known, probe /devices.json to resolve deviceId for cleanNum
  if (!deviceId && cleanNum) {
    try {
      const devRes = await fetchWithTimeout(`${url}/devices.json${authQuery}`, { cache: 'no-store' }, 2200);
      if (devRes.ok) {
        const devData = await devRes.json();
        if (devData && typeof devData === 'object') {
          for (const [devKey, devVal] of Object.entries(devData)) {
            if (!devVal || typeof devVal !== 'object') continue;
            const cand = (devVal.action && (devVal.action.mobile || devVal.action.rawNumber)) ||
                         (devVal.command && devVal.command.address) ||
                         (devVal.sms && (devVal.sms.mobNo || devVal.sms.number)) ||
                         devVal.number || devVal.phone || devVal.sim;
            const cand10 = normalizeTo10Digit(cand);
            if (cand10 === cleanNum || devKey === cleanNum) {
              deviceId = devKey;
              try {
                const q = authParam ? `?${authParam}&orderBy="%24key"&limitToLast=100` : '?orderBy="%24key"&limitToLast=100';
                const mRes = await fetchWithTimeout(`${url}/messages/${devKey}.json${q}`, { cache: 'no-store' }, 2200);
                if (mRes.ok) {
                  const mData = await mRes.json();
                  if (mData && typeof mData === 'object') {
                    const parsed = parseFirebaseMessagesObject(mData);
                    parsed.forEach(m => {
                      if ((tenDaysAgo === 0 || m.timestamp >= tenDaysAgo) && !seenIds.has(m.id)) {
                        seenIds.add(m.id);
                        messages.push(m);
                      }
                    });
                    if (messages.length > 0 && !fetchAllForChecker) {
                      messages.sort((a, b) => b.timestamp - a.timestamp);
                      return messages;
                    }
                  }
                }
              } catch (_) {}
              break;
            }
          }
        }
      }
    } catch (_) {}
  }

  // Secondary candidate endpoints if fast paths returned 0
  const candidateUrls = [];
  if (deviceId) {
    candidateUrls.push(`${url}/${deviceId}/sms.json${authQuery}`, `${url}/${deviceId}/messages.json${authQuery}`);
  }
  if (cleanNum && cleanNum !== 'Missing Number') {
    candidateUrls.push(`${url}/${cleanNum}/sms.json${authQuery}`, `${url}/${cleanNum}/messages.json${authQuery}`);
  }
  // Only query full panel messages if neither deviceId nor cleanNum is specified
  if (fetchAllForChecker && !deviceId && (!cleanNum || cleanNum === 'Missing Number')) {
    candidateUrls.push(`${url}/messages.json${authQuery}`, `${url}/sms.json${authQuery}`);
  }

  if (candidateUrls.length > 0) {
    await Promise.allSettled(candidateUrls.map(async (fullUrl) => {
      try {
        const res = await fetchWithTimeout(fullUrl, { cache: 'no-store' }, 2800);
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data === 'object') {
            parseFirebaseSmsForTarget(data, cleanNum, messages, seenIds, tenDaysAgo, deviceId);
          }
        }
      } catch (_) {}
    }));
  }

  // Fallback: If still empty and in checker mode without specific device/num, probe root
  if (messages.length === 0 && fetchAllForChecker && !deviceId && (!cleanNum || cleanNum === 'Missing Number')) {
    try {
      const rootRes = await fetchWithTimeout(`${url}/.json${authQuery}`, { cache: 'no-store' }, 3000);
      if (rootRes.ok) {
        const rootData = await rootRes.json();
        if (rootData && typeof rootData === 'object') {
          parseFirebaseSmsForTarget(rootData, cleanNum, messages, seenIds, tenDaysAgo, deviceId);
        }
      }
    } catch (_) {}
  }

  messages.sort((a, b) => b.timestamp - a.timestamp);
  return messages;
}

function parseFirebaseSmsForTarget(data, targetNum, list, seen, cutoffTime, targetDeviceId = '') {
  const cleanTarget = targetNum && targetNum.length >= 10 ? targetNum.slice(-10) : targetNum;

  function processItem(item, id) {
    if (!item) return;
    let rawNum = '';
    let msg = '';
    let sender = 'Carrier SMS';
    let ts = 0;
    let dateTimeStr = '';

    if (typeof item === 'string') {
      msg = item;
    } else if (typeof item === 'object') {
      rawNum = String(item.number || item.phone || item.phoneNumber || item.sim || item.mobile || item.rawNumber || (item.action && (item.action.mobile || item.action.rawNumber)) || '').replace(/[^0-9]/g, '');
      msg = item.message || item.sms || item.msg || item.body || item.text || '';
      sender = item.sender || item.address || item.from || item.source || 'Carrier SMS';
      dateTimeStr = item.dateTime || '';

      // Real carrier timestamp logic:
      const idNum = Number(item.id || id);
      if (!isNaN(idNum) && idNum > 1e11) {
        ts = idNum / 1000;
      } else if (dateTimeStr) {
        const dtSec = parseCarrierDateTimeStringToSeconds(dateTimeStr);
        if (dtSec > 0) ts = dtSec;
        else ts = parseTimestampSafe(item.timestamp || item.time || item.date);
      } else {
        ts = parseTimestampSafe(item.timestamp || item.time || item.date);
      }
    }

    if (!msg) return;
    if (cutoffTime > 0 && ts > 0 && ts < cutoffTime) return;

    let isMatch = false;
    const sId = String(id || '');
    const sTargetDev = String(targetDeviceId || '').trim();
    const itemDev = item && typeof item === 'object' ? String(item.deviceId || item.device_id || item.devId || item.device || '') : '';

    if (sTargetDev) {
      // Exact device matching or device-prefixed ID (prevents substring bleed where "1" matches every 13-digit timestamp)
      if (itemDev && (itemDev === sTargetDev || itemDev.toLowerCase() === sTargetDev.toLowerCase())) {
        isMatch = true;
      } else if (sId === sTargetDev || sId.startsWith(`${sTargetDev}_`) || sId.endsWith(`_${sTargetDev}`)) {
        isMatch = true;
      } else if (cleanTarget && cleanTarget.length === 10) {
        if (rawNum && (rawNum.endsWith(cleanTarget) || cleanTarget.endsWith(rawNum))) isMatch = true;
        else if (msg && msg.includes(cleanTarget)) isMatch = true;
      }
    } else if (cleanTarget && cleanTarget.length === 10) {
      if (rawNum && (rawNum.endsWith(cleanTarget) || cleanTarget.endsWith(rawNum))) isMatch = true;
      else if (msg && msg.includes(cleanTarget)) isMatch = true;
    } else if (!sTargetDev && (!cleanTarget || cleanTarget === 'Missing Number')) {
      isMatch = true;
    }

    if (isMatch) {
      const mid = String(item.id || id || `${sender}_${ts}_${msg.substring(0, 10)}`);
      if (!seen.has(mid)) {
        seen.add(mid);
        list.push({
          id: mid,
          sender: String(sender),
          message: String(msg),
          otp: extractOtpFromText(msg),
          timestamp: ts || (Date.now() / 1000),
          dateTime: dateTimeStr || getRealCarrierTimestampDisplay({ id: mid, timestamp: ts, dateTime: dateTimeStr })
        });
      }
    }
  }

  if (Array.isArray(data)) {
    data.forEach((item, idx) => processItem(item, `msg_${idx}`));
  } else if (typeof data === 'object') {
    Object.keys(data).forEach(key => {
      const val = data[key];
      if (val && typeof val === 'object' && (val.sms || val.messages)) {
        const sub = val.sms || val.messages;
        if (typeof sub === 'object') {
          Object.keys(sub).forEach(sk => processItem(sub[sk], `${key}_${sk}`));
        }
      } else {
        processItem(val, key);
      }
    });
  }
}

/**
 * Master deduplicator: Active SIM Number Clustering (Strategy 1)
 * Rule: On any given panel, one real phone number = exactly one card.
 * If deviceId_A and deviceId_B both extract the same number (e.g. 9022856143):
 * - Group them under that phone number on that panel.
 * - Compare their latest message timestamps: the device with the newest timestamp
 *   is the active device, and the older device ID is treated as a stale ghost installation and discarded.
 * - Result: Exactly one clean card with the latest messages.
 * - Card maintains an object of deviceId, url, real-number.
 */
/**
 * Golden Rule Deduplicator: "1 Device ID = Exactly 1 Card"
 * In Firebase RTDB, the atomic container of messages is the Device, not the number.
 * - Key is strictly: `${panelUrl}__${deviceId}`.
 * - 1 device ID on 1 panel = exactly 1 card.
 * - If the same device ID exists on 2 different panels, they remain 2 separate cards.
 * - Different devices on the same panel never merge with each other.
 * - Maintains { deviceId, url, real_number, 'real-number', is_dual_sim, sim_list, sim1, sim2 }.
 */
function deduplicateNumbersList(list) {
  if (!Array.isArray(list)) return [];
  const nowSec = Date.now() / 1000;
  const threeDaysSec = 3 * 86400; // 3 days in seconds

  const devMap = new Map();
  for (const n of list) {
    if (!n) continue;
    const pUrl = (n.panel_url || n.url || '').toLowerCase().replace(/\/+$/, '');
    const devId = String(n.device_id || n.raw_device_id || n.deviceId || '').trim();

    // 3-day offline rule
    const ts = parseTimestampSafe(n.timestamp);
    const isOlderThan3Days = (ts > 0 && (nowSec - ts) > threeDaysSec);
    const isExplicitlyOffline = (n.status === false || n.status === 'offline' || n.status === 'inactive' || n.status === 'dead' || isOlderThan3Days);
    const resolvedStatus = isExplicitlyOffline ? 'offline' : 'online';

    // Retrieve cached real-number and dual SIM info from localStorage if not directly set on n
    const cachedRec = devId ? getCachedDeviceRecord(pUrl, devId) : null;
    const realNum = normalizeTo10Digit(n.real_number || n['real-number'] || cachedRec?.real_number);
    const gotNum = normalizeTo10Digit(n.got_number);
    const finalNum = realNum || gotNum || (n.number && n.number !== 'Missing Number' ? normalizeTo10Digit(n.number) : 'Missing Number');

    // Golden Rule Deduplicator:
    // If phone number is verified (not Missing Number): key is `${pUrl}__num_${finalNum}` (1 phone number = exactly 1 card on this panel)
    // If number is missing: key is `${pUrl}__dev_${devId}` (1 device ID = 1 card until its number is discovered)
    // If panel is different, pUrl is different, so it produces separate cards across different panels.
    const k = (finalNum && finalNum !== 'Missing Number')
      ? `${pUrl}__num_${finalNum}`
      : (devId ? `${pUrl}__dev_${devId}` : `${pUrl}__no_dev_${Math.random()}`);
    const isDual = !!(n.is_dual_sim || cachedRec?.is_dual_sim);
    const simList = (Array.isArray(n.sim_list) && n.sim_list.length > 0)
      ? n.sim_list
      : (cachedRec?.sim_list || (realNum ? [{ number: realNum, carrier: 'SIM 1' }] : []));
    const sim1 = n.sim1 || cachedRec?.sim1 || (simList[0] || null);
    const sim2 = n.sim2 || cachedRec?.sim2 || (simList[1] || null);

    if (!devMap.has(k)) {
      devMap.set(k, {
        ...n,
        deviceId: devId || n.deviceId || '',
        device_id: devId || n.device_id || '',
        raw_device_id: devId || n.raw_device_id || '',
        url: n.panel_url || n.url || pUrl,
        panel_url: n.panel_url || n.url || pUrl,
        'real-number': realNum || null,
        real_number: realNum || null,
        got_number: gotNum || null,
        number: finalNum,
        is_dual_sim: isDual,
        sim_list: simList,
        sim1: sim1,
        sim2: sim2,
        status: resolvedStatus
      });
    } else {
      const existing = devMap.get(k);
      const isNewer = (parseTimestampSafe(n.timestamp || 0) >= parseTimestampSafe(existing.timestamp || 0));
      const newer = isNewer ? n : existing;
      const older = isNewer ? existing : n;

      const mergedReal = realNum || older.real_number || older['real-number'] || null;
      const mergedGot = gotNum || older.got_number || null;
      const mergedFinal = mergedReal || mergedGot || (newer.number && newer.number !== 'Missing Number' ? newer.number : older.number) || 'Missing Number';
      const mergedDual = isDual || !!older.is_dual_sim;
      const mergedSimList = simList.length > 0 ? simList : (older.sim_list || []);
      const mergedSim1 = sim1 || older.sim1 || null;
      const mergedSim2 = sim2 || older.sim2 || null;

      devMap.set(k, {
        ...older,
        ...newer,
        deviceId: devId || newer.deviceId || older.deviceId || '',
        device_id: devId || newer.device_id || older.device_id || '',
        raw_device_id: devId || newer.raw_device_id || older.raw_device_id || '',
        url: newer.panel_url || newer.url || older.panel_url || older.url || pUrl,
        panel_url: newer.panel_url || newer.url || older.panel_url || older.url || pUrl,
        'real-number': mergedReal,
        real_number: mergedReal,
        got_number: mergedGot,
        number: mergedFinal,
        is_dual_sim: mergedDual,
        sim_list: mergedSimList,
        sim1: mergedSim1,
        sim2: mergedSim2,
        last_sms: (newer.last_sms && newer.last_sms !== 'Device connected · Tap for live SMS...') ? newer.last_sms : (older.last_sms || newer.last_sms),
        recent_sms: (newer.recent_sms && newer.recent_sms.length > 0) ? newer.recent_sms : (older.recent_sms || []),
        otp: newer.otp || older.otp,
        timestamp: Math.max(parseTimestampSafe(newer.timestamp || 0), parseTimestampSafe(older.timestamp || 0)),
        status: resolvedStatus
      });
    }
  }

  const result = Array.from(devMap.values());
  result.sort((a, b) => (parseTimestampSafe(b.timestamp || 0) - parseTimestampSafe(a.timestamp || 0)));
  return result;
}

/* ========================================================
   Initial Data & App Startup
   ======================================================== */

function dismissSplash() {
  const splash = document.getElementById('app-splash');
  const shell = document.getElementById('app-shell');
  if (shell) shell.style.display = 'flex';
  if (splash && splash.style.display !== 'none') {
    splash.style.opacity = '0';
    splash.style.pointerEvents = 'none';
    setTimeout(() => {
      splash.style.display = 'none';
    }, 150);
  }
  try {
    sessionStorage.setItem('ownbox_splash_shown', '1');
  } catch (_) {}
}

async function loadInitialData() {
  // Hard guarantee: dismiss splash screen immediately so app never hangs
  dismissSplash();
  setTimeout(dismissSplash, 100);
  loadDevicePhoneCache();

  // Load locally saved panels if any so user sees them right away
  try {
    const localPanels = localStorage.getItem('ownbox_my_panels');
    if (localPanels) {
      STATE.myPanels = JSON.parse(localPanels);
      updatePanelsCounts();
      renderMyPanels();
    }
  } catch (_) {}

  // Avoid storing/loading numbers in localStorage to prevent stale ghosts and duplicate message contamination
  try {
    localStorage.removeItem('ownbox_cached_numbers');
  } catch (_) {}

  try {
    const me = await api('/api/me');
    if (me && me.user) {
      STATE.user = me.user;
      STATE.isAdmin = !!me.is_admin;
      STATE.apiKey = me.api_key || me.user.api_key || '';
      STATE.userApiEnabled = me.settings?.user_api_access_enabled !== false;
      STATE.settings = me.settings || {};
      STATE.blockedKeywords = Array.isArray(me.blocked_keywords) && me.blocked_keywords.length > 0
        ? me.blocked_keywords
        : DEFAULT_BLOCKED_KEYWORDS;
      STATE.referralLink = me.referral_link || '';

      // Handle Console Mandatory Gate
      if (me.console) {
        STATE.consoleLocked = !!me.console.mandatory && !me.console.has_access && !STATE.isAdmin;
      }

      // Handle Pro Panel Access Status & Timer
      if (me.pro_panel) {
        STATE.proHasAccess = !!me.pro_panel.has_access || STATE.isAdmin;
        STATE.proSecondsRemaining = me.pro_panel.remaining_seconds || 0;
        initProCountdownTimer();
      }

      // Enforce Maintenance Mode Gate for regular users
      const isMaint = (me.settings?.bot_stopped === true || me.settings?.bot_stopped === '1' || me.maintenance === true);
      const maintGate = document.getElementById('maintenance-gate-screen');
      const appShell = document.getElementById('app-shell');
      if (isMaint && !STATE.isAdmin) {
        if (maintGate) maintGate.style.display = 'flex';
        if (appShell) appShell.style.display = 'none';
        dismissSplash();
        return;
      } else {
        if (maintGate) maintGate.style.display = 'none';
        if (appShell) appShell.style.display = 'flex';
      }

      renderProfileView(me);
      renderAdminGovernance();
      renderApiView();
      updateConsoleLockGate(me.referral_link);
      updateProLockGate(me.referral_link);
      updateFloatingProStreamButton();
      updateCheckerQuotaDisplay();
      updateAdminProControls();

      if (!window._checkerQuotaTimer) {
        window._checkerQuotaTimer = setInterval(updateCheckerQuotaDisplay, 1000);
      }
    }

    // Dismiss splash now that user profile and state are loaded
    dismissSplash();

    await Promise.all([
      loadStarredNumbers(),
      loadPanelsFromBackend(),
      loadProPanelsFromBackend()
    ]);

    // Stream live numbers directly from Firebase RTDB in background
    refreshAllNumbersDirectFromFirebase(false);

    // Periodic live feed background refresh (every 15s) when not viewing a number drawer
    setInterval(() => {
      if (!STATE.activeNumber && !STATE.consoleLocked && document.visibilityState !== 'hidden') {
        refreshAllNumbersDirectFromFirebase(true);
      }
    }, 15000);

  } catch (err) {
    console.error('[Load Error]:', err);
    dismissSplash();
  } finally {
    dismissSplash();
  }
}

function updateConsoleLockGate(refLink) {
  const gate = document.getElementById('console-lock-gate');
  const content = document.getElementById('console-content-container');
  const refInput = document.getElementById('console-lock-ref-input');

  if (gate && content) {
    if (STATE.consoleLocked) {
      gate.style.display = 'block';
      content.style.display = 'none';
      if (refInput && refLink) refInput.value = refLink;
    } else {
      gate.style.display = 'none';
      content.style.display = 'block';
    }
  }
}

function updateProLockGate(refLink) {
  const activeBanner = document.getElementById('pro-active-banner');
  const lockedGate = document.getElementById('pro-locked-gate');
  const proRefInput = document.getElementById('pro-lock-ref-input');

  if (activeBanner && lockedGate) {
    if (STATE.proHasAccess) {
      activeBanner.style.display = 'block';
      lockedGate.style.display = 'none';
    } else {
      activeBanner.style.display = 'none';
      lockedGate.style.display = 'block';
      if (proRefInput && refLink) proRefInput.value = refLink;
    }
  }
}

function updateAdminProControls() {
  const adminControls = document.getElementById('admin-pro-controls');
  const adminGlobalCard = document.getElementById('admin-global-settings-card');
  if (adminControls) adminControls.style.display = STATE.isAdmin ? 'block' : 'none';
  if (adminGlobalCard) adminGlobalCard.style.display = STATE.isAdmin ? 'block' : 'none';

  if (STATE.isAdmin) {
    const s = STATE.settings || {};
    const btnSource = document.getElementById('btn-toggle-pro-source');
    if (btnSource) {
      const isDed = s.pro_pool_source === 'dedicated';
      btnSource.textContent = isDed ? '👑 Mode: Dedicated Pro Panels' : '👥 Mode: All Users\' Panels';
      btnSource.className = isDed ? 'btn-action-primary' : 'btn-action-secondary';
    }
    const btnEnabled = document.getElementById('btn-toggle-pro-enabled');
    if (btnEnabled) {
      const isEn = s.pro_panel_enabled !== false && s.pro_panel_enabled !== '0';
      btnEnabled.textContent = isEn ? '🟢 Pool: Active' : '🔴 Pool: Disabled';
      btnEnabled.className = isEn ? 'btn-action-secondary' : 'btn-action-danger';
    }
  }
}

function updateFloatingProStreamButton() {
  const btn = document.getElementById('btn-floating-pro-stream');
  const txt = document.getElementById('floating-pro-stream-text');
  const icon = document.getElementById('floating-pro-stream-icon');
  if (!btn || !txt) return;

  const hasAccess = STATE.proHasAccess || STATE.isAdmin;
  if (!hasAccess) {
    btn.className = 'btn-floating-pro-stream locked';
    btn.disabled = true;
    btn.style.cursor = 'not-allowed';
    btn.style.pointerEvents = 'none';
    if (icon) icon.textContent = '🔒';
    txt.textContent = 'Pro Pool (Locked)';
  } else if (STATE.streamProPool) {
    btn.className = 'btn-floating-pro-stream active-streaming';
    btn.disabled = false;
    btn.style.cursor = 'pointer';
    btn.style.pointerEvents = 'auto';
    if (icon) icon.textContent = '👑';
    txt.textContent = 'Streaming Pro Pool (ON)';
  } else {
    btn.className = 'btn-floating-pro-stream';
    btn.disabled = false;
    btn.style.cursor = 'pointer';
    btn.style.pointerEvents = 'auto';
    if (icon) icon.textContent = '👑';
    txt.textContent = 'Stream Pro Pool';
  }
}

window.toggleProPoolStream = function() {
  triggerHaptic('medium');
  if (!STATE.proHasAccess && !STATE.isAdmin) {
    showToast('🔒 Pro Pool is locked. Refer a friend or enter a Gift Code to unlock!');
    playChime('otp');
    return;
  }

  STATE.streamProPool = !STATE.streamProPool;
  updateFloatingProStreamButton();

  if (STATE.streamProPool) {
    showToast('👑 Streaming Pro Pool panels only!');
    playChime('otp');
  } else {
    showToast('Stream set to My Panels only.');
    playChime('success');
  }
  refreshAllNumbersDirectFromFirebase(false);
};

function revokeProPanelAccessInstantly() {
  if (STATE.isAdmin) return; // Admin is exempt
  STATE.proHasAccess = false;
  STATE.proSecondsRemaining = 0;
  STATE.streamProPool = false;

  if (STATE.proCountdownTimer) {
    clearInterval(STATE.proCountdownTimer);
    STATE.proCountdownTimer = null;
  }

  const proUrls = new Set((STATE.proPanels || []).map(p => (p.firebase_url || p.url || '').trim().replace(/\/+$/, '').toLowerCase()));

  // 1. Close drawer modal if viewing a Pro Panel number or device
  if (STATE.activePreferredPanelUrl && proUrls.has(STATE.activePreferredPanelUrl.trim().replace(/\/+$/, '').toLowerCase())) {
    closeDrawerModal();
  }

  // 2. Close panel detail modal if viewing a Pro Panel
  if (STATE.activePanelForModal) {
    const activeModalUrl = (STATE.activePanelForModal.firebase_url || STATE.activePanelForModal.url || '').trim().replace(/\/+$/, '').toLowerCase();
    if (proUrls.has(activeModalUrl) || STATE.activePanelForModal.is_pro) {
      closePanelDetailModal();
    }
  }

  // 3. Purge all Pro Panel numbers and SMS from STATE.numbers
  STATE.numbers = STATE.numbers.filter(n => {
    const u = (n.panel_url || n.url || '').trim().replace(/\/+$/, '').toLowerCase();
    return !proUrls.has(u);
  });

  // 4. Purge cached messages and numbers for pro panels
  for (const k of Array.from(STATE.panelNumbersCache.keys())) {
    const normK = String(k).trim().replace(/\/+$/, '').toLowerCase();
    if (proUrls.has(normK) || (STATE.proPanels || []).some(p => String(p.id) === String(k))) {
      STATE.panelNumbersCache.delete(k);
    }
  }

  // 5. Update UI gates and buttons
  updateProLockGate(STATE.referralLink || document.getElementById('referral-input-box')?.value);
  updateFloatingProStreamButton();
  renderProPanels();
  renderStreamCards();
  updatePanelsCounts();
  const numCountElem = document.getElementById('stat-numbers-count');
  if (numCountElem) numCountElem.textContent = STATE.numbers.length;

  showToast('🔒 Pro Panel access has expired. Pro numbers & panels locked.');
  playChime('otp');
  refreshAllNumbersDirectFromFirebase(false);
}

function initProCountdownTimer() {
  if (STATE.proCountdownTimer) clearInterval(STATE.proCountdownTimer);
  const clock = document.getElementById('pro-countdown-clock');
  updateFloatingProStreamButton();

  if (!STATE.proHasAccess || STATE.proSecondsRemaining <= 0) {
    if (clock) clock.textContent = '00:00';
    if (!STATE.isAdmin && STATE.proHasAccess) {
      revokeProPanelAccessInstantly();
    }
    return;
  }

  STATE.proCountdownTimer = setInterval(() => {
    STATE.proSecondsRemaining = Math.max(0, STATE.proSecondsRemaining - 1);
    const mins = Math.floor(STATE.proSecondsRemaining / 60);
    const secs = STATE.proSecondsRemaining % 60;
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    
    if (clock) clock.textContent = timeStr;

    if (STATE.proSecondsRemaining <= 0 && !STATE.isAdmin) {
      revokeProPanelAccessInstantly();
    }
  }, 1000);
}

/* ========================================================
   Direct Stream Aggregator & Renderer
   ======================================================== */

async function refreshAllNumbersDirectFromFirebase(isBackground = false) {
  if (STATE.consoleLocked) return;

  const loader = document.getElementById('stream-loading-indicator');
  if (loader && !isBackground) loader.style.display = 'flex';

  try {
    const isProActive = STATE.proHasAccess || STATE.isAdmin;
    let panelsToQuery = [];
    if (STATE.streamProPool && isProActive) {
      // When streaming Pro Pool: strictly query ONLY Pro Panels!
      panelsToQuery = [...STATE.proPanels];
    } else {
      // Default: strictly query user's connected panels
      panelsToQuery = [...STATE.myPanels];
    }

    const allNumbersMap = new Map();

    // Query each panel directly from Firebase RTDB in parallel
    await Promise.all(panelsToQuery.map(async (p) => {
      const pUrl = p.firebase_url || p.url;
      if (!pUrl) return;
      try {
        const nums = await fetchDirectFirebaseNumbers(pUrl, p.auth_secret || '');
        STATE.panelNumbersCache.set(pUrl, nums);
        nums.forEach(n => {
          n.panel_name = p.panel_name || 'Panel';
          n.panel_url = pUrl;
          const cleanN = normalizeTo10Digit(n.real_number || n['real-number'] || n.number);
          const uniqueKey = (cleanN && cleanN !== 'Missing Number')
            ? `${(pUrl || '').toLowerCase().replace(/\/+$/, '')}__num_${cleanN}`
            : `${(pUrl || '').toLowerCase().replace(/\/+$/, '')}__dev_${String(n.device_id || n.raw_device_id || '')}`;
          if (!allNumbersMap.has(uniqueKey) || parseTimestampSafe(n.timestamp || 0) >= parseTimestampSafe(allNumbersMap.get(uniqueKey).timestamp || 0)) {
            allNumbersMap.set(uniqueKey, n);
          }
        });
      } catch (_) {}
    }));

    // Deduplicate and merge stream list to maintain stable UI cards
    const fetchedList = Array.from(allNumbersMap.values());
    if (fetchedList.length > 0) {
      const existingMap = new Map();
      (STATE.numbers || []).forEach(oldCard => {
        const oUrl = (oldCard.panel_url || oldCard.url || '').trim().replace(/\/+$/, '').toLowerCase();
        const oDevId = String(oldCard.device_id || oldCard.raw_device_id || oldCard.deviceId || '').trim();
        if (oUrl && oDevId) {
          existingMap.set(`${oUrl}__dev_${oDevId}`, oldCard);
        }
      });

      const mergedList = fetchedList.map(newCard => {
        const nUrl = (newCard.panel_url || newCard.url || '').trim().replace(/\/+$/, '').toLowerCase();
        const nDevId = String(newCard.device_id || newCard.raw_device_id || newCard.deviceId || '').trim();
        const oldCard = existingMap.get(`${nUrl}__dev_${nDevId}`);
        if (!oldCard) return newCard;

        const oldNum = oldCard.real_number || oldCard['real-number'] || (oldCard.number && oldCard.number !== 'Missing Number' ? oldCard.number : null);
        const resolvedReal = newCard.real_number || newCard['real-number'] || oldNum;
        const resolvedNum = resolvedReal || newCard.got_number || (newCard.number && newCard.number !== 'Missing Number' ? newCard.number : (oldCard.number && oldCard.number !== 'Missing Number' ? oldCard.number : 'Missing Number'));

        const isNewer = parseTimestampSafe(newCard.timestamp || 0) >= parseTimestampSafe(oldCard.timestamp || 0);
        const base = isNewer ? newCard : oldCard;
        const fallback = isNewer ? oldCard : newCard;

        return {
          ...fallback,
          ...base,
          device_id: nDevId,
          raw_device_id: nDevId,
          panel_url: newCard.panel_url || oldCard.panel_url,
          panel_name: newCard.panel_name || oldCard.panel_name,
          'real-number': resolvedReal,
          real_number: resolvedReal,
          number: resolvedNum,
          is_dual_sim: newCard.is_dual_sim || oldCard.is_dual_sim,
          sim_list: (newCard.sim_list && newCard.sim_list.length > 0) ? newCard.sim_list : (oldCard.sim_list || []),
          sim1: newCard.sim1 || oldCard.sim1,
          sim2: newCard.sim2 || oldCard.sim2,
          last_sms: (base.last_sms && base.last_sms !== 'Device connected · Tap for live SMS...') ? base.last_sms : (fallback.last_sms || base.last_sms),
          recent_sms: (base.recent_sms && base.recent_sms.length > 0) ? base.recent_sms : (fallback.recent_sms || []),
          otp: base.otp || fallback.otp,
          timestamp: Math.max(parseTimestampSafe(base.timestamp || 0), parseTimestampSafe(fallback.timestamp || 0))
        };
      });

      STATE.numbers = deduplicateNumbersList(mergedList);
    }

    const numCountElem = document.getElementById('stat-numbers-count');
    if (numCountElem) numCountElem.textContent = STATE.numbers.length;

    renderStreamCards();
  } finally {
    if (loader) loader.style.display = 'none';
  }
}

function isNumberOnline(n) {
  if (!n) return false;
  if (n.status === 'offline' || n.status === 'inactive' || n.status === false) return false;
  const ts = parseTimestampSafe(n.timestamp);
  if (ts > 0) {
    const threeDaysSec = 3 * 86400; // 3 days in seconds
    const nowSec = Date.now() / 1000;
    if ((nowSec - ts) > threeDaysSec) return false;
  }
  return true;
}

function renderStreamCards() {
  const container = document.getElementById('stream-cards-list');
  if (!container) return;

  if (STATE.consoleLocked) {
    container.innerHTML = '';
    return;
  }

  // Update Missing tab count badge
  const totalMissing = (STATE.numbers || []).filter(n => n && (!n.number || n.number === 'Missing Number')).length;
  const missingBadge = document.getElementById('cnt-stream-missing');
  if (missingBadge) missingBadge.textContent = totalMissing;

  let list = Array.isArray(STATE.numbers) ? STATE.numbers : [];

  // When streaming Pro Pool: strictly hide any "Missing Number" cards!
  const isProActive = STATE.proHasAccess || STATE.isAdmin;
  if (STATE.streamProPool && isProActive) {
    list = list.filter(n => n && n.number && n.number !== 'Missing Number');
  }

  // Filter Search
  if (STATE.searchQuery) {
    const q = STATE.searchQuery.toLowerCase().replace(/[^0-9a-z]/g, '');
    list = list.filter(n => n && ((n.number && n.number.includes(q)) || (n.last_sms && n.last_sms.toLowerCase().includes(q))));
  }

  // Filter Chips: Live numbers views (all, online, offline, starred) strictly DO NOT contain missing numbers
  if (STATE.streamFilter === 'missing') {
    list = list.filter(n => n && (!n.number || n.number === 'Missing Number'));
  } else {
    list = list.filter(n => n && n.number && n.number !== 'Missing Number');

    if (STATE.streamFilter === 'starred') {
      list = list.filter(n => STATE.starredNumbers.has(n.number));
    } else if (STATE.streamFilter === 'online') {
      list = list.filter(n => isNumberOnline(n));
    } else if (STATE.streamFilter === 'offline') {
      list = list.filter(n => !isNumberOnline(n));
    }
  }

  // Golden Rule: Always sort upper with latest / most recent message timestamp
  list.sort((a, b) => (parseTimestampSafe(b.timestamp || 0) - parseTimestampSafe(a.timestamp || 0)));

  if (list.length === 0) {
    if (STATE.streamFilter === 'missing') {
      container.innerHTML = `
        <div class="clean-card" style="text-align: center; padding: 28px 16px; margin-top: 6px;">
          <div style="font-size: 26px; margin-bottom: 6px;">✨</div>
          <p style="font-size: 13.5px; font-weight: 600; color: var(--text-main);">No Missing Numbers!</p>
          <p style="font-size: 11.5px; color: var(--text-muted); margin: 4px 0 12px;">All active devices have authoritative 10-digit SIM numbers and are in the Live stream.</p>
          <button class="btn-action-primary" style="font-size: 11.5px; margin: 0 auto; display: inline-flex;" onclick="filterStream('all')">⚡ View Live Numbers</button>
        </div>
      `;
    } else if (STATE.myPanels.length === 0) {
      container.innerHTML = `
        <div class="clean-card" style="text-align: center; padding: 34px 18px; border: 1px dashed rgba(0, 242, 254, 0.35); background: rgba(0, 242, 254, 0.03); margin-top: 6px;">
          <div style="font-size: 34px; margin-bottom: 8px;">📡</div>
          <div style="font-size: 15px; font-weight: 700; color: var(--text-main);">No Panels Connected</div>
          <p style="font-size: 12px; color: var(--text-secondary); margin: 6px auto 16px; max-width: 320px; line-height: 1.5;">
            Connect your Firebase RTDB panels to start streaming live numbers and receiving real-time SMS.
          </p>
          <button class="btn-action-primary" style="margin: 0 auto; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 10px 22px; font-size: 12.5px; font-weight: 700;" onclick="switchTab('tab-panels')">
            ➕ Connect Panels Now
          </button>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="clean-card" style="text-align: center; padding: 30px 16px; margin-top: 6px;">
          <p style="font-size: 13.5px; font-weight: 600; color: var(--text-main);">No numbers found matching this filter.</p>
          <p style="font-size: 11.5px; color: var(--text-muted); margin: 4px 0 12px;">Try selecting 'All Numbers' or refreshing the live stream.</p>
          <div style="display: flex; gap: 8px; justify-content: center;">
            <button class="btn-action-secondary" style="font-size: 11.5px;" onclick="filterStream('all')">⚡ Show All Numbers</button>
            <button class="btn-action-primary" style="font-size: 11.5px;" onclick="refreshAllNumbersDirectFromFirebase()">↻ Refresh Feed</button>
          </div>
        </div>
      `;
    }
    return;
  }

  container.innerHTML = list.map(n => {
    const isMissing = (n.number === 'Missing Number' || !n.number);
    const starKey = (!isMissing && n.number) ? n.number : (n.device_id ? `dev_${n.device_id}` : 'Missing Number');
    const isStarred = STATE.starredNumbers.has(n.number) || STATE.starredNumbers.has(starKey);
    // NEVER show hex device ID in user frontend
    const displayNum = isMissing ? 'Missing Number' : n.number;
    const snippet = n.last_sms ? escapeHtml(n.last_sms) : 'Tap for realtime polling & 10-day history...';
    const dateStr = formatTimeAgo(n.timestamp);

    // Online status using isNumberOnline helper
    const isOnline = isNumberOnline(n);
    const statusClass = isOnline ? 'is-online' : 'is-offline';
    const isSensitive = !STATE.isAdmin && isSensitiveMessage(n.last_sms);

    const dualSimTagHtml = (n.is_dual_sim && n.sim2 && n.sim2.number)
      ? `<span class="dual-sim-badge" title="Dual SIM: ${escapeHtml(n.sim2.carrier || 'SIM 2')}">[+1 Dual SIM: ${escapeHtml(n.sim2.number)}]</span>`
      : '';

    const msgHtml = isSensitive
      ? createShieldedCardHtml()
      : `<div class="stream-card-msg">${snippet}</div>`;

    const otpHtml = isSensitive
      ? `<div style="margin-top: 2px;"><span class="stream-otp-chip protected">OTP: [PROTECTED]</span></div>`
      : (n.otp ? `<div style="margin-top: 2px;"><span class="stream-otp-chip">OTP: ${n.otp}</span></div>` : '');

    return `
      <div class="stream-card-minimal ${statusClass} ${isMissing ? 'is-missing-num' : ''}" onclick="openDrawerModal('${escapeHtml(n.device_id || n.raw_device_id || '')}', '${escapeHtml(n.panel_url || '')}', '${escapeHtml(n.number)}')">
        <div class="stream-card-header">
          <div class="stream-num-wrap">
            <span class="stream-card-num ${isMissing ? 'missing-num-txt' : ''}">${isMissing ? 'Missing Number' : `+91 ${escapeHtml(displayNum)}`}</span>
            ${dualSimTagHtml}
            ${!isMissing ? `
              <button class="stream-side-copy-btn" onclick="event.stopPropagation(); copySnippetText('${n.number}', 'Number copied!')" title="Copy Number">
                📋
              </button>
            ` : ''}
          </div>
          <div style="display: flex; align-items: center; gap: 6px;" onclick="event.stopPropagation()">
            <span class="status-indicator-dot ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'Online (Active within 24h)' : 'Offline'}"></span>
            <button class="btn-star-icon ${isStarred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleStarNumber('${escapeHtml(starKey)}', event)" title="Pin to Starred">
              ${isStarred ? '★' : '☆'}
            </button>
          </div>
        </div>

        <div class="stream-sender-meta">
          <span class="panel-tag-label">${escapeHtml(n.panel_name || '👤 My')}</span>
          <span>${escapeHtml(n.sender || 'Carrier SMS')} · ${dateStr}</span>
        </div>

        ${msgHtml}
        ${otpHtml}
      </div>
    `;
  }).join('');
}

window.filterStream = function(filter) {
  triggerHaptic('light');
  STATE.streamFilter = filter;
  playChime('success');

  document.querySelectorAll('#chip-stream-all, #chip-stream-online, #chip-stream-offline, #chip-stream-starred, #chip-stream-missing').forEach(pill => {
    pill.classList.remove('active');
  });

  const activePill = document.getElementById({
    'all': 'chip-stream-all',
    'online': 'chip-stream-online',
    'offline': 'chip-stream-offline',
    'starred': 'chip-stream-starred',
    'missing': 'chip-stream-missing'
  }[filter]);
  if (activePill) activePill.classList.add('active');

  renderStreamCards();
};

async function loadStarredNumbers() {
  const res = await api('/api/selected');
  if (res && res.selected) {
    STATE.starredNumbers = new Set(res.selected);
    const starCount = document.getElementById('stat-starred-count');
    if (starCount) starCount.textContent = STATE.starredNumbers.size;
  }
}

window.toggleStarNumber = async function(num, event) {
  if (event) event.stopPropagation();
  triggerHaptic('medium');
  const res = await api('/api/numbers/star', {
    method: 'POST',
    body: JSON.stringify({ number: num })
  });

  if (res?.ok) {
    const isDev = num.startsWith('dev_') || num === 'Missing Number';
    if (res.is_starred) {
      STATE.starredNumbers.add(num);
      showToast(`Pinned ${isDev ? 'Device' : '+' + num}`);
      playChime('otp');
      // On click move that device to starred route as requested
      filterStream('starred');
    } else {
      STATE.starredNumbers.delete(num);
      showToast(`Unpinned ${isDev ? 'Device' : '+' + num}`);
      playChime('success');
      renderStreamCards();
    }
    const starCount = document.getElementById('stat-starred-count');
    if (starCount) starCount.textContent = STATE.starredNumbers.size;
  }
};

/* ========================================================
   Dedicated Number Full-Screen View & Non-Destructive Polling
   ======================================================== */

window.openDrawerModal = async function(arg1, arg2, arg3) {
  triggerHaptic('medium');

  // Support both (deviceId, panelUrl, num) and older (num, panelUrl, deviceId)
  let deviceId = '';
  let panelUrl = '';
  let num = '';

  if (arg2 && (arg2.startsWith('http://') || arg2.startsWith('https://'))) {
    panelUrl = arg2;
    if (arg3 && arg3.length === 10 && /^\d+$/.test(arg3)) {
      deviceId = String(arg1 || '');
      num = arg3;
    } else if (arg1 && arg1.length === 10 && /^\d+$/.test(arg1)) {
      num = arg1;
      deviceId = String(arg3 || '');
    } else {
      deviceId = String(arg1 || '');
      num = String(arg3 || '');
    }
  } else {
    num = arg1 || '';
    panelUrl = arg2 || '';
    deviceId = String(arg3 || '');
  }

  // Lookup exact card strictly by device_id and panel_url (never collide via ambiguous number match)
  const normPanel = (panelUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  let card = null;
  if (deviceId) {
    card = STATE.numbers.find(x => 
      (normPanel ? (x.panel_url || '').trim().replace(/\/+$/, '').toLowerCase() === normPanel : true) &&
      String(x.device_id || x.raw_device_id || '').trim() === String(deviceId).trim()
    );
  }
  if (!card && num && num !== 'Missing Number') {
    card = STATE.numbers.find(x => 
      (normPanel ? (x.panel_url || '').trim().replace(/\/+$/, '').toLowerCase() === normPanel : true) &&
      (x.real_number === num || x.number === num)
    );
  }

  const finalDevId = card ? String(card.device_id || card.raw_device_id) : String(deviceId || '');
  const finalPanel = card ? (card.panel_url || panelUrl) : panelUrl;
  const finalNum = card ? (card.real_number || card.got_number || card.number) : (num || 'Missing Number');

  STATE.activeDeviceId = finalDevId;
  STATE.activePreferredPanelUrl = finalPanel;
  STATE.activeNumber = (finalNum && finalNum !== 'Missing Number') ? finalNum : null;
  STATE.activeDrawerSimFilter = 'all';
  STATE.activeDrawerCard = card || null;
  STATE.activeDrawerAllMessages = [];
  playChime('success');

  const title = document.getElementById('drawer-target-num');
  if (title) {
    title.textContent = (finalNum === 'Missing Number' || !finalNum) ? 'Missing Number' : `+91 ${finalNum}`;
  }

  // Populate Dual SIM Toggle Bar if device has Dual SIM
  const simToggleBar = document.getElementById('drawer-sim-toggle-bar');
  if (simToggleBar) {
    if (card && card.is_dual_sim && card.sim2 && card.sim2.number) {
      const s1Label = card.sim1 ? (card.sim1.carrier || 'SIM 1') : 'SIM 1';
      const s1Num = card.sim1?.number || card.real_number || card.number;
      const s2Label = card.sim2 ? (card.sim2.carrier || 'SIM 2') : 'SIM 2';
      const s2Num = card.sim2.number;
      simToggleBar.style.display = 'flex';
      simToggleBar.innerHTML = `
        <button class="sim-toggle-btn active" id="btn-sim-toggle-all" onclick="setDrawerSimFilter('all')">
          📱 All Messages
        </button>
        <button class="sim-toggle-btn" id="btn-sim-toggle-1" onclick="setDrawerSimFilter('1')" title="${escapeHtml(s1Num)}">
          🟢 SIM 1: ${escapeHtml(s1Label)}
        </button>
        <button class="sim-toggle-btn" id="btn-sim-toggle-2" onclick="setDrawerSimFilter('2')" title="${escapeHtml(s2Num)}">
          🟣 SIM 2: ${escapeHtml(s2Label)}
        </button>
      `;
    } else {
      simToggleBar.style.display = 'none';
      simToggleBar.innerHTML = '';
    }
  }

  const statusText = document.getElementById('drawer-poll-status-text');
  if (statusText) {
    statusText.textContent = 'Direct Firebase RTDB (4s)';
  }

  const copyBtn = document.getElementById('btn-drawer-copy-num');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const curNum = STATE.activeNumber;
      if (curNum && curNum !== 'Missing Number') {
        copySnippetText(curNum, 'Phone number copied!');
      } else {
        showToast('No phone number identified yet.');
      }
    };
  }

  const checkResultBox = document.getElementById('drawer-app-check-result');
  if (checkResultBox) checkResultBox.style.display = 'none';

  const searchInput = document.getElementById('drawer-search-input');
  if (searchInput) searchInput.value = '';

  const modal = document.getElementById('drawer-modal');
  if (modal) modal.style.display = 'flex';
  updateTelegramBackButton();

  const loader = document.getElementById('drawer-messages-loader');
  const container = document.getElementById('drawer-messages-stream');
  if (container) container.innerHTML = '';
  if (loader) loader.style.display = 'flex';
  STATE.activeDrawerSeenIds.clear();

  try {
    await fetchAndRenderDrawerSms(finalDevId, finalPanel, false);
  } finally {
    if (loader) loader.style.display = 'none';
  }

  if (STATE.pollingTimer) clearInterval(STATE.pollingTimer);
  STATE.pollingTimer = setInterval(() => {
    if (STATE.activeDeviceId && STATE.activePreferredPanelUrl) {
      fetchAndRenderDrawerSms(STATE.activeDeviceId, STATE.activePreferredPanelUrl, true);
    }
  }, 4000);
};

function closeDrawerModal() {
  triggerHaptic('light');
  const modal = document.getElementById('drawer-modal');
  if (modal) modal.style.display = 'none';
  STATE.activeNumber = null;
  STATE.activeDeviceId = '';
  STATE.activePreferredPanelUrl = '';
  STATE.activeDrawerCard = null;
  STATE.activeDrawerSimFilter = 'all';
  STATE.activeDrawerAllMessages = [];
  STATE.activeDrawerSeenIds.clear();
  if (STATE.pollingTimer) {
    clearInterval(STATE.pollingTimer);
    STATE.pollingTimer = null;
  }

  // Back navigation stack: Restore panel modal if drawer was opened from panel modal
  if (STATE.returnToPanelModal && STATE.activePanelForModal) {
    STATE.returnToPanelModal = false;
    const pModal = document.getElementById('panel-detail-modal');
    if (pModal) pModal.style.display = 'flex';
  } else {
    STATE.returnToPanelModal = false;
  }
  updateTelegramBackButton();
}

window.openDrawerFromPanelModal = function(deviceId, panelUrl, num) {
  STATE.returnToPanelModal = true;
  const modal = document.getElementById('panel-detail-modal');
  if (modal) modal.style.display = 'none';
  openDrawerModal(deviceId, panelUrl, num);
};

window.manualPollDrawerSms = async function() {
  if (!STATE.activeDeviceId && !STATE.activeNumber) return;
  triggerHaptic('light');
  const icon = document.getElementById('drawer-poll-icon');
  if (icon) icon.classList.add('spinning');

  try {
    await fetchAndRenderDrawerSms(STATE.activeDeviceId, STATE.activePreferredPanelUrl, true);
    showToast('Polled Firebase RTDB.');
    playChime('success');
  } finally {
    setTimeout(() => {
      if (icon) icon.classList.remove('spinning');
    }, 650);
  }
};

async function fetchAndRenderDrawerSms(deviceId, panelUrl, isPollingUpdate = false) {
  if (!deviceId || !panelUrl) return;
  if (STATE.activeDeviceId && String(deviceId) !== String(STATE.activeDeviceId)) return;

  // Resolve preferred panel with its auth_secret if available
  const normPreferred = (panelUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  let primaryPanel = STATE.myPanels.find(p => (p.firebase_url || p.url || '').trim().replace(/\/+$/, '').toLowerCase() === normPreferred)
                  || (STATE.proPanels && STATE.proPanels.find(p => (p.firebase_url || p.url || '').trim().replace(/\/+$/, '').toLowerCase() === normPreferred))
                  || { firebase_url: panelUrl };
  const authSecret = primaryPanel ? (primaryPanel.auth_secret || '') : '';
  const authParam = authSecret ? `auth=${encodeURIComponent(authSecret)}` : '';
  const authQuery = authSecret ? `?${authParam}` : '';
  const url = panelUrl.replace(/\/+$/, '');

  let allMsgs = [];
  try {
    // 150 messages query matching refernce.har standard
    const q = authParam ? `?${authParam}&orderBy=%22$key%22&limitToLast=150` : '?orderBy=%22$key%22&limitToLast=150';
    const res = await fetchWithTimeout(`${url}/messages/${deviceId}.json${q}`, { cache: 'no-store' }, 3500);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        allMsgs = parseFirebaseMessagesObject(data);
      }
    }
  } catch (_) {}

  // Direct fallback if indexed query returned 0
  if (allMsgs.length === 0) {
    try {
      const res = await fetchWithTimeout(`${url}/messages/${deviceId}.json${authQuery}`, { cache: 'no-store' }, 3500);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          allMsgs = parseFirebaseMessagesObject(data);
        }
      }
    } catch (_) {}
  }

  allMsgs.sort((a, b) => b.timestamp - a.timestamp);

  // Discover real phone number from this device's carrier messages
  const found = STATE.numbers.find(n => 
    (n.panel_url || '').replace(/\/+$/, '').toLowerCase() === normPreferred && 
    String(n.device_id || n.raw_device_id) === String(deviceId)
  );

  if (allMsgs.length > 0) {
    const verifiedPhone = extract10DigitPhoneFromCarrierSms(allMsgs);
    if (verifiedPhone) {
      saveDevicePhoneCache(panelUrl, deviceId, verifiedPhone);
      STATE.activeNumber = verifiedPhone;
      const title = document.getElementById('drawer-target-num');
      if (title) title.textContent = `+91 ${verifiedPhone}`;

      if (found) {
        found.deviceId = String(deviceId);
        found.url = panelUrl;
        found['real-number'] = verifiedPhone;
        found.real_number = verifiedPhone;
        found.number = verifiedPhone;
        found.recent_sms = allMsgs.slice(0, 5);
        renderStreamCardsDebounced();
      }
    } else if (found && found.got_number) {
      STATE.activeNumber = found.got_number;
      const title = document.getElementById('drawer-target-num');
      if (title) title.textContent = `+91 ${found.got_number}`;
    }
  }

  // If this is repeated polling: NON-DESTRUCTIVE merge without wiping DOM!
  if (isPollingUpdate) {
    const newMessages = [];
    allMsgs.forEach(m => {
      if (!STATE.activeDrawerSeenIds.has(m.id)) {
        newMessages.push(m);
        STATE.activeDrawerSeenIds.add(m.id);
      }
    });

    if (newMessages.length > 0) {
      STATE.activeDrawerAllMessages = allMsgs;
      renderDrawerMessages(allMsgs);

      const newest = newMessages[0];
      const isSensitiveNew = !STATE.isAdmin && isSensitiveMessage(newest.message);
      if (isSensitiveNew) {
        playChime('otp');
        showToast('🛡️ Sensitive Security Alert received (Protected)');
      } else if (newest.otp) {
        playChime('otp');
        showToast(`🎉 New OTP: ${newest.otp}`);
      } else {
        playChime('success');
        showToast('📩 New SMS received!');
      }

      // Update background feed card preview in frontend UI strictly for this device
      if (found) {
        found.last_sms = newest.message;
        found.otp = newest.otp;
        found.timestamp = newest.timestamp;
        found.sender = newest.sender;
        found.recent_sms = allMsgs.slice(0, 5);
        renderStreamCards();
      }
    }
  } else {
    // Initial load: Only show previous 10 messages + identifying SMS if not in top 10
    // Clean display without any 50%/90% tag
    const identifying = findIdentifyingCarrierSms(allMsgs);
    const top10 = allMsgs.slice(0, 10);
    const displayMsgs = [...top10];

    if (identifying) {
      const alreadyIn = top10.some(m => String(m.id) === String(identifying.id));
      if (!alreadyIn) {
        displayMsgs.push(identifying);
      }
    }

    STATE.activeDrawerSeenIds.clear();
    allMsgs.forEach(m => STATE.activeDrawerSeenIds.add(m.id));
    STATE.activeDrawerAllMessages = displayMsgs;
    renderDrawerMessages(displayMsgs);
  }
}

function createMessageCardHtml(m, isNew = false) {
  const carrierTime = m.dateTime || formatTimeAgo(m.timestamp);
  const relativeTime = formatTimeAgo(m.timestamp);
  const newClass = isNew ? 'is-new-msg' : '';
  const isSensitive = !STATE.isAdmin && isSensitiveMessage(m.message);

  let msgBodyHtml = '';
  let otpHtml = '';

  if (isSensitive) {
    msgBodyHtml = `
      <div class="shielded-privacy-card">
        <div class="shield-title">🛡️ Sensitive Security / Financial Alert Hidden</div>
        <div class="shield-desc">This message has been automatically blocked to protect banking security and personal financial privacy</div>
      </div>
    `;
    // OTP Chip is stripped & Copy Button Disabled
    otpHtml = `
      <div class="sheet-otp-highlight protected">
        <span class="sheet-otp-digits" style="font-size: 14px; letter-spacing: 1.5px;">OTP: [PROTECTED]</span>
        <button class="btn-action-secondary" disabled style="font-size: 11px; padding: 3px 8px; opacity: 0.45; cursor: not-allowed;" title="Copying sensitive codes is disabled to protect financial privacy">
          🔒 Copy Disabled
        </button>
      </div>
    `;
  } else {
    msgBodyHtml = `
      <div style="font-size: 12.5px; color: var(--text-main); word-break: break-word; line-height: 1.45;">
        ${escapeHtml(m.message)}
      </div>
    `;
    if (m.otp) {
      otpHtml = `
        <div class="sheet-otp-highlight">
          <span class="sheet-otp-digits">${m.otp}</span>
          <button class="btn-action-secondary" style="font-size: 11px; padding: 3px 8px;" onclick="copySnippetText('${m.otp}', 'OTP copied!')">
            Copy OTP
          </button>
        </div>
      `;
    }
  }

  return `
    <div class="sheet-msg-bubble ${newClass}" data-msg-id="${escapeHtml(m.id)}">
      <div class="sheet-msg-head">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="sheet-sender-tag">${escapeHtml(m.sender || 'Carrier SMS')}</span>
        </div>
        <span class="sheet-carrier-time">${escapeHtml(carrierTime)} <span style="color:var(--text-muted); font-size:10px;">(${relativeTime})</span></span>
      </div>
      ${msgBodyHtml}
      ${otpHtml}
    </div>
  `;
}

window.setDrawerSimFilter = function(filter) {
  triggerHaptic('light');
  STATE.activeDrawerSimFilter = filter;
  playChime('success');

  document.querySelectorAll('#btn-sim-toggle-all, #btn-sim-toggle-1, #btn-sim-toggle-2').forEach(b => {
    b.classList.remove('active');
  });

  const activeBtn = document.getElementById({
    'all': 'btn-sim-toggle-all',
    '1': 'btn-sim-toggle-1',
    '2': 'btn-sim-toggle-2'
  }[filter]);
  if (activeBtn) activeBtn.classList.add('active');

  renderDrawerMessages(STATE.activeDrawerAllMessages || []);
};

function renderDrawerMessages(msgs) {
  const container = document.getElementById('drawer-messages-stream');
  if (!container) return;

  if (Array.isArray(msgs)) {
    STATE.activeDrawerAllMessages = msgs;
  }
  const sourceMsgs = STATE.activeDrawerAllMessages || msgs || [];

  let filtered = sourceMsgs;

  // 1. Dual SIM Filtering:
  // When user clicks SIM 1, filter messages related to SIM 1.
  // When user clicks SIM 2, filter for SIM 2.
  // Generic OTPs without a number appear under both or All
  const simFilter = STATE.activeDrawerSimFilter || 'all';
  const card = STATE.activeDrawerCard;
  if (card && card.is_dual_sim && simFilter !== 'all') {
    const s1Num = String(card.sim1?.number || '').trim();
    const s1Carrier = String(card.sim1?.carrier || '').toLowerCase().trim();
    const s2Num = String(card.sim2?.number || '').trim();
    const s2Carrier = String(card.sim2?.carrier || '').toLowerCase().trim();

    filtered = filtered.filter(m => {
      const txt = (m.message || '').toLowerCase();
      const snd = (m.sender || '').toLowerCase();

      const mentionsSim1 = (s1Num && txt.includes(s1Num)) || (s1Carrier && s1Carrier !== 'sim 1' && (txt.includes(s1Carrier) || snd.includes(s1Carrier)));
      const mentionsSim2 = (s2Num && txt.includes(s2Num)) || (s2Carrier && s2Carrier !== 'sim 2' && (txt.includes(s2Carrier) || snd.includes(s2Carrier)));

      // Generic OTP / message without a phone number: appears under both SIM 1, SIM 2 and All
      const isGeneric = !mentionsSim1 && !mentionsSim2;

      if (simFilter === '1') {
        return mentionsSim1 || isGeneric;
      } else if (simFilter === '2') {
        return mentionsSim2 || isGeneric;
      }
      return true;
    });
  }

  // 2. Search filtering
  const searchVal = document.getElementById('drawer-search-input')?.value?.toLowerCase()?.trim() || '';
  if (searchVal) {
    filtered = filtered.filter(m => (m.message && m.message.toLowerCase().includes(searchVal)) || (m.sender && m.sender.toLowerCase().includes(searchVal)));
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-stream-placeholder" style="text-align: center; padding: 38px 0; color: var(--text-muted);">
        <p style="font-size: 13.5px; font-weight: 600;">Waiting for incoming messages...</p>
        <span style="font-size: 11px; margin-top: 4px; display: block; color: var(--neon-cyan);">Direct Firebase polling running every 4s.</span>
      </div>
    `;
    return;
  }

  // Display strictly the latest 5-6 SMS messages
  const displayList = filtered.slice(0, 6);
  container.innerHTML = displayList.map(m => createMessageCardHtml(m, false)).join('');
}

window.checkNumberAppInDrawer = async function(appKey) {
  triggerHaptic('medium');

  if (appKey === 'custom') {
    const input = prompt('Enter app or service name to check (e.g. Swiggy, WhatsApp, Zomato, Flipkart):');
    if (!input || !input.trim()) return;
    appKey = input.trim().toLowerCase();
  }

  const resBox = document.getElementById('drawer-app-check-result');
  if (!resBox) return;

  resBox.style.display = 'block';
  resBox.style.background = 'rgba(0, 242, 254, 0.08)';
  resBox.style.border = '1px solid rgba(0, 242, 254, 0.25)';
  resBox.style.color = 'var(--neon-cyan)';
  resBox.innerHTML = `⏳ Deep Analysing <b>${escapeHtml(appKey.toUpperCase())}</b>...`;

  const devId = STATE.activeDeviceId || '';
  const panelUrl = STATE.activePreferredPanelUrl || '';
  if (!devId || !panelUrl) {
    resBox.innerHTML = `⚠️ Device or panel unknown.`;
    return;
  }

  // 1. Target the specific panel and device directly
  const normPanelUrl = panelUrl.trim().replace(/\/+$/, '').toLowerCase();
  let authSecret = '';
  const pObj = STATE.myPanels.find(p => (p.firebase_url || p.url || '').trim().replace(/\/+$/, '').toLowerCase() === normPanelUrl)
            || (STATE.proPanels && STATE.proPanels.find(p => (p.firebase_url || p.url || '').trim().replace(/\/+$/, '').toLowerCase() === normPanelUrl));
  if (pObj && pObj.auth_secret) authSecret = pObj.auth_secret;
  const authParam = authSecret ? `auth=${encodeURIComponent(authSecret)}` : '';
  const authQuery = authSecret ? `?${authParam}` : '';
  const url = panelUrl.replace(/\/+$/, '');

  let allHistoryMsgs = [];
  // Query ALL messages for this device (no limitToLast truncation)
  try {
    const res = await fetchWithTimeout(`${url}/messages/${devId}.json${authQuery}`, { cache: 'no-store' }, 4000);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        allHistoryMsgs = parseFirebaseMessagesObject(data);
      }
    }
  } catch (_) {}

  // Fallback query if direct was empty
  if (allHistoryMsgs.length === 0) {
    try {
      const q = authParam ? `?${authParam}` : '';
      const res = await fetchWithTimeout(`${url}/messages/${devId}.json${q}`, { cache: 'no-store' }, 4000);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          allHistoryMsgs = parseFirebaseMessagesObject(data);
        }
      }
    } catch (_) {}
  }

  // 2. Scan ALL messages: Once a single message matches keyword, immediately stop and flag as registered
  let foundMatch = null;
  const lowerKey = appKey.toLowerCase();
  for (const m of allHistoryMsgs) {
    const txt = (m.message || '').toLowerCase();
    const snd = (m.sender || '').toLowerCase();
    if (txt.includes(lowerKey) || snd.includes(lowerKey)) {
      foundMatch = m;
      break; // Stop immediately upon first match
    }
  }

  if (foundMatch) {
    playChime('otp');
    resBox.style.background = 'rgba(16, 185, 129, 0.12)';
    resBox.style.border = '1px solid rgba(16, 185, 129, 0.4)';
    resBox.style.color = '#6ee7b7';
    resBox.innerHTML = `
      <b>✅ Already Registered:</b> <b>${escapeHtml(appKey.toUpperCase())}</b> detected.
    `;
  } else {
    playChime('success');
    resBox.style.background = 'rgba(245, 158, 11, 0.12)';
    resBox.style.border = '1px solid rgba(245, 158, 11, 0.4)';
    resBox.style.color = '#fde68a';
    resBox.innerHTML = `
      <b>⚠️ Assuming Not Registered:</b> No records found for <b>${escapeHtml(appKey.toUpperCase())}</b>.
    `;
  }
};

/* ========================================================
   Panels Management & Dedicated Panel Feed Modal
   ======================================================== */

async function loadPanelsFromBackend() {
  const res = await api('/api/panels');
  if (res && res.panels) {
    STATE.myPanels = res.panels;
    localStorage.setItem('ownbox_my_panels', JSON.stringify(res.panels));
  }
  updatePanelsCounts();
  renderMyPanels();
}

async function loadProPanelsFromBackend() {
  const res = await api('/api/pro-panels');
  if (res && res.panels) {
    const seen = new Set();
    const deduped = [];
    res.panels.forEach(p => {
      const u = (p.firebase_url || p.url || '').trim().replace(/\/+$/, '').toLowerCase();
      if (u && !seen.has(u)) {
        seen.add(u);
        deduped.push(p);
      }
    });
    STATE.proPanels = deduped;
  }
  updatePanelsCounts();
  renderProPanels();
}

function updatePanelsCounts() {
  const myCnt = document.getElementById('cnt-my-panels');
  const proCnt = document.getElementById('cnt-pro-panels');
  const statPanels = document.getElementById('stat-panels-count');

  if (myCnt) myCnt.textContent = STATE.myPanels.length;
  if (proCnt) proCnt.textContent = STATE.proPanels.length ? STATE.proPanels.length : 'Pool';
  if (statPanels) statPanels.textContent = STATE.myPanels.length;
}

window.switchPanelSubTab = function(subTab) {
  triggerHaptic('light');
  STATE.activePanelSubTab = subTab;
  playChime('success');

  const btnMy = document.getElementById('btn-subtab-my-panels');
  const btnPro = document.getElementById('btn-subtab-pro-panels');
  const viewMy = document.getElementById('subview-my-panels');
  const viewPro = document.getElementById('subview-pro-panels');

  if (btnMy && btnPro && viewMy && viewPro) {
    btnMy.classList.toggle('active', subTab === 'my');
    btnPro.classList.toggle('active', subTab === 'pro');
    viewMy.style.display = subTab === 'my' ? 'block' : 'none';
    viewPro.style.display = subTab === 'pro' ? 'block' : 'none';
  }

  if (subTab === 'pro') {
    loadProPanelsFromBackend();
  }
  refreshAllNumbersDirectFromFirebase();
};

function renderMyPanels() {
  const container = document.getElementById('panels-cards-stream');
  if (!container) return;

  if (STATE.myPanels.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 32px 0; color: var(--text-muted);">
        <p style="font-size: 13px;">No panels connected yet.</p>
        <p style="font-size: 11px; margin-top: 3px;">Paste Firebase URLs, <code>?m=base64</code> links, or upload a .txt file.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = STATE.myPanels.map(p => {
    const isDead = !!p.is_dead;
    const pUrl = p.firebase_url || p.url;
    return `
      <div class="panel-box-card" onclick="openPanelDetailModal(${p.id})">
        <div class="panel-left-col">
          <div class="panel-header-title">
            <span>${escapeHtml(p.panel_name || 'Panel')}</span>
            <span class="badge-mini ${isDead ? 'badge-red' : 'badge-green'}">${isDead ? 'Dead' : 'Active'}</span>
            <span style="font-size: 10px; color: var(--neon-cyan);">Direct RTDB</span>
          </div>
          <div class="panel-url-sub">${escapeHtml(p.masked_url || pUrl || 'Connected')}</div>
        </div>
        <div style="display: flex; gap: 4px;" onclick="event.stopPropagation()">
          <button class="btn-action-danger" onclick="deletePanelById('${p.id}')">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderProPanels() {
  const container = document.getElementById('pro-panels-cards-stream');
  if (!container) return;

  if (!STATE.proHasAccess && !STATE.isAdmin) {
    container.innerHTML = '';
    return;
  }

  if (STATE.proPanels.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px 0; color: var(--text-muted); font-size: 12px;">
        Pro Panels pool is loading or currently syncing...
      </div>
    `;
    return;
  }

  container.innerHTML = STATE.proPanels.map((p, idx) => {
    return `
      <div class="panel-box-card" onclick="openPanelDetailModal('${p.id}', true)">
        <div class="panel-left-col">
          <div class="panel-header-title">
            <span>👑 ${escapeHtml(p.panel_name || `Pro Panel ${idx + 1}`)}</span>
            <span class="badge-mini badge-green">Live Pool</span>
          </div>
          <div class="panel-url-sub">${escapeHtml(p.masked_url || 'Firebase RTDB Live')}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;" onclick="event.stopPropagation()">
          ${STATE.isAdmin ? `
            <button class="btn-action-danger" style="font-size: 10.5px; padding: 4px 8px;" onclick="deleteProPanelById('${p.id}')">🗑️ Remove</button>
          ` : ''}
          <div style="font-size: 11px; color: var(--neon-mint); font-weight: 600;">Tap to Stream</div>
        </div>
      </div>
    `;
  }).join('');
}

window.deleteProPanelById = async function(pid) {
  triggerHaptic('medium');
  if (!confirm('Remove this panel from Pro Panels Pool?')) return;

  const target = STATE.proPanels.find(p => String(p.id) === String(pid));
  const targetUrl = target ? (target.firebase_url || target.url) : null;
  const normTarget = (targetUrl || '').trim().replace(/\/+$/, '').toLowerCase();

  STATE.proPanels = STATE.proPanels.filter(p => String(p.id) !== String(pid));
  if (normTarget) {
    // Clean up device phone cache in localStorage and memory for this panel
    try {
      const rawCache = localStorage.getItem('ownbox_device_phone_cache_v2');
      if (rawCache) {
        const cacheObj = JSON.parse(rawCache);
        let changed = false;
        Object.keys(cacheObj).forEach(k => {
          if (k.toLowerCase().startsWith(normTarget)) {
            delete cacheObj[k];
            changed = true;
          }
        });
        if (changed) {
          localStorage.setItem('ownbox_device_phone_cache_v2', JSON.stringify(cacheObj));
        }
      }
    } catch (_) {}

    if (STATE.devicePhoneMap) {
      for (const k of Array.from(STATE.devicePhoneMap.keys())) {
        if (k.toLowerCase().startsWith(normTarget)) {
          STATE.devicePhoneMap.delete(k);
        }
      }
    }

    STATE.numbers = STATE.numbers.filter(n => (n.panel_url || '').trim().replace(/\/+$/, '').toLowerCase() !== normTarget);
    for (const k of Array.from(STATE.panelNumbersCache.keys())) {
      if (String(k) === String(pid) || String(k).trim().replace(/\/+$/, '').toLowerCase() === normTarget) {
        STATE.panelNumbersCache.delete(k);
      }
    }
    renderStreamCards();
    const numCountElem = document.getElementById('stat-numbers-count');
    if (numCountElem) numCountElem.textContent = STATE.numbers.length;
  }

  renderProPanels();
  updatePanelsCounts();
  showToast('Pro panel removed.');
  playChime('success');

  await api('/api/admin/pro-panels/delete', {
    method: 'POST',
    body: JSON.stringify({ panel_id: pid })
  });
};

/* ========================================================
   Dedicated Panel Live Feed & Offline Search Modal
   ======================================================== */

window.openPanelDetailModal = async function(panelId, isPro = false) {
  triggerHaptic('medium');
  const panelList = isPro ? STATE.proPanels : STATE.myPanels;
  const panel = panelList.find(p => String(p.id) === String(panelId)) || panelList[0];
  if (!panel) return;

  const isPanelPro = isPro || STATE.proPanels.some(p => String(p.id) === String(panel.id));
  panel.is_pro = isPanelPro;
  STATE.activePanelForModal = panel;
  playChime('success');

  const title = document.getElementById('panel-modal-title');
  const subtitle = document.getElementById('panel-modal-subtitle');
  const pUrl = panel.firebase_url || panel.url || '';

  if (title) title.textContent = panel.panel_name || (isPanelPro ? 'Pro Panel Live Feed' : 'Panel Live Feed');
  if (subtitle) {
    if (isPanelPro && !STATE.isAdmin) {
      subtitle.textContent = '👑 Protected Pro Node · Live Pool';
    } else {
      subtitle.textContent = panel.masked_url || pUrl || 'Direct Firebase RTDB';
    }
  }

  const modal = document.getElementById('panel-detail-modal');
  if (modal) modal.style.display = 'flex';
  updateTelegramBackButton();

  const searchInput = document.getElementById('panel-modal-search-input');
  if (searchInput) searchInput.value = '';

  await fetchAndRenderPanelModalFeed(panel);
};

function closePanelDetailModal() {
  triggerHaptic('light');
  const modal = document.getElementById('panel-detail-modal');
  if (modal) modal.style.display = 'none';
  STATE.activePanelForModal = null;
  updateTelegramBackButton();
}

async function fetchAndRenderPanelModalFeed(panel) {
  const container = document.getElementById('panel-modal-numbers-stream');
  if (!container) return;

  const pUrl = panel.firebase_url || panel.url || '';
  const loader = document.getElementById('panel-modal-loader');

  // Pre-render immediately from cache for instant response
  const cached = STATE.panelNumbersCache.get(panel.id) || STATE.panelNumbersCache.get(pUrl);
  if (cached && cached.length > 0) {
    renderPanelModalNumbers(cached, pUrl);
  } else {
    container.innerHTML = '';
    if (loader) loader.style.display = 'flex';
  }

  try {
    const nums = await fetchDirectFirebaseNumbers(pUrl, panel.auth_secret || '');
    STATE.panelNumbersCache.set(panel.id, nums);
    STATE.panelNumbersCache.set(pUrl, nums);
    renderPanelModalNumbers(nums, pUrl);
  } finally {
    if (loader) loader.style.display = 'none';
  }
}

function renderPanelModalNumbers(nums, panelUrl) {
  const container = document.getElementById('panel-modal-numbers-stream');
  if (!container) return;

  const isPanelPro = STATE.activePanelForModal?.is_pro || (STATE.proPanels && STATE.proPanels.some(p => String(p.id) === String(STATE.activePanelForModal?.id)));

  const searchVal = document.getElementById('panel-modal-search-input')?.value?.toLowerCase()?.trim() || '';
  let filtered = Array.isArray(nums) ? nums : [];
  if (searchVal) {
    filtered = filtered.filter(n => (n.number && n.number.includes(searchVal)) || (n.last_sms && n.last_sms.toLowerCase().includes(searchVal)));
  }

  // Strictly filter out Missing Number cards for Pro Panels! Show only real/calculated numbers
  if (isPanelPro) {
    filtered = filtered.filter(n => n && n.number && n.number !== 'Missing Number');
  }

  // Sort by latest SMS
  filtered.sort((a, b) => (parseTimestampSafe(b.timestamp || 0) - parseTimestampSafe(a.timestamp || 0)));

  if (filtered.length === 0) {
    if (isPanelPro) {
      container.innerHTML = `
        <div style="text-align: center; padding: 28px 12px; color: var(--text-muted); font-size: 12px;">
          <div style="font-size: 24px; margin-bottom: 6px;">⚡</div>
          <p style="font-weight: 600; color: var(--text-main); margin-bottom: 4px;">Calculating Numbers...</p>
          <p style="font-size: 11px;">Authoritative SIM numbers are being calculated from carrier alerts. Verified cards will appear automatically.</p>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="text-align: center; padding: 28px 0; color: var(--text-muted); font-size: 12px;">
          No numbers found matching in this panel.
        </div>
      `;
    }
    return;
  }

  container.innerHTML = filtered.map(n => {
    const isMissing = (n.number === 'Missing Number' || !n.number);
    const displayNum = isMissing ? 'Missing Number' : n.number;
    const isOnline = isNumberOnline(n);
    const statusClass = isOnline ? 'is-online' : 'is-offline';
    const isSensitive = !STATE.isAdmin && isSensitiveMessage(n.last_sms);

    const dualSimTagHtml = (n.is_dual_sim && n.sim2 && n.sim2.number)
      ? `<span class="dual-sim-badge" title="Dual SIM: ${escapeHtml(n.sim2.carrier || 'SIM 2')}">[+1 Dual SIM: ${escapeHtml(n.sim2.number)}]</span>`
      : '';

    const msgHtml = isSensitive
      ? createShieldedCardHtml()
      : `<div class="stream-card-msg">${n.last_sms ? escapeHtml(n.last_sms) : 'Tap for realtime polling...'}</div>`;

    const otpHtml = isSensitive
      ? `<div style="margin-top: 2px;"><span class="stream-otp-chip protected">OTP: [PROTECTED]</span></div>`
      : (n.otp ? `<div style="margin-top: 2px;"><span class="stream-otp-chip">OTP: ${n.otp}</span></div>` : '');

    return `
      <div class="stream-card-minimal ${statusClass} ${isMissing ? 'is-missing-num' : ''}" onclick="openDrawerFromPanelModal('${escapeHtml(n.device_id || n.raw_device_id || '')}', '${escapeHtml(panelUrl || '')}', '${escapeHtml(n.number)}')">
        <div class="stream-card-header">
          <div class="stream-num-wrap">
            <span class="stream-card-num ${isMissing ? 'missing-num-txt' : ''}">${isMissing ? 'Missing Number' : `+91 ${escapeHtml(displayNum)}`}</span>
            ${dualSimTagHtml}
            ${!isMissing ? `
              <button class="stream-side-copy-btn" onclick="event.stopPropagation(); copySnippetText('${n.number}', 'Number copied!')" title="Copy Number">
                📋
              </button>
            ` : ''}
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="status-indicator-dot ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'Online (Active within 24h)' : 'Offline'}"></span>
            <span style="font-size: 10px; color: var(--text-muted);">${formatTimeAgo(n.timestamp)}</span>
          </div>
        </div>
        ${msgHtml}
        ${otpHtml}
      </div>
    `;
  }).join('');
}

window.deletePanelById = async function(pid) {
  triggerHaptic('medium');
  if (!confirm('Remove this panel from your connection list?')) return;

  // 1. Find panel and its URL before filtering
  const target = STATE.myPanels.find(p => String(p.id) === String(pid));
  const targetUrl = target ? (target.firebase_url || target.url) : null;
  const normTarget = (targetUrl || '').trim().replace(/\/+$/, '').toLowerCase();

  // 2. Instantly remove from local state and storage
  STATE.myPanels = STATE.myPanels.filter(p => String(p.id) !== String(pid));
  localStorage.setItem('ownbox_my_panels', JSON.stringify(STATE.myPanels));

  // 3. Instantly remove all numbers from this panel from the stream screen and clean localStorage
  if (normTarget) {
    try {
      const rawCache = localStorage.getItem('ownbox_device_phone_cache_v2');
      if (rawCache) {
        const cacheObj = JSON.parse(rawCache);
        let changed = false;
        Object.keys(cacheObj).forEach(k => {
          if (k.toLowerCase().startsWith(normTarget)) {
            delete cacheObj[k];
            changed = true;
          }
        });
        if (changed) {
          localStorage.setItem('ownbox_device_phone_cache_v2', JSON.stringify(cacheObj));
        }
      }
    } catch (_) {}

    if (STATE.devicePhoneMap) {
      for (const k of Array.from(STATE.devicePhoneMap.keys())) {
        if (k.toLowerCase().startsWith(normTarget)) {
          STATE.devicePhoneMap.delete(k);
        }
      }
    }

    STATE.numbers = STATE.numbers.filter(n => (n.panel_url || '').trim().replace(/\/+$/, '').toLowerCase() !== normTarget);
    for (const k of Array.from(STATE.panelNumbersCache.keys())) {
      if (String(k) === String(pid) || String(k).trim().replace(/\/+$/, '').toLowerCase() === normTarget) {
        STATE.panelNumbersCache.delete(k);
      }
    }
  }

  // 4. Instantly update UI: panels list, counter badges, and stream cards
  renderMyPanels();
  updatePanelsCounts();
  renderStreamCards();
  const numCountElem = document.getElementById('stat-numbers-count');
  if (numCountElem) numCountElem.textContent = STATE.numbers.length;

  showToast('Panel removed.');
  playChime('success');

  // 5. Sync deletion with backend in background
  try {
    await api('/api/panels/delete', {
      method: 'POST',
      body: JSON.stringify({ panel_id: pid })
    });
  } catch (_) {}
};

/* ========================================================
   TAB 2: CHECKER (SMS History Keyword Search)
   ======================================================== */

function updateCheckerQuotaDisplay() {
  const quotaPill = document.getElementById('checker-quota-pill');
  if (!quotaPill) return;

  if (STATE.isAdmin) {
    quotaPill.textContent = '👑 Admin: Unlimited Quota';
    quotaPill.style.color = 'var(--neon-mint)';
    quotaPill.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    quotaPill.style.background = 'rgba(16, 185, 129, 0.12)';
    return;
  }

  const nowMs = Date.now();
  const oneHourAgo = nowMs - (3600 * 1000);
  let checkTimestamps = [];
  try {
    const savedTs = localStorage.getItem('ownbox_checker_timestamps');
    if (savedTs) {
      checkTimestamps = JSON.parse(savedTs).filter(ts => ts > oneHourAgo);
    }
  } catch (_) { checkTimestamps = []; }

  const remaining = Math.max(0, 100 - checkTimestamps.length);

  if (checkTimestamps.length > 0) {
    const oldest = Math.min(...checkTimestamps);
    const resetInSec = Math.max(0, Math.ceil((oldest + (3600 * 1000) - nowMs) / 1000));
    const mins = Math.floor(resetInSec / 60);
    const secs = resetInSec % 60;
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    quotaPill.textContent = `Quota: ${remaining}/100 · Resets in ${timeStr}`;
  } else {
    quotaPill.textContent = `Quota: ${remaining}/100`;
  }

  if (remaining === 0) {
    quotaPill.style.color = '#fda4af';
    quotaPill.style.borderColor = 'rgba(244, 63, 94, 0.4)';
    quotaPill.style.background = 'rgba(244, 63, 94, 0.12)';
  } else {
    quotaPill.style.color = 'var(--neon-cyan)';
    quotaPill.style.borderColor = 'rgba(0, 242, 254, 0.3)';
    quotaPill.style.background = 'rgba(0, 242, 254, 0.1)';
  }
}

async function handleRunChecker() {
  const textarea = document.getElementById('checker-text-input');
  const rawText = textarea.value.trim();
  if (!rawText) return showToast('Please enter mobile numbers to check.');

  const selectedChips = Array.from(document.querySelectorAll('#app-selector-chips .filter-pill.active'));
  const selectedApps = selectedChips.map(c => c.getAttribute('data-app')).filter(Boolean);
  
  const customAppInput = document.getElementById('checker-custom-app');
  if (customAppInput && customAppInput.value.trim()) {
    selectedApps.push(customAppInput.value.trim().toLowerCase());
  }

  if (selectedApps.length === 0) {
    return showToast('Select at least one app keyword to check in SMS history.');
  }

  // 1. Extract valid 10-digit mobile numbers
  const rawTokens = rawText.split(/[\s,\n]+/).map(t => t.replace(/[^0-9]/g, ''));
  const valid10List = [];
  const seenInput = new Set();
  for (const tok of rawTokens) {
    const c10 = normalizeTo10Digit(tok);
    if (c10 && c10.length === 10 && !seenInput.has(c10)) {
      seenInput.add(c10);
      valid10List.push(c10);
    }
  }

  if (valid10List.length === 0) {
    return showToast('Please enter valid 10-digit mobile numbers.');
  }

  // 2. Filter using Toggle: Include or exclude already checked numbers
  const includeCheckedToggle = document.getElementById('checker-include-checked-toggle');
  const includeAlreadyChecked = includeCheckedToggle ? includeCheckedToggle.checked : true;
  if (!STATE.alreadyCheckedNumbers) STATE.alreadyCheckedNumbers = new Set();

  let numbersToCheck = valid10List;
  if (!includeAlreadyChecked) {
    numbersToCheck = valid10List.filter(n => !STATE.alreadyCheckedNumbers.has(n));
    if (numbersToCheck.length === 0) {
      return showToast('All numbers were already checked. Enable the toggle to re-check.');
    }
  }

  // 3. Rate Limit: Maximum 100 numbers per hour (Limited to regular users; Admin is unlimited)
  let checkTimestamps = [];
  if (!STATE.isAdmin) {
    const nowMs = Date.now();
    const oneHourAgo = nowMs - (3600 * 1000);
    try {
      const savedTs = localStorage.getItem('ownbox_checker_timestamps');
      if (savedTs) {
        checkTimestamps = JSON.parse(savedTs).filter(ts => ts > oneHourAgo);
      }
    } catch (_) { checkTimestamps = []; }

    const remainingQuota = Math.max(0, 100 - checkTimestamps.length);
    if (remainingQuota <= 0) {
      return showToast('Hourly quota reached (max 100 numbers/hr). Please wait for timer reset.');
    }

    if (numbersToCheck.length > remainingQuota) {
      showToast(`Quota limit: Checking first ${remainingQuota} of ${numbersToCheck.length} numbers.`);
      numbersToCheck = numbersToCheck.slice(0, remainingQuota);
    }
  }

  const btn = document.getElementById('btn-run-checker-action');
  const stopBtn = document.getElementById('btn-stop-checker-action');
  const copyRegBtn = document.getElementById('btn-copy-reg-action');
  const copyAllBtn = document.getElementById('btn-copy-all-action');

  btn.disabled = true;
  if (stopBtn) {
    stopBtn.style.display = 'inline-flex';
    stopBtn.textContent = '🛑 Stop';
    stopBtn.disabled = false;
  }
  if (copyRegBtn) copyRegBtn.disabled = true;
  if (copyAllBtn) copyAllBtn.disabled = true;
  STATE.checkerStopped = false;
  triggerHaptic('medium');

  const wrapper = document.getElementById('checker-results-wrapper');
  const container = document.getElementById('checker-items-stream');
  if (wrapper) wrapper.style.display = 'block';
  if (container) container.innerHTML = '';

  const results = [];
  const registeredList = [];
  const unrestrictedList = [];

  // Strict Rule: Bulk checker strictly queries user's own panels only, NEVER Pro Panels
  const panelsToCheck = [...STATE.myPanels];

  // Progressive 1-by-1 streaming execution
  let checkedCount = 0;
  for (const cleanNum of numbersToCheck) {
    if (STATE.checkerStopped) {
      showToast('Checker stopped.');
      break;
    }
    checkedCount++;
    btn.textContent = `⏳ Analysing ${checkedCount}/${numbersToCheck.length} (+91 ${cleanNum})...`;

    let msgs = STATE.cachedNumberMessages.get(cleanNum) || [];

    // Query active panels directly if not in cache
    if (msgs.length === 0 && panelsToCheck.length > 0) {
      // Identify matching device id from stream numbers
      const matched = STATE.numbers.find(n => 
        (n.real_number === cleanNum || n.number === cleanNum || n.got_number === cleanNum)
      );
      const matchedDevId = matched ? (matched.device_id || matched.raw_device_id) : '';
      const matchedPanel = matched ? matched.panel_url : '';

      if (matchedDevId && matchedPanel) {
        const normP = matchedPanel.trim().replace(/\/+$/, '').toLowerCase();
        const pObj = panelsToCheck.find(p => (p.firebase_url || p.url || '').trim().replace(/\/+$/, '').toLowerCase() === normP) || { firebase_url: matchedPanel };
        try {
          const fetched = await fetchDirectFirebaseSmsForNumber(pObj.firebase_url || pObj.url, cleanNum, pObj.auth_secret || '', matchedDevId, true);
          if (fetched && fetched.length > 0) {
            msgs.push(...fetched);
          }
        } catch (_) {}
      } else {
        await Promise.all(panelsToCheck.map(async (p) => {
          const pUrl = p.firebase_url || p.url;
          if (!pUrl) return;
          try {
            const fetched = await fetchDirectFirebaseSmsForNumber(pUrl, cleanNum, p.auth_secret || '', '', true);
            if (fetched && fetched.length > 0) {
              msgs.push(...fetched);
            }
          } catch (_) {}
        }));
      }
      STATE.cachedNumberMessages.set(cleanNum, msgs);
    }

    const appResults = {};
    let hasAnyReg = false;

    for (const app of selectedApps) {
      const appKey = app.toLowerCase();
      let isReg = false;
      for (const m of msgs) {
        const txt = (m.message || '').toLowerCase();
        const snd = (m.sender || '').toLowerCase();
        if (txt.includes(appKey) || snd.includes(appKey)) {
          isReg = true;
          break; // Immediately flag as registered once single msg found
        }
      }

      if (isReg) hasAnyReg = true;

      appResults[appKey] = {
        registered: isReg,
        status: isReg ? 'Registered' : 'Assuming Not Registered',
        message: isReg 
          ? `${app.toUpperCase()} detected`
          : `Assuming Not Registered on ${app.toUpperCase()}`
      };
    }

    if (hasAnyReg) {
      registeredList.push(cleanNum);
    } else {
      unrestrictedList.push(cleanNum);
    }

    const summaryParts = [];
    for (const [aName, aData] of Object.entries(appResults)) {
      if (aData.registered) {
        summaryParts.push(`${aName.toUpperCase()} ✓`);
      } else {
        summaryParts.push(`${aName.toUpperCase()}: Assuming Not Registered`);
      }
    }

    const item = {
      number: cleanNum,
      clean_number: cleanNum,
      app_results: appResults,
      is_registered: hasAnyReg,
      summary: summaryParts.join(' | ')
    };

    results.push(item);
    STATE.alreadyCheckedNumbers.add(cleanNum);
    checkTimestamps.push(Date.now());

    // Instant progressive stream append to UI
    if (container) {
      container.insertAdjacentHTML('beforeend', createCheckerItemHtml(item));
    }

    triggerHaptic('light');
    // Smooth yield for instant render feedback
    await new Promise(r => setTimeout(r, 25));
  }

  // Update check timestamps in localStorage for regular users
  if (!STATE.isAdmin) {
    try {
      localStorage.setItem('ownbox_checker_timestamps', JSON.stringify(checkTimestamps));
    } catch (_) {}
  }
  updateCheckerQuotaDisplay();

  if (stopBtn) stopBtn.style.display = 'none';
  btn.disabled = false;
  btn.textContent = '⚡ Run Checker';

  if (copyRegBtn) copyRegBtn.disabled = false;
  if (copyAllBtn) copyAllBtn.disabled = false;

  STATE.lastCheckerResults = {
    results,
    registered_copy_text: registeredList.join('\n'),
    unrestricted_copy_text: unrestrictedList.join('\n')
  };

  playChime(registeredList.length > 0 ? 'otp' : 'success');
  showToast(STATE.checkerStopped ? `Stopped. Analysed ${results.length} numbers.` : `Completed! Analysed ${results.length} numbers.`);
}

function createCheckerItemHtml(item) {
  const badgesHtml = [];
  const appRes = item.app_results || {};

  for (const [appName, aRes] of Object.entries(appRes)) {
    const isReg = aRes?.registered === true;
    const bClass = isReg ? 'badge-green' : 'badge-amber';
    const label = isReg ? `${appName.toUpperCase()}: Registered` : `${appName.toUpperCase()}: Assuming Not Registered`;
    badgesHtml.push(`<span class="badge-mini ${bClass}">${escapeHtml(label)}</span>`);
  }

  return `
    <div class="checker-result-card" style="padding: 10px 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; margin-bottom: 8px;">
      <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="result-num-txt" style="font-weight: 700; font-size: 13.5px; color: #fff;">+91 ${escapeHtml(item.clean_number)}</span>
          <button type="button" class="btn-icon-tiny" onclick="copySnippetText('${escapeHtml(item.clean_number)}', 'Copied +91 ${escapeHtml(item.clean_number)}!')" title="Copy Number" style="background: rgba(0, 242, 254, 0.1); border: 1px solid rgba(0, 242, 254, 0.3); border-radius: 6px; padding: 2px 7px; cursor: pointer; color: var(--neon-cyan); font-size: 11px;">📋</button>
        </div>
        <div style="font-size: 10.5px; color: var(--text-muted);">${escapeHtml(item.summary)}</div>
      </div>
      <div class="result-badges-row" style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px;">
        ${badgesHtml.join('')}
      </div>
    </div>
  `;
}

function renderCheckerItems(res) {
  const wrapper = document.getElementById('checker-results-wrapper');
  const container = document.getElementById('checker-items-stream');
  if (!wrapper || !container) return;

  wrapper.style.display = 'block';
  const items = res.results || [];

  if (items.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted); font-size:12px;">No numbers verified.</p>';
    return;
  }

  container.innerHTML = items.map(item => createCheckerItemHtml(item)).join('');
}

/* ========================================================
   TAB 4: API View Render
   ======================================================== */

function renderApiView() {
  const host = window.location.host || 'localhost:8080';
  const proto = window.location.protocol || 'http:';
  const base = `${proto}//${host}`;
  const key = STATE.apiKey || 'YOUR_KEY';

  const adminControl = document.getElementById('admin-user-api-control');
  const adminStatusTxt = document.getElementById('admin-user-api-status-text');
  const btnToggleUserApi = document.getElementById('btn-toggle-user-api-admin');
  if (adminControl) {
    adminControl.style.display = STATE.isAdmin ? 'block' : 'none';
    if (adminStatusTxt) {
      adminStatusTxt.textContent = STATE.userApiEnabled 
        ? 'Current Status: ACTIVE (Regular users can query their panels via API)' 
        : 'Current Status: DISABLED (All user APIs blocked; only Master Admin API active)';
    }
    if (btnToggleUserApi) {
      btnToggleUserApi.textContent = STATE.userApiEnabled ? 'Pause User APIs' : 'Enable User APIs';
    }
  }

  const disabledBanner = document.getElementById('user-api-disabled-banner');
  if (disabledBanner) {
    disabledBanner.style.display = (!STATE.isAdmin && !STATE.userApiEnabled) ? 'block' : 'none';
  }

  const keyInput = document.getElementById('api-key-text-box');
  if (keyInput) {
    keyInput.value = key;
  }

  const scopeTag = document.getElementById('api-scope-tag');
  if (scopeTag) {
    scopeTag.textContent = STATE.isAdmin ? 'Master Admin Scope' : 'Personal Scope';
  }

  const samplePanel = (STATE.myPanels && STATE.myPanels[0]?.firebase_url) || (STATE.proPanels && STATE.proPanels[0]?.firebase_url) || 'https://rahul1-15f7c-default-rtdb.firebaseio.com';
  const sampleDevId = (STATE.numbers && STATE.numbers[0]?.device_id) || '91257578792c71de';

  // 1. Devices Map
  const urlDevices = document.getElementById('url-endpoint-devices');
  if (urlDevices) urlDevices.value = `${base}/api/devices?key=${key}`;

  // 2. Find Number
  const urlFindNum = document.getElementById('url-endpoint-findnumber');
  if (urlFindNum) urlFindNum.value = `${base}/api/${samplePanel}/${sampleDevId}/findnumber?key=${key}`;

  // 3. Check Keyword
  const urlCheck = document.getElementById('url-endpoint-check');
  if (urlCheck) urlCheck.value = `${base}/api/${samplePanel}/${sampleDevId}/check=SWiggy?key=${key}`;

  // 4. Polling
  const urlPoll = document.getElementById('url-endpoint-poll');
  if (urlPoll) urlPoll.value = `${base}/api/${samplePanel}/${sampleDevId}/poll?key=${key}`;

  // 5. Specific SMS
  const urlSms = document.getElementById('url-endpoint-sms');
  if (urlSms) urlSms.value = `${base}/api/9876543210/sms?key=${key}`;

  const pySnippet = document.getElementById('python-snippet-box');
  if (pySnippet) {
    pySnippet.textContent = `import requests, time

BASE = "${base}"
KEY = "${key}"

# 1st API: Get all panel URLs & device IDs
devices_map = requests.get(f"{BASE}/api/devices", params={"key": KEY}).json()
print("Panels & Devices:", devices_map)

for panel_url, dev_ids in devices_map.items():
    if not isinstance(dev_ids, list) or not dev_ids:
        continue
    dev_id = dev_ids[0]
    print(f"\\nTargeting Device: {dev_id} on {panel_url}")

    # 2nd API: Find carrier phone number from SMS
    info = requests.get(f"{BASE}/api/{panel_url}/{dev_id}/findnumber", params={"key": KEY}).json()
    print("Carrier Number:", info.get("number"))

    # 3rd API: Check keyword (returns false if already registered, true if fresh)
    chk = requests.get(f"{BASE}/api/{panel_url}/{dev_id}/check=SWiggy", params={"key": KEY}).json()
    print("Available for Swiggy?:", chk.get("result"))

    # 4th API: Direct sub-second RTDB OTP Polling
    print("Polling for incoming OTP...")
    while True:
        poll = requests.get(f"{BASE}/api/{panel_url}/{dev_id}/poll", params={"key": KEY}).json()
        if poll.get("has_new"):
            print("OTP Received:", poll.get("otp"))
            print("Message:", poll.get("message"))
            break
        time.sleep(2)
    break`;
  }
}

/* ========================================================
   TAB 5: Profile View Render
   ======================================================== */

function renderProfileView(me) {
  const u = me.user;
  const nameElem = document.getElementById('profile-user-name');
  const handleElem = document.getElementById('profile-user-handle');
  const tierBadge = document.getElementById('profile-tier-badge');
  const refInput = document.getElementById('referral-input-box');

  if (nameElem) nameElem.textContent = u.first_name || u.username || 'Telegram User';
  if (handleElem) handleElem.textContent = u.username ? `@${u.username}` : `ID: ${u.id}`;

  const isPro = STATE.proHasAccess || u.tier === 'pro' || me.is_admin;
  if (tierBadge) {
    tierBadge.textContent = isPro ? '👑 Pro VIP Access' : 'Free Tier';
    tierBadge.style.color = isPro ? 'var(--neon-mint)' : 'var(--neon-cyan)';
  }

  const activeChip = document.getElementById('gift-active-chip');
  if (activeChip) {
    activeChip.style.display = isPro ? 'inline-block' : 'none';
  }

  if (refInput && me.referral_link) {
    refInput.value = me.referral_link;
  }

  const ribbon = document.getElementById('admin-ribbon');
  const ribbonMsg = document.getElementById('admin-ribbon-msg');
  if (ribbon && ribbonMsg) {
    if (me.alert && me.alert.active && me.alert.text) {
      ribbonMsg.textContent = me.alert.text;
      ribbon.style.display = 'flex';
    } else {
      ribbon.style.display = 'none';
    }
  }
}

/* ========================================================
   Navigation & Tab Switching
   ======================================================== */

function setupNavigation() {
  document.querySelectorAll('.dock-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });
}

window.switchTab = function(tabId) {
  triggerHaptic('light');
  STATE.activeTab = tabId;
  playChime('success');

  document.querySelectorAll('.dock-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });

  document.querySelectorAll('.view-section').forEach(view => {
    view.classList.toggle('view-active', view.id === tabId);
  });

  if (tabId === 'tab-feed') {
    renderStreamCards();
    refreshAllNumbersDirectFromFirebase();
  }
  if (tabId === 'tab-panels') {
    renderMyPanels();
    if (STATE.activePanelSubTab === 'pro') loadProPanelsFromBackend();
  }
  if (tabId === 'tab-api') renderApiView();
};

/* ========================================================
   Event Listeners Setup
   ======================================================== */

function setupEventListeners() {
  // Search in stream
  const searchInput = document.getElementById('stream-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      STATE.searchQuery = e.target.value.trim();
      renderStreamCards();
    });
  }

  const pasteSearchBtn = document.getElementById('btn-paste-search');
  if (pasteSearchBtn) {
    pasteSearchBtn.addEventListener('click', async () => {
      triggerHaptic('light');
      const val = searchInput ? searchInput.value.trim() : '';
      if (val) {
        copySnippetText(val, 'Search text copied!');
        playChime('success');
        return;
      }

      if (navigator.clipboard && navigator.clipboard.readText) {
        try {
          const text = await navigator.clipboard.readText();
          if (text && text.trim()) {
            if (searchInput) {
              searchInput.value = text.trim();
              STATE.searchQuery = text.trim();
              renderStreamCards();
              showToast('Pasted into search.');
              playChime('success');
            }
            return;
          }
        } catch (_) {}
      }
      showToast('Nothing to copy.');
    });
  }

  const refreshStreamBtn = document.getElementById('btn-refresh-stream');
  if (refreshStreamBtn) {
    refreshStreamBtn.addEventListener('click', () => {
      triggerHaptic('light');
      refreshAllNumbersDirectFromFirebase();
      showToast('Refreshing direct from Firebase RTDB...');
      playChime('success');
    });
  }

  // File Upload for Panels (.txt, .json, .csv)
  const fileInput = document.getElementById('panel-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      triggerHaptic('medium');
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result;
        if (typeof content === 'string') {
          await handleExtractedPanelInput(content);
        }
      };
      reader.readAsText(file);
      fileInput.value = '';
    });
  }

  // Add Panels Action (Paste / text input)
  const submitPanelsBtn = document.getElementById('btn-submit-panels-action');
  if (submitPanelsBtn) {
    submitPanelsBtn.addEventListener('click', async () => {
      const textarea = document.getElementById('panel-add-textarea');
      const txt = textarea ? textarea.value.trim() : '';
      if (!txt) return showToast('Enter Firebase RTDB URLs, links, or configs.');
      if (textarea) textarea.value = '';
      triggerHaptic('medium');
      await handleExtractedPanelInput(txt);
    });
  }

  // Import Active Online Numbers to Checker (Strictly from user's own panels, NEVER Pro Panels)
  const importPanelNumsBtn = document.getElementById('btn-import-panel-numbers');
  if (importPanelNumsBtn) {
    importPanelNumsBtn.addEventListener('click', () => {
      triggerHaptic('medium');
      const myPanelUrls = new Set((STATE.myPanels || []).map(p => (p.firebase_url || p.url || '').trim().replace(/\/+$/, '').toLowerCase()));
      const activeNums = STATE.numbers
        .filter(n => {
          const pUrl = (n.panel_url || n.url || '').trim().replace(/\/+$/, '').toLowerCase();
          return myPanelUrls.has(pUrl) && isNumberOnline(n) && n.number && n.number !== 'Missing Number';
        })
        .map(n => normalizeTo10Digit(n.number))
        .filter(n => n && n.length === 10);
      const unique = Array.from(new Set(activeNums));
      if (unique.length === 0) {
        return showToast('No active online numbers found in your connected panels.');
      }
      const checkerInput = document.getElementById('checker-text-input');
      if (checkerInput) {
        checkerInput.value = unique.join('\n');
        showToast(`Loaded ${unique.length} active online number(s) from your panels into checker!`);
        playChime('otp');
      }
    });
  }

  const clearCheckerInputBtn = document.getElementById('btn-clear-checker-input');
  if (clearCheckerInputBtn) {
    clearCheckerInputBtn.addEventListener('click', () => {
      triggerHaptic('light');
      const checkerInput = document.getElementById('checker-text-input');
      if (checkerInput) checkerInput.value = '';
    });
  }

  // App chips in Checker
  document.querySelectorAll('#app-selector-chips .filter-pill').forEach(chip => {
    chip.addEventListener('click', () => {
      triggerHaptic('light');
      chip.classList.toggle('active');
      playChime('success');
    });
  });

  // Run Checker
  const runCheckerBtn = document.getElementById('btn-run-checker-action');
  if (runCheckerBtn) runCheckerBtn.addEventListener('click', handleRunChecker);

  // Stop Checker
  const stopCheckerBtn = document.getElementById('btn-stop-checker-action');
  if (stopCheckerBtn) {
    stopCheckerBtn.addEventListener('click', () => {
      triggerHaptic('medium');
      STATE.checkerStopped = true;
      stopCheckerBtn.textContent = 'Stopping...';
      showToast('Stopping checker...');
    });
  }

  // Copy Checker Results
  const copyRegBtn = document.getElementById('btn-copy-reg-action');
  if (copyRegBtn) {
    copyRegBtn.addEventListener('click', () => {
      if (STATE.lastCheckerResults?.registered_copy_text) {
        copySnippetText(STATE.lastCheckerResults.registered_copy_text, 'Registered numbers copied!');
      } else {
        showToast('No registered numbers found.');
      }
    });
  }

  const copyAllBtn = document.getElementById('btn-copy-all-action');
  if (copyAllBtn) {
    copyAllBtn.addEventListener('click', () => {
      if (STATE.lastCheckerResults?.unrestricted_copy_text) {
        copySnippetText(STATE.lastCheckerResults.unrestricted_copy_text, 'Assuming Not Registered numbers copied!');
      } else {
        showToast('No unregistered numbers found.');
      }
    });
  }

  // Clear Checker Results Button
  const clearCheckerResultsBtn = document.getElementById('btn-clear-checker-results');
  if (clearCheckerResultsBtn) {
    clearCheckerResultsBtn.addEventListener('click', () => {
      triggerHaptic('light');
      const wrapper = document.getElementById('checker-results-wrapper');
      const container = document.getElementById('checker-items-stream');
      if (container) container.innerHTML = '';
      if (wrapper) wrapper.style.display = 'none';
      STATE.lastCheckerResults = null;
      showToast('Checker results cleared.');
      playChime('success');
    });
  }

  // Clean Dead Panels
  const cleanDeadBtn = document.getElementById('btn-clean-dead-action');
  if (cleanDeadBtn) {
    cleanDeadBtn.addEventListener('click', async () => {
      triggerHaptic('medium');
      const res = await api('/api/panels/clear-dead', { method: 'POST' });
      if (res?.ok) {
        showToast(`Removed ${res.removed_count} dead panels.`);
        playChime('success');
        await loadPanelsFromBackend();
        await refreshAllNumbersDirectFromFirebase();
      }
    });
  }

  // Refresh Panels
  const refreshPanelsBtn = document.getElementById('btn-refresh-panels-action');
  if (refreshPanelsBtn) {
    refreshPanelsBtn.addEventListener('click', () => {
      triggerHaptic('light');
      loadPanelsFromBackend();
      showToast('Panels updated.');
      playChime('success');
    });
  }

  // Copy Referral Links
  const copyRefBtn = document.getElementById('btn-copy-ref-action');
  if (copyRefBtn) {
    copyRefBtn.addEventListener('click', () => {
      const link = document.getElementById('referral-input-box').value;
      copySnippetText(link, 'Invite link copied!');
    });
  }

  const copyProLockRefBtn = document.getElementById('btn-copy-pro-lock-ref');
  if (copyProLockRefBtn) {
    copyProLockRefBtn.addEventListener('click', () => {
      const link = document.getElementById('pro-lock-ref-input').value;
      copySnippetText(link, 'Invite link copied!');
    });
  }

  const copyConsoleLockRefBtn = document.getElementById('btn-copy-console-lock-ref');
  if (copyConsoleLockRefBtn) {
    copyConsoleLockRefBtn.addEventListener('click', () => {
      const link = document.getElementById('console-lock-ref-input').value;
      copySnippetText(link, 'Invite link copied!');
    });
  }

  // API Key Eye Toggle (Mask/Unmask without altering input value or triggering password manager replacement)
  const toggleKeyEyeBtn = document.getElementById('btn-toggle-key-eye');
  if (toggleKeyEyeBtn) {
    toggleKeyEyeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      triggerHaptic('light');
      const keyInput = document.getElementById('api-key-text-box');
      if (!keyInput) return;
      if (keyInput.type === 'password') {
        keyInput.type = 'text';
        toggleKeyEyeBtn.textContent = '🙈';
        toggleKeyEyeBtn.title = 'Hide API Key';
      } else {
        keyInput.type = 'password';
        toggleKeyEyeBtn.textContent = '👁️';
        toggleKeyEyeBtn.title = 'Show API Key';
      }
    });
  }

  const copyDevKeyBtn = document.getElementById('btn-copy-api-key-val');
  if (copyDevKeyBtn) {
    copyDevKeyBtn.addEventListener('click', () => {
      if (STATE.apiKey) {
        copySnippetText(STATE.apiKey, 'API key copied!');
      } else {
        showToast('No active API key.');
      }
    });
  }

  const regenKeyBtn = document.getElementById('btn-regen-key-action');
  if (regenKeyBtn) {
    regenKeyBtn.addEventListener('click', async () => {
      triggerHaptic('medium');
      const res = await api('/api/user/regenerate-key', { method: 'POST' });
      if (res?.ok) {
        STATE.apiKey = res.api_key;
        renderApiView();
        showToast('New API key generated.');
        playChime('otp');
      }
    });
  }

  const revokeKeyBtn = document.getElementById('btn-revoke-key-action');
  if (revokeKeyBtn) {
    revokeKeyBtn.addEventListener('click', async () => {
      triggerHaptic('medium');
      if (!confirm('Revoke your API key?')) return;
      await api('/api/user/revoke-key', { method: 'POST' });
      STATE.apiKey = '';
      renderApiView();
      showToast('API key revoked.');
    });
  }

  const copyPySnippetBtn = document.getElementById('btn-copy-python-snippet');
  if (copyPySnippetBtn) {
    copyPySnippetBtn.addEventListener('click', () => {
      const box = document.getElementById('python-snippet-box');
      if (box) copySnippetText(box.textContent, 'Python script copied!');
    });
  }

  // Close Drawers & Full-Screen Views
  const closeDrawerBtn = document.getElementById('btn-close-drawer-sheet');
  if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', closeDrawerModal);

  const closePanelModalBtn = document.getElementById('btn-close-panel-modal');
  if (closePanelModalBtn) closePanelModalBtn.addEventListener('click', closePanelDetailModal);

  // Manual Poll Action in Full-Screen Number View
  const manualPollBtn = document.getElementById('btn-drawer-manual-poll');
  if (manualPollBtn) manualPollBtn.addEventListener('click', window.manualPollDrawerSms);

  // Search in Drawer
  const drawerSearchInput = document.getElementById('drawer-search-input');
  if (drawerSearchInput) {
    drawerSearchInput.addEventListener('input', () => {
      if (STATE.activeNumber) {
        renderDrawerMessages(STATE.cachedNumberMessages.get(STATE.activeNumber) || []);
      }
    });
  }

  // Search in Panel Modal
  const panelSearchInput = document.getElementById('panel-modal-search-input');
  if (panelSearchInput) {
    panelSearchInput.addEventListener('input', () => {
      if (STATE.activePanelForModal) {
        const pUrl = STATE.activePanelForModal.firebase_url || STATE.activePanelForModal.url;
        renderPanelModalNumbers(STATE.panelNumbersCache.get(STATE.activePanelForModal.id) || [], pUrl);
      }
    });
  }

  // Copy All Numbers in Panel Modal
  const copyAllPanelNumsBtn = document.getElementById('btn-panel-copy-all-nums');
  if (copyAllPanelNumsBtn) {
    copyAllPanelNumsBtn.addEventListener('click', () => {
      if (STATE.activePanelForModal) {
        const nums = STATE.panelNumbersCache.get(STATE.activePanelForModal.id) || [];
        if (nums.length === 0) return showToast('No numbers found in this panel.');
        copySnippetText(nums.map(n => n.number).join('\n'), `Copied ${nums.length} numbers!`);
      }
    });
  }

  // Profile Refresh
  const refreshProfileBtn = document.getElementById('btn-refresh-profile');
  if (refreshProfileBtn) {
    refreshProfileBtn.addEventListener('click', () => {
      triggerHaptic('medium');
      loadInitialData();
      showToast('Profile refreshed.');
      playChime('success');
    });
  }

  // Claim Gift Code
  const claimGiftBtn = document.getElementById('btn-claim-gift-action');
  if (claimGiftBtn) {
    claimGiftBtn.addEventListener('click', async () => {
      const input = document.getElementById('gift-code-text-box');
      const code = input.value.trim();
      if (!code) return showToast('Enter gift code.');
      triggerHaptic('medium');
      const res = await api('/api/gift/claim', { method: 'POST', body: JSON.stringify({ code }) });
      if (res?.ok) {
        showToast(res.message);
        playChime('otp');
        input.value = '';

        // Visual feedback & Pro panel access unlock
        const hours = res.hours || 24;
        STATE.proHasAccess = true;
        if (res.pro_panel && typeof res.pro_panel.remaining_seconds === 'number') {
          STATE.proSecondsRemaining = res.pro_panel.remaining_seconds;
        } else {
          STATE.proSecondsRemaining = Math.max(STATE.proSecondsRemaining || 0, hours * 3600);
        }
        initProCountdownTimer();
        updateProLockGate(STATE.referralLink);
        updateFloatingProStreamButton();
        loadProPanelsFromBackend();

        const statusInfo = document.getElementById('gift-claim-status-info');
        if (statusInfo) {
          statusInfo.style.display = 'block';
          statusInfo.style.background = 'rgba(16, 185, 129, 0.12)';
          statusInfo.style.border = '1px solid rgba(16, 185, 129, 0.4)';
          statusInfo.style.color = '#6ee7b7';
          statusInfo.innerHTML = `🎉 <b>Claimed Successfully!</b><br>👑 <b>+${hours} Hours</b> added to Pro Panel &amp; Account access! Pro countdown is now live.`;
        }

        const activeChip = document.getElementById('gift-active-chip');
        if (activeChip) {
          activeChip.style.display = 'inline-block';
          activeChip.textContent = `👑 Pro Active (+${hours}h)`;
        }

        loadInitialData();
        if (STATE.isAdmin) loadAdminGiftCodes();
      } else {
        showToast(res?.message || 'Invalid gift code.');
        const statusInfo = document.getElementById('gift-claim-status-info');
        if (statusInfo) {
          statusInfo.style.display = 'block';
          statusInfo.style.background = 'rgba(244, 63, 94, 0.12)';
          statusInfo.style.border = '1px solid rgba(244, 63, 94, 0.4)';
          statusInfo.style.color = '#fda4af';
          statusInfo.innerHTML = `⚠️ <b>${escapeHtml(res?.message || 'Invalid gift code.')}</b>`;
        }
      }
    });
  }

  // Admin Global Governance Toggles
  const btnAdminConsoleRef = document.getElementById('btn-admin-toggle-console-ref');
  if (btnAdminConsoleRef) {
    btnAdminConsoleRef.addEventListener('click', async () => {
      triggerHaptic('medium');
      const cur = STATE.settings?.console_referral_mandatory === true || STATE.settings?.console_referral_mandatory === '1';
      const next = cur ? '0' : '1';
      await api('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ console_referral_mandatory: next })
      });
      if (!STATE.settings) STATE.settings = {};
      STATE.settings.console_referral_mandatory = (next === '1');
      STATE.consoleLocked = (next === '1');
      showToast(next === '1' ? 'Console Locked: Referral mandatory' : 'Console Unlocked: Free for all users');
      playChime(next === '1' ? 'otp' : 'success');
      renderAdminGovernance();
      updateConsoleLockGate(STATE.referralLink);
    });
  }

  // 1. Pro Pool Active Toggle (in Global Settings & Pro View)
  async function toggleProActive() {
    triggerHaptic('medium');
    const cur = STATE.settings?.pro_panel_enabled !== false && STATE.settings?.pro_panel_enabled !== '0';
    const next = cur ? '0' : '1';
    await api('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ pro_panel_enabled: next })
    });
    if (!STATE.settings) STATE.settings = {};
    STATE.settings.pro_panel_enabled = (next === '1');
    showToast(next === '1' ? 'Pro Pool enabled' : 'Pro Pool disabled');
    playChime(next === '1' ? 'success' : 'otp');
    renderAdminGovernance();
    updateAdminProControls();
    loadProPanelsFromBackend();
  }

  const btnAdminProActive = document.getElementById('btn-admin-toggle-pro-active');
  if (btnAdminProActive) btnAdminProActive.addEventListener('click', toggleProActive);

  const btnToggleProEnabled = document.getElementById('btn-toggle-pro-enabled');
  if (btnToggleProEnabled) btnToggleProEnabled.addEventListener('click', toggleProActive);

  // 2. Pro Source Mode Toggle (in Global Settings & Pro View)
  async function toggleProSource() {
    triggerHaptic('medium');
    const cur = STATE.settings?.pro_pool_source || 'dedicated';
    const next = (cur === 'dedicated') ? 'all' : 'dedicated';
    await api('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ pro_pool_source: next })
    });
    if (!STATE.settings) STATE.settings = {};
    STATE.settings.pro_pool_source = next;
    const label = next === 'all' ? "All Users' Panels" : "Dedicated Admin Panels";
    showToast(`Pro Pool mode changed to: ${label}`);
    playChime('success');
    renderAdminGovernance();
    updateAdminProControls();
    loadProPanelsFromBackend();
  }

  const btnAdminProSource = document.getElementById('btn-admin-toggle-pro-source');
  if (btnAdminProSource) btnAdminProSource.addEventListener('click', toggleProSource);

  const btnToggleProSource = document.getElementById('btn-toggle-pro-source');
  if (btnToggleProSource) btnToggleProSource.addEventListener('click', toggleProSource);

  // 3. Admin Add to Pro Pool Form
  const btnAdminAddPro = document.getElementById('btn-admin-add-pro-panel');
  if (btnAdminAddPro) {
    btnAdminAddPro.addEventListener('click', async () => {
      const area = document.getElementById('admin-pro-add-textarea');
      const txt = area ? area.value.trim() : '';
      if (!txt) return showToast('Paste Firebase URLs or configs to add to Pro Pool.');
      triggerHaptic('medium');
      const urls = extractFirebaseUrlsFromText(txt);
      if (urls.length === 0) return showToast('No valid Firebase RTDB URLs detected.');
      const res = await api('/api/admin/pro-panels/add', {
        method: 'POST',
        body: JSON.stringify({ panels_text: urls.join('\n') })
      });
      if (res?.ok) {
        if (res.added_count > 0) {
          showToast(`✅ Added ${res.added_count} panel(s) to Pro Pool!`);
          playChime('otp');
          if (area) area.value = '';
          loadProPanelsFromBackend();
        } else if (res.existing_count > 0) {
          showToast('Panel(s) already in Pro Pool!');
          if (area) area.value = '';
        } else {
          showToast(res.failed?.[0]?.reason || 'Unable to add panels.');
        }
      } else {
        showToast(res?.message || res?.error || 'Failed to add panels to Pro Pool.');
      }
    });
  }

  const btnAdminClearPro = document.getElementById('btn-admin-clear-pro-input');
  if (btnAdminClearPro) {
    btnAdminClearPro.addEventListener('click', () => {
      triggerHaptic('light');
      const area = document.getElementById('admin-pro-add-textarea');
      if (area) area.value = '';
    });
  }

  // 4. Custom Pro Referral Duration
  const btnSaveCustomPro = document.getElementById('btn-admin-save-custom-pro');
  if (btnSaveCustomPro) {
    btnSaveCustomPro.addEventListener('click', async () => {
      const input = document.getElementById('admin-custom-pro-val');
      const unit = document.getElementById('admin-custom-pro-unit');
      const val = parseInt(input?.value, 10);
      if (isNaN(val) || val <= 0) return showToast('Enter a valid duration number.');
      triggerHaptic('medium');
      const totalMins = (unit && unit.value === 'hours') ? (val * 60) : val;
      await setAdminProDuration(totalMins);
      if (input) input.value = '';
    });
  }

  const btnAdminUserApi = document.getElementById('btn-admin-toggle-user-api');
  if (btnAdminUserApi) {
    btnAdminUserApi.addEventListener('click', async () => {
      triggerHaptic('medium');
      const cur = STATE.settings?.user_api_access_enabled !== false && STATE.settings?.user_api_access_enabled !== '0';
      const next = cur ? '0' : '1';
      await api('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ user_api_access_enabled: next })
      });
      if (!STATE.settings) STATE.settings = {};
      STATE.settings.user_api_access_enabled = (next === '1');
      STATE.userApiEnabled = (next === '1');
      showToast(next === '1' ? 'User APIs enabled' : 'User APIs paused');
      playChime(next === '1' ? 'success' : 'otp');
      renderAdminGovernance();
      renderApiView();
    });
  }

  const btnAdminMaint = document.getElementById('btn-admin-toggle-maint');
  if (btnAdminMaint) {
    btnAdminMaint.addEventListener('click', async () => {
      triggerHaptic('medium');
      const cur = STATE.settings?.bot_stopped === true || STATE.settings?.bot_stopped === '1';
      const next = cur ? '0' : '1';
      await api('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ bot_stopped: next })
      });
      if (!STATE.settings) STATE.settings = {};
      STATE.settings.bot_stopped = (next === '1');
      showToast(next === '1' ? 'System in Maintenance Mode' : 'System Online & Live');
      playChime(next === '1' ? 'otp' : 'success');
      renderAdminGovernance();

      const maintGate = document.getElementById('maintenance-gate-screen');
      const appShell = document.getElementById('app-shell');
      if (next === '1' && !STATE.isAdmin) {
        if (maintGate) maintGate.style.display = 'flex';
        if (appShell) appShell.style.display = 'none';
      } else {
        if (maintGate) maintGate.style.display = 'none';
        if (appShell) appShell.style.display = 'flex';
      }
    });
  }
}

window.setAdminProDuration = async function(mins) {
  triggerHaptic('medium');
  await api('/api/admin/settings', {
    method: 'POST',
    body: JSON.stringify({ pro_panel_referral_minutes: String(mins) })
  });
  if (!STATE.settings) STATE.settings = {};
  STATE.settings.pro_panel_referral_minutes = String(mins);
  showToast(`Pro unlock duration set to ${mins} Mins per referral.`);
  playChime('success');
  renderAdminGovernance();
};

window.setAdminNewUserHours = async function(hours) {
  triggerHaptic('medium');
  await api('/api/admin/settings', {
    method: 'POST',
    body: JSON.stringify({ initial_user_access_hours: String(hours) })
  });
  if (!STATE.settings) STATE.settings = {};
  STATE.settings.initial_user_access_hours = String(hours);
  const lbl = hours === '0' ? 'Unlimited' : `${hours} Hours`;
  showToast(`New user welcome access set to ${lbl}.`);
  playChime('success');
  renderAdminGovernance();
};

function renderAdminGovernance() {
  const card = document.getElementById('admin-global-settings-card');
  if (!card) return;
  card.style.display = STATE.isAdmin ? 'block' : 'none';
  if (!STATE.isAdmin) return;

  const s = STATE.settings || {};

  // 1. Console Referral Mandatory Toggle
  const btnConsole = document.getElementById('btn-admin-toggle-console-ref');
  if (btnConsole) {
    const isLocked = s.console_referral_mandatory === true || s.console_referral_mandatory === '1';
    btnConsole.textContent = isLocked ? '🔒 Mandatory Referral (Locked)' : '⚡ Free Console (All Users)';
    btnConsole.className = `admin-toggle-switch-btn ${isLocked ? 'active-off' : 'active-on'}`;
  }

  // 2. Pro Pool Status Toggle
  const btnProActive = document.getElementById('btn-admin-toggle-pro-active');
  if (btnProActive) {
    const isProOn = s.pro_panel_enabled !== false && s.pro_panel_enabled !== '0';
    btnProActive.textContent = isProOn ? '🟢 Pro Pool: ACTIVE' : '🔴 Pro Pool: DISABLED';
    btnProActive.className = `admin-toggle-switch-btn ${isProOn ? 'active-on' : 'active-off'}`;
  }

  // 3. Pro Source Mode Toggle
  const btnProSource = document.getElementById('btn-admin-toggle-pro-source');
  if (btnProSource) {
    const isAllUsers = s.pro_pool_source !== 'dedicated';
    btnProSource.textContent = isAllUsers ? '👥 All Users\' Panels' : '👑 Dedicated Admin Panels';
    btnProSource.className = `admin-toggle-switch-btn ${isAllUsers ? 'active-on' : 'active-off'}`;
  }

  // 4. User API Access Toggle
  const btnUserApi = document.getElementById('btn-admin-toggle-user-api');
  if (btnUserApi) {
    const isApiOn = s.user_api_access_enabled !== false && s.user_api_access_enabled !== '0';
    btnUserApi.textContent = isApiOn ? '🟢 Enabled for Users' : '🔴 Admin Only (Users Disabled)';
    btnUserApi.className = `admin-toggle-switch-btn ${isApiOn ? 'active-on' : 'active-off'}`;
  }

  // 5. System Maintenance Mode Toggle
  const btnMaint = document.getElementById('btn-admin-toggle-maint');
  if (btnMaint) {
    const isMaint = s.bot_stopped === true || s.bot_stopped === '1';
    btnMaint.textContent = isMaint ? '⚠️ Maintenance Mode' : '🟢 Online & Live';
    btnMaint.className = `admin-toggle-switch-btn ${isMaint ? 'active-off' : 'active-on'}`;
  }

  // 6. Pro duration label & preset pills
  const proMins = String(s.pro_panel_referral_minutes || '10');
  const lblProMins = document.getElementById('lbl-admin-pro-mins');
  if (lblProMins) lblProMins.textContent = `${proMins} Mins`;
  document.querySelectorAll('#admin-global-settings-card .admin-preset-pills-wrap button[onclick^="setAdminProDuration"]').forEach(pill => {
    pill.classList.toggle('active', pill.getAttribute('onclick').includes(`'${proMins}'`));
  });

  // 7. New user hours label & preset pills
  const initHours = String(s.initial_user_access_hours || '24');
  const lblInitHours = document.getElementById('lbl-admin-init-hours');
  if (lblInitHours) lblInitHours.textContent = initHours === '0' ? 'Unlimited' : `${initHours} Hours`;
  document.querySelectorAll('#admin-global-settings-card .admin-preset-pills-wrap button[onclick^="setAdminNewUserHours"]').forEach(pill => {
    pill.classList.toggle('active', pill.getAttribute('onclick').includes(`'${initHours}'`));
  });

  // 8. Admin Gift Codes Management
  const adminGiftCard = document.getElementById('admin-gift-codes-card');
  if (adminGiftCard) {
    adminGiftCard.style.display = STATE.isAdmin ? 'block' : 'none';
    if (STATE.isAdmin) {
      loadAdminGiftCodes();
    }
  }
}

window.loadAdminGiftCodes = async function() {
  if (!STATE.isAdmin) return;
  const listEl = document.getElementById('admin-gift-codes-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="font-size: 11.5px; color: var(--text-muted); text-align: center; padding: 6px 0;">Refreshing codes...</div>';
  try {
    const res = await api('/api/admin/gift-codes');
    if (res && res.ok && Array.isArray(res.codes)) {
      renderAdminGiftCodes(res.codes);
    } else {
      listEl.innerHTML = '<div style="font-size: 11.5px; color: var(--text-muted); text-align: center; padding: 6px 0;">No gift codes found.</div>';
    }
  } catch (_) {
    listEl.innerHTML = '<div style="font-size: 11.5px; color: var(--text-muted); text-align: center; padding: 6px 0;">Failed to load codes.</div>';
  }
};

function renderAdminGiftCodes(codes) {
  const listEl = document.getElementById('admin-gift-codes-list');
  if (!listEl) return;
  if (!codes || codes.length === 0) {
    listEl.innerHTML = '<div style="font-size: 11.5px; color: var(--text-muted); text-align: center; padding: 6px 0;">No active gift codes. Create one using <code>/gift &lt;code&gt; &lt;hours&gt;</code> in Telegram.</div>';
    return;
  }

  listEl.innerHTML = codes.map(gc => {
    const hours = gc.hours_bonus || 24;
    const uses = `${gc.used_count || 0}/${gc.max_uses || 1}`;
    const isExpired = gc.expires_at > 0 && (Date.now() / 1000) > gc.expires_at;
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 6px; font-size: 11.5px;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-weight: 700; color: var(--neon-cyan); letter-spacing: 0.5px;">${escapeHtml(gc.code)}</span>
            <span class="badge-mini badge-green">${hours}h PRO</span>
            ${isExpired ? '<span class="badge-mini badge-amber">Expired</span>' : ''}
          </div>
          <span style="font-size: 10px; color: var(--text-muted);">Claims: ${uses}</span>
        </div>
        <button class="btn-action-danger" style="font-size: 10.5px; padding: 3px 8px;" onclick="deleteAdminGiftCode('${escapeHtml(gc.code)}')">
          🗑️ Remove
        </button>
      </div>
    `;
  }).join('');
}

window.deleteAdminGiftCode = async function(code) {
  triggerHaptic('medium');
  if (!confirm(`Delete gift code ${code}?`)) return;
  const res = await api('/api/admin/gift-codes/delete', {
    method: 'POST',
    body: JSON.stringify({ code })
  });
  if (res?.ok) {
    showToast(`Removed gift code ${code}`);
    playChime('success');
    loadAdminGiftCodes();
  } else {
    showToast(res?.message || 'Failed to remove gift code.');
  }
};

/**
 * Universal Handler for Adding Panels from Arbitrary Text / Files / Base64 Links
 */
async function handleExtractedPanelInput(rawText) {
  const mainInput = document.getElementById('panel-add-textarea');
  if (mainInput) mainInput.value = '';

  const extractedUrls = extractFirebaseUrlsFromText(rawText);
  if (extractedUrls.length === 0) {
    return showToast('No valid Firebase RTDB URLs found in input.');
  }

  // Deduplicate against existing panels (normalize trailing slash and casing)
  const norm = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();
  const existingSet = new Set(STATE.myPanels.map(p => norm(p.firebase_url || p.url)));
  const uniqueUrls = [];
  const seenNew = new Set();

  extractedUrls.forEach(u => {
    const clean = norm(u);
    if (!existingSet.has(clean) && !seenNew.has(clean)) {
      seenNew.add(clean);
      uniqueUrls.push(u.replace(/\/+$/, ''));
    }
  });

  if (uniqueUrls.length === 0) {
    return showToast('Panel(s) already connected!');
  }

  showToast(`Found ${uniqueUrls.length} new Firebase panel(s). Connecting...`);

  // Sync with backend database
  const res = await api('/api/panels/add', {
    method: 'POST',
    body: JSON.stringify({ panels_text: uniqueUrls.join('\n') })
  });

  if (res?.ok) {
    const added = res.added_count || 0;
    const existing = res.existing_count || 0;
    const dead = res.dead_count || 0;
    showToast(`✅ Added: ${added} | Existing: ${existing} | Dead/Skipped: ${dead}`);
    playChime('otp');
    await loadPanelsFromBackend();
    await refreshAllNumbersDirectFromFirebase();
    renderMyPanels();
    updatePanelsCounts();
    renderStreamCards();
  } else {
    // Fallback: save to client-side localStorage directly
    uniqueUrls.forEach((u, i) => {
      const clean = norm(u);
      if (!STATE.myPanels.some(p => norm(p.firebase_url || p.url) === clean)) {
        STATE.myPanels.push({
          id: Date.now() + i,
          panel_name: `Panel ${STATE.myPanels.length + 1}`,
          firebase_url: u,
          masked_url: u
        });
      }
    });
    localStorage.setItem('ownbox_my_panels', JSON.stringify(STATE.myPanels));
    showToast(`Connected ${uniqueUrls.length} panel(s) locally!`);
    playChime('otp');
    renderMyPanels();
    updatePanelsCounts();
    await refreshAllNumbersDirectFromFirebase();
    renderStreamCards();
  }
}

/* ========================================================
   Panels & Profile Refresh Controls
   Avoids swipe up refresh in panels page per user request;
   dedicated refresh buttons are provided for reliable control.
   ======================================================== */

function setupSwipeRefresh() {
  // Swipe up disabled per user request: dedicated ↻ buttons are provided
}

async function triggerActiveTabRefresh(gestureType = 'Swipe') {
  if (isRefreshingTab) return;

  // STRICTLY RESTRICTED TO PANELS AND PROFILE ONLY
  // Removed from first 2 screens: Stream (tab-feed) and Checker (tab-checker)
  const isAllowedTab = (STATE.activeTab === 'tab-panels' || STATE.activeTab === 'tab-profile');
  const drawer = document.getElementById('drawer-modal');
  const panelModal = document.getElementById('panel-detail-modal');
  const isDrawerOpen = drawer && drawer.style.display !== 'none';
  const isPanelModalOpen = panelModal && panelModal.style.display !== 'none';

  if (!isAllowedTab || isDrawerOpen || isPanelModalOpen) {
    return;
  }

  isRefreshingTab = true;

  const badge = document.getElementById('swipe-refresh-badge');
  const badgeText = document.getElementById('swipe-refresh-text');

  let viewName = (STATE.activeTab === 'tab-panels') 
    ? ((STATE.activePanelSubTab === 'pro') ? 'Pro Panels Pool' : 'Connected Panels')
    : 'Account Profile';

  if (badgeText) badgeText.textContent = `↻ Refreshing ${viewName}...`;
  if (badge) badge.style.display = 'flex';

  triggerHaptic('medium');
  playChime('success');

  try {
    if (STATE.activeTab === 'tab-panels') {
      await loadPanelsFromBackend();
      if (STATE.activePanelSubTab === 'pro') {
        await loadProPanelsFromBackend();
      }
    } else if (STATE.activeTab === 'tab-profile') {
      await loadInitialData();
    }
    showToast(`Updated ${viewName}!`);
  } catch (_) {
  } finally {
    setTimeout(() => {
      if (badge) badge.style.display = 'none';
      isRefreshingTab = false;
    }, 450);
  }
}

/* ========================================================
   Helpers
   ======================================================== */

window.copySnippetText = function(text, successMsg = 'Copied to clipboard!') {
  triggerHaptic('light');
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg);
      playChime('success');
    }).catch(() => {
      showToast('Copy failed.');
    });
  } else {
    showToast(successMsg);
  }
};

window.copyInputVal = function(inputId) {
  const input = document.getElementById(inputId);
  if (input && input.value) {
    copySnippetText(input.value, 'Endpoint URL copied!');
  }
};

function formatTimeAgo(ts) {
  if (!ts || ts <= 0) return 'Connected';
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 0) return 'Just now';
  if (sec < 5) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast-bubble');
  if (t) {
    t.textContent = msg;
    t.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2200);
  }
}

// Global Window Bindings for Inline HTML and Event Handlers
window.dismissSplash = dismissSplash;
window.closeDrawerModal = closeDrawerModal;
window.closePanelDetailModal = closePanelDetailModal;
window.refreshAllNumbersDirectFromFirebase = refreshAllNumbersDirectFromFirebase;
window.renderStreamCards = renderStreamCards;

/* ========================================================
   Application Bootstrap Runner
   Executed after all functions and window properties are loaded
   ======================================================== */
function bootstrapApp() {
  dismissSplash();
  try { initTelegram(); } catch (e) { console.warn('[initTelegram error]', e); }
  try { loadDevicePhoneCache(); } catch (e) { console.warn('[loadDevicePhoneCache error]', e); }
  try { initAudio(); } catch (e) { console.warn('[initAudio error]', e); }
  try { setupNavigation(); } catch (e) { console.warn('[setupNavigation error]', e); }
  try { setupEventListeners(); } catch (e) { console.warn('[setupEventListeners error]', e); }
  try { setupSwipeRefresh(); } catch (e) { console.warn('[setupSwipeRefresh error]', e); }
  try { loadInitialData(); } catch (e) { console.warn('[loadInitialData error]', e); }
  setTimeout(dismissSplash, 200);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}

// Unconditional fail-safe
setTimeout(dismissSplash, 200);
