// GenesisPlus 管理後台 — 純 vanilla JS + Supabase REST（無第三方依賴）
(function () {
  "use strict";

  // ---- 設定 ----
  const SUPABASE_URL = "https://xwhhsoppcpkijxxychjm.supabase.co";
  const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3aGhzb3BwY3BraWp4eHljaGptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NjA3NjcsImV4cCI6MjEwNDQzNjc2N30.nxtS7htIk_lqBfSEc0KRxsTks0efCyrLp-w0nGfufrU"; // 公開 key（RLS 已限制，僅登入者可寫）
  const WORKER_URL = "https://genesisplus-lead-gen.prefumeshop.workers.dev";
  const LANGS = ["en", "zh-Hant", "zh-CN", "ko", "ja", "th", "fr", "ar"];
  const SESSION_KEY = "gp_admin_session";
  const TOKEN_KEY = "gp_admin_worker_token";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Supabase anon key 從 admin_defaults.js 旁邊的設定注入；沒有則從後台頁面讀
  // （此 key 為公開 key，RLS 已限制寫入權限，僅登入者可寫）
  // ---- Supabase REST client ----
  const supabase = {
    session: null,
    _load() {
      try { this.session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { this.session = null; }
    },
    _save() { localStorage.setItem(SESSION_KEY, JSON.stringify(this.session)); },
    _clear() { localStorage.removeItem(SESSION_KEY); this.session = null; },
    _authHeaders(roleKey) {
      return {
        apikey: roleKey || SUPABASE_ANON,
        "Content-Type": "application/json",
      };
    },
    async _ensureToken() {
      if (!this.session) throw new Error("未登入");
      const exp = this.session.expires_at || 0;
      if (Date.now() < exp - 60000) return this.session.access_token;
      // 嘗試 refresh
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: this._authHeaders(),
        body: JSON.stringify({ refresh_token: this.session.refresh_token }),
      });
      if (!resp.ok) { this._clear(); throw new Error("登入已過期，請重新登入"); }
      const data = await resp.json();
      this.session.access_token = data.access_token;
      this.session.refresh_token = data.refresh_token || this.session.refresh_token;
      this.session.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
      this.session.user = data.user || this.session.user;
      this._save();
      return this.session.access_token;
    },
    async signIn(email, password) {
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: this._authHeaders(),
        body: JSON.stringify({ email, password }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error_description || err.msg || err.error || "登入失敗");
      }
      const data = await resp.json();
      this.session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        user: data.user,
      };
      this._save();
      return data.user;
    },
    async changePassword(newPwd) {
      const token = await this._ensureToken();
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: { ...this._authHeaders(), Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: newPwd }),
      });
      if (!resp.ok) throw new Error("更改密碼失敗");
      return resp.json();
    },
    async dbFetch(table, query, { schema = "genesisplus" } = {}) {
      const token = await this._ensureToken();
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
        headers: { ...this._authHeaders(), Authorization: `Bearer ${token}`, "Accept-Profile": schema },
      });
      if (!resp.ok) throw new Error(`讀取 ${table} 失敗 (${resp.status})`);
      return resp.json();
    },
    async dbUpsert(table, rows, { schema = "genesisplus" } = {}) {
      const token = await this._ensureToken();
      const pk = table === "site_content" ? "lang" : "id";
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          ...this._authHeaders(),
          Authorization: `Bearer ${token}`,
          "Content-Profile": schema,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(rows),
      });
      if (!resp.ok) throw new Error(`儲存 ${table} 失敗 (${resp.status})`);
      return true;
    },
    async dbDelete(table, query, { schema = "genesisplus" } = {}) {
      const token = await this._ensureToken();
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
        method: "DELETE",
        headers: { ...this._authHeaders(), Authorization: `Bearer ${token}`, "Accept-Profile": schema, "Content-Profile": schema },
      });
      if (!resp.ok) throw new Error(`刪除 ${table} 失敗 (${resp.status})`);
      return true;
    },
  };

  // ---- Worker API（需要 admin token）----
  const worker = {
    token() { return localStorage.getItem(TOKEN_KEY) || ""; },
    async call(path, opts = {}) {
      const token = this.token();
      if (!token) throw new Error("請先在上方填入 Worker 管理權杖");
      const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
      if (opts.body) headers["Content-Type"] = "application/json";
      const resp = await fetch(`${WORKER_URL}${path}`, { ...opts, headers });
      const text = await resp.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!resp.ok) throw new Error(data && data.error ? data.error : `Worker ${resp.status}`);
      return data;
    },
  };

  // ---- UI helpers ----
  function toast(msg, type = "ok") {
    const el = document.createElement("div");
    el.className = "toast" + (type === "err" ? " err" : type === "warn" ? " warn" : "");
    el.textContent = msg;
    $("toastroot").appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
  let busyCount = 0;
  function busy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    const bar = $("loadbar");
    if (bar) {
      if (busyCount > 0) { bar.style.display = "block"; bar.style.width = "100%"; }
      else { bar.style.width = "0"; setTimeout(() => (bar.style.display = "none"), 300); }
    }
  }
  // 自訂確認彈窗（取代原生 confirm，避免卡死）
  function gpConfirm(message, title = "確認") {
    return new Promise((resolve) => {
      $("modalTitle").textContent = title;
      $("modalMsg").textContent = message;
      $("modalBg").classList.add("open");
      const done = (v) => {
        $("modalBg").classList.remove("open");
        $("modalOk").onclick = null;
        $("modalCancel").onclick = null;
        resolve(v);
      };
      $("modalOk").onclick = () => done(true);
      $("modalCancel").onclick = () => done(false);
    });
  }
  function showView(name) {
    $("loginView").style.display = name === "login" ? "" : "none";
    $("appView").style.display = name === "app" ? "" : "none";
  }
  function switchTab(tab) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    ["content", "email", "data", "ai", "aiJobs", "account"].forEach((t) => ($("tab-" + t).style.display = t === tab ? "" : "none"));
    if (tab === "data") loadData();
    if (tab === "email") loadEmailForm();
    if (tab === "aiJobs") ajLoad();
  }

  // ---- 內容分組 ----
  const GROUP_RULES = [
    { re: /^nav/, label: "🧭 導覽列" },
    { re: /^faq/, label: "❓ FAQ" },
    { re: /^(cb|chat)/, label: "🤖 聊天機器人" },
    { re: /^hero/, label: "🏠 首頁主視覺" },
    { re: /^(startProject|cta|viewAll)/, label: "🔘 行動按鈕" },
    { re: /^scope/, label: "🛠️ 服務流程" },
    { re: /^mode/, label: "📐 服務模式" },
    { re: /^product/, label: "📦 產品" },
    { re: /^(case|filter)/, label: "🏆 案例" },
    { re: /^client/, label: "🤝 客戶" },
    { re: /^about/, label: "🏢 關於我們" },
    { re: /^(contact|form)/, label: "✉️ 聯絡表單" },
    { re: /^footer/, label: "🦶 頁尾" },
    { re: /^news/, label: "📰 新聞" },
    { re: /^benefits/, label: "💎 優勢" },
    { re: /^contactSuccess/, label: "✉️ 聯絡表單" },
  ];
  const GROUP_ORDER = ["🧭 導覽列", "🏠 首頁主視覺", "🔘 行動按鈕", "🤖 聊天機器人", "🛠️ 服務流程", "📐 服務模式", "📦 產品", "🏆 案例", "🤝 客戶", "🏢 關於我們", "✉️ 聯絡表單", "💎 優勢", "❓ FAQ", "📰 新聞", "🦶 頁尾", "其他"];
  function groupOf(key) {
    for (const g of GROUP_RULES) if (g.re.test(key)) return g.label;
    return "其他";
  }

  // ---- 內容頁狀態 ----
  const contentState = { lang: "en", diffs: {}, search: "" };

  function buildLangPills() {
    const box = $("langPills");
    box.innerHTML = "";
    LANGS.forEach((l) => {
      const b = document.createElement("button");
      b.textContent = l;
      b.className = contentState.lang === l ? "active" : "";
      b.addEventListener("click", () => { contentState.lang = l; buildLangPills(); renderContent(); });
      box.appendChild(b);
    });
  }

  async function loadContentRow(lang) {
    try {
      const rows = await supabase.dbFetch("site_content", `select=lang,data&lang=eq.${encodeURIComponent(lang)}&limit=1`);
      return rows && rows[0] && rows[0].data ? rows[0].data : {};
    } catch (e) { throw e; }
  }

  function renderContent() {
    const lang = contentState.lang;
    const defaults = (window.GP_DEFAULTS && window.GP_DEFAULTS[lang]) || {};
    const stored = contentState.diffs[lang] || {};
    const search = contentState.search.toLowerCase();
    const keys = Object.keys(defaults);
    // 合併顯示值：stored 覆寫 default；外加 stored 中不在 default 的鍵
    const allKeys = [...new Set([...keys, ...Object.keys(stored)])].sort();
    const groups = {};
    allKeys.forEach((k) => {
      if (search && !k.toLowerCase().includes(search)) return;
      const g = groupOf(k);
      (groups[g] = groups[g] || []).push(k);
    });
    const box = $("contentGroups");
    box.innerHTML = "";
    const order = [...GROUP_ORDER.filter((g) => groups[g]), ...Object.keys(groups).filter((g) => !GROUP_ORDER.includes(g))];
    order.forEach((g) => {
      const keysInGroup = groups[g].sort();
      const details = document.createElement("details");
      details.className = "group";
      details.open = keysInGroup.length < 15;
      const sum = document.createElement("summary");
      const editedCnt = keysInGroup.filter((k) => stored[k] !== undefined).length;
      sum.innerHTML = `${esc(g)} <span class="cnt">${keysInGroup.length} 個欄位${editedCnt ? " · 已修改 " + editedCnt : ""}</span>`;
      details.appendChild(sum);
      const body = document.createElement("div");
      keysInGroup.forEach((k) => {
        const f = document.createElement("div");
        f.className = "field";
        const label = document.createElement("div");
        label.className = "k";
        label.textContent = k;
        const ta = document.createElement("textarea");
        ta.dataset.key = k;
        ta.value = stored[k] !== undefined ? stored[k] : defaults[k];
        ta.addEventListener("input", () => {
          if (!contentState.diffs[lang]) contentState.diffs[lang] = {};
          const v = ta.value;
          contentState.diffs[lang][k] = v === defaults[k] ? undefined : v;
          if (contentState.diffs[lang][k] === undefined) delete contentState.diffs[lang][k];
          const edited = Object.keys(contentState.diffs[lang] || {}).length;
          $("contentStatus").textContent = edited ? `此語系有 ${edited} 個欄位待儲存` : "";
        });
        f.appendChild(label);
        f.appendChild(ta);
        body.appendChild(f);
      });
      details.appendChild(body);
      box.appendChild(details);
    });
    const edited = Object.keys(contentState.diffs[lang] || {}).length;
    $("contentStatus").textContent = edited ? `此語系有 ${edited} 個欄位待儲存` : "";
  }

  async function saveContent() {
    const lang = contentState.lang;
    const diff = contentState.diffs[lang] || {};
    const keys = Object.keys(diff).filter((k) => diff[k] !== undefined);
    busy(true);
    try {
      if (keys.length === 0) { toast("沒有需要儲存的變更", "warn"); return; }
      const data = {};
      keys.forEach((k) => (data[k] = diff[k]));
      await supabase.dbUpsert("site_content", [{ lang, data }]);
      toast(`已儲存 ${lang} 語系 ${keys.length} 個欄位 ✅`);
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  async function resetContent() {
    const lang = contentState.lang;
    const ok = await gpConfirm(`確定把「${lang}」重設為網站內建預設？後台覆寫值會全部移除。`);
    if (!ok) return;
    busy(true);
    try {
      await supabase.dbDelete("site_content", `lang=eq.${encodeURIComponent(lang)}`);
      delete contentState.diffs[lang];
      toast(`已重設 ${lang} 語系為網站預設`);
      renderContent();
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  // ---- 郵件設置 ----
  // Worker 現行設置（env secrets）預設值：後台未儲存設置時以此預填，避免誤覆寫
  const EMAIL_DEFAULTS = {
    from_name: "Cyrus Chow",
    from_email: "hello@genesisplus.net",
    reply_to: "cyrus.chow@genesisplus.net",
    daily_cap: 20,
    per_run_cap: 5,
    send_pacing_ms: 3000,
    max_analyze: 5,
    outreach_enabled: true,
  };
  async function loadEmailForm() {
    busy(true);
    try {
      const rows = await supabase.dbFetch("email_settings", "select=settings&id=eq.1&limit=1");
      const raw = (rows && rows[0] && rows[0].settings) || {};
      const hasStored = raw && typeof raw === "object" && Object.keys(raw).length > 0;
      const v = hasStored ? raw : EMAIL_DEFAULTS;
      $("st_from_name").value = v.from_name || "";
      $("st_from_email").value = v.from_email || "";
      $("st_reply_to").value = v.reply_to || "";
      $("st_daily_cap").value = v.daily_cap != null ? v.daily_cap : EMAIL_DEFAULTS.daily_cap;
      $("st_per_run_cap").value = v.per_run_cap != null ? v.per_run_cap : EMAIL_DEFAULTS.per_run_cap;
      $("st_pacing").value = v.send_pacing_ms != null ? v.send_pacing_ms : EMAIL_DEFAULTS.send_pacing_ms;
      $("st_max_analyze").value = v.max_analyze != null ? v.max_analyze : EMAIL_DEFAULTS.max_analyze;
      $("st_outreach").checked = v.outreach_enabled !== undefined ? !!v.outreach_enabled : EMAIL_DEFAULTS.outreach_enabled;
      updateOutreachLabel();
      const effNote = document.getElementById("effNote");
      if (effNote) effNote.textContent = hasStored
        ? "已由後台管理。修改後儲存即生效（約 1 分鐘內）。"
        : "尚未由後台管理——欄位顯示 Worker 現行設置，儲存後將改由後台接管。";
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  function updateOutreachLabel() {
    const on = $("st_outreach").checked;
    $("st_outreach_label").textContent = "發送閘門：" + (on ? "開啟（每天會自動發信）" : "關閉（不實際發信）");
  }

  async function saveEmail() {
    busy(true);
    try {
      const settings = {
        from_name: $("st_from_name").value.trim(),
        from_email: $("st_from_email").value.trim(),
        reply_to: $("st_reply_to").value.trim(),
        daily_cap: parseInt($("st_daily_cap").value, 10) || 20,
        per_run_cap: parseInt($("st_per_run_cap").value, 10) || 5,
        send_pacing_ms: parseInt($("st_pacing").value, 10) || 3000,
        max_analyze: parseInt($("st_max_analyze").value, 10) || 5,
        outreach_enabled: $("st_outreach").checked,
      };
      await supabase.dbUpsert("email_settings", [{ id: 1, settings }]);
      toast("郵件設置已儲存 ✅（約 1 分鐘內生效）");
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  async function reloadEffective() {
    busy(true);
    try {
      const s = await worker.call("/settings?refresh=1");
      const on = s.outreach_enabled;
      $("effectiveView").innerHTML =
        `<div style="background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px;font-size:12px;line-height:1.9">
           <span class="badge ${on ? "on" : "off"}">${on ? "發送閘門：開啟" : "發送閘門：關閉"}</span> &nbsp;
           <span class="badge">來源：${esc(s.source || "env")}</span><br>
           發件人：<b>${esc(s.from_name)}</b> &lt;${esc(s.from_email)}&gt;<br>
           回復信箱：${esc(s.reply_to)}<br>
           每日上限：${s.daily_cap} 封 · 每輪上限：${s.per_run_cap} 封 · 間隔：${s.send_pacing_ms}ms · 分析數：${s.max_analyze}
         </div>`;
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  async function sendTestEmail() {
    const to = $("testTo").value.trim();
    if (!to) { toast("請填測試收件人電郵", "warn"); return; }
    busy(true);
    try {
      const r = await worker.call("/test-email", { method: "POST", body: JSON.stringify({ to }) });
      toast(`測試信已發送 ✅（Resend id: ${r.id}）`);
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  // ---- 數據 ----
  async function loadData() {
    busy(true);
    try {
      const [stats, report] = await Promise.all([worker.call("/stats"), worker.call("/report")]);
      $("statGrid").innerHTML = [
        ["已發送總數", stats.totalSent || 0],
        ["今日已發送", stats.sentToday || 0],
        ["每日上限", stats.dailyCap || "-"],
        ["發送閘門", stats.outreachEnabled ? "開啟" : "關閉"],
        ["符合客戶", (report.summary && report.summary.totalQualified) || 0],
        ["近 7 日發送", (report.summary && report.summary.emailsSentLast7Days) || 0],
        ["抑制清單", stats.suppressionListSize || 0],
        ["運行次數(7日)", (report.summary && report.summary.runsLast7Days) || 0],
      ].map(([l, v]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");

      const tb = $("sentTable").querySelector("tbody");
      tb.innerHTML = "";
      if (!report.sentLeads || !report.sentLeads.length) {
        tb.innerHTML = `<tr><td colspan="5" class="empty">尚未發送任何郵件</td></tr>`;
      } else {
        report.sentLeads.forEach((s) => {
          const tr = document.createElement("tr");
          const body = s.body || "";
          tr.innerHTML = `
            <td style="white-space:nowrap">${esc((s.sentAt || s.date || "").slice(0, 16))}</td>
            <td>${esc(s.emails && s.emails[0] ? s.emails[0] : "")}</td>
            <td>${esc(s.subject || "")}</td>
            <td>${esc(s.title || s.domain || "")}</td>
            <td><button class="ghost small" data-act="view" style="font-size:11px">${body ? "查看全文" : "無"}</button>
                <div class="bodyprev">${esc(body)}</div></td>`;
          tb.appendChild(tr);
        });
      }
      // 抑制清單
      const sl = $("suppressList");
      const list = stats.suppressed || [];
      if (!list.length) sl.innerHTML = `<div class="empty">抑制清單為空</div>`;
      else sl.innerHTML = list.map((x) => {
        const v = typeof x === "string" ? x : (x.email || x.domain || "");
        return `<span class="badge" style="margin:0 6px 6px 0;display:inline-block">${esc(v)}</span>`;
      }).join("");
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  async function addSuppress() {
    const input = $("suppressInput").value.trim();
    if (!input) { toast("請輸入電郵或網域", "warn"); return; }
    busy(true);
    try {
      const payload = input.includes("@") ? { email: input } : { domain: input };
      await worker.call("/suppress", { method: "POST", body: JSON.stringify({ ...payload, reason: "admin" }) });
      toast(`已加入抑制清單：${input}`);
      $("suppressInput").value = "";
      loadData();
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  // ---- 登入 / 帳戶 ----
  async function doLogin() {
    const email = $("loginEmail").value.trim();
    const pwd = $("loginPwd").value;
    if (!email || !pwd) { toast("請輸入電郵與密碼", "warn"); return; }
    busy(true);
    try {
      const user = await supabase.signIn(email, pwd);
      showView("app");
      $("whoami").textContent = user.email || "";
      buildLangPills();
      renderContent();
      toast("登入成功 ✅");
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  async function doChangePwd() {
    const p1 = $("newPwd1").value;
    const p2 = $("newPwd2").value;
    if (p1.length < 8) { toast("密碼至少 8 字元", "warn"); return; }
    if (p1 !== p2) { toast("兩次輸入不一致", "warn"); return; }
    busy(true);
    try {
      await supabase.changePassword(p1);
      $("newPwd1").value = ""; $("newPwd2").value = "";
      toast("密碼已更改 ✅");
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  // ---- AI 助手 ----
  async function aiCall(action, payload) {
    return worker.call("/ai", { method: "POST", body: JSON.stringify({ action, ...payload }) });
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => toast("已複製 ✅")).catch(() => toast("複製失敗，請手動選取", "warn"));
    } else {
      toast("此瀏覽器不支援自動複製，請手動選取", "warn");
    }
  }
  function aiResBox(title, inner) {
    return `<div class="aires"><div class="ait" style="font-size:12px;color:var(--muted);margin-bottom:6px">${title}</div>${inner}</div>`;
  }
  function aiOutTextarea(value, extra = "") {
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<textarea class="aiout" readonly data-copy="${esc(value)}" style="min-height:64px">${esc(value)}</textarea>${extra}`;
  }
  function aiButtons(id) {
    return `<div class="row" style="margin-top:6px;gap:8px">
      <button data-copy="${id}">📋 複製</button>
      <button data-apply="${id}">套用至編輯器</button>
    </div>`;
  }
  // 將某欄位值寫入內容編輯器（切語系＋標記變更）
  function applyToEditor(lang, key, value) {
    if (!key) { toast("請先填欄位 Key 才能套用", "warn"); return; }
    contentState.lang = lang;
    buildLangPills();
    renderContent();
    const ta = document.querySelector(`#contentGroups textarea[data-key="${key}"]`);
    if (!ta) { toast("找不到欄位 " + key, "err"); return; }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    toast(`已套用至 ${lang} / ${key} — 記得按「儲存此語系」上線 ✅`);
  }
  // 開發信測試：以變體內容發到回復信箱
  async function aiTestVariant(subject, body) {
    let st = EMAIL_DEFAULTS;
    try { const eff = await worker.call("/settings"); if (eff) st = { ...st, ...eff }; } catch (e) {}
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cleanBody = esc(body).replace(/\[Sender\]/g, esc(st.from_name || "Cyrus Chow"));
    const lines = cleanBody.split("\n").map((l) => (l.trim() ? l : "&nbsp;")).join("<br>");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#374151;font-size:15px;line-height:1.7;">${lines}
      <p style="margin-top:22px">Best regards,<br><strong>${esc(st.from_name || "Cyrus Chow")}</strong><br>
      GenesisPlus Packaging · <a href="https://genesisplus.net">genesisplus.net</a></p>
      <div style="margin-top:20px;padding-top:14px;border-top:1px solid #eee;font-size:12px;color:#999;line-height:1.6;">
      GenesisPlus Packaging (HK) Company · Unit 12, 5/F, Industrial Building, Kwun Tong, Kowloon, Hong Kong<br>
      You received this because our packaging services may be relevant to your business. To stop receiving emails, you can <a href="https://genesisplus-lead-gen.prefumeshop.workers.dev/unsubscribe?email=${encodeURIComponent(st.reply_to || "sales@genesisplus.net")}">Unsubscribe Here</a>.</div></div>`;
    busy(true);
    try {
      const r = await worker.call("/test-email", { method: "POST", body: JSON.stringify({ to: st.reply_to || "sales@genesisplus.net", subject, html }) });
      toast(`已發測試信到 ${r.to}（Resend id ${String(r.id).slice(0, 8)}…）✅`);
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }
  // 翻譯助手
  function aiTlSelected() {
    return [...document.querySelectorAll("#aiTlDst input[type=checkbox]:checked")].map((c) => c.value);
  }
  async function aiTranslateRun() {
    const text = $("aiTlText").value.trim();
    if (!text) { toast("請輸入待翻譯文案", "warn"); return; }
    const targets = aiTlSelected();
    if (!targets.length) { toast("請至少選一個目標語系", "warn"); return; }
    busy(true);
    $("aiTlRes").innerHTML = `<div class="hint">翻譯中（約 5–25 秒）…</div>`;
    try {
      const { translations } = await aiCall("translate", { text, targetLangs: targets, sourceLang: $("aiTlSrc").value });
      const key = $("aiTlKey").value.trim();
      const rows = Object.entries(translations).map(([lang, v]) => {
        const id = `aiTlOut_${lang}`;
        return `<div style="margin-bottom:10px"><div class="k">${esc(lang)}</div>${aiOutTextarea(v, aiButtons(id))}</div>`;
      }).join("");
      $("aiTlRes").innerHTML = rows || '<div class="hint">沒有取得翻譯結果，請重試</div>';
      $("aiTlRes").querySelectorAll("button[data-copy]").forEach((b) => b.addEventListener("click", () => {
        const ta = b.closest("div.row").previousElementSibling;
        copyText(ta.dataset.copy || ta.value);
      }));
      $("aiTlRes").querySelectorAll("button[data-apply]").forEach((b) => {
        b.addEventListener("click", () => {
          const lang = b.getAttribute("data-apply");
          const ta = b.closest("div.row").previousElementSibling;
          applyToEditor(lang, key, ta.value);
        });
      });
    } catch (e) { $("aiTlRes").innerHTML = `<div class="hint err">${esc(e.message)}</div>`; toast(e.message, "err"); }
    finally { busy(false); }
  }
  // 潤色助手
  async function aiPolishRun() {
    const text = $("aiPlText").value.trim();
    if (!text) { toast("請輸入原文案", "warn"); return; }
    busy(true);
    $("aiPlRes").innerHTML = `<div class="hint">潤色中（約 3–15 秒）…</div>`;
    try {
      const { text: out } = await aiCall("polish", { text, tone: $("aiPlTone").value });
      $("aiPlRes").innerHTML = aiOutTextarea(out, aiButtons("aiPlOut"));
      const b = $("aiPlRes").querySelector("button[data-copy]");
      b.addEventListener("click", () => copyText($("aiPlRes").querySelector(".aiout").value));
      $("aiPlRes").querySelector("button[data-apply]").addEventListener("click", () => {
        applyToEditor(contentState.lang, $("aiPlKey").value.trim(), $("aiPlRes").querySelector(".aiout").value);
      });
    } catch (e) { $("aiPlRes").innerHTML = `<div class="hint err">${esc(e.message)}</div>`; toast(e.message, "err"); }
    finally { busy(false); }
  }
  // 開發信變體
  async function aiEmailRun() {
    busy(true);
    $("aiEvRes").innerHTML = `<div class="hint">生成中（約 5–25 秒）…</div>`;
    try {
      const { variants } = await aiCall("email_variants", {
        topic: $("aiEvTopic").value.trim(), market: $("aiEvMarket").value.trim(), count: Number($("aiEvCount").value),
      });
      const cards = variants.map((v, i) => {
        const id = `aiEvOut_${i}`;
        const esc2 = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px">
          <div style="font-weight:700;margin-bottom:4px">主旨：${esc2(v.subject)}</div>
          ${aiOutTextarea(v.body)}
          <div class="row" style="margin-top:6px;gap:8px">
            <button data-copy-v="${id}">📋 複製全文</button>
            <button class="primary" data-test="${i}">✈ 發測試信到回復信箱</button>
          </div>
        </div>`;
      }).join("");
      $("aiEvRes").innerHTML = cards;
      $("aiEvRes").querySelectorAll("button[data-copy-v]").forEach((b) => b.addEventListener("click", () => {
        const ta = b.closest("div.row").previousElementSibling;
        copyText((ta.dataset.copy || "") + "\n\nSubject: " + variants[Number(b.getAttribute("data-copy-v").split("_")[1])].subject);
      }));
      $("aiEvRes").querySelectorAll("button[data-test]").forEach((b) => b.addEventListener("click", () => {
        const i = Number(b.getAttribute("data-test"));
        const ta = b.closest("div.row").previousElementSibling;
        aiTestVariant(variants[i].subject, ta.value);
      }));
    } catch (e) { $("aiEvRes").innerHTML = `<div class="hint err">${esc(e.message)}</div>`; toast(e.message, "err"); }
    finally { busy(false); }
  }
  // SEO 助手
  async function aiSeoRun() {
    const text = $("aiSeoText").value.trim();
    if (!text) { toast("請輸入頁面文案", "warn"); return; }
    busy(true);
    $("aiSeoRes").innerHTML = `<div class="hint">分析中（約 3–15 秒）…</div>`;
    try {
      const r = await aiCall("seo", { page: $("aiSeoPage").value, text });
      const esc2 = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const kw = (r.keywords || []).map((k) => `<span class="chip">${esc2(k)}</span>`).join(" ");
      const meta = `${aiResBox("Meta Title", `<div class="aiout">${esc2(r.metaTitle)}</div>`)}
        ${aiResBox("Meta Description", `<div class="aiout">${esc2(r.metaDescription)}</div>`)}`;
      $("aiSeoRes").innerHTML = `${aiResBox("關鍵字", `<div>${kw}</div>`)}${meta}
        <div class="row" style="margin-top:8px"><button data-seo-copy="1">📋 複製全部</button></div>`;
      $("aiSeoRes").querySelector("[data-seo-copy]").addEventListener("click", () => {
        copyText(`Keywords: ${(r.keywords || []).join(", ")}\nMeta Title: ${r.metaTitle}\nMeta Description: ${r.metaDescription}`);
      });
    } catch (e) { $("aiSeoRes").innerHTML = `<div class="hint err">${esc(e.message)}</div>`; toast(e.message, "err"); }
    finally { busy(false); }
  }
  function aiLoadCurrentLangText() {
    const lang = contentState.lang;
    const defaults = (window.GP_DEFAULTS && window.GP_DEFAULTS[lang]) || {};
    const parts = Object.values(defaults).filter((v) => v && String(v).trim()).map((v) => String(v));
    const text = parts.join("\n").replace(/<[^>]+>/g, "").slice(0, 4000);
    $("aiSeoText").value = text;
    toast(`已載入 ${lang} 語系的頁面文字（${text.length} 字元）`);
  }
  function buildAiLangChecks() {
    const src = $("aiTlSrc");
    if (!src.options.length) {
      LANGS.forEach((l) => { const o = document.createElement("option"); o.value = l; o.textContent = l; src.appendChild(o); });
    }
    const box = $("aiTlDst");
    box.innerHTML = "";
    LANGS.forEach((l) => {
      const lab = document.createElement("label");
      lab.style.cssText = "display:inline-flex;align-items:center;gap:4px;margin:0 8px 6px 0;font-size:12px";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.value = l; cb.checked = l !== "en";
      lab.appendChild(cb); lab.appendChild(document.createTextNode(l));
      box.appendChild(lab);
    });
    src.addEventListener("change", () => {
      box.querySelectorAll("input").forEach((c) => {
        c.disabled = c.value === src.value;
        if (c.value === src.value) c.checked = false;
      });
    });
    src.dispatchEvent(new Event("change"));
  }

  // ---- AI 自動任務（獨立運作，排程由 Worker 執行）----
  const AJ_ACTIONS = {
    translate: "🌐 多語系翻譯",
    polish: "✍️ 文案潤色",
    email_variants: "📧 開發信變體",
    seo: "🔍 SEO 建議",
  };
  const AJ_TARGET_LANGS = ["zh-Hant", "zh-CN", "ko", "ja", "th", "fr", "ar"];
  const AJ_PAGES = ["Home", "About", "Services", "Products", "Cases", "News", "FAQ", "Contact"];

  function renderAjParams() {
    const action = $("ajAction").value;
    let html = "";
    if (action === "translate") {
      html = `<div class="row">
        <div class="grow" style="max-width:220px"><label>來源語系</label><select id="ajpSource">
          ${LANGS.map((l) => `<option value="${l}" ${l === "en" ? "selected" : ""}>${l}</option>`).join("")}
        </select></div>
        <div class="grow"><label>目標語系</label><div class="langs" id="ajpTargets" style="margin:10px 0 0">
          ${AJ_TARGET_LANGS.map((l) => `<button data-lang="${l}" class="${l === "zh-Hant" ? "active" : ""}">${l}</button>`).join("")}
        </div></div>
      </div>
      <div style="margin-top:10px"><label>待翻譯文案</label><textarea id="ajpText" style="min-height:70px" placeholder="輸入要翻譯的文案…"></textarea></div>`;
    } else if (action === "polish") {
      html = `<div class="row"><div class="grow" style="max-width:220px"><label>語氣</label><select id="ajpTone">
        <option value="professional">專業商務</option><option value="luxury">高端奢華</option>
        <option value="friendly">親切友善</option><option value="concise">精簡有力</option>
      </select></div></div>
      <div style="margin-top:10px"><label>原文案</label><textarea id="ajpText" style="min-height:70px" placeholder="輸入要潤色的文案…"></textarea></div>`;
    } else if (action === "email_variants") {
      html = `<div class="row">
        <div class="grow"><label>主題（選填）</label><input type="text" id="ajpTopic" placeholder="例如 custom skincare boxes"></div>
        <div class="grow"><label>目標市場（選填）</label><input type="text" id="ajpMarket" placeholder="例如 skincare brands in US"></div>
        <div class="grow" style="max-width:150px"><label>數量</label><select id="ajpCount">
          <option value="2">2</option><option value="3" selected>3</option><option value="4">4</option><option value="5">5</option>
        </select></div>
      </div>`;
    } else {
      html = `<div class="row"><div class="grow" style="max-width:220px"><label>頁面</label><select id="ajpPage">
        ${AJ_PAGES.map((p) => `<option value="${p}">${p}</option>`).join("")}
      </select></div></div>
      <div style="margin-top:10px"><label>頁面文案</label><textarea id="ajpText" style="min-height:70px" placeholder="輸入頁面文案…"></textarea></div>`;
    }
    $("ajParams").innerHTML = html;
    $("ajParams").addEventListener("click", (e) => {
      const b = e.target.closest("#ajpTargets button");
      if (b) b.classList.toggle("active");
    });
  }

  function ajCollectParams(action) {
    const params = {};
    if (action === "translate") {
      params.text = $("ajpText").value;
      params.sourceLang = $("ajpSource").value;
      params.targetLangs = [...document.querySelectorAll("#ajpTargets button.active")].map((b) => b.dataset.lang);
    } else if (action === "polish") {
      params.text = $("ajpText").value;
      params.tone = $("ajpTone").value;
    } else if (action === "email_variants") {
      params.topic = $("ajpTopic").value;
      params.market = $("ajpMarket").value;
      params.count = Number($("ajpCount").value);
    } else {
      params.page = $("ajpPage").value;
      params.text = $("ajpText").value;
    }
    return params;
  }

  function fmtLocal(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("zh-HK", { hour12: false });
  }

  function ajStatusPill(job) {
    if (!job.enabled) return '<span class="pill off">已停用</span>';
    if (job.last_status === "ok") return '<span class="pill ok">上次成功</span>';
    if (job.last_status === "error") return '<span class="pill err">上次失敗</span>';
    return '<span class="pill off">等待執行</span>';
  }

  async function ajLoad() {
    try {
      const res = await worker.call("/ai/jobs");
      const jobs = (res && res.jobs) || [];
      const box = $("ajList");
      if (!jobs.length) {
        box.innerHTML = '<p class="hint">還沒有任務。用上方表單建立第一個自動任務。</p>';
        return;
      }
      box.innerHTML = `<div style="overflow-x:auto"><table><thead><tr><th>名稱</th><th>動作</th><th>排程 (UTC)</th><th>狀態</th><th>上次執行</th><th>下次執行</th><th>操作</th></tr></thead><tbody>
        ${jobs.map((j) => `<tr class="jobrow">
          <td>${esc(j.name)}</td>
          <td>${esc(AJ_ACTIONS[j.action] || j.action)}</td>
          <td><code>${esc(j.schedule)}</code></td>
          <td>${ajStatusPill(j)}</td>
          <td>${fmtLocal(j.last_run_at)}</td>
          <td>${fmtLocal(j.next_run_at)}</td>
          <td class="ops">
            <button data-act="run" data-id="${j.id}">▶ 立即執行</button>
            <button data-act="results" data-id="${j.id}">📄 結果</button>
            <button data-act="toggle" data-id="${j.id}" data-on="${j.enabled}">${j.enabled ? "停用" : "啟用"}</button>
            <button data-act="del" data-id="${j.id}">🗑 刪除</button>
          </td>
        </tr>`).join("")}
      </tbody></table></div>`;
    } catch (e) {
      $("ajList").innerHTML = `<p class="hint">⚠️ ${esc(e.message)}</p>`;
    }
  }

  async function ajCreate() {
    const action = $("ajAction").value;
    const params = ajCollectParams(action);
    const name = $("ajName").value.trim() || AJ_ACTIONS[action];
    const schedule = $("ajCron").value.trim();
    if (!/^[0-9*\/,\- ]{5,60}$/.test(schedule)) { toast("排程格式不正確（需 5 欄位 cron，例如 0 1 * * *）", "warn"); return; }
    if (action === "translate" && (!params.targetLangs || !params.targetLangs.length)) { toast("請至少選一個目標語系", "warn"); return; }
    if ((action === "translate" || action === "polish" || action === "seo") && !String(params.text || "").trim()) { toast("請填寫文案內容", "warn"); return; }
    busy(true);
    try {
      await worker.call("/ai/jobs", { method: "POST", body: JSON.stringify({ name, action, params, schedule, enabled: $("ajEnabled").checked }) });
      toast("任務已建立 ✅ 到期會自動執行");
      $("ajName").value = "";
      await ajLoad();
    } catch (e) { toast(e.message, "err"); }
    finally { busy(false); }
  }

  async function ajRun(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "執行中…"; }
    try {
      const res = await worker.call("/ai/jobs/run", { method: "POST", body: JSON.stringify({ id }) });
      const r = res && res.result;
      if (r && r.ok) toast("執行完成 ✅ 結果已記錄");
      else toast("執行失敗：" + ((r && r.error) || "未知錯誤"), "err");
      await ajLoad();
    } catch (e) { toast(e.message, "err"); await ajLoad(); }
  }

  async function ajToggle(id, enabled) {
    try {
      await worker.call("/ai/jobs/update", { method: "POST", body: JSON.stringify({ id, enabled: !enabled }) });
      toast(enabled ? "已停用" : "已啟用 ✅");
      await ajLoad();
    } catch (e) { toast(e.message, "err"); }
  }

  async function ajDelete(id, btn) {
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = "1";
      btn.textContent = "確認刪除？";
      setTimeout(() => { delete btn.dataset.confirm; btn.textContent = "🗑 刪除"; }, 3500);
      return;
    }
    try {
      await worker.call("/ai/jobs/delete", { method: "POST", body: JSON.stringify({ id }) });
      toast("已刪除");
      await ajLoad();
    } catch (e) { toast(e.message, "err"); }
  }

  async function ajShowResults(id, name) {
    try {
      const res = await worker.call(`/ai/jobs/results?job_id=${id}&limit=10`);
      const results = (res && res.results) || [];
      $("ajResultsCard").style.display = "";
      $("ajResultsTitle").textContent = `📄 ${name} — 最近 ${results.length} 次執行`;
      if (!results.length) {
        $("ajResults").innerHTML = '<p class="hint">還沒有執行記錄。按「▶ 立即執行」跑一次，或等排程觸發。</p>';
        return;
      }
      const parts = [];
      results.forEach((r) => {
        const head = `<div style="color:var(--muted);margin-bottom:4px">${fmtLocal(r.run_at)} · ${r.trigger === "manual" ? "手動" : "排程"} · <span class="pill ${r.status === "ok" ? "ok" : "err"}">${r.status === "ok" ? "成功" : "失敗"}</span>${r.error ? " · " + esc(r.error) : ""}</div>`;
        let body = "";
        if (r.status === "ok" && r.output) {
          const out = r.output;
          if (out.translations) {
            body = Object.entries(out.translations).map(([l, v]) => `<div><b>${esc(l)}</b><div class="ajres">${esc(v)}</div></div>`).join("");
          } else if (out.variants) {
            body = out.variants.map((v, i) => `<div><b>變體 ${i + 1}</b><div class="ajres">SUBJECT: ${esc(v.subject)}\n\n${esc(v.body)}</div></div>`).join("");
          } else {
            body = `<div class="ajres">${esc(JSON.stringify(out, null, 2))}</div>`;
          }
        } else {
          body = `<div class="ajres">${esc(r.error || "無輸出")}</div>`;
        }
        parts.push(`<div style="margin-bottom:16px;border-bottom:1px solid var(--line);padding-bottom:12px">${head}${body}</div>`);
      });
      $("ajResults").innerHTML = parts.join("");
    } catch (e) { toast(e.message, "err"); }
  }

  // ---- 初始化 ----
  function init() {
    supabase._load();

    // 事件綁定
    $("loginBtn").addEventListener("click", doLogin);
    $("loginPwd").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
    $("logoutBtn").addEventListener("click", () => { supabase._clear(); showView("login"); });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $("keySearch").addEventListener("input", (e) => { contentState.search = e.target.value; renderContent(); });
    $("saveContentBtn").addEventListener("click", saveContent);
    $("resetContentBtn").addEventListener("click", resetContent);
    $("saveEmailBtn").addEventListener("click", saveEmail);
    $("reloadEffBtn").addEventListener("click", reloadEffective);
    $("testEmailBtn").addEventListener("click", sendTestEmail);
    $("saveTokenBtn").addEventListener("click", () => {
      localStorage.setItem(TOKEN_KEY, $("workerToken").value.trim());
      toast("管理權杖已儲存到本機");
    });
    $("workerToken").value = localStorage.getItem(TOKEN_KEY) || "";
    $("st_outreach").addEventListener("change", updateOutreachLabel);
    $("refreshDataBtn").addEventListener("click", loadData);
    $("addSuppressBtn").addEventListener("click", addSuppress);
    $("suppressInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addSuppress(); });
    $("changePwdBtn").addEventListener("click", doChangePwd);
    $("sentTable").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act=view]");
      if (btn) {
        const prev = btn.nextElementSibling;
        prev.style.display = prev.style.display === "block" ? "none" : "block";
        btn.textContent = prev.style.display === "block" ? "收起" : "查看全文";
      }
    });
    // AI 助手
    buildAiLangChecks();
    $("aiTlBtn").addEventListener("click", aiTranslateRun);
    $("aiPlBtn").addEventListener("click", aiPolishRun);
    $("aiEvBtn").addEventListener("click", aiEmailRun);
    $("aiSeoBtn").addEventListener("click", aiSeoRun);
    $("aiSeoLoad").addEventListener("click", aiLoadCurrentLangText);

    // AI 自動任務
    $("ajAction").addEventListener("change", renderAjParams);
    renderAjParams();
    document.querySelectorAll("button.preset").forEach((b) => b.addEventListener("click", () => { $("ajCron").value = b.dataset.cron; }));
    $("ajCreateBtn").addEventListener("click", ajCreate);
    $("ajRefreshBtn").addEventListener("click", ajLoad);
    $("ajList").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const id = Number(btn.dataset.id);
      const act = btn.dataset.act;
      if (act === "run") ajRun(id, btn);
      else if (act === "toggle") ajToggle(id, btn.dataset.on === "true");
      else if (act === "del") ajDelete(id, btn);
      else if (act === "results") {
        const row = btn.closest("tr");
        const name = row ? row.children[0].textContent : "任務";
        ajShowResults(id, name);
      }
    });

    if (supabase.session) {
      supabase._ensureToken().then(() => {
        showView("app");
        $("whoami").textContent = (supabase.session.user && supabase.session.user.email) || "";
        buildLangPills();
        renderContent();
      }).catch((err) => { toast(err.message, "warn"); showView("login"); });
    } else {
      showView("login");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
