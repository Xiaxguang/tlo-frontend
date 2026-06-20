(function () {
  function getApiBaseUrl() {
    var cfg = window.TLO_CONFIG || {};
    return String(cfg.API_BASE_URL || "").replace(/\/+$/, "");
  }

  function getPlayerUID() {
    var params = new URLSearchParams(window.location.search);
    var urlUid = params.get("uid");
    var savedUid = localStorage.getItem("TLO_UID");
    var uid = (urlUid || savedUid || "").trim();

    if (!uid) {
      uid = (prompt("請輸入你的玩家 UID / 玩家代碼") || "").trim();
    }

    if (!uid) {
      uid = "guest_" + Math.random().toString(36).slice(2, 8);
      alert("系統已建立臨時 UID：" + uid + "\\n建議你記下來，之後才能找回資料。");
    }

    localStorage.setItem("TLO_UID", uid);
    return uid;
  }

  window.TLO_PLAYER_UID = getPlayerUID();
  window.TLO_INITIAL_TIMES = "0";

  async function callRpc(method, args) {
    var baseUrl = getApiBaseUrl();
    if (!baseUrl || baseUrl.indexOf("你的-railway") !== -1) {
      throw new Error("尚未設定 Railway API 網址。請先修改 js/config.js 的 API_BASE_URL。");
    }

    var res = await fetch(baseUrl + "/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: method,
        args: args || []
      })
    });

    var data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error("後端沒有回傳 JSON，請檢查 Railway API 是否正常。");
    }

    if (!res.ok) {
      throw new Error(data && data.msg ? data.msg : "API 呼叫失敗");
    }

    return data;
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
              if (typeof successHandler === "function") {
                successHandler(data);
              }
            })
            .catch(function (err) {
              console.error("TLO API Error:", prop, err);
              if (typeof failureHandler === "function") {
                failureHandler(err);
              } else {
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

  document.addEventListener("DOMContentLoaded", function () {
    var uidEl = document.getElementById("display-uid");
    if (uidEl) uidEl.textContent = window.TLO_PLAYER_UID;

    // 初始化首頁資料：舊前端本來就有 loadHomeState()，如果存在就呼叫它。
    setTimeout(function () {
      if (typeof window.loadHomeState === "function") {
        window.loadHomeState();
      } else if (window.google && window.google.script && window.google.script.run) {
        window.google.script.run.withSuccessHandler(function (res) {
          if (res && res.success) {
            var countEl = document.getElementById("display-count");
            if (countEl) countEl.textContent = res.timesLeft || 0;
            var summaryEl = document.getElementById("collection-summary-count");
            if (summaryEl) summaryEl.textContent = res.collectionUniqueCount || 0;
            var historyEl = document.getElementById("history-list");
            if (historyEl && res.historyHtml) historyEl.innerHTML = res.historyHtml;
          }
        }).getHomeState(window.TLO_PLAYER_UID);
      }
    }, 0);
  });
})();