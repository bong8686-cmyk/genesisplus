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
    ["content", "email", "data", "account"].forEach((t) => ($("tab-" + t).style.display = t === tab ? "" : "none"));
    if (tab === "data") loadData();
    if (tab === "email") loadEmailForm();
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
