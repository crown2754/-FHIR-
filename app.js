const { createApp, ref, reactive, computed, nextTick } = Vue;

/* ---------- 共用工具 ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDT = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${fmtTime(d)}`;
const toISO = (d) => `${fmtDate(d)}T${fmtTime(d)}:00+08:00`;
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

function cnToNum(s) {
  if (/^\d+$/.test(s)) return +s;
  const d = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const i = s.indexOf('十');
  if (i === -1) return d[s] ?? NaN;
  const tens = i === 0 ? 1 : d[s[0]];
  const ones = s[i + 1] ? d[s[i + 1]] : 0;
  return tens * 10 + ones;
}

/* ---------- 醫療代碼 ---------- */
const PERIODS = {
  fasting: { label: '空腹', loinc: '1558-6', display: 'Fasting glucose [Mass/volume] in Serum or Plasma', high: 130, target: '80–130' },
  premeal: { label: '餐前', loinc: '2339-0', display: 'Glucose [Mass/volume] in Blood', high: 130, target: '80–130' },
  post2h: { label: '餐後2h', loinc: '1521-4', display: 'Glucose [Mass/volume] in Serum or Plasma --2 hours post meal', high: 180, target: '<180' },
  random: { label: '其他', loinc: '2339-0', display: 'Glucose [Mass/volume] in Blood', high: 180, target: '<180' },
};
const ICD = {
  'E11.9': 'Type 2 diabetes mellitus without complications',
  'E11.65': 'Type 2 diabetes mellitus with hyperglycemia',
  'Z79.84': 'Long term (current) use of oral hypoglycemic drugs',
};
const PATIENT = { name: '衛斯理 先生', gender: 'male', birthDate: '1988-03-14', id: 'A12****789' };
const DOCTOR = { name: '原振俠 醫師', dept: '新陳代謝科', org: '中原智慧醫院' };

function interp(r) {
  if (r.value < 70) return 'L';
  return r.value > PERIODS[r.period].high ? 'H' : 'N';
}

/* ---------- 種子資料：約 70 天的居家血糖 ---------- */
function seedRecords() {
  const rand = mulberry32(20261019);
  const ri = (a, b) => Math.round(a + rand() * (b - a));
  const list = [];
  const now = new Date();
  for (let d = 72; d >= 1; d--) {
    const day = new Date(now);
    day.setDate(now.getDate() - d);
    if (rand() < 0.82) {
      const t = new Date(day); t.setHours(7, ri(0, 40), 0, 0);
      list.push({ id: uuid(), time: t, period: 'fasting', value: ri(94, 142), source: 'seed' });
    }
    if (rand() < 0.38) {
      const t = new Date(day); t.setHours(ri(13, 20), ri(0, 59), 0, 0);
      list.push({ id: uuid(), time: t, period: 'post2h', value: ri(136, 232), source: 'seed' });
    }
  }
  return list;
}

function calcStats(recs) {
  if (!recs.length) return null;
  const avg = (a) => (a.length ? Math.round(a.reduce((s, r) => s + r.value, 0) / a.length) : 0);
  const f = recs.filter((r) => r.period === 'fasting');
  const p = recs.filter((r) => r.period === 'post2h');
  const values = recs.map((r) => r.value);
  const all = avg(recs);
  const high = recs.filter((r) => interp(r) === 'H').length;
  const low = recs.filter((r) => interp(r) === 'L').length;
  const sorted = [...recs].sort((a, b) => a.time - b.time);
  return {
    n: recs.length, avg: all, fAvg: avg(f), pAvg: avg(p), fN: f.length, pN: p.length,
    pHigh: p.filter((r) => interp(r) === 'H').length,
    max: Math.max(...values), min: Math.min(...values), high, low,
    inRate: Math.round(((recs.length - high - low) / recs.length) * 100),
    gmi: (3.31 + 0.02392 * all).toFixed(1),
    from: sorted[0].time, to: sorted[sorted.length - 1].time,
  };
}

function suggestIcd(stats) {
  if (stats && stats.high / stats.n >= 0.25) {
    return {
      code: 'E11.65', display: ICD['E11.65'], zh: '第二型糖尿病伴有高血糖',
      reason: `${stats.n} 筆中有 ${stats.high} 筆高於目標（${Math.round((stats.high / stats.n) * 100)}%），餐後平均 ${stats.pAvg} mg/dL`,
    };
  }
  return null;
}

/* ---------- FHIR R4 Bundle ---------- */
function buildBundle(recs, hba1c, suggestion) {
  const pUrl = `urn:uuid:${uuid()}`;
  const icd = (code) => ({ system: 'http://hl7.org/fhir/sid/icd-10-cm', code, display: ICD[code] });
  const condition = (code, text, verification, note) => ({
    fullUrl: `urn:uuid:${uuid()}`,
    resource: {
      resourceType: 'Condition',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: verification }] },
      code: { coding: [icd(code)], text },
      subject: { reference: pUrl },
      ...(note ? { note: [{ text: note }] } : {}),
    },
    request: { method: 'POST', url: 'Condition' },
  });

  const entries = [
    {
      fullUrl: pUrl,
      resource: {
        resourceType: 'Patient',
        identifier: [{ system: 'https://www.ris.gov.tw/national-id', value: PATIENT.id }],
        name: [{ text: PATIENT.name }],
        gender: PATIENT.gender,
        birthDate: PATIENT.birthDate,
      },
      request: { method: 'PUT', url: `Patient?identifier=${PATIENT.id}` },
    },
    condition('E11.9', '第二型糖尿病', 'confirmed'),
    condition('Z79.84', '長期使用口服降血糖藥（Metformin）', 'confirmed'),
  ];
  if (suggestion) {
    entries.push(condition(suggestion.code, suggestion.zh, 'provisional', `AI Agent 建議碼，待醫師確認：${suggestion.reason}`));
  }
  if (hba1c) {
    entries.push({
      fullUrl: `urn:uuid:${uuid()}`,
      resource: {
        resourceType: 'Observation', status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }], text: '糖化血色素 HbA1c' },
        subject: { reference: pUrl },
        effectiveDateTime: toISO(hba1c.time),
        valueQuantity: { value: hba1c.value, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
      },
      request: { method: 'POST', url: 'Observation' },
    });
  }
  for (const r of recs) {
    const p = PERIODS[r.period];
    const i = interp(r);
    entries.push({
      fullUrl: `urn:uuid:${r.id}`,
      resource: {
        resourceType: 'Observation', status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: p.loinc, display: p.display }], text: `${p.label}血糖（居家自我監測）` },
        subject: { reference: pUrl },
        effectiveDateTime: toISO(r.time),
        valueQuantity: { value: r.value, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
        interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: i }] }],
        method: { text: 'SMBG（居家血糖機）' },
      },
      request: { method: 'POST', url: 'Observation' },
    });
  }
  return { resourceType: 'Bundle', id: uuid(), type: 'transaction', timestamp: toISO(new Date()), entry: entries };
}

function bundlePreview(bundle) {
  const obs = bundle.entry.filter((e) => e.resource.resourceType === 'Observation');
  const others = bundle.entry.filter((e) => e.resource.resourceType !== 'Observation');
  const short = { ...bundle, entry: [...others.slice(0, 2), ...obs.slice(-1), { '…': `其餘 ${bundle.entry.length - 3} 筆 entry（Condition / Observation）` }] };
  return JSON.stringify(short, null, 2).split('\n');
}

