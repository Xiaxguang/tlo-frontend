(function () {
  var AUTH_UID_KEY = "TLO_AUTH_UID";
  var AUTH_TOKEN_KEY = "TLO_AUTH_TOKEN";
  var AUTH_PLAYER_KEY = "TLO_AUTH_PLAYER";
  var GUEST_MODE_KEY = "TLO_GUEST_MODE";
  var GUEST_DEMO_STATE_KEY = "TLO_GUEST_DEMO_STATE";
  var TERMS_ACCEPTED_KEY = "TLO_TERMS_ACCEPTED";

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
    localStorage.removeItem("TLO_UID");
  }

  var currentAuth = getAuth();
  window.TLO_IS_AUTHENTICATED = !!(currentAuth.uid && currentAuth.token);
  if (window.TLO_IS_AUTHENTICATED) sessionStorage.removeItem(GUEST_MODE_KEY);
  window.TLO_IS_GUEST = !window.TLO_IS_AUTHENTICATED && sessionStorage.getItem(GUEST_MODE_KEY) === "1";
  window.TLO_PLAYER_UID = window.TLO_IS_AUTHENTICATED ? currentAuth.uid : "";
  window.TLO_AUTH_TOKEN = window.TLO_IS_AUTHENTICATED ? currentAuth.token : "";
  window.TLO_INITIAL_TIMES = "0";

  var TLO_INFLIGHT_RPC = new Map();
  var TLO_RPC_READ_CACHE = new Map();
  var TLO_RPC_READ_CACHE_MAX = 160;
  var TLO_READ_CACHE_TTL_MS = {
    getPublicSettings: 180000,
    getHomeState: 5000,
    getPlayerCollection: 8000,
    getLinkBattleDashboard: 10000,
    getDailyDungeonDashboard: 8000,
    getGachaPools: 180000,
    getBattleDashboard: 15000,
    getCardProbabilityTable: 180000,
    getRpgDashboard: 15000,
    getShopDashboard: 8000,
    getGuestShopCatalog: 8000,
    getPersonalDashboard: 8000,
    getSocialDashboard: 8000,
    getPvpDashboard: 15000,
    getTrainingDashboard: 15000,
    getLeaderboardDashboard: 15000,
    getStarShopDashboard: 8000,
    getCharacterGrowthDashboard: 8000,
    getMissionDashboard: 10000,
    getMonthlyCardStatus: 8000,
    getBattlePassDashboard: 8000,
    getAchievementDashboard: 10000,
    getDemonChallengeDashboard: 12000,
    getWorldBossDashboard: 8000,
    getChatDashboard: 4000,
    getMessageBoard: 10000,
    getPlayerHistory: 10000,
    adminListLinkBattleStages: 180000,
    adminListLinkBattleChapters: 180000,
    adminListLinkBattleBosses: 180000
  };
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
    "getMonthlyCardStatus",
    "getBattlePassDashboard",
    "getAchievementDashboard",
    "getDemonChallengeDashboard",
    "getWorldBossDashboard",
    "getChatDashboard",
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

  function cloneRpcData(data) {
    try { return JSON.parse(JSON.stringify(data)); } catch (_) { return data; }
  }

  function getRpcReadCache(key) {
    var item = TLO_RPC_READ_CACHE.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      TLO_RPC_READ_CACHE.delete(key);
      return null;
    }
    return cloneRpcData(item.value);
  }

  function setRpcReadCache(key, method, value) {
    var ttl = Number(TLO_READ_CACHE_TTL_MS[String(method || '')] || 0);
    if (!key || !ttl || !value || value.success === false) return;
    if (TLO_RPC_READ_CACHE.size >= TLO_RPC_READ_CACHE_MAX) {
      var first = TLO_RPC_READ_CACHE.keys().next().value;
      if (first) TLO_RPC_READ_CACHE.delete(first);
    }
    TLO_RPC_READ_CACHE.set(key, { value: cloneRpcData(value), expiresAt: Date.now() + ttl });
  }

  function clearRpcReadCache() {
    TLO_RPC_READ_CACHE.clear();
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
    if (dedupeKey && !options.noCache) {
      var cached = getRpcReadCache(dedupeKey);
      if (cached) return cached;
    }
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

      if (isRead && dedupeKey) setRpcReadCache(dedupeKey, method, data);
      if (!isRead) clearRpcReadCache();
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
  window.TLO_CLEAR_RPC_CACHE = clearRpcReadCache;

  function injectAuthStyle() {
    if (document.getElementById("tlo-auth-style")) return;
    var style = document.createElement("style");
    style.id = "tlo-auth-style";
    style.textContent = `
      :root{--tlo-gold:#ffe29a;--tlo-gold2:#c58a32;--tlo-purple:#7c35ff;--tlo-cyan:#7fefff;--tlo-deep:#070821;}
      .tlo-auth-overlay{position:fixed;inset:0;z-index:99999;background:#05020f;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#fff;font-family:'Noto Sans TC','Microsoft JhengHei','PingFang TC','Helvetica Neue',Arial,sans-serif;}
      .tlo-auth-overlay *{box-sizing:border-box;}
      .tlo-auth-stage{position:relative;width:min(100vw,56.25dvh);height:min(100dvh,177.78vw);max-width:520px;max-height:100dvh;background-image:url('./assets/ui/login-bg-summer.webp');background-size:100% 100%;background-position:center;background-repeat:no-repeat;overflow:hidden;box-shadow:0 0 42px rgba(115,62,255,.45),0 0 90px rgba(17,214,255,.18);isolation:isolate;}
      .tlo-auth-stage:before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 54%,rgba(3,3,18,.26) 70%,rgba(3,3,18,.72) 100%);pointer-events:none;z-index:0;}
      .tlo-login-card{position:absolute;left:7.2%;right:7.2%;bottom:4.4%;z-index:2;background:linear-gradient(180deg,rgba(17,19,54,.66),rgba(8,9,32,.86));border:1px solid rgba(255,226,154,.78);box-shadow:0 0 24px rgba(127,53,255,.45),inset 0 0 18px rgba(126,239,255,.12);border-radius:18px;padding:13px 13px 12px;backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);max-height:45%;overflow:auto;scrollbar-width:none;-ms-overflow-style:none;}
      .tlo-login-card:before{content:'';position:absolute;inset:-1px;border-radius:18px;padding:1px;background:linear-gradient(135deg,rgba(255,226,154,.95),rgba(126,239,255,.45),rgba(124,53,255,.8),rgba(255,226,154,.8));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;}
      .tlo-auth-title{text-align:center;font-size:18px;font-weight:900;letter-spacing:.08em;color:#fff5cf;text-shadow:0 0 10px rgba(255,226,154,.85),0 0 18px rgba(124,53,255,.85);margin:0 0 4px;}
      .tlo-auth-sub{text-align:center;color:#d9d3ff;font-size:11px;line-height:1.45;margin:0 0 9px;text-shadow:0 0 8px rgba(0,0,0,.95);}
      .tlo-auth-tabs{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:9px;}
      .tlo-auth-tab{min-height:34px;border:1px solid rgba(255,226,154,.55);background:linear-gradient(180deg,rgba(32,35,85,.82),rgba(12,14,45,.9));color:#d8d2ff;border-radius:12px;padding:7px 9px;font-weight:900;font-size:13px;letter-spacing:.04em;cursor:pointer;box-shadow:inset 0 0 10px rgba(126,239,255,.06);}
      .tlo-auth-tab.active{background:linear-gradient(180deg,rgba(255,226,154,.30),rgba(124,53,255,.78));color:#fff7d7;border-color:rgba(255,226,154,.95);text-shadow:0 0 8px rgba(255,226,154,.8);box-shadow:0 0 14px rgba(124,53,255,.45),inset 0 0 12px rgba(255,226,154,.14);}
      .tlo-auth-label{display:block;color:#ffe29a;font-size:11px;font-weight:900;margin:8px 0 4px;letter-spacing:.04em;}
      .tlo-auth-input-wrap{position:relative;display:flex;align-items:center;margin-bottom:7px;}
      .tlo-auth-input-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:15px;color:#fff0bd;text-shadow:0 0 8px rgba(255,226,154,.65);pointer-events:none;}
      .tlo-auth-input{width:100%;height:42px;border:1px solid rgba(255,226,154,.46);background:linear-gradient(180deg,rgba(7,8,29,.9),rgba(18,16,49,.86));color:#fff;border-radius:12px;padding:10px 42px 10px 38px;font-size:16px;outline:none;box-shadow:inset 0 0 12px rgba(0,0,0,.42);}
      .tlo-auth-input::placeholder{color:rgba(218,218,245,.58);}
      .tlo-auth-input:focus{border-color:rgba(126,239,255,.95);box-shadow:0 0 14px rgba(126,239,255,.30),inset 0 0 12px rgba(0,0,0,.46);}
      .tlo-password-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:30px;height:30px;border:0;background:transparent;color:#e8e6ff;font-size:16px;cursor:pointer;border-radius:9px;}
      .tlo-password-toggle:active,.tlo-password-toggle:hover{background:rgba(255,255,255,.08);}
      .tlo-auth-main-btn{width:100%;min-height:47px;border:1px solid rgba(255,236,182,.95);border-radius:16px;background:linear-gradient(180deg,#a56aff 0%,#6f2ae8 48%,#371067 100%);color:#fff9d9;padding:10px 12px;font-size:20px;font-weight:900;letter-spacing:.12em;margin:9px 0 9px;cursor:pointer;text-shadow:0 2px 0 rgba(52,20,95,.8),0 0 12px rgba(255,226,154,.65);box-shadow:0 0 20px rgba(124,53,255,.62),inset 0 2px 0 rgba(255,255,255,.28),inset 0 -3px 0 rgba(32,10,77,.7);}
      .tlo-auth-main-btn:active{transform:translateY(1px);filter:brightness(.96);}
      .tlo-auth-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:9px;}
      .tlo-auth-action-btn,.tlo-auth-guest-btn{min-height:38px;border:1px solid rgba(255,226,154,.70);border-radius:12px;background:linear-gradient(180deg,rgba(46,56,129,.92),rgba(19,22,69,.95));color:#f7f2ff;padding:7px 6px;font-size:12px;font-weight:900;cursor:pointer;box-shadow:0 0 10px rgba(54,42,176,.18),inset 0 0 10px rgba(126,239,255,.08);}
      .tlo-auth-action-btn:hover,.tlo-auth-guest-btn:hover{border-color:#fff0bd;filter:brightness(1.08);}
      .tlo-auth-guest-btn{width:100%;margin-top:10px;}
      .tlo-auth-note{background:rgba(36,27,8,.66);border:1px solid rgba(255,193,7,.62);color:#ffecaa;border-radius:12px;padding:9px;font-size:11px;line-height:1.5;margin-top:9px;}
      .tlo-auth-msg{font-size:12px;text-align:center;margin-top:8px;min-height:17px;color:#ff8787;line-height:1.35;text-shadow:0 0 8px rgba(0,0,0,.8);}
      .tlo-terms-row{display:flex;align-items:flex-start;gap:8px;color:#e9e4ff;font-size:11px;line-height:1.45;margin:7px 0 0;text-shadow:0 0 7px rgba(0,0,0,.9);}
      .tlo-terms-row input{appearance:none;-webkit-appearance:none;width:18px;height:18px;flex:0 0 18px;border:1px solid rgba(255,226,154,.75);background:rgba(4,5,22,.84);border-radius:5px;margin:1px 0 0;box-shadow:inset 0 0 8px rgba(0,0,0,.45);}
      .tlo-terms-row input:checked{background:linear-gradient(135deg,#ffe29a,#7fefff);box-shadow:0 0 12px rgba(126,239,255,.35);}
      .tlo-terms-row input:checked:after{content:'✓';display:block;text-align:center;color:#130822;font-size:14px;font-weight:900;line-height:17px;}
      .tlo-legal-link{border:0;background:transparent;color:#7fefff;padding:0;font:inherit;font-weight:900;text-decoration:underline;cursor:pointer;text-shadow:0 0 8px rgba(126,239,255,.45);}
      .tlo-auth-divider{display:flex;align-items:center;gap:10px;color:#aaa;font-size:11px;margin-top:12px;}.tlo-auth-divider:before,.tlo-auth-divider:after{content:'';height:1px;background:rgba(255,226,154,.26);flex:1;}
      .tlo-auth-small-btn{border:1px solid rgba(255,226,154,.55);background:rgba(18,20,56,.9);color:#eee;border-radius:10px;padding:8px 10px;font-size:12px;font-weight:900;cursor:pointer;margin:4px;}
      .tlo-auth-userbar{text-align:center;margin-top:8px;}
      .tlo-auth-force{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;color:#fff;font-family:'Noto Sans TC','Microsoft JhengHei','PingFang TC','Helvetica Neue',Arial,sans-serif;}
      .tlo-auth-force .tlo-auth-card{width:min(420px,100%);background:rgba(20,20,24,.96);border:1px solid rgba(255,226,154,.7);box-shadow:0 0 35px rgba(255,193,7,.35);border-radius:22px;padding:24px;box-sizing:border-box;text-align:left;}
      .tlo-auth-force .tlo-auth-title{font-size:24px;color:#00fff0;text-shadow:0 0 14px rgba(0,255,240,.8);}
      .tlo-auth-warning{color:#ffc107;font-size:13px;line-height:1.5;background:#2a210b;border:1px solid #ffc107;border-radius:12px;padding:10px;margin:10px 0;}
      .tlo-guest-banner{background:linear-gradient(135deg,rgba(255,221,119,.14),rgba(0,255,240,.10));border:1px solid rgba(255,221,119,.55);color:#ffecaa;border-radius:14px;padding:11px 13px;margin:10px 0;font-size:12px;line-height:1.6;text-align:center;}
      .tlo-legal-modal{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:18px;color:#fff;font-family:'Noto Sans TC','Microsoft JhengHei','PingFang TC','Helvetica Neue',Arial,sans-serif;}
      .tlo-legal-card{width:min(460px,100%);max-height:min(78dvh,680px);overflow:auto;background:linear-gradient(180deg,rgba(16,18,56,.98),rgba(8,7,28,.98));border:1px solid rgba(255,226,154,.78);border-radius:20px;padding:20px;box-shadow:0 0 35px rgba(124,53,255,.42);}
      .tlo-legal-card h3{margin:0 0 10px;color:#fff0bd;text-align:center;font-size:22px;text-shadow:0 0 12px rgba(255,226,154,.55);}
      .tlo-legal-card p,.tlo-legal-card li{font-size:13px;line-height:1.75;color:#eee;margin:8px 0;}
      .tlo-legal-card ul{padding-left:20px;margin:8px 0;}
      .tlo-legal-close{width:100%;margin-top:14px;border:1px solid rgba(255,226,154,.8);background:linear-gradient(180deg,#7357cc,#2b1b74);color:#fff7d7;border-radius:13px;padding:11px;font-weight:900;cursor:pointer;}

      /* 隱藏登入頁與彈窗滾動條，但保留滑動功能 */
      html.tlo-auth-open,body.tlo-auth-open{scrollbar-width:none;-ms-overflow-style:none;}
      html.tlo-auth-open::-webkit-scrollbar,body.tlo-auth-open::-webkit-scrollbar{width:0;height:0;display:none;}
      .tlo-auth-overlay,.tlo-auth-stage,.tlo-login-card,.tlo-legal-modal,.tlo-legal-card{scrollbar-width:none;-ms-overflow-style:none;}
      .tlo-auth-overlay::-webkit-scrollbar,.tlo-auth-stage::-webkit-scrollbar,.tlo-login-card::-webkit-scrollbar,.tlo-legal-modal::-webkit-scrollbar,.tlo-legal-card::-webkit-scrollbar{width:0;height:0;display:none;}
      @media (max-width:430px){.tlo-login-card{left:6%;right:6%;bottom:3.2%;padding:11px 11px 10px;max-height:47%;}.tlo-auth-title{font-size:16px}.tlo-auth-sub{font-size:10px}.tlo-auth-input{height:39px;font-size:15px}.tlo-auth-main-btn{min-height:44px;font-size:18px}.tlo-auth-actions{gap:6px}.tlo-auth-action-btn{font-size:11px;min-height:36px}.tlo-terms-row{font-size:10.5px}}
      @media (max-height:720px){.tlo-login-card{max-height:52%;bottom:2.8%;}.tlo-auth-title,.tlo-auth-sub{display:none}.tlo-auth-tabs{margin-bottom:7px}.tlo-auth-input{height:37px}.tlo-auth-main-btn{min-height:40px;font-size:17px;margin:7px 0}.tlo-auth-note{display:none}.tlo-terms-row{font-size:10px}.tlo-auth-actions{margin-bottom:6px}}
    `;
    document.head.appendChild(style);
  }

  function authHtml() {
    var urlUid = getUrlUid();
    var accepted = localStorage.getItem(TERMS_ACCEPTED_KEY) === "1" ? "checked" : "";
    return `
      <div class="tlo-auth-overlay" id="tlo-auth-overlay">
        <div class="tlo-auth-stage" aria-label="T-LO 實況星域登入首頁">
          <div class="tlo-login-card">
            <div class="tlo-auth-title">登入實況星域</div>
            <div class="tlo-auth-sub">收集直播主卡牌，挑戰異世界討伐</div>
            <div class="tlo-auth-tabs">
              <button class="tlo-auth-tab active" id="tlo-login-tab" type="button">玩家登入</button>
              <button class="tlo-auth-tab" id="tlo-register-tab" type="button">新玩家註冊</button>
            </div>

            <div id="tlo-login-panel">
              <label class="tlo-auth-label" for="tlo-login-uid">玩家 UID</label>
              <div class="tlo-auth-input-wrap">
                <span class="tlo-auth-input-icon">👤</span>
                <input class="tlo-auth-input" id="tlo-login-uid" value="${escapeAttr(urlUid)}" autocomplete="username" placeholder="請輸入 UID">
              </div>
              <label class="tlo-auth-label" for="tlo-login-password">密碼</label>
              <div class="tlo-auth-input-wrap">
                <span class="tlo-auth-input-icon">🔒</span>
                <input class="tlo-auth-input" id="tlo-login-password" type="password" autocomplete="current-password" placeholder="請輸入密碼">
                <button class="tlo-password-toggle" id="tlo-login-password-toggle" type="button" aria-label="顯示或隱藏密碼">👁</button>
              </div>
              <button class="tlo-auth-main-btn" id="tlo-login-btn" type="button">進入實況星域</button>
              <div class="tlo-auth-actions">
                <button class="tlo-auth-action-btn" id="tlo-guest-btn" type="button">訪客登入</button>
                <button class="tlo-auth-action-btn" id="tlo-register-shortcut-btn" type="button">新玩家註冊</button>
                <button class="tlo-auth-action-btn" id="tlo-forgot-btn" type="button">忘記密碼</button>
              </div>
            </div>

            <div id="tlo-register-panel" style="display:none;">
              <label class="tlo-auth-label" for="tlo-register-uid">建立玩家 UID</label>
              <div class="tlo-auth-input-wrap"><span class="tlo-auth-input-icon">🆔</span><input class="tlo-auth-input" id="tlo-register-uid" autocomplete="username" placeholder="例如：tlo123 或你的暱稱"></div>
              <label class="tlo-auth-label" for="tlo-register-name">顯示名稱</label>
              <div class="tlo-auth-input-wrap"><span class="tlo-auth-input-icon">✨</span><input class="tlo-auth-input" id="tlo-register-name" placeholder="可不填，預設同 UID"></div>
              <label class="tlo-auth-label" for="tlo-register-invite-code">好友邀請碼（選填）</label>
              <div class="tlo-auth-input-wrap"><span class="tlo-auth-input-icon">🎁</span><input class="tlo-auth-input" id="tlo-register-invite-code" maxlength="20" autocomplete="off" placeholder="輸入後雙方各獲得抽卡次數 +5"></div>
              <label class="tlo-auth-label" for="tlo-register-password">設定密碼</label>
              <div class="tlo-auth-input-wrap"><span class="tlo-auth-input-icon">🔒</span><input class="tlo-auth-input" id="tlo-register-password" type="password" autocomplete="new-password" placeholder="至少 8 碼"><button class="tlo-password-toggle" id="tlo-register-password-toggle" type="button" aria-label="顯示或隱藏密碼">👁</button></div>
              <label class="tlo-auth-label" for="tlo-register-password2">確認密碼</label>
              <div class="tlo-auth-input-wrap"><span class="tlo-auth-input-icon">🔐</span><input class="tlo-auth-input" id="tlo-register-password2" type="password" autocomplete="new-password" placeholder="再次確認密碼"><button class="tlo-password-toggle" id="tlo-register-password2-toggle" type="button" aria-label="顯示或隱藏密碼">👁</button></div>
              <button class="tlo-auth-main-btn" id="tlo-register-btn" type="button">註冊並開始冒險</button>
              <div class="tlo-auth-note">新玩家會建立全新資料；好友邀請碼可之後到社交頁補填。</div>
            </div>

            <label class="tlo-terms-row" for="tlo-terms-check">
              <input id="tlo-terms-check" type="checkbox" ${accepted}>
              <span>我已閱讀並同意 <button class="tlo-legal-link" type="button" data-legal="terms">《使用者條款》</button> 與 <button class="tlo-legal-link" type="button" data-legal="privacy">《隱私政策》</button></span>
            </label>
            <div class="tlo-auth-msg" id="tlo-auth-msg"></div>
          </div>
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


  function ensureTermsAccepted() {
    var checkbox = document.getElementById("tlo-terms-check");
    if (!checkbox || checkbox.checked) {
      localStorage.setItem(TERMS_ACCEPTED_KEY, "1");
      return true;
    }
    setAuthMsg("請先勾選同意使用者條款與隱私政策。", false);
    return false;
  }

  function togglePasswordVisibility(inputId, buttonId) {
    var input = document.getElementById(inputId);
    var button = document.getElementById(buttonId);
    if (!input || !button) return;
    var show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "🙈" : "👁";
  }

  function showLegalModal(kind) {
    var isPrivacy = kind === "privacy";
    var title = isPrivacy ? "T-LO 隱私政策" : "T-LO 使用者條款";
    var content = isPrivacy ? `
      <p>本政策說明 T-LO 實況星域在玩家使用服務時，如何處理必要資料。</p>
      <ul>
        <li>我們會保存玩家 UID、顯示名稱、登入狀態、遊戲進度、抽卡紀錄、戰鬥紀錄、留言、好友與排行榜資料，用於提供遊戲功能。</li>
        <li>密碼會由後端處理，前端不會顯示或公開玩家密碼。請勿把密碼提供給他人。</li>
        <li>訪客模式資料只暫存在目前瀏覽器分頁，關閉後可能消失，且不會轉移到正式帳號。</li>
        <li>若未來串接付款，訂單與交易流程會依第三方金流平台規範處理。</li>
        <li>玩家可聯繫管理員協助處理帳號、密碼或資料異常問題。</li>
      </ul>
    ` : `
      <p>使用 T-LO 實況星域前，請先閱讀並同意以下規範。</p>
      <ul>
        <li>玩家應妥善保管自己的 UID 與密碼，因分享帳號造成的損失需自行承擔。</li>
        <li>禁止使用外掛、腳本、惡意請求或其他破壞遊戲公平性的行為。</li>
        <li>留言、暱稱與社交內容不得包含騷擾、詐欺、冒名、惡意攻擊或違法內容。</li>
        <li>活動獎勵、抽卡機率、商城品項與遊戲數值，可能依營運需求調整。</li>
        <li>若系統偵測異常資料或惡意操作，管理員可暫停帳號、回復異常紀錄或限制功能。</li>
      </ul>
    `;
    var old = document.getElementById("tlo-legal-modal");
    if (old) old.remove();
    document.body.insertAdjacentHTML("beforeend", `
      <div class="tlo-legal-modal" id="tlo-legal-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="tlo-legal-card">
          <h3>${title}</h3>
          ${content}
          <button class="tlo-legal-close" id="tlo-legal-close" type="button">我知道了</button>
        </div>
      </div>
    `);
    document.getElementById("tlo-legal-close").onclick = function () { document.getElementById("tlo-legal-modal").remove(); };
    document.getElementById("tlo-legal-modal").onclick = function (event) {
      if (event.target.id === "tlo-legal-modal") event.currentTarget.remove();
    };
  }

  function showForgotPasswordModal() {
    var old = document.getElementById("tlo-legal-modal");
    if (old) old.remove();
    document.body.insertAdjacentHTML("beforeend", `
      <div class="tlo-legal-modal" id="tlo-legal-modal" role="dialog" aria-modal="true" aria-label="忘記密碼">
        <div class="tlo-legal-card">
          <h3>忘記密碼</h3>
          <p>目前尚未開放自動寄信重設密碼。請把你的玩家 UID 提供給管理員或客服，由後台協助重設。</p>
          <p>為了保護帳號安全，請不要在公開留言區張貼密碼或個人敏感資料。</p>
          <button class="tlo-legal-close" id="tlo-legal-close" type="button">我知道了</button>
        </div>
      </div>
    `);
    document.getElementById("tlo-legal-close").onclick = function () { document.getElementById("tlo-legal-modal").remove(); };
    document.getElementById("tlo-legal-modal").onclick = function (event) {
      if (event.target.id === "tlo-legal-modal") event.currentTarget.remove();
    };
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
    var shortcut = document.getElementById("tlo-register-shortcut-btn");
    if (shortcut) shortcut.onclick = function () { switchAuthTab("register"); };
    var forgot = document.getElementById("tlo-forgot-btn");
    if (forgot) forgot.onclick = showForgotPasswordModal;
    var terms = document.getElementById("tlo-terms-check");
    if (terms) terms.onchange = function () {
      if (terms.checked) localStorage.setItem(TERMS_ACCEPTED_KEY, "1");
      else localStorage.removeItem(TERMS_ACCEPTED_KEY);
    };
    var legalLinks = document.querySelectorAll(".tlo-legal-link");
    Array.prototype.forEach.call(legalLinks, function (btn) {
      btn.onclick = function (event) {
        event.preventDefault();
        event.stopPropagation();
        showLegalModal(btn.getAttribute("data-legal"));
      };
    });
    var loginPw = document.getElementById("tlo-login-password-toggle");
    if (loginPw) loginPw.onclick = function () { togglePasswordVisibility("tlo-login-password", "tlo-login-password-toggle"); };
    var regPw = document.getElementById("tlo-register-password-toggle");
    if (regPw) regPw.onclick = function () { togglePasswordVisibility("tlo-register-password", "tlo-register-password-toggle"); };
    var regPw2 = document.getElementById("tlo-register-password2-toggle");
    if (regPw2) regPw2.onclick = function () { togglePasswordVisibility("tlo-register-password2", "tlo-register-password2-toggle"); };
  }

  function handleGuestEntry() {
    if (!ensureTermsAccepted()) {
      if (window.TLOAudio) window.TLOAudio.playSfx("error");
      return;
    }
    clearAuth();
    sessionStorage.setItem(GUEST_MODE_KEY, "1");
    location.reload();
  }

  async function handleLogin() {
    try {
      if (!ensureTermsAccepted()) throw new Error("請先同意使用者條款與隱私政策。");
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
      if (!ensureTermsAccepted()) throw new Error("請先同意使用者條款與隱私政策。");
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
    if (!confirm("確定要登出並回到登入畫面嗎？")) return;
    try {
      if (window.TLO_IS_AUTHENTICATED) {
        await rawRpc("logoutAccount", [window.TLO_PLAYER_UID], { auth: true });
      }
    } catch (_) {}
    clearAuth();
    sessionStorage.removeItem(GUEST_MODE_KEY);
    sessionStorage.removeItem(GUEST_DEMO_STATE_KEY);
    window.TLO_IS_AUTHENTICATED = false;
    window.TLO_IS_GUEST = false;
    window.TLO_PLAYER_UID = "";
    window.TLO_AUTH_TOKEN = "";
    location.reload();
  }

  window.TLO_LOGOUT = handleLogout;

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
