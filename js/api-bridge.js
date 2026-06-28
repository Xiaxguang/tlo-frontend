(function () {
  var AUTH_UID_KEY = "TLO_AUTH_UID";
  var AUTH_TOKEN_KEY = "TLO_AUTH_TOKEN";
  var AUTH_PLAYER_KEY = "TLO_AUTH_PLAYER";
  var GUEST_MODE_KEY = "TLO_GUEST_MODE";
  var GUEST_DEMO_STATE_KEY = "TLO_GUEST_DEMO_STATE";

  function getApiBaseUrl() {
    var cfg = window.TLO_CONFIG || {};
    return String(cfg.API_BASE_URL || "").replace(/\/+$/, "");
  }

  function getUrlUid() {
    var params = new URLSearchParams(window.location.search);
    return (params.get("uid") || "").trim();
  }

  function getAuth() {
    var uid = (localStorage.getItem(AUTH_UID_KEY) || "").trim();
    var token = (localStorage.getItem(AUTH_TOKEN_KEY) || "").trim();
    var player = null;
    try { player = JSON.parse(localStorage.getItem(AUTH_PLAYER_KEY) || "null"); } catch (_) {}
    return { uid: uid, token: token, player: player };
  }

  function saveAuth(data) {
    if (!data || !data.success || !data.token || !data.player || !data.player.uid) {
      throw new Error(data && data.msg ? data.msg : "登入資料不完整");
    }
    localStorage.setItem(AUTH_UID_KEY, data.player.uid);
    localStorage.setItem(AUTH_TOKEN_KEY, data.token);
    localStorage.setItem(AUTH_PLAYER_KEY, JSON.stringify(data.player));
    localStorage.setItem("TLO_UID", data.player.uid); // 保留舊版相容
    sessionStorage.removeItem(GUEST_MODE_KEY);
    sessionStorage.removeItem(GUEST_DEMO_STATE_KEY);
  }

  function clearAuth() {
    localStorage.removeItem(AUTH_UID_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_PLAYER_KEY);
  }

  var currentAuth = getAuth();
  window.TLO_IS_AUTHENTICATED = !!(currentAuth.uid && currentAuth.token);
  if (window.TLO_IS_AUTHENTICATED) sessionStorage.removeItem(GUEST_MODE_KEY);
  window.TLO_IS_GUEST = !window.TLO_IS_AUTHENTICATED && sessionStorage.getItem(GUEST_MODE_KEY) === "1";
  window.TLO_PLAYER_UID = window.TLO_IS_AUTHENTICATED ? currentAuth.uid : "";
  window.TLO_AUTH_TOKEN = window.TLO_IS_AUTHENTICATED ? currentAuth.token : "";
  window.TLO_INITIAL_TIMES = "0";

  var TLO_INFLIGHT_RPC = new Map();
  var TLO_READ_METHODS = new Set([
    "getPublicSettings",
    "getHomeState",
    "getPlayerCollection",
    "getLinkBattleDashboard",
    "getDailyDungeonDashboard",
    "getGachaPools",
    "getBattleDashboard",
    "getCardProbabilityTable",
    "getRpgDashboard",
    "getShopDashboard",
    "getGuestShopCatalog",
    "getPersonalDashboard",
    "getSocialDashboard",
    "getPvpDashboard",
    "getTrainingDashboard",
    "getLeaderboardDashboard",
    "getStarShopDashboard",
    "getCharacterGrowthDashboard",
    "getMissionDashboard",
    "getAchievementDashboard",
    "getDemonChallengeDashboard",
    "getMessageBoard",
    "getPlayerHistory",
    "adminListLinkBattleStages",
    "adminListLinkBattleChapters",
    "adminListLinkBattleBosses"
  ]);

  function stableRpcKey(method, args, authToken) {
    var safeArgs;
    try { safeArgs = JSON.stringify(args || []); } catch (_) { safeArgs = String(args || ""); }
    return String(method || "") + "::" + String(authToken || "") + "::" + safeArgs;
  }

  async function rawRpc(method, args, options) {
    options = options || {};
    var baseUrl = getApiBaseUrl();
    if (!baseUrl || baseUrl.indexOf("你的-railway") !== -1) {
      throw new Error("尚未設定 Railway API 網址。請先修改 js/config.js 的 API_BASE_URL。");
    }

    var auth = getAuth();
    var body = {
      method: method,
      args: args || []
    };

    if (options.auth !== false && auth.token) {
      body.authToken = auth.token;
    }

    var isRead = TLO_READ_METHODS.has(String(method || ""));
    var dedupeKey = isRead ? stableRpcKey(method, body.args, body.authToken || "public") : "";
    if (dedupeKey && TLO_INFLIGHT_RPC.has(dedupeKey)) {
      return TLO_INFLIGHT_RPC.get(dedupeKey);
    }

    var request = fetch(baseUrl + "/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(async function(res) {
      var data;
      try {
        data = await res.json();
      } catch (err) {
        throw new Error("後端沒有回傳 JSON，請檢查 Railway API 是否正常。");
      }

      if (!res.ok || (data && data.success === false)) {
        if (res.status === 401) {
          clearAuth();
          showAuthScreen("登入狀態已過期，請重新登入。");
        }
        throw new Error(data && data.msg ? data.msg : "API 呼叫失敗");
      }

      return data;
    });

    if (dedupeKey) {
      TLO_INFLIGHT_RPC.set(dedupeKey, request);
      request.then(function () { TLO_INFLIGHT_RPC.delete(dedupeKey); }, function () { TLO_INFLIGHT_RPC.delete(dedupeKey); });
    }

    return request;
  }

  async function callRpc(method, args) {
    if (!window.TLO_IS_AUTHENTICATED) {
      if (window.TLO_IS_GUEST && typeof window.TLO_GUEST_RPC === "function") {
        var guestResult = await window.TLO_GUEST_RPC(String(method || ""), args || []);
        if (guestResult !== undefined) return guestResult;
      }
      if (window.TLO_IS_GUEST) showAuthScreen("訪客可體驗抽卡與記憶翻牌；這項正式玩家功能需要登入或註冊。");
      throw new Error(window.TLO_IS_GUEST ? "此功能需要登入玩家帳號。" : "請先登入或註冊帳號。");
    }
    return rawRpc(method, args, { auth: true });
  }

  function makeRunner(successHandler, failureHandler) {
    return new Proxy({}, {
      get: function (_target, prop) {
        if (prop === "withSuccessHandler") {
          return function (handler) {
            return makeRunner(handler, failureHandler);
          };
        }

        if (prop === "withFailureHandler") {
          return function (handler) {
            return makeRunner(successHandler, handler);
          };
        }

        if (prop === "withUserObject") {
          return function () {
            return makeRunner(successHandler, failureHandler);
          };
        }

        return function () {
          var args = Array.prototype.slice.call(arguments);
          callRpc(String(prop), args)
            .then(function (data) {
              if (typeof successHandler === "function") successHandler(data);
            })
            .catch(function (err) {
              console.error("TLO API Error:", prop, err);
              if (typeof failureHandler === "function") {
                failureHandler(err);
              } else if (window.TLO_IS_AUTHENTICATED) {
                alert(err.message || String(err));
              }
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner();
  window.TLO_RAW_RPC = rawRpc;

  function injectAuthStyle() {
    if (document.getElementById("tlo-auth-style")) return;
    var style = document.createElement("style");
    style.id = "tlo-auth-style";
    style.textContent = `
      .tlo-auth-overlay{position:fixed;inset:0;z-index:99999;background:radial-gradient(circle at top,#3b0b5e 0,#101010 52%,#050505 100%);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;color:#fff;font-family:'Helvetica Neue',Arial,sans-serif;}
      .tlo-auth-card{width:min(420px,100%);background:rgba(20,20,24,.96);border:1px solid rgba(0,255,240,.45);box-shadow:0 0 35px rgba(127,0,255,.45);border-radius:22px;padding:24px;box-sizing:border-box;text-align:left;}
      .tlo-auth-title{text-align:center;font-size:24px;font-weight:900;color:#00fff0;text-shadow:0 0 14px rgba(0,255,240,.8);margin-bottom:6px;}
      .tlo-auth-sub{text-align:center;color:#bbb;font-size:13px;line-height:1.5;margin-bottom:18px;}
      .tlo-auth-tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;}
      .tlo-auth-tab{border:1px solid #444;background:#191919;color:#aaa;border-radius:12px;padding:10px;font-weight:900;cursor:pointer;}
      .tlo-auth-tab.active{background:linear-gradient(45deg,#ff007f,#7f00ff);color:#fff;border-color:#ff00ff;}
      .tlo-auth-label{display:block;color:#00fff0;font-size:12px;font-weight:900;margin:10px 0 5px;}
      .tlo-auth-input{width:100%;box-sizing:border-box;border:1px solid #444;background:#111;color:#fff;border-radius:12px;padding:13px;font-size:16px;outline:none;}
      .tlo-auth-input:focus{border-color:#00fff0;box-shadow:0 0 12px rgba(0,255,240,.25);}
      .tlo-auth-main-btn{width:100%;border:none;border-radius:14px;background:linear-gradient(45deg,#00fff0,#7f00ff);color:#fff;padding:14px;font-size:17px;font-weight:900;margin-top:14px;cursor:pointer;box-shadow:0 0 18px rgba(0,255,240,.3);}
      .tlo-auth-guest-btn{width:100%;border:1px solid rgba(255,221,119,.65);border-radius:14px;background:#17130a;color:#ffdd77;padding:13px;font-size:15px;font-weight:900;margin-top:12px;cursor:pointer;}
      .tlo-auth-divider{display:flex;align-items:center;gap:10px;color:#777;font-size:11px;margin-top:14px;}.tlo-auth-divider:before,.tlo-auth-divider:after{content:'';height:1px;background:#333;flex:1;}
      .tlo-auth-note{background:#241b08;border:1px solid #ffc107;color:#ffdd77;border-radius:12px;padding:10px;font-size:12px;line-height:1.5;margin-top:12px;}
      .tlo-auth-msg{font-size:13px;text-align:center;margin-top:10px;min-height:18px;color:#ff7777;line-height:1.4;}
      .tlo-auth-small-btn{border:1px solid #555;background:#191919;color:#ddd;border-radius:10px;padding:8px 10px;font-size:12px;font-weight:900;cursor:pointer;margin:4px;}
      .tlo-auth-userbar{text-align:center;margin-top:8px;}
      .tlo-auth-force{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;}
      .tlo-auth-force .tlo-auth-card{border-color:#ffc107;box-shadow:0 0 35px rgba(255,193,7,.35);}
      .tlo-auth-warning{color:#ffc107;font-size:13px;line-height:1.5;background:#2a210b;border:1px solid #ffc107;border-radius:12px;padding:10px;margin:10px 0;}
      .tlo-guest-banner{background:linear-gradient(135deg,rgba(255,221,119,.14),rgba(0,255,240,.10));border:1px solid rgba(255,221,119,.55);color:#ffecaa;border-radius:14px;padding:11px 13px;margin:10px 0;font-size:12px;line-height:1.6;text-align:center;}
    `;
    document.head.appendChild(style);
  }

  function authHtml() {
    var urlUid = getUrlUid();
    return `
      <div class="tlo-auth-overlay" id="tlo-auth-overlay">
        <div class="tlo-auth-card">
          <div class="tlo-auth-title">✨ T-LO 玩家登入 ✨</div>
          <div class="tlo-auth-sub">登入後會讀取你的抽卡次數、卡盒、戰鬥、PVP 與排行榜資料。</div>
          <div class="tlo-auth-tabs">
            <button class="tlo-auth-tab active" id="tlo-login-tab" type="button">內測玩家登入</button>
            <button class="tlo-auth-tab" id="tlo-register-tab" type="button">新用戶註冊</button>
          </div>

          <div id="tlo-login-panel">
            <label class="tlo-auth-label">玩家 UID / 玩家代碼</label>
            <input class="tlo-auth-input" id="tlo-login-uid" value="${escapeAttr(urlUid)}" placeholder="輸入你的內測 UID">
            <label class="tlo-auth-label">密碼</label>
            <input class="tlo-auth-input" id="tlo-login-password" type="password" placeholder="輸入你的密碼">
            <button class="tlo-auth-main-btn" id="tlo-login-btn" type="button">登入遊戲</button>
            <div class="tlo-auth-note">請使用自己的玩家 UID 與密碼登入。若無法登入，請聯繫管理員重設密碼。</div>
          </div>

          <div id="tlo-register-panel" style="display:none;">
            <label class="tlo-auth-label">建立玩家 UID / 玩家代碼</label>
            <input class="tlo-auth-input" id="tlo-register-uid" placeholder="例如：tlo123 或你的暱稱">
            <label class="tlo-auth-label">顯示名稱</label>
            <input class="tlo-auth-input" id="tlo-register-name" placeholder="可不填，預設同 UID">
            <label class="tlo-auth-label">好友邀請碼（選填）</label>
            <input class="tlo-auth-input" id="tlo-register-invite-code" maxlength="20" autocomplete="off" placeholder="輸入後雙方各獲得抽卡次數 +5">
            <label class="tlo-auth-label">設定密碼</label>
            <input class="tlo-auth-input" id="tlo-register-password" type="password" placeholder="至少 8 碼">
            <label class="tlo-auth-label">再次輸入密碼</label>
            <input class="tlo-auth-input" id="tlo-register-password2" type="password" placeholder="再次確認密碼">
            <button class="tlo-auth-main-btn" id="tlo-register-btn" type="button">註冊並開始遊戲</button>
            <div class="tlo-auth-note">新用戶會建立全新資料，不會覆蓋內測玩家資料。</div>
          </div>
          <div class="tlo-auth-divider">免登入瀏覽</div>
          <button class="tlo-auth-guest-btn" id="tlo-guest-btn" type="button">👀 訪客模式免登入</button>
          <div style="color:#999;font-size:11px;line-height:1.5;text-align:center;margin-top:7px;">訪客可體驗抽卡與記憶翻牌，資料只保存在目前分頁且不會寫入正式帳號。</div>
          <div class="tlo-auth-msg" id="tlo-auth-msg"></div>
        </div>
      </div>
    `;
  }

  function escapeAttr(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function setAuthMsg(text, good) {
    var el = document.getElementById("tlo-auth-msg");
    if (!el) return;
    el.style.color = good ? "#00ff7f" : "#ff7777";
    el.textContent = text || "";
  }

  function showAuthScreen(msg) {
    injectAuthStyle();
    if (!document.getElementById("tlo-auth-overlay")) {
      document.body.insertAdjacentHTML("afterbegin", authHtml());
      bindAuthEvents();
    }
    var container = document.querySelector(".container");
    if (container) container.style.display = "none";
    if (msg) setAuthMsg(msg, false);
  }

  function hideAuthScreen() {
    var overlay = document.getElementById("tlo-auth-overlay");
    if (overlay) overlay.remove();
    var container = document.querySelector(".container");
    if (container) container.style.display = "flex";
  }

  function switchAuthTab(mode) {
    var isLogin = mode === "login";
    document.getElementById("tlo-login-tab").classList.toggle("active", isLogin);
    document.getElementById("tlo-register-tab").classList.toggle("active", !isLogin);
    document.getElementById("tlo-login-panel").style.display = isLogin ? "block" : "none";
    document.getElementById("tlo-register-panel").style.display = isLogin ? "none" : "block";
    setAuthMsg("");
  }

  function bindAuthEvents() {
    document.getElementById("tlo-login-tab").onclick = function () { switchAuthTab("login"); };
    document.getElementById("tlo-register-tab").onclick = function () { switchAuthTab("register"); };
    document.getElementById("tlo-login-btn").onclick = handleLogin;
    document.getElementById("tlo-register-btn").onclick = handleRegister;
    document.getElementById("tlo-guest-btn").onclick = handleGuestEntry;
  }

  function handleGuestEntry() {
    clearAuth();
    sessionStorage.setItem(GUEST_MODE_KEY, "1");
    location.reload();
  }

  async function handleLogin() {
    try {
      var uid = document.getElementById("tlo-login-uid").value.trim();
      var pw = document.getElementById("tlo-login-password").value;
      if (!uid || !pw) throw new Error("請輸入 UID 與密碼。");
      setAuthMsg("登入中...", true);
      var data = await rawRpc("loginAccount", [uid, pw], { auth: false });
      saveAuth(data);
      if (window.TLOAudio) window.TLOAudio.playSfx("login");
      setAuthMsg("登入成功，正在進入遊戲...", true);
      setTimeout(function () { location.reload(); }, 450);
    } catch (err) {
      if (window.TLOAudio) window.TLOAudio.playSfx("error");
      setAuthMsg(err.message || String(err), false);
    }
  }

  async function handleRegister() {
    try {
      var uid = document.getElementById("tlo-register-uid").value.trim();
      var name = document.getElementById("tlo-register-name").value.trim();
      var inviteCode = document.getElementById("tlo-register-invite-code").value.trim();
      var pw = document.getElementById("tlo-register-password").value;
      var pw2 = document.getElementById("tlo-register-password2").value;
      if (!uid || !pw) throw new Error("請輸入 UID 與密碼。");
      if (pw !== pw2) throw new Error("兩次輸入的密碼不一致。");
      setAuthMsg("註冊中...", true);
      var data = await rawRpc("registerAccount", [uid, pw, name, inviteCode], { auth: false });
      saveAuth(data);
      if (window.TLOAudio) window.TLOAudio.playSfx("login");
      setAuthMsg("註冊成功，正在進入遊戲...", true);
      setTimeout(function () { location.reload(); }, 450);
    } catch (err) {
      if (window.TLOAudio) window.TLOAudio.playSfx("error");
      setAuthMsg(err.message || String(err), false);
    }
  }

  function addUserControls() {
    var info = document.querySelector(".asset-info");
    if (!info || document.getElementById("tlo-auth-userbar")) return;
    var player = getAuth().player || {};
    var div = document.createElement("div");
    div.id = "tlo-auth-userbar";
    div.className = "tlo-auth-userbar";
    div.innerHTML = `
      <button class="tlo-auth-small-btn" type="button" id="tlo-change-password-btn">🔐 更改密碼</button>
      <button class="tlo-auth-small-btn" type="button" id="tlo-logout-btn">🚪 登出</button>
      ${player.mustChangePassword ? '<div style="color:#ffc107;font-size:12px;margin-top:4px;">建議先更改預設密碼</div>' : ''}
    `;
    info.appendChild(div);

    document.getElementById("tlo-change-password-btn").onclick = function () { showChangePasswordModal(false); };
    document.getElementById("tlo-logout-btn").onclick = handleLogout;
  }

  function addGuestControls() {
    var info = document.querySelector(".asset-info");
    if (info && !document.getElementById("tlo-auth-userbar")) {
      var controls = document.createElement("div");
      controls.id = "tlo-auth-userbar";
      controls.className = "tlo-auth-userbar";
      controls.innerHTML = '<span style="color:#ffdd77;font-size:12px;font-weight:900;">目前為訪客體驗模式</span><br><button class="tlo-auth-small-btn" type="button" id="tlo-guest-login-btn">🔐 綁定／登入帳號</button>';
      info.appendChild(controls);
      document.getElementById("tlo-guest-login-btn").onclick = function () {
        var hasProgress = typeof window.TLO_GUEST_HAS_PROGRESS === "function" && window.TLO_GUEST_HAS_PROGRESS();
        if (hasProgress && !confirm("訪客體驗資料無法轉移到正式帳號。現在登入／註冊後，可永久保存之後的遊戲進度。確定前往登入嗎？")) return;
        window.TLO_SHOW_LOGIN("請登入或註冊帳號；訪客體驗資料不會匯入正式帳號。登入後的進度才會永久保存。");
      };
    }
    var container = document.querySelector(".container");
    if (container && !document.getElementById("tlo-guest-banner")) {
      var banner = document.createElement("div");
      banner.id = "tlo-guest-banner";
      banner.className = "tlo-guest-banner";
      banner.innerHTML = '<b>👀 訪客模式免登入</b><br>可體驗抽卡與記憶翻牌並查看商城；資料只暫存在此分頁，關閉後消失，且不會轉移到正式帳號。';
      var header = container.querySelector("header");
      if (header) header.insertAdjacentElement("afterend", banner);
      else container.insertAdjacentElement("afterbegin", banner);
    }
    var uidEl = document.getElementById("display-uid");
    if (uidEl) uidEl.textContent = "訪客";
  }

  async function handleLogout() {
    try {
      if (window.TLO_IS_AUTHENTICATED) {
        await rawRpc("logoutAccount", [window.TLO_PLAYER_UID], { auth: true });
      }
    } catch (_) {}
    clearAuth();
    location.reload();
  }

  function showChangePasswordModal(force) {
    injectAuthStyle();
    if (document.getElementById("tlo-password-modal")) return;
    var closeBtn = force ? "" : '<button class="tlo-auth-small-btn" type="button" id="tlo-close-password-modal">稍後再改</button>';
    document.body.insertAdjacentHTML("beforeend", `
      <div class="tlo-auth-force" id="tlo-password-modal">
        <div class="tlo-auth-card">
          <div class="tlo-auth-title">🔐 更改密碼</div>
          <div class="tlo-auth-warning">${force ? '你目前使用內測預設密碼，請先更改密碼再繼續遊戲。' : '請輸入原密碼與新密碼。'}</div>
          <label class="tlo-auth-label">原密碼</label>
          <input class="tlo-auth-input" id="tlo-old-password" type="password" placeholder="輸入目前密碼">
          <label class="tlo-auth-label">新密碼</label>
          <input class="tlo-auth-input" id="tlo-new-password" type="password" placeholder="至少 8 碼">
          <label class="tlo-auth-label">再次輸入新密碼</label>
          <input class="tlo-auth-input" id="tlo-new-password2" type="password" placeholder="再次確認新密碼">
          <button class="tlo-auth-main-btn" type="button" id="tlo-save-password-btn">儲存新密碼</button>
          <div style="text-align:center;margin-top:8px;">${closeBtn}</div>
          <div class="tlo-auth-msg" id="tlo-password-msg"></div>
        </div>
      </div>
    `);
    document.getElementById("tlo-save-password-btn").onclick = handleChangePassword;
    var close = document.getElementById("tlo-close-password-modal");
    if (close) close.onclick = function () { document.getElementById("tlo-password-modal").remove(); };
  }

  function setPasswordMsg(text, good) {
    var el = document.getElementById("tlo-password-msg");
    if (!el) return;
    el.style.color = good ? "#00ff7f" : "#ff7777";
    el.textContent = text || "";
  }

  async function handleChangePassword() {
    try {
      var oldPw = document.getElementById("tlo-old-password").value;
      var newPw = document.getElementById("tlo-new-password").value;
      var newPw2 = document.getElementById("tlo-new-password2").value;
      if (!oldPw || !newPw) throw new Error("請輸入原密碼與新密碼。");
      if (newPw !== newPw2) throw new Error("兩次新密碼不一致。");
      setPasswordMsg("更新中...", true);
      var data = await rawRpc("changePassword", [window.TLO_PLAYER_UID, oldPw, newPw], { auth: true });
      if (!data.success) throw new Error(data.msg || "密碼更新失敗");
      var auth = getAuth();
      auth.player = data.player;
      localStorage.setItem(AUTH_PLAYER_KEY, JSON.stringify(data.player));
      setPasswordMsg("密碼已更新。", true);
      setTimeout(function () { location.reload(); }, 500);
    } catch (err) {
      setPasswordMsg(err.message || String(err), false);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    injectAuthStyle();

    if (!window.TLO_IS_AUTHENTICATED && !window.TLO_IS_GUEST) {
      showAuthScreen("");
      return;
    }

    hideAuthScreen();
    if (window.TLO_IS_GUEST) {
      addGuestControls();
      return;
    }
    addUserControls();

    var uidEl = document.getElementById("display-uid");
    if (uidEl) uidEl.textContent = window.TLO_PLAYER_UID;

    var player = getAuth().player || {};
    if (player.mustChangePassword) {
      setTimeout(function () { showChangePasswordModal(true); }, 700);
    }
  });

  window.TLO_SHOW_LOGIN = function (message) {
    sessionStorage.removeItem(GUEST_MODE_KEY);
    window.TLO_IS_GUEST = false;
    showAuthScreen(message || "請登入或註冊玩家帳號後繼續。");
  };

  window.addEventListener("beforeunload", function (event) {
    if (!window.TLO_IS_GUEST) return;
    if (typeof window.TLO_GUEST_HAS_PROGRESS !== "function" || !window.TLO_GUEST_HAS_PROGRESS()) return;
    event.preventDefault();
    event.returnValue = "";
  });
})();