/* ---------- 傳輸步驟 ---------- */
const STEP_DEFS = [
  { key: 'query', icon: '🔎', title: 'AI Agent 查詢 SQLite 資料庫', desc: '從本地 SQLite (glucose.db) 撈出最近的血糖紀錄' },
  { key: 'icd', icon: '🩺', title: '疾病脈絡 → ICD-10-CM', desc: '帶入既有診斷，並依血糖趨勢提出建議碼' },
  { key: 'fhir', icon: '🧩', title: '封裝 FHIR R4 Bundle', desc: 'Patient + Condition + Observation（LOINC / UCUM）' },
  { key: 'auth', icon: '🔐', title: '病人授權與安全通道', desc: 'Consent + SMART on FHIR OAuth 2.0 + TLS 1.3' },
  { key: 'send', icon: '📡', title: '傳送至醫院 FHIR Server', desc: 'POST [base]/ （transaction）' },
  { key: 'verify', icon: '✅', title: '伺服器驗證與入庫', desc: '$validate → 200 OK，每筆 entry 201 Created' },
  { key: 'notify', icon: '🔔', title: '通知主治醫師', desc: '推播至醫師的行動裝置' },
];

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------- App ---------- */
createApp({
  setup() {
    const records = ref(seedRecords());
    const hba1c = ref(null);
    const messages = ref([]);
    const DEMO_PROMPT = '預估我最近的糖化血色素';
    const input = ref(DEMO_PROMPT);
    const typing = ref(false);
    const chatBody = ref(null);
    const logBox = ref(null);
    const fileInput = ref(null);
    const clock = ref(fmtTime(new Date()));
    setInterval(() => (clock.value = fmtTime(new Date())), 15000);

    /* ----- SQLite (sql.js) 引擎狀態 ----- */
    let SQL = null;
    let sqliteDb = null;
    let initialDbBytes = null;
    const dbState = reactive({
      ready: false,
      source: '載入中…',
      showModal: false,
      lastSql: '',
      sqlQuery: 'SELECT substr(recorded_at, 1, 16) AS 時間, slot AS 時段, period_label AS 狀態, value AS 血糖值, interpretation AS 判讀, loinc_code AS LOINC, note AS 備註 FROM glucose_records ORDER BY recorded_at DESC LIMIT 20;',
      queryCols: [],
      queryRows: [],
      queryError: '',
    });

    function syncRecordsFromSqlite() {
      if (!sqliteDb) return;
      const res = sqliteDb.exec('SELECT id, recorded_at, slot, period, value, source, note FROM glucose_records ORDER BY recorded_at ASC;');
      if (!res.length) {
        records.value = [];
        return;
      }
      records.value = res[0].values.map(([id, recorded_at, slot, period, value, source, note]) => ({
        id,
        time: new Date(recorded_at),
        slot: slot || '',
        period: PERIODS[period] ? period : 'random',
        value: Number(value),
        source: source || 'seed',
        note: note || '',
      }));
    }

    function runCustomSql(sqlText) {
      if (sqlText) dbState.sqlQuery = sqlText;
      if (!sqliteDb) return;
      dbState.queryError = '';
      try {
        const res = sqliteDb.exec(dbState.sqlQuery);
        if (res.length) {
          dbState.queryCols = res[0].columns;
          dbState.queryRows = res[0].values;
        } else {
          dbState.queryCols = ['結果'];
          dbState.queryRows = [['執行成功（0 筆回傳列）']];
        }
        syncRecordsFromSqlite();
      } catch (err) {
        dbState.queryError = err.message || String(err);
      }
    }

    async function initSqlite(forceReset = false) {
      try {
        if (!SQL && window.initSqlJs) {
          SQL = await window.initSqlJs();
        }
        if (!SQL) return;
        if (!initialDbBytes || forceReset) {
          try {
            const resp = await fetch('data/glucose.db');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            initialDbBytes = new Uint8Array(await resp.arrayBuffer());
            dbState.source = 'data/glucose.db (SQLite 3)';
          } catch (_) {
            if (window.__SEED_SQLITE_B64__) {
              initialDbBytes = b64ToBytes(window.__SEED_SQLITE_B64__);
              dbState.source = 'data/glucose.db (內嵌 SQLite 3)';
            }
          }
        }
        if (initialDbBytes) {
          if (sqliteDb) sqliteDb.close();
          sqliteDb = new SQL.Database(new Uint8Array(initialDbBytes));
          dbState.ready = true;
          dbState.lastSql = 'SELECT * FROM glucose_records ORDER BY recorded_at DESC;';
          syncRecordsFromSqlite();
          runCustomSql();
        }
      } catch (e) {
        console.warn('SQLite init fallback:', e);
      }
    }
    initSqlite();

    function insertRecordToSqlite(rec) {
      if (!sqliteDb) return '';
      const p = PERIODS[rec.period];
      const i = interp(rec);
      const iso = toISO(rec.time);
      const s = rec.slot || '其他';
      const note = '病人透過卡皮君對話新增';
      sqliteDb.run(
        `INSERT INTO glucose_records (id, patient_id, patient_name, recorded_at, slot, period, period_label, loinc_code, loinc_display, value, unit, interpretation, source, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mg/dL', ?, 'chat', ?);`,
        [rec.id, PATIENT.id, PATIENT.name, iso, s, rec.period, p.label, p.loinc, p.display, rec.value, i, note]
      );
      const sqlPreview = `INSERT INTO glucose_records (recorded_at, slot, period, loinc_code, value, interpretation) VALUES ('${iso}', '${s}', '${rec.period}', '${p.loinc}', ${rec.value}, '${i}');`;
      dbState.lastSql = sqlPreview;
      syncRecordsFromSqlite();
      runCustomSql();
      return sqlPreview;
    }

    function downloadSqliteDb() {
      if (!sqliteDb) return;
      const bytes = sqliteDb.export();
      const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'glucose.db';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function downloadCsv() {
      const headers = ['id', 'patient_id', 'patient_name', 'recorded_at', 'slot', 'period', 'period_label', 'loinc_code', 'loinc_display', 'value', 'unit', 'interpretation', 'source', 'note'];
      let rows = [];
      if (sqliteDb) {
        const res = sqliteDb.exec(`SELECT ${headers.join(', ')} FROM glucose_records ORDER BY recorded_at ASC;`);
        if (res.length) rows = res[0].values;
      } else {
        rows = sortedRecords.value.map((r) => [
          r.id, PATIENT.id, PATIENT.name, toISO(r.time), r.slot || '', r.period, PERIODS[r.period].label,
          PERIODS[r.period].loinc, PERIODS[r.period].display, r.value, 'mg/dL', interp(r), r.source || 'seed', r.note || '',
        ]);
      }
      const esc = (v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'glucose_records.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    async function handleFileImport(ev) {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        if (file.name.endsWith('.db') || file.name.endsWith('.sqlite') || file.name.endsWith('.sqlite3')) {
          const buf = new Uint8Array(await file.arrayBuffer());
          if (sqliteDb) sqliteDb.close();
          sqliteDb = new SQL.Database(buf);
          dbState.source = `${file.name} (匯入 SQLite)`;
          syncRecordsFromSqlite();
          runCustomSql();
        } else if (file.name.endsWith('.csv')) {
          const text = await file.text();
          const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
          if (lines.length > 1 && sqliteDb) {
            const cols = lines[0].split(',').map((c) => c.trim());
            const idxTime = cols.indexOf('recorded_at');
            const idxSlot = cols.indexOf('slot');
            const idxPeriod = cols.indexOf('period');
            const idxVal = cols.indexOf('value');
            const idxNote = cols.indexOf('note');
            sqliteDb.run('BEGIN TRANSACTION;');
            for (let i = 1; i < lines.length; i++) {
              const parts = lines[i].split(',');
              const period = PERIODS[parts[idxPeriod]] ? parts[idxPeriod] : 'fasting';
              const val = Number(parts[idxVal]);
              if (!Number.isFinite(val)) continue;
              const p = PERIODS[period];
              const dt = parts[idxTime] ? new Date(parts[idxTime]) : new Date();
              const slot = parts[idxSlot] || '早上';
              const note = parts[idxNote] || 'CSV 匯入';
              const id = uuid();
              sqliteDb.run(
                `INSERT INTO glucose_records (id, patient_id, patient_name, recorded_at, slot, period, period_label, loinc_code, loinc_display, value, unit, interpretation, source, note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mg/dL', ?, 'csv', ?);`,
                [id, PATIENT.id, PATIENT.name, toISO(dt), slot, period, p.label, p.loinc, p.display, val, interp({ period, value: val }), note]
              );
            }
            sqliteDb.run('COMMIT;');
            dbState.source = `${file.name} (CSV 已匯入 SQLite)`;
            syncRecordsFromSqlite();
            runCustomSql();
          }
        }
      } catch (err) {
        dbState.queryError = '匯入失敗：' + (err.message || err);
      }
      ev.target.value = '';
    }

    const transfer = reactive({ started: false, running: false, steps: [], logs: [], sent: 0, total: 0, preview: [], previewShown: 0 });
    const doctor = reactive({ notified: false, opened: false, tab: 'overview', bundle: null, records: [], hba1c: null, suggestion: null, aiDecision: null, replied: false, showNotif: false });

    const sortedRecords = computed(() => [...records.value].sort((a, b) => b.time - a.time));

    const scrollChat = () => nextTick(() => { if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight; });
    const scrollLog = () => nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; });

    function push(msg) {
      messages.value.push({ id: uuid(), time: fmtTime(new Date()), ...msg });
      scrollChat();
    }
    async function agentSay(msg, delay = 800) {
      typing.value = true; scrollChat();
      await sleep(delay);
      typing.value = false;
      push({ from: 'agent', type: 'text', ...msg });
    }

    push({
      from: 'agent', type: 'text',
      text: `${PATIENT.name} 午安！我是你的專屬水豚健康管家「卡皮君」🦫👓\n\n小本本已經準備好囉 📝 在下方選好「時段」、「狀態」和「血糖值」按送出，本豚就會迅速幫你轉換成國際標準 FHIR 格式收進健康檔案！\n\n累積好紀錄後，隨時按「📤 傳最近 50 筆給醫師」，交給我一鍵打包護送～`,
    });

    const page = ref(1);
    const SLOTS = ['早上', '中午', '晚上', '睡前'];
    const STATES = [
      { key: 'fasting', label: '空腹' },
      { key: 'premeal', label: '餐前' },
      { key: 'post2h', label: '餐後 2 小時' },
    ];
    const composer = reactive({ slot: '早上', state: 'fasting', value: 118 });
    const composerValid = computed(() => Number.isFinite(composer.value) && composer.value >= 20 && composer.value <= 600);
    const composerInterp = computed(() => (composerValid.value ? interp({ period: composer.state, value: composer.value }) : null));
    const bump = (d) => { composer.value = Math.min(600, Math.max(20, (Number(composer.value) || 0) + d)); };

    function submitComposer() {
      if (!composerValid.value || typing.value || transfer.running) return;
      const label = STATES.find((s) => s.key === composer.state).label;
      push({ from: 'user', type: 'text', text: `${composer.slot}・${label}・血糖 ${composer.value} mg/dL` });
      recordGlucose(composer.state, composer.value, composer.slot);
    }

    const goPage = (n) => {
      if (n === 2 && !transfer.started) return;
      if (n === 3 && !doctor.notified) return;
      page.value = n;
      if (n === 3 && !doctor.opened) {
        doctor.showNotif = false;
        setTimeout(() => (doctor.showNotif = true), 800);
      }
    };

    /* ----- 意圖判斷（簡化版規則，模擬 LLM 的 function calling） ----- */
    async function handle(text) {
      const t = text.replace(/\s/g, '');
      const countMatch = t.match(/(\d+|[一二兩三四五六七八九十]+)筆/);
      const count = countMatch ? cnToNum(countMatch[1]) : NaN;

      if (/(傳|送|分享|上傳|給).*(醫師|醫生|醫院|大夫)/.test(t)) {
        if (transfer.running) return agentSay({ text: '卡皮君正在全速跑腿傳送資料中，請稍等一下下喔 🐾' });
        const n = Number.isFinite(count) && count > 0 ? count : 50;
        const recs = sortedRecords.value.slice(0, n);
        const st = calcStats(recs);
        typing.value = true; scrollChat();
        await sleep(900);
        typing.value = false;
        return push({
          from: 'agent', type: 'consent', state: 'pending',
          data: { n: recs.length, asked: n, from: fmtDate(st.from), to: fmtDate(st.to), hba1c: hba1c.value },
        });
      }

      if (/(列出|查看|顯示|看一下|最近).*(血糖|紀錄|記錄)/.test(t)) {
        const n = Number.isFinite(count) && count > 0 ? Math.min(count, 30) : 10;
        typing.value = true; scrollChat();
        await sleep(700);
        typing.value = false;
        return push({ from: 'agent', type: 'table', text: `（推眼鏡👓）翻開小本本！這是你最近 ${n} 筆血糖紀錄，整整齊齊：`, data: sortedRecords.value.slice(0, n) });
      }

      if (/(糖化|a1c)/i.test(t) && /(預估|估算|推估|估計|計算|多少|幫我算)/.test(t)) {
        typing.value = true; scrollChat();
        await sleep(1100);
        typing.value = false;
        return push(estimateA1c());
      }

      if (/(糖化|a1c)/i.test(t)) {
        const m = t.replace(/hba1c|a1c/gi, '').match(/(\d{1,2}(?:\.\d)?)/);
        if (!m) return agentSay({ text: '歪頭 🦫 請告訴卡皮君糖化血色素的數值喔，例如「糖化血色素 6.8」～' });
        const v = parseFloat(m[1]);
        hba1c.value = { value: v, time: new Date() };
        const tip = v >= 7
          ? '稍微高於一般糖友的控制目標（<7%）喔，回診時我們一起請原振俠醫師看看怎麼調整治療！'
          : '穩穩控制在目標（<7%）內，跟水豚一樣情緒與血糖都超穩定，繼續保持！🌟';
        return agentSay({
          type: 'record',
          text: `唰唰唰 📝 已幫你把糖化血色素 HbA1c ${v}% 記進小本本囉！\n${tip}\n\n💡 卡皮君小知識：它反映過去約 3 個月的平均血糖，平常多記「餐後 2 小時」，本豚幫你推算會更神準喔！`,
          data: { code: '4548-4', display: 'Hemoglobin A1c', value: v, unit: '%', interp: v >= 7 ? 'H' : 'N' },
        });
      }

      const valMatch = t.match(/(\d{2,3})/);
      const hasGlucose = /血糖|飯後|餐後|空腹|餐前|睡前/.test(t);
      if (hasGlucose && !valMatch) return agentSay({ text: '小鉛筆準備好了 ✏️ 血糖是多少呢？告訴我數字就好，例如「晚餐後血糖 165」～' });
      if (valMatch) {
        const v = +valMatch[1];
        if (v < 20 || v > 600) return agentSay({ text: `咦？${v} mg/dL 讓卡皮君的眼鏡都滑下來了 👓💦 要不要再確認一下血糖機上的數字呢？` });
        let period = 'random';
        if (/飯後|餐後|吃完|食後/.test(t)) period = 'post2h';
        else if (/餐前|飯前/.test(t)) period = 'premeal';
        else if (/空腹|起床|早上|晨/.test(t)) period = 'fasting';
        return recordGlucose(period, v);
      }

      return agentSay({ text: '包在精明能幹的卡皮君身上 🦫✨ 我可以幫你：\n• 記錄血糖（例：午餐後血糖 186）\n• 記錄糖化血色素（例：糖化血色素 6.8）\n• 預估糖化血色素（例：預估我最近的糖化血色素）\n• 列出紀錄（例：列出最近十筆血糖）\n• 傳給醫師（例：把最近五十筆血糖傳給我的醫師）' });
    }

    function estimateA1c() {
      const since = new Date(Date.now() - 90 * 864e5);
      const recs = records.value.filter((r) => r.time >= since);
      const s = calcStats(recs);
      const e = (s.avg + 46.7) / 28.7;
      const lab = hba1c.value;
      let text = `${PATIENT.name}，（推眼鏡👓）卡皮君調出你最近 90 天的 ${s.n} 筆血糖，高速精算結果出爐囉：`;
      let note = s.pN / s.n < 0.4
        ? `🧐 本豚敏銳發現：你的紀錄以空腹為主（空腹 ${s.fN} 筆、餐後 ${s.pN} 筆），餐後波動容易漏抓，實際抽血的糖化血色素可能會比估算值再高一些喔！`
        : '✨ 空腹與餐後紀錄比例很均衡，卡皮君算出的這份參考價值很高喔！';
      if (lab) {
        const diff = (lab.value - e).toFixed(1);
        note += `\n\n📊 跟你回報的實測值 ${lab.value}% 相比差了 ${diff > 0 ? '+' : ''}${diff}%。`;
      }
      note += '\n\n⚠️ 卡皮君貼心提醒：這是依平均血糖換算的推估值，不能取代醫院抽血檢驗喔！';
      return {
        from: 'agent', type: 'a1c', text, note,
        data: { ...s, e: e.toFixed(1), lab, pos: Math.min(100, Math.max(0, ((e - 4) / 6) * 100)) },
      };
    }

    function recordGlucose(period, v, slot = '') {
      const rec = { id: uuid(), time: new Date(), period, value: v, slot, source: 'chat' };
      insertRecordToSqlite(rec);
      if (!dbState.ready) records.value.push(rec);
      const p = PERIODS[period];
      const i = interp(rec);
      let tip;
      if (i === 'L') tip = '🚨 警報！這是低血糖！卡皮君請你立刻補充 15 公克快速糖（像半杯果汁或 3 顆方糖），15 分鐘後一定要再測一次喔！';
      else if (period === 'post2h' && v >= 250) tip = '⚠️ 數值明顯偏高！如果持續偏高，或是覺得口渴、多尿、累累的，要盡快找醫師報到喔！';
      else if (i === 'H') tip = period === 'post2h'
        ? '稍微高於餐後目標（<180 mg/dL）囉～回想一下這餐是不是澱粉比較多？跟著卡皮君去散步 15 分鐘很有幫助喔 🐾'
        : `稍微高於${p.label}目標（${p.target} mg/dL），可以留意是不是前一晚有吃宵夜或用藥時間變動喔 🧐`;
      else tip = `穩穩落在目標範圍（${p.target} mg/dL）內！跟水豚頂橘子一樣穩當當 🍊👍`;
      return agentSay({
        type: 'record',
        text: `筆記完成 📝！已幫你記錄 ${slot}${p.label}血糖 ${v} mg/dL（${fmtTime(rec.time)}）。\n${tip}\n\n目前卡皮君的金庫裡已經幫你收好 ${records.value.length} 筆血糖紀錄囉！`,
        data: { code: p.loinc, display: p.display, value: v, unit: 'mg/dL', interp: i },
      });
    }

    function send(text) {
      const v = (text ?? input.value).trim();
      if (!v || typing.value) return;
      push({ from: 'user', type: 'text', text: v });
      input.value = DEMO_PROMPT;
      handle(v);
    }

    function cancelConsent(msg) {
      msg.state = 'cancelled';
      agentSay({ text: '收到！卡皮君立刻把資料鎖回小金庫 🔒 絕對不會離開你的手機半步喔～' }, 500);
    }

    /* ----- 傳輸流程 ----- */
    function log(text, kind = '') {
      transfer.logs.push({ t: fmtTime(new Date()) + ':' + pad(new Date().getSeconds()), text, kind });
      scrollLog();
    }

    async function runStep(key, fn) {
      const s = transfer.steps.find((x) => x.key === key);
      s.status = 'active';
      await fn();
      s.status = 'done';
      await sleep(300);
    }

    async function confirmConsent(msg) {
      msg.state = 'confirmed';
      push({ from: 'agent', type: 'text', text: '收到授權 ✅ 卡皮君戴好眼鏡，啟動 FHIR 加密特快車出發囉 🦫💨！' });

      Object.assign(transfer, {
        started: true, running: true, logs: [], sent: 0, preview: [], previewShown: 0,
        steps: STEP_DEFS.map((s) => ({ ...s, status: 'pending' })),
      });
      Object.assign(doctor, { notified: false, opened: false, tab: 'overview', aiDecision: null, replied: false, showNotif: false });
      await sleep(700);
      page.value = 2;
      await sleep(600);

      const recs = sortedRecords.value.slice(0, msg.data.asked);
      transfer.total = recs.length;
      const st = calcStats(recs);
      const suggestion = suggestIcd(st);
      let bundle;

      await runStep('query', async () => {
        log(`SQLite (data/glucose.db)> SELECT * FROM glucose_records ORDER BY recorded_at DESC LIMIT ${msg.data.asked};`, 'code');
        await sleep(700);
        log(`取得 ${recs.length} 筆（${fmtDate(st.from)} ~ ${fmtDate(st.to)}）`, 'ok');
        log(`空腹 ${st.fN} 筆 · 餐後 ${st.pN} 筆 · 平均 ${st.avg} mg/dL`);
        await sleep(500);
      });

      await runStep('icd', async () => {
        log('讀取病人問題清單 (Problem List)…');
        await sleep(600);
        log('E11.9  Type 2 diabetes mellitus without complications', 'code');
        log('Z79.84 Long term use of oral hypoglycemic drugs', 'code');
        await sleep(600);
        if (suggestion) {
          log(`AI 分析：${suggestion.reason}`, 'warn');
          log(`建議碼 ${suggestion.code} ${suggestion.display}（provisional，待醫師確認）`, 'warn');
        } else {
          log('AI 分析：血糖多在目標內，維持既有診斷', 'ok');
        }
        await sleep(500);
      });

      await runStep('fhir', async () => {
        bundle = buildBundle(recs, hba1c.value, suggestion);
        transfer.preview = bundlePreview(bundle);
        log(`建立 Bundle/${bundle.id.slice(0, 8)}… type=transaction`);
        const total = transfer.preview.length;
        for (let i = 0; i <= total; i += 3) {
          transfer.previewShown = i;
          await sleep(28);
        }
        transfer.previewShown = total;
        log(`共 ${bundle.entry.length} 個 entry：Patient ×1、Condition ×${suggestion ? 3 : 2}、Observation ×${bundle.entry.length - (suggestion ? 4 : 3)}`, 'ok');
        log(`Bundle 大小 ${(JSON.stringify(bundle).length / 1024).toFixed(1)} KB`);
        await sleep(400);
      });

      await runStep('auth', async () => {
        log('Consent：病人同意分享給 ' + DOCTOR.name + '（目的：治療 TREAT）');
        await sleep(500);
        log('POST /auth/token  scope=patient/Observation.write patient/Condition.write');
        await sleep(600);
        log('access_token 取得（有效 300 秒）· TLS 1.3 加密通道建立', 'ok');
        await sleep(300);
      });

      await runStep('send', async () => {
        log(`POST https://fhir.cycu-hospital.example/r4/  Content-Type: application/fhir+json`);
        const n = recs.length;
        for (let i = 1; i <= n; i++) {
          transfer.sent = i;
          await sleep(Math.max(20, 1800 / n));
        }
        log(`已上傳 ${n} 筆血糖 Observation`, 'ok');
      });

      await runStep('verify', async () => {
        await sleep(500);
        log('$validate：符合 FHIR R4 結構，ICD-10-CM / LOINC / UCUM 代碼有效', 'ok');
        await sleep(400);
        log(`HTTP 200 OK · ${bundle.entry.length} × 201 Created`, 'ok');
      });

      await runStep('notify', async () => {
        await sleep(400);
        log(`推播 → ${DOCTOR.name}（${DOCTOR.dept}）`, 'ok');
        Object.assign(doctor, { bundle, records: recs, hba1c: hba1c.value, suggestion, notified: true });
      });

      transfer.running = false;
      push({
        from: 'agent', type: 'done',
        text: `使命必達 🦫✨！卡皮君已經把最近 ${recs.length} 筆血糖紀錄${hba1c.value ? '與糖化血色素' : ''}安全送到 ${DOCTOR.name} 的平板上囉！`,
        data: { id: bundle.id.slice(0, 8), n: bundle.entry.length },
      });
    }

    /* ----- 醫師端 ----- */
    const dStats = computed(() => calcStats(doctor.records));
    const chart = computed(() => {
      const recs = [...doctor.records].sort((a, b) => a.time - b.time);
      const W = 640, H = 220, pl = 40, pr = 14, pt = 12, pb = 26, ymin = 40, ymax = 260;
      const x = (i) => pl + (recs.length <= 1 ? 0 : (i * (W - pl - pr)) / (recs.length - 1));
      const y = (v) => pt + ((ymax - Math.min(Math.max(v, ymin), ymax)) * (H - pt - pb)) / (ymax - ymin);
      const pts = recs.map((r, i) => ({ x: x(i), y: y(r.value), r, i: interp(r) }));
      const line = (p) => pts.filter((q) => q.r.period === p).map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
      const idx = recs.length ? [0, Math.floor((recs.length - 1) / 2), recs.length - 1] : [];
      return {
        W, H, pl, pr, pts,
        fLine: line('fasting'), pLine: line('post2h'),
        grid: [70, 130, 180, 250].map((v) => ({ v, y: y(v) })),
        band: { y1: y(180), y2: y(70) },
        xlabels: idx.map((i) => ({ x: x(i), text: fmtDate(recs[i].time).slice(5) })),
      };
    });
    const doctorTable = computed(() => [...doctor.records].sort((a, b) => b.time - a.time));
    const bundleJson = computed(() => (doctor.bundle ? JSON.stringify(doctor.bundle, null, 2) : ''));

    function decideAi(accept) {
      doctor.aiDecision = accept ? 'accepted' : 'rejected';
      const c = doctor.bundle.entry.find((e) => e.resource.resourceType === 'Condition' && e.resource.verificationStatus.coding[0].code === 'provisional');
      if (c) c.resource.verificationStatus.coding[0].code = accept ? 'confirmed' : 'refuted';
    }

    function doctorReply() {
      const s = dStats.value;
      doctor.replied = true;
      push({
        from: 'doctor', type: 'text',
        text: `${PATIENT.name}你好，我是${DOCTOR.name}。已看過你最近 ${s.n} 筆血糖：空腹平均 ${s.fAvg}、餐後平均 ${s.pAvg} mg/dL，餐後超過 180 有 ${s.pHigh} 次。` +
          `\n\n下次回診我們一起討論飲食與藥物調整，這段時間請多記錄「餐後 2 小時」血糖，謝謝你的配合！`,
      });
      setTimeout(() => goPage(1), 1200);
    }

    function reset() {
      initSqlite();
      if (!dbState.ready) records.value = seedRecords();
      hba1c.value = null;
      page.value = 1;
      input.value = DEMO_PROMPT;
      Object.assign(composer, { slot: '早上', state: 'fasting', value: 118 });
      messages.value = [];
      Object.assign(transfer, { started: false, running: false, steps: [], logs: [], sent: 0, total: 0, preview: [], previewShown: 0 });
      Object.assign(doctor, { notified: false, opened: false, tab: 'overview', bundle: null, records: [], hba1c: null, suggestion: null, aiDecision: null, replied: false, showNotif: false });
      push({ from: 'agent', type: 'text', text: `${PATIENT.name} 午安！我是你的專屬水豚健康管家「卡皮君」🦫👓\n\n小本本與 SQLite 資料庫已經重新準備好囉 📝 在下方選好「時段」、「狀態」和「血糖值」按送出就可以開始記錄！` });
    }

    return {
      PERIODS, PATIENT, DOCTOR, ICD,
      records, messages, input, typing, chatBody, logBox, fileInput, clock, page, goPage,
      dbState, runCustomSql, downloadSqliteDb, downloadCsv, handleFileImport,
      SLOTS, STATES, composer, composerValid, composerInterp, bump, submitComposer,
      transfer, doctor, dStats, chart, doctorTable, bundleJson,
      send, confirmConsent, cancelConsent, decideAi, doctorReply, reset,
      fmtDT, fmtDate, fmtTime, interp,
    };
  },

  template: `
  <header class="topbar">
    <div class="brand">
      <span class="dot"></span>
      病人主訴「糖尿病回診」：<b>AI Agent</b> × <b>FHIR R4</b> × <b>ICD-10-CM</b>
    </div>
    <ol class="stages">
      <li :class="{ on: true, cur: page === 1 }" @click="goPage(1)"><span>1</span>病人對 AI 記錄血糖</li>
      <li :class="{ on: transfer.started, cur: page === 2 }" @click="goPage(2)"><span>2</span>FHIR 標準化傳輸</li>
      <li :class="{ on: doctor.notified, cur: page === 3 }" @click="goPage(3)"><span>3</span>醫師行動裝置接收</li>
    </ol>
    <div class="top-actions">
      <button class="ghost db-btn" @click="dbState.showModal = true; runCustomSql()">
        🗄️ SQLite / CSV（{{ records.length }} 筆）
      </button>
      <button class="ghost" @click="reset">↺ 重新開始</button>
    </div>
  </header>

  <main class="stage" :class="'p' + page">
    <!-- ===== 病人手機 ===== -->
    <section class="col col-phone" v-show="page === 1">
      <div class="col-title"><img class="title-av" src="patient.jpg" alt="衛斯理 先生" /> 病人手機 · {{ PATIENT.name }} ＆ 專屬 AI Agent</div>
      <div class="phone">
        <div class="phone-status"><span>{{ clock }}</span><span>5G ▮▮▮ 🔋</span></div>
        <div class="chat-head">
          <img class="avatar" src="avatar.jpg" alt="卡皮君" />
          <div style="flex: 1">
            <div class="chat-name">卡皮君 · 健康 AI Agent</div>
            <div class="chat-sub">{{ typing ? '卡皮君正奮筆疾書… ✏️' : '精明水豚管家 · 已連結 SQLite / FHIR' }}</div>
          </div>
          <button class="ghost sm db-mini" @click="dbState.showModal = true; runCustomSql()" title="檢視 SQLite 資料庫與匯出 CSV">🗄️ DB</button>
        </div>

        <div class="chat-body" ref="chatBody">
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.from">
            <div v-if="m.from === 'doctor'" class="from-doc">🩺 {{ DOCTOR.name }}（經由 FHIR Communication）</div>

            <div v-if="m.type === 'text' || m.type === 'record' || m.type === 'done'" class="bubble">
              <div class="txt">{{ m.text }}</div>
              <div v-if="m.type === 'record'" class="fhir-chip">
                <div class="chip-h">FHIR Observation</div>
                <div>LOINC <code>{{ m.data.code }}</code> {{ m.data.display }}</div>
                <div>valueQuantity <b>{{ m.data.value }} {{ m.data.unit }}</b>
                  <span class="tag" :class="m.data.interp">{{ m.data.interp }}</span>
                </div>
              </div>
              <div v-if="m.type === 'done'" class="fhir-chip ok">
                <div class="chip-h">Bundle {{ m.data.id }}… · {{ m.data.n }} entries</div>
                <div>狀態：200 OK，已寫入醫院 FHIR Server</div>
              </div>
              <div class="meta">{{ m.time }}</div>
            </div>

            <div v-else-if="m.type === 'a1c'" class="bubble">
              <div class="txt">{{ m.text }}</div>
              <div class="a1c">
                <div class="a1c-main">
                  <small>估算糖化血色素 eA1c</small>
                  <b :class="{ hi: m.data.e >= 7 }">{{ m.data.e }}<em>%</em></b>
                </div>
                <div class="gauge">
                  <div class="g-bar"><i :style="{ left: m.data.pos + '%' }"></i></div>
                  <div class="g-lbl"><span>4%</span><span>正常 &lt;5.7</span><span>目標 &lt;7</span><span>10%</span></div>
                </div>
                <div class="a1c-rows">
                  <div><span>平均血糖</span><b>{{ m.data.avg }} mg/dL</b></div>
                  <div><span>空腹 / 餐後平均</span><b>{{ m.data.fAvg }} / {{ m.data.pAvg }}</b></div>
                  <div><span>資料期間</span><b>{{ fmtDate(m.data.from).slice(5) }} ~ {{ fmtDate(m.data.to).slice(5) }}（{{ m.data.n }} 筆）</b></div>
                  <div v-if="m.data.lab"><span>回報實測值</span><b>{{ m.data.lab.value }}%</b></div>
                </div>
                <div class="formula">公式（ADAG）：eA1c = (平均血糖 + 46.7) ÷ 28.7</div>
              </div>
              <div class="txt">{{ m.note }}</div>
              <div class="meta">{{ m.time }}</div>
            </div>

            <div v-else-if="m.type === 'table'" class="bubble">
              <div class="txt">{{ m.text }}</div>
              <table class="mini">
                <tr><th>時間</th><th>時段</th><th>mg/dL</th></tr>
                <tr v-for="r in m.data" :key="r.id">
                  <td>{{ fmtDT(r.time) }}</td><td>{{ PERIODS[r.period].label }}</td>
                  <td :class="'v-' + interp(r)">{{ r.value }}</td>
                </tr>
              </table>
              <div class="meta">{{ m.time }}</div>
            </div>

            <div v-else-if="m.type === 'consent'" class="bubble consent">
              <div class="chip-h">📤 卡皮君的分享授權確認單 🦫📝</div>
              <div class="txt">本豚已經幫你整理好包裹，準備加密傳送給 <b>{{ DOCTOR.name }}</b>（{{ DOCTOR.org }} {{ DOCTOR.dept }}）：</div>
              <ul>
                <li>最近 <b>{{ m.data.n }}</b> 筆血糖紀錄（{{ m.data.from }} ~ {{ m.data.to }}）</li>
                <li v-if="m.data.hba1c">糖化血色素 {{ m.data.hba1c.value }}%</li>
                <li>診斷：E11.9 第二型糖尿病（ICD-10-CM）</li>
                <li>格式：HL7 FHIR R4 Bundle</li>
              </ul>
              <div v-if="m.data.n < m.data.asked" class="warn-s">目前只有 {{ m.data.n }} 筆，會全部傳送。</div>
              <div class="btns" v-if="m.state === 'pending'">
                <button class="primary" @click="confirmConsent(m)">同意傳送</button>
                <button class="ghost" @click="cancelConsent(m)">取消</button>
              </div>
              <div v-else class="state">{{ m.state === 'confirmed' ? '✅ 已授權' : '已取消' }}</div>
              <div class="meta">{{ m.time }}</div>
            </div>
          </div>

          <div v-if="typing" class="msg agent"><div class="bubble typing"><i></i><i></i><i></i></div></div>
        </div>

        <div class="composer">
          <div class="row">
            <span class="lbl">時段</span>
            <div class="seg">
              <button v-for="s in SLOTS" :key="s" :class="{ on: composer.slot === s }" @click="composer.slot = s">{{ s }}</button>
            </div>
          </div>
          <div class="row">
            <span class="lbl">狀態</span>
            <div class="seg">
              <button v-for="s in STATES" :key="s.key" :class="{ on: composer.state === s.key }" @click="composer.state = s.key">{{ s.label }}</button>
            </div>
          </div>
          <div class="row">
            <span class="lbl">血糖</span>
            <div class="val">
              <button class="step" @click="bump(-10)">−10</button>
              <button class="step" @click="bump(-1)">−</button>
              <input type="number" min="20" max="600" v-model.number="composer.value" :class="composerInterp" />
              <span class="unit">mg/dL</span>
              <button class="step" @click="bump(1)">＋</button>
              <button class="step" @click="bump(10)">+10</button>
            </div>
          </div>
          <input type="range" min="40" max="350" v-model.number="composer.value" class="slider" />
          <div class="actions">
            <button class="primary send" :disabled="!composerValid || typing || transfer.running" @click="submitComposer">
              送出：{{ composer.slot }}・{{ STATES.find(s => s.key === composer.state).label }}・{{ composer.value }}
            </button>
          </div>
          <div class="quick">
            <button @click="send('列出我最近十筆血糖')" :disabled="typing || transfer.running">📋 最近十筆</button>
            <button class="to-doc" @click="send('幫我把最近的五十筆血糖紀錄傳給我的醫師')" :disabled="typing || transfer.running">📤 傳最近 50 筆給醫師</button>
          </div>
        </div>
        <form class="chat-input" @submit.prevent="send()">
          <input v-model="input" placeholder="輸入訊息，例如：預估我最近的糖化血色素" />
          <button class="primary" :disabled="!input.trim() || typing">➤</button>
        </form>
      </div>
    </section>

    <!-- ===== 傳輸過程 ===== -->
    <section class="col col-pipe" v-show="page === 2">
      <div class="col-title">🔄 傳輸過程 · 資料如何安全抵達醫師</div>

      <div class="flow" :class="{ running: transfer.running, done: doctor.notified }">
        <div class="node">📱<span>病人 PHR</span></div>
        <div class="wire"><i v-for="n in 6" :key="n" :style="{ animationDelay: (n * 0.25) + 's' }"></i></div>
        <div class="node">🏥<span>FHIR Server</span></div>
        <div class="wire"><i v-for="n in 6" :key="n" :style="{ animationDelay: (n * 0.25) + 's' }"></i></div>
        <div class="node">💻<span>醫師平板</span></div>
      </div>

      <div v-if="!transfer.started" class="idle">
        <div class="big">⏳</div>
        <p>在病人手機對 AI Agent 說<br><b>「幫我把最近的五十筆血糖紀錄傳給我的醫師」</b><br>這裡會即時顯示資料被標準化與傳送的每一步。</p>
        <div class="legend">
          <div><b>ICD-10-CM</b> 疾病是什麼（E11.9 第二型糖尿病）</div>
          <div><b>LOINC</b> 量了什麼（1521-4 餐後 2 小時血糖）</div>
          <div><b>UCUM</b> 單位是什麼（mg/dL）</div>
          <div><b>FHIR</b> 用什麼格式交換（Bundle / Observation）</div>
        </div>
      </div>

      <template v-else>
        <ol class="steps">
          <li v-for="s in transfer.steps" :key="s.key" :class="s.status">
            <span class="ico">
              <i v-if="s.status === 'active'" class="spinner"></i>
              <b v-else-if="s.status === 'done'" class="check">✔</b>
              <template v-else>{{ s.icon }}</template>
            </span>
            <div class="sbody">
              <div class="st">{{ s.title }}
                <span class="stat" v-if="s.status === 'active'">處理中…</span>
                <span class="stat ok" v-else-if="s.status === 'done'">完成</span>
                <span v-if="s.key === 'send' && s.status !== 'pending'" class="cnt">{{ transfer.sent }} / {{ transfer.total }}</span>
              </div>
              <div class="sd">{{ s.desc }}</div>
              <div v-if="s.key === 'send' && s.status !== 'pending'" class="bar"><b :style="{ width: (transfer.sent / transfer.total * 100) + '%' }"></b></div>
            </div>
          </li>
        </ol>
        <div class="split">
          <div class="pane">
            <div class="pane-h">FHIR Bundle（預覽）</div>
            <pre class="json">{{ transfer.preview.slice(0, transfer.previewShown).join('\\n') }}</pre>
          </div>
          <div class="pane">
            <div class="pane-h">系統紀錄</div>
            <div class="logs" ref="logBox">
              <div v-for="(l, i) in transfer.logs" :key="i" :class="l.kind"><span>{{ l.t }}</span> {{ l.text }}</div>
            </div>
          </div>
        </div>
        <transition name="drop">
          <div v-if="doctor.notified" class="finish">
            <span>✅ 全部 {{ transfer.steps.length }} 個步驟完成，資料已送達 {{ DOCTOR.name }}</span>
            <button class="primary" @click="goPage(3)">📲 切換到醫師平板 →</button>
          </div>
        </transition>
      </template>
    </section>

    <!-- ===== 醫師平板 ===== -->
    <section class="col col-tab" v-show="page === 3">
      <div class="col-title">🩺 醫師平板 · {{ DOCTOR.name }}
        <button class="ghost sm back" @click="goPage(1)">← 回病人手機</button>
      </div>
      <div class="tablet">
        <div v-if="!doctor.opened" class="lock">
          <div class="lock-time">{{ clock }}</div>
          <div class="lock-sub">{{ DOCTOR.org }} · 醫師行動工作站</div>
          <transition name="drop">
            <div v-if="doctor.showNotif" class="notif" @click="doctor.opened = true">
              <div class="n-h"><span>🏥 智慧病歷 App</span><span>現在</span></div>
              <div class="n-t">新的病人上傳資料：{{ PATIENT.name }}</div>
              <div class="n-b">{{ doctor.records.length }} 筆居家血糖 · FHIR Bundle 已驗證<span v-if="doctor.suggestion"> · AI 建議碼 {{ doctor.suggestion.code }}</span></div>
              <div class="n-c">點一下查看 →</div>
            </div>
          </transition>
          <div v-if="!doctor.showNotif" class="waiting">接收資料中…</div>
        </div>

        <div v-else class="emr">
          <div class="emr-top">
            <div class="pt">
              <img class="pt-av" src="patient.jpg" :alt="PATIENT.name" />
              <div>
                <div class="pt-name">{{ PATIENT.name }} <small>男 · {{ PATIENT.birthDate }} · {{ PATIENT.id }}</small></div>
                <div class="pt-sub">主訴：糖尿病回診 · 來源：病人 AI Agent（FHIR R4）</div>
              </div>
            </div>
            <div class="tabs">
              <button :class="{ on: doctor.tab === 'overview' }" @click="doctor.tab = 'overview'">總覽</button>
              <button :class="{ on: doctor.tab === 'list' }" @click="doctor.tab = 'list'">血糖紀錄（{{ doctor.records.length }}）</button>
              <button :class="{ on: doctor.tab === 'json' }" @click="doctor.tab = 'json'">原始 FHIR</button>
            </div>
          </div>

          <div class="emr-body" v-if="doctor.tab === 'overview' && dStats">
            <div class="dx">
              <div class="dx-card ok"><code>E11.9</code><div><b>第二型糖尿病</b><small>{{ ICD['E11.9'] }}</small></div><span class="badge">已確認</span></div>
              <div class="dx-card ok"><code>Z79.84</code><div><b>長期使用口服降血糖藥</b><small>Metformin 500mg BID</small></div><span class="badge">已確認</span></div>
              <div v-if="doctor.suggestion" class="dx-card ai" :class="doctor.aiDecision">
                <code>{{ doctor.suggestion.code }}</code>
                <div><b>{{ doctor.suggestion.zh }}</b><small>🤖 AI 建議：{{ doctor.suggestion.reason }}</small></div>
                <div v-if="!doctor.aiDecision" class="dx-btns">
                  <button class="primary sm" @click="decideAi(true)">採納</button>
                  <button class="ghost sm" @click="decideAi(false)">不採納</button>
                </div>
                <span v-else class="badge">{{ doctor.aiDecision === 'accepted' ? '醫師已採納' : '醫師未採納' }}</span>
              </div>
            </div>

            <div class="kpis">
              <div><small>筆數</small><b>{{ dStats.n }}</b><em>{{ fmtDate(dStats.from).slice(5) }} ~ {{ fmtDate(dStats.to).slice(5) }}</em></div>
              <div><small>空腹平均</small><b :class="{ hi: dStats.fAvg > 130 }">{{ dStats.fAvg }}</b><em>目標 80–130</em></div>
              <div><small>餐後平均</small><b :class="{ hi: dStats.pAvg > 180 }">{{ dStats.pAvg }}</b><em>目標 &lt;180</em></div>
              <div><small>達標率</small><b>{{ dStats.inRate }}%</b><em>高 {{ dStats.high }} · 低 {{ dStats.low }}</em></div>
              <div v-if="doctor.hba1c"><small>HbA1c</small><b :class="{ hi: doctor.hba1c.value >= 7 }">{{ doctor.hba1c.value }}%</b><em>病人回報</em></div>
              <div v-else><small>估算 GMI</small><b>{{ dStats.gmi }}%</b><em>僅供參考</em></div>
            </div>

            <div class="chart-card">
              <div class="chart-h">
                <span>血糖趨勢（mg/dL）</span>
                <span class="lg"><i class="f"></i>空腹 <i class="p"></i>餐後2h <i class="b"></i>目標區 70–180</span>
              </div>
              <svg :viewBox="'0 0 ' + chart.W + ' ' + chart.H" class="chart">
                <rect :x="chart.pl" :y="chart.band.y1" :width="chart.W - chart.pl - chart.pr" :height="chart.band.y2 - chart.band.y1" class="band" />
                <g v-for="g in chart.grid" :key="g.v">
                  <line :x1="chart.pl" :x2="chart.W - chart.pr" :y1="g.y" :y2="g.y" class="grid" />
                  <text :x="chart.pl - 6" :y="g.y + 4" text-anchor="end" class="ax">{{ g.v }}</text>
                </g>
                <polyline :points="chart.fLine" class="ln f" />
                <polyline :points="chart.pLine" class="ln p" />
                <circle v-for="(p, k) in chart.pts" :key="k" :cx="p.x" :cy="p.y" r="3.4" :class="['pt', p.r.period, p.i]">
                  <title>{{ fmtDT(p.r.time) }} {{ PERIODS[p.r.period].label }} {{ p.r.value }} mg/dL</title>
                </circle>
                <text v-for="l in chart.xlabels" :key="l.x" :x="l.x" :y="chart.H - 6" text-anchor="middle" class="ax">{{ l.text }}</text>
              </svg>
            </div>

            <div class="summary">
              <b>🦫 卡皮君 AI 臨床摘要（供原振俠醫師參考）</b>
              <p>近 {{ dStats.n }} 筆中空腹 {{ dStats.fN }} 筆、餐後 {{ dStats.pN }} 筆；餐後 &gt;180 mg/dL 共 {{ dStats.pHigh }} 次，最高 {{ dStats.max }} mg/dL{{ dStats.low ? '，有 ' + dStats.low + ' 次低血糖' : '，無低血糖紀錄' }}。
                餐後紀錄比例偏低，建議請病人增加餐後 2 小時監測。</p>
              <button class="primary" :disabled="doctor.replied" @click="doctorReply">{{ doctor.replied ? '✅ 已回覆病人' : '💬 回覆病人（傳回病人手機）' }}</button>
            </div>
          </div>

          <div class="emr-body" v-else-if="doctor.tab === 'list'">
            <table class="full">
              <thead><tr><th>#</th><th>時間</th><th>時段</th><th>數值</th><th>判讀</th><th>LOINC</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in doctorTable" :key="r.id">
                  <td>{{ i + 1 }}</td><td>{{ fmtDT(r.time) }}</td><td>{{ PERIODS[r.period].label }}</td>
                  <td :class="'v-' + interp(r)"><b>{{ r.value }}</b> mg/dL</td>
                  <td><span class="tag" :class="interp(r)">{{ interp(r) }}</span></td>
                  <td><code>{{ PERIODS[r.period].loinc }}</code></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="emr-body" v-else>
            <pre class="json light">{{ bundleJson }}</pre>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== SQLite / CSV 資料庫管理視窗 ===== -->
    <div v-if="dbState.showModal" class="db-backdrop" @click.self="dbState.showModal = false">
      <div class="db-modal">
        <div class="db-head">
          <div>
            <b>🗄️ 卡皮君的 SQLite 血糖資料庫 ＆ CSV 管理</b>
            <span class="db-badge">{{ dbState.source }} · 共 {{ records.length }} 筆</span>
          </div>
          <div class="db-actions">
            <button class="ghost sm" @click="downloadSqliteDb">⬇ 匯出 .db (SQLite)</button>
            <button class="ghost sm" @click="downloadCsv">⬇ 匯出 .csv (Excel)</button>
            <button class="ghost sm" @click="fileInput.click()">⬆ 匯入 .db / .csv</button>
            <input ref="fileInput" type="file" accept=".db,.sqlite,.sqlite3,.csv" style="display:none" @change="handleFileImport" />
            <button class="ghost sm" @click="dbState.showModal = false">✕ 關閉</button>
          </div>
        </div>

        <div class="db-sql-bar">
          <div class="db-presets">
            <span>常用 SQL：</span>
            <button class="ghost sm" @click="runCustomSql('SELECT substr(recorded_at, 1, 16) AS 時間, slot AS 時段, period_label AS 狀態, value AS 血糖值, interpretation AS 判讀, loinc_code AS LOINC, note AS 備註 FROM glucose_records ORDER BY recorded_at DESC LIMIT 20;')">最近 20 筆</button>
            <button class="ghost sm" @click="runCustomSql('SELECT substr(recorded_at, 1, 16) AS 時間, slot AS 時段, period_label AS 狀態, value AS 血糖值, note AS 備註 FROM glucose_records WHERE interpretation = \\'H\\' ORDER BY value DESC;')">超標紀錄 (H)</button>
            <button class="ghost sm" @click="runCustomSql('SELECT period_label AS 狀態, COUNT(*) AS 筆數, ROUND(AVG(value), 1) AS 平均血糖, MIN(value) AS 最低, MAX(value) AS 最高 FROM glucose_records GROUP BY period_label;')">依狀態統計 (GROUP BY)</button>
            <button class="ghost sm" @click="runCustomSql('SELECT substr(recorded_at, 1, 16) AS 時間, slot AS 時段, period_label AS 狀態, value AS 血糖值, source AS 來源 FROM glucose_records WHERE source != \\'seed\\' ORDER BY recorded_at DESC;')">對話新增紀錄</button>
          </div>
          <div class="db-query-row">
            <textarea v-model="dbState.sqlQuery" rows="2" spellcheck="false"></textarea>
            <button class="primary" @click="runCustomSql()">▶ 執行 SQL</button>
          </div>
          <div v-if="dbState.queryError" class="db-err">⚠️ {{ dbState.queryError }}</div>
        </div>

        <div class="db-table-wrap">
          <table class="db-table" v-if="dbState.queryCols.length">
            <thead>
              <tr><th v-for="c in dbState.queryCols" :key="c">{{ c }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, rIdx) in dbState.queryRows" :key="rIdx">
                <td v-for="(cell, cIdx) in row" :key="cIdx">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </main>
  `,
}).mount('#app');
