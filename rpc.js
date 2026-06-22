import express from "express";
import crypto from "crypto";
import { execute, queryAll, queryOne, withTransaction, isTransientDbError } from "../db.js";
import { getOrCreatePlayer, maskUid, normalizeUid, makePlayerId, makeRecoveryCode } from "../utils/uid.js";
import { todayKeyTaipei, dateKeyOffsetTaipei, formatTaipeiMMddHHmm } from "../utils/dates.js";
import {
  createSession,
  getPlayerBySessionToken,
  hashPassword,
  publicAuthPlayer,
  revokeSession,
  validatePassword,
  verifyPassword
} from "../utils/auth.js";

import {
  CARD_STAR_MAX,
  CARD_STAR_COSTS,
  CARD_LEVEL_MAX,
  CARD_SKILL_MAX,
  CARD_STAR_MULTIPLIERS,
  POWER_RULES,
  calculatePlayerPower,
  calculateSingleCardPowerWithStar,
  calculateSingleCardPowerWithGrowth,
  calculateTrainingTitle,
  drawOneCard,
  escapeHtml,
  getCardLevelExpNeed,
  getCardProgressMap,
  getCardTrainingEnergyCost,
  getCollectionUniqueCount,
  getOwnedCardsMap,
  getLevelMultiplier,
  getSkillLevelMultiplier,
  getSkillUpgradeEnergyCost,
  getStarMap,
  normalizeRarityForCss
} from "../utils/game.js";

const router = express.Router();

const HISTORY_TYPE_GACHA = "網頁扣次數抽卡";
const FREE_DAILY_MEMORY_LIMIT = 3;
const FREE_CHECKIN_ENERGY = 100;
const FREE_CHECKIN_SCORE = 50;
const FREE_QUIZ_CORRECT_SCORE = 120;
const FREE_QUIZ_WRONG_SCORE = 30;
const FREE_QUIZ_CORRECT_ENERGY = 80;
const FREE_QUIZ_WRONG_ENERGY = 20;
const SHADOW_DAILY_LIMIT = 5;
const SHADOW_CORRECT_SCORE = 100;
const SHADOW_WRONG_SCORE = 20;
const SHADOW_CORRECT_ENERGY = 60;
const SHADOW_WRONG_ENERGY = 10;
const MESSAGE_DAILY_LIMIT = 3;
const PVP_DAILY_LIMIT = 10;
const PVP_DAILY_WIN_TARGET = 3;
const PVP_FRAGMENTS_TO_DRAW = 3;
const BATTLE_DAILY_TICKET_LIMIT = 30;
const BATTLE_DAILY_NORMAL_FIRST_CLEAR_LIMIT = 20;
const BATTLE_DAILY_HARD_FIRST_CLEAR_LIMIT = 6;
const RPG_DAILY_TICKET_LIMIT = 20;
const SOCIAL_ONLINE_WINDOW_MS = Number(process.env.SOCIAL_ONLINE_WINDOW_MS || 120000);
const PRESENCE_TOUCH_INTERVAL_MS = Number(process.env.PRESENCE_TOUCH_INTERVAL_MS || 60000);
const PROFILE_DISPLAY_NAME_MAX = 40;
const PROFILE_BIO_MAX = 200;
const SOCIAL_STATUS_LABELS = { ONLINE: "在線", OFFLINE: "離線", BUSY: "忙碌" };
const PRESENCE_TOUCH_CACHE = new Map();

// 卡牌重置券：重置角色星等與技能等級，退還養成資源。
const ITEM_CARD_RESET_TICKET = "CARD_RESET_TICKET";
const TLO_ITEM_DEFS = {
  CARD_RESET_TICKET: { name: "卡牌重置券", desc: "可重置 1 張已持有卡牌的星等與技能等級，並退還潮流能量與技能經驗。" }
};
let RESET_ITEM_SCHEMA_READY = false;


// 維護模式測試帳號設定
// 預設 guang 可在維護期間進入玩家端；可於 Railway Variables 設定：
// MAINTENANCE_TEST_UIDS=guang,other_uid
// TEST_ACCOUNT_BYPASS_LIMITS=true 時，維護期間白名單測試帳號不消耗爭霸戰/遠征每日限制。
const DEFAULT_MAINTENANCE_TEST_UIDS = String(process.env.MAINTENANCE_TEST_UIDS || "guang");
const TEST_ACCOUNT_BYPASS_LIMITS = /^(1|true|yes|on)$/i.test(String(process.env.TEST_ACCOUNT_BYPASS_LIMITS || "false"));

function normalizeMaintenanceUid(uid) {
  return String(uid || "").trim().toLowerCase();
}

function parseMaintenanceTestUids(raw) {
  return new Set(String(raw || "")
    .split(/[,\n\s]+/)
    .map(normalizeMaintenanceUid)
    .filter(Boolean));
}
// 潮流爭霸戰章節設定
// 普通模式：3 章 x 25 關 = 75 關
// 困難模式：普通模式全通後解鎖，3 章 x 6 關 = 18 關
const BATTLE_NORMAL_STAGES_PER_CHAPTER = 25;
const BATTLE_HARD_STAGES_PER_CHAPTER = 6;
const BATTLE_NORMAL_MAX_STAGE_ID = 75;
const BATTLE_HARD_START_STAGE_ID = 76;
const BATTLE_HARD_MAX_STAGE_ID = 93;
const BATTLE_CHAPTERS = [
  {
    chapterId: 1,
    mode: "normal",
    modeLabel: "普通",
    chapterNo: 1,
    title: "第一章｜初見秘寶閣",
    story: "初次接觸秘寶閣，從外圍試煉開始踏入未知領域。",
    startStageId: 1,
    endStageId: 25
  },
  {
    chapterId: 2,
    mode: "normal",
    modeLabel: "普通",
    chapterNo: 2,
    title: "第二章｜秘寶閣隱秘",
    story: "發現秘寶閣深處藏有不為人知的秘密，守關者實力全面提升。",
    startStageId: 26,
    endStageId: 50
  },
  {
    chapterId: 3,
    mode: "normal",
    modeLabel: "普通",
    chapterNo: 3,
    title: "第三章｜決戰秘寶閣",
    story: "各方勢力爭奪秘寶閣歸屬權，最終守關者展開決戰。",
    startStageId: 51,
    endStageId: 75
  },
  {
    chapterId: 4,
    mode: "hard",
    modeLabel: "困難",
    chapterNo: 1,
    title: "困難第一章｜秘寶閣深層試煉",
    story: "普通模式全通後開啟，秘寶閣真正的深層試煉開始。",
    startStageId: 76,
    endStageId: 81
  },
  {
    chapterId: 5,
    mode: "hard",
    modeLabel: "困難",
    chapterNo: 2,
    title: "困難第二章｜秘寶閣禁區",
    story: "踏入秘寶閣禁區，精英守關者開始阻擋玩家接近核心。",
    startStageId: 82,
    endStageId: 87
  },
  {
    chapterId: 6,
    mode: "hard",
    modeLabel: "困難",
    chapterNo: 3,
    title: "困難第三章｜秘寶閣終局",
    story: "終局王權之戰，決定秘寶閣最後歸屬。",
    startStageId: 88,
    endStageId: 93
  }
];

const shadowAnswerCache = new Map();

// Supabase 高流量穩定版：營運設定不需要每個 RPC 都打資料庫。
// 這可以直接消除 Logs 裡大量 SELECT value FROM app_settings 的 1~3 秒慢查。
const APP_SETTING_CACHE_TTL_MS = Math.max(5000, Number(process.env.APP_SETTING_CACHE_TTL_MS || 60000));
const APP_SETTING_CACHE = new Map();
function getAppSettingCache(key) {
  const item = APP_SETTING_CACHE.get(String(key));
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    APP_SETTING_CACHE.delete(String(key));
    return null;
  }
  return item.value;
}
function setAppSettingCache(key, value) {
  APP_SETTING_CACHE.set(String(key), { value: String(value ?? ""), expiresAt: Date.now() + APP_SETTING_CACHE_TTL_MS });
}
function clearAppSettingCache(key = "") {
  if (key) APP_SETTING_CACHE.delete(String(key));
  else APP_SETTING_CACHE.clear();
}

// ===============================
// 最終效能優化：短暫讀取快取
// 目的：避免玩家切換畫面、連續打開面板時，重複向 Turso 讀取大量資料。
// 規則：只快取讀取型 API；任何寫入型 API 成功後清空快取，避免資料不同步。
// ===============================
const RPC_READ_CACHE = new Map();
const RPC_INFLIGHT_READS = new Map();
const RPC_RATE_LIMITS = new Map();
const RPC_CACHE_MAX_ITEMS = Number(process.env.RPC_CACHE_MAX_ITEMS || 2000);
const RPC_FAST_CACHE_TTL_MS = Number(process.env.RPC_FAST_CACHE_TTL_MS || 10000);
const RPC_STATIC_CACHE_TTL_MS = Number(process.env.RPC_STATIC_CACHE_TTL_MS || 180000);
const RPC_INFLIGHT_MAX_ITEMS = Number(process.env.RPC_INFLIGHT_MAX_ITEMS || 300);

// 高流量防爆：限制同一玩家同一動作在短時間內重複送出，避免狂點把 Turso 打爆。
const RPC_WRITE_RATE_LIMIT_MS = new Map([
  // Supabase 高流量穩定版：寫入型操作要更嚴格，避免玩家連點把 Postgres pool 打滿。
  ["executeRpgAdventure", Number(process.env.RPC_LIMIT_RPG_MS || 4500)],
  ["executePvpBattle", Number(process.env.RPC_LIMIT_PVP_MS || 3000)],
  ["executeBattle", Number(process.env.RPC_LIMIT_BOSS_MS || 2500)],
  ["executeGacha", Number(process.env.RPC_LIMIT_GACHA_MS || 2500)],
  ["executeGacha10", Number(process.env.RPC_LIMIT_GACHA10_MS || 4500)],
  ["buyShopItem", Number(process.env.RPC_LIMIT_SHOP_MS || 1800)],
  ["createEcpayOrder", Number(process.env.RPC_LIMIT_ECPAY_ORDER_MS || 3000)],
  ["useCardResetTicket", Number(process.env.RPC_LIMIT_CARD_RESET_MS || 2500)],
  ["updatePlayerProfile", Number(process.env.RPC_LIMIT_PROFILE_MS || 1500)],
  ["setPlayerPresenceStatus", Number(process.env.RPC_LIMIT_STATUS_MS || 1000)],
  ["sendFriendRequest", Number(process.env.RPC_LIMIT_FRIEND_MS || 2500)],
  ["respondFriendRequest", Number(process.env.RPC_LIMIT_FRIEND_RESPOND_MS || 1500)],
  ["removeFriend", Number(process.env.RPC_LIMIT_REMOVE_FRIEND_MS || 2000)],
  ["answerDailyQuiz", Number(process.env.RPC_LIMIT_QUIZ_MS || 2000)],
  ["saveMemoryGameScore", Number(process.env.RPC_LIMIT_MEMORY_MS || 2500)],
  ["claimDailyFortune", Number(process.env.RPC_LIMIT_FORTUNE_MS || 2500)],
  ["claimDailyCheckIn", Number(process.env.RPC_LIMIT_CHECKIN_MS || 2000)],
  ["claimMissionReward", Number(process.env.RPC_LIMIT_MISSION_MS || 2500)],
  ["claimAchievementReward", Number(process.env.RPC_LIMIT_ACHIEVEMENT_MS || 2500)],
  ["setRpgTeam", 1200],
  ["setPvpRepresentative", 1200],
  ["setBattleRepresentative", 1200],
  ["loginAccount", 1200],
  ["registerAccount", 2500]
]);

const RPC_READ_CACHE_TTL = new Map([
  ["getPublicSettings", 180000],
  ["getHomeState", 8000],
  ["getPlayerCollection", 10000],
  ["getBattleDashboard", Number(process.env.RPC_BATTLE_CACHE_TTL_MS || 20000)],
  ["getCardProbabilityTable", RPC_STATIC_CACHE_TTL_MS],
  ["getRpgDashboard", Number(process.env.RPC_RPG_CACHE_TTL_MS || 20000)],
  ["getShopDashboard", Number(process.env.RPC_SHOP_CACHE_TTL_MS || 8000)],
  ["getPersonalDashboard", Number(process.env.RPC_PERSONAL_CACHE_TTL_MS || 8000)],
  ["getSocialDashboard", Number(process.env.RPC_SOCIAL_CACHE_TTL_MS || 8000)],
  ["getPvpDashboard", Number(process.env.RPC_PVP_CACHE_TTL_MS || 20000)],
  ["getTrainingDashboard", Number(process.env.RPC_TRAINING_CACHE_TTL_MS || 20000)],
  ["getStarShopDashboard", RPC_FAST_CACHE_TTL_MS],
  ["getCharacterGrowthDashboard", RPC_FAST_CACHE_TTL_MS],
  ["getMissionDashboard", 15000],
  ["getAchievementDashboard", 15000],
  ["getMessageBoard", 12000],
  ["getPlayerHistory", 12000],
  ["adminSearchPlayers", 10000],
  ["adminGetPlayer", 3000],
  ["adminListCards", RPC_STATIC_CACHE_TTL_MS],
  ["adminListBattleChapters", RPC_STATIC_CACHE_TTL_MS],
  ["adminListBossStages", RPC_STATIC_CACHE_TTL_MS],
  ["adminListRpgChapters", RPC_STATIC_CACHE_TTL_MS],
  ["adminListRpgDungeons", RPC_STATIC_CACHE_TTL_MS],
  ["adminListShopItems", 5000],
  ["adminGetAuditLogs", 3500],
  ["adminGetOpsSettings", 8000],
  ["adminListRedeemCodes", 5000],
  ["adminGetRedeemLogs", 3500]
]);

const RPC_WRITE_METHODS = new Set([
  "registerAccount", "loginAccount", "logoutAccount", "changePassword",
  "executeGacha", "executeGacha10",
  "setBattleRepresentative", "executeBattle",
  "claimDailyCheckIn", "answerDailyQuiz", "saveMemoryGameScore",
  "getShadowQuestion", "submitShadowGuess", "claimDailyFortune",
  "submitBoardMessage",
  "setPvpRepresentative", "executePvpBattle",
  "upgradeCardStar", "trainCardLevel", "upgradeCardSkill", "useCardResetTicket",
  "redeemCode", "setRpgTeam", "executeRpgAdventure",
  "buyShopItem", "createEcpayOrder",
  "updatePlayerProfile", "setPlayerPresenceStatus", "sendFriendRequest", "respondFriendRequest", "removeFriend",
  "claimOpeningReward", "claimMissionReward", "claimAchievementReward",
  "adminLogout", "adminChangeOwnPassword", "adminUpdateDrawTimes", "adminAddDrawTimes",
  "adminUpdateTraining", "adminGrantSkillExp", "adminSetCardQuantity", "adminGiftCard",
  "adminResetPlayerPassword", "adminUpsertCard", "adminUpdateCardSettings",
  "adminUpsertBattleChapter", "adminSetBattleChapterActive", "adminUpsertBossStage", "adminUpsertRpgChapter", "adminSetRpgChapterActive", "adminUpsertRpgDungeon", "adminSetRpgDungeonActive",
  "adminUpdateOpsSettings", "adminCreateRedeemCode", "adminSetRedeemCodeActive",
  "adminUpsertShopItem", "adminSetShopItemActive", "adminTestGrantShopItem"
]);

// 圖片網址統一處理：GM 可貼完整 raw URL、GitHub blob 頁面，或只填檔名。
// 若沒有填圖，會預設使用 lbr-images/main/{卡名}.png，避免新增卡片只出現問號圖。
const TLO_IMAGE_RAW_BASE = "https://raw.githubusercontent.com/Xiaxguang/lbr-images/main/";

function encodeGithubImagePath(value) {
  return String(value || "")
    .replace(/^\.?\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join("/");
}

function normalizeCardImageUrl(value, cardName = "") {
  let url = String(value || "").trim();

  // 沒有填圖時，預設抓 lbr-images 裡「卡名.png」
  if (!url && cardName) url = `${cardName}.png`;
  if (!url) return "";

  // GitHub 網頁瀏覽網址自動轉 raw 圖片網址
  url = url.replace(
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/i,
    "https://raw.githubusercontent.com/$1/$2/$3"
  );

  if (/^https?:\/\//i.test(url)) return url;

  // 只填「圖片名稱」或「圖片名稱.png」時，自動補成你的 lbr-images raw 網址
  let path = url.replace(/^\.?\/+/, "");
  if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(path)) path += ".png";
  return TLO_IMAGE_RAW_BASE + encodeGithubImagePath(path);
}

function rpcStableStringify(value) {
  try {
    return JSON.stringify(value, function(key, val) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.keys(val).sort().reduce((obj, k) => {
          obj[k] = val[k];
          return obj;
        }, {});
      }
      return val;
    });
  } catch (_) {
    return String(value);
  }
}

function makeRpcCacheKey(method, scope, args) {
  return method + "::" + scope + "::" + rpcStableStringify(args || []);
}

function getRpcReadCache(key) {
  const cached = RPC_READ_CACHE.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    RPC_READ_CACHE.delete(key);
    return null;
  }
  return cached.value;
}

function setRpcReadCache(key, value, ttlMs) {
  if (!key || !ttlMs || !value || value.success === false) return;
  if (RPC_READ_CACHE.size >= RPC_CACHE_MAX_ITEMS) {
    const first = RPC_READ_CACHE.keys().next().value;
    if (first) RPC_READ_CACHE.delete(first);
  }
  RPC_READ_CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function clearRpcReadCache() {
  RPC_READ_CACHE.clear();
}

function clearRpcReadCacheForScope(scope) {
  if (!scope) return;
  const needle = `::${scope}::`;
  for (const key of RPC_READ_CACHE.keys()) {
    if (key.includes(needle)) RPC_READ_CACHE.delete(key);
  }
}

function clearRpcReadCacheAfterWrite(method, scope) {
  // GM 改卡片、關卡、營運設定時才清全部；一般玩家操作只清自己的快取。
  const globalMethods = new Set([
    "adminUpsertCard", "adminUpdateCardSettings",
    "adminUpsertBattleChapter", "adminSetBattleChapterActive", "adminUpsertBossStage", "adminUpsertRpgChapter", "adminSetRpgChapterActive", "adminUpsertRpgDungeon", "adminSetRpgDungeonActive",
    "adminUpdateOpsSettings", "adminCreateRedeemCode", "adminSetRedeemCodeActive",
  "adminUpsertShopItem", "adminSetShopItemActive", "adminTestGrantShopItem"
  ]);
  if (globalMethods.has(method)) return clearRpcReadCache();
  clearRpcReadCacheForScope(scope);
}

function clearRpcInflight(key) {
  if (key) RPC_INFLIGHT_READS.delete(key);
}

function checkRpcRateLimit(method, scope) {
  const limitMs = RPC_WRITE_RATE_LIMIT_MS.get(method) || 0;
  if (!limitMs) return 0;
  const key = `${method}::${scope || "public"}`;
  const now = Date.now();
  const blockedUntil = RPC_RATE_LIMITS.get(key) || 0;
  if (blockedUntil > now) return blockedUntil - now;
  RPC_RATE_LIMITS.set(key, now + limitMs);
  return 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of RPC_READ_CACHE.entries()) {
    if (!cached || cached.expiresAt <= now) RPC_READ_CACHE.delete(key);
  }
  for (const [key, blockedUntil] of RPC_RATE_LIMITS.entries()) {
    if (!blockedUntil || blockedUntil <= now) RPC_RATE_LIMITS.delete(key);
  }
}, 60000).unref?.();


function pad4(n) {
  return String(n).padStart(4, "0");
}

function publicPlayer(player) {
  return {
    uid: player.uid,
    displayName: player.display_name || player.uid,
    recoveryCode: player.recovery_code,
    mustChangePassword: Number(player.must_change_password || 0) === 1
  };
}

async function createBasePlayerRows(playerId, now) {
  await execute(
    "INSERT OR IGNORE INTO player_assets (player_id, draw_times, trend_energy, updated_at) VALUES (?, 5, 0, ?)",
    [playerId, now]
  );
  await execute(
    "INSERT OR IGNORE INTO battle_progress (player_id, current_stage_id, updated_at) VALUES (?, 1, ?)",
    [playerId, now]
  );
  await execute(
    "INSERT OR IGNORE INTO training_profiles (player_id, energy, total_score, streak, daily_key, title, updated_at) VALUES (?, 0, 0, 0, '', '潮流新人', ?)",
    [playerId, now]
  );
  await execute(
    "INSERT OR IGNORE INTO pvp_players (player_id, representative_card_name, representative_power, fragments, total_wins, total_losses, updated_at) VALUES (?, '', 0, 0, 0, 0, ?)",
    [playerId, now]
  );
}

async function registerAccount(uidInput, passwordInput, displayNameInput) {
  const uid = normalizeUid(uidInput);
  const password = validatePassword(passwordInput);
  const displayName = String(displayNameInput || uid).trim().slice(0, 40) || uid;
  const existing = await queryOne("SELECT id FROM players WHERE uid = ?", [uid]);
  if (existing) {
    return { success: false, msg: "這個玩家代碼已經存在，請改用登入。" };
  }

  const now = new Date().toISOString();
  const id = makePlayerId(uid);
  const recoveryCode = makeRecoveryCode(uid);
  const passwordHash = hashPassword(password);

  await withTransaction(async () => {
    await execute(
      `INSERT INTO players (id, uid, display_name, recovery_code, password_hash, must_change_password, password_changed_at, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, uid, displayName, recoveryCode, passwordHash, now, now, now]
    );
    await createBasePlayerRows(id, now);
  });

  const player = await queryOne("SELECT * FROM players WHERE id = ?", [id]);
  const session = await createSession(id);
  return {
    success: true,
    msg: "註冊成功",
    token: session.token,
    expiresAt: session.expiresAt,
    player: publicAuthPlayer(player)
  };
}

async function loginAccount(uidInput, passwordInput) {
  const uid = normalizeUid(uidInput);
  const password = String(passwordInput || "");
  const player = await queryOne("SELECT * FROM players WHERE uid = ?", [uid]);
  if (!player || !verifyPassword(password, player.password_hash)) {
    return { success: false, msg: "玩家代碼或密碼錯誤。" };
  }

  const now = new Date().toISOString();
  await execute("UPDATE players SET last_login_at = ? WHERE id = ?", [now, player.id]);
  const freshPlayer = await queryOne("SELECT * FROM players WHERE id = ?", [player.id]);
  const session = await createSession(player.id);

  return {
    success: true,
    msg: "登入成功",
    token: session.token,
    expiresAt: session.expiresAt,
    player: publicAuthPlayer(freshPlayer)
  };
}

async function changePassword(uid, oldPasswordInput, newPasswordInput) {
  const player = await getOrCreatePlayer(uid);
  const oldPassword = String(oldPasswordInput || "");
  const newPassword = validatePassword(newPasswordInput);

  if (!verifyPassword(oldPassword, player.password_hash)) {
    return { success: false, msg: "原密碼錯誤。" };
  }

  const now = new Date().toISOString();
  await execute(
    "UPDATE players SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?",
    [hashPassword(newPassword), now, player.id]
  );

  const updated = await queryOne("SELECT * FROM players WHERE id = ?", [player.id]);
  return {
    success: true,
    msg: "密碼已更新。",
    player: publicAuthPlayer(updated)
  };
}

async function getCurrentAuthUser(uid) {
  const player = await getOrCreatePlayer(uid);
  return { success: true, player: publicAuthPlayer(player) };
}

async function logoutAccount(_uid, token) {
  await revokeSession(token);
  return { success: true, msg: "已登出" };
}

function getRequestToken(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String((req.body && req.body.authToken) || "").trim();
}

async function requireAuth(req) {
  const token = getRequestToken(req);
  const player = await getPlayerBySessionToken(token);
  if (!player) {
    const err = new Error("請先登入。內測玩家請用原本 UID 登入，預設密碼 aaa123456。");
    err.statusCode = 401;
    throw err;
  }
  return { token, player };
}

async function getAssets(playerId) {
  let row = await queryOne("SELECT * FROM player_assets WHERE player_id = ?", [playerId]);
  if (!row) {
    await execute("INSERT INTO player_assets (player_id, draw_times, trend_energy, updated_at) VALUES (?, 0, 0, ?)", [playerId, new Date().toISOString()]);
    row = await queryOne("SELECT * FROM player_assets WHERE player_id = ?", [playerId]);
  }
  return row;
}


function cleanProfileText(value, maxLen) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function normalizeSocialStatus(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (["ONLINE", "OFFLINE", "BUSY"].includes(raw)) return raw;
  if (["在線", "上線"].includes(raw)) return "ONLINE";
  if (["離線", "隱身"].includes(raw)) return "OFFLINE";
  if (["忙碌", "勿擾"].includes(raw)) return "BUSY";
  return "ONLINE";
}

function publicPresence(profile) {
  const manualStatus = normalizeSocialStatus(profile?.status || "ONLINE");
  const lastSeenMs = Date.parse(profile?.last_seen_at || "") || 0;
  let status = manualStatus;
  if (manualStatus === "ONLINE" && Date.now() - lastSeenMs > SOCIAL_ONLINE_WINDOW_MS) status = "OFFLINE";
  return {
    status,
    statusLabel: SOCIAL_STATUS_LABELS[status] || "離線",
    manualStatus,
    isOnline: status === "ONLINE",
    lastSeenAt: profile?.last_seen_at || ""
  };
}

async function ensurePlayerProfile(playerOrId, touch = false) {
  let player = playerOrId;
  if (typeof playerOrId === "string") player = await queryOne("SELECT * FROM players WHERE id = ?", [playerOrId]);
  if (!player) throw new Error("找不到玩家資料。 ");
  const now = new Date().toISOString();
  let profile = await queryOne("SELECT * FROM player_profiles WHERE player_id = ?", [player.id]);
  if (!profile) {
    await execute(
      `INSERT INTO player_profiles (player_id, uid, display_name, bio, status, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, '', 'ONLINE', ?, ?, ?)`,
      [player.id, player.uid, player.display_name || player.uid, now, now, now]
    );
    profile = await queryOne("SELECT * FROM player_profiles WHERE player_id = ?", [player.id]);
  } else if (String(profile.uid || "") !== String(player.uid || "")) {
    await execute("UPDATE player_profiles SET uid = ?, updated_at = ? WHERE player_id = ?", [player.uid, now, player.id]);
    profile = await queryOne("SELECT * FROM player_profiles WHERE player_id = ?", [player.id]);
  }
  if (touch && normalizeSocialStatus(profile.status) !== "OFFLINE") {
    await execute("UPDATE player_profiles SET last_seen_at = ?, updated_at = ? WHERE player_id = ?", [now, now, player.id]);
    profile = await queryOne("SELECT * FROM player_profiles WHERE player_id = ?", [player.id]);
  }
  return profile;
}

async function touchPlayerPresence(player) {
  if (!player || !player.id) return;
  const key = String(player.id);
  const nowMs = Date.now();
  const last = PRESENCE_TOUCH_CACHE.get(key) || 0;
  if (nowMs - last < PRESENCE_TOUCH_INTERVAL_MS) return;
  PRESENCE_TOUCH_CACHE.set(key, nowMs);
  try {
    const now = new Date().toISOString();
    const existing = await queryOne("SELECT status FROM player_profiles WHERE player_id = ?", [player.id]);
    if (!existing) {
      await execute(
        `INSERT INTO player_profiles (player_id, uid, display_name, bio, status, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, '', 'ONLINE', ?, ?, ?)`,
        [player.id, player.uid, player.display_name || player.uid, now, now, now]
      );
      return;
    }
    if (normalizeSocialStatus(existing.status) !== "OFFLINE") {
      await execute("UPDATE player_profiles SET last_seen_at = ?, updated_at = ? WHERE player_id = ?", [now, now, player.id]);
    }
  } catch (err) {
    console.warn("touchPlayerPresence failed:", err?.message || err);
  }
}

function publicPlayerProfile(row, friendInfo = {}) {
  const presence = publicPresence(row || {});
  return {
    playerId: row?.player_id || "",
    uid: row?.uid || "",
    displayName: row?.display_name || row?.uid || "玩家",
    bio: row?.bio || "",
    status: presence.status,
    statusLabel: presence.statusLabel,
    manualStatus: presence.manualStatus,
    isOnline: presence.isOnline,
    lastSeenAt: presence.lastSeenAt,
    friendSince: friendInfo.friendSince || "",
    requestId: friendInfo.requestId || null,
    requestedAt: friendInfo.requestedAt || ""
  };
}

async function getLatestHistoryHtml(playerId) {
  const rows = await queryAll(
    `SELECT g.id, g.created_at, g.card_name, p.uid
     FROM gacha_logs g
     JOIN players p ON p.id = g.player_id
     WHERE g.player_id = ? AND g.source = ?
     ORDER BY g.id DESC
     LIMIT 10`,
    [playerId, HISTORY_TYPE_GACHA]
  );

  if (!rows.length) return "<div>暫無抽卡紀錄</div>";

  return rows.map(row => {
    const date = formatTaipeiMMddHHmm(row.created_at);
    return `<div class="history-item">[${escapeHtml(date)}] 玩家 <span class="hist-uid">${escapeHtml(row.uid)}</span> 抽到了 <span class="hist-name">${escapeHtml(row.card_name)}</span></div>`;
  }).join("");
}

async function getTotalCollectibleCards() {
  const row = await queryOne("SELECT COUNT(*) AS cnt FROM cards WHERE is_drawable = 1");
  return Number(row?.cnt || 0);
}

async function getCardProbabilityTable(uid = "") {
  const rows = await queryAll(
    `SELECT id, name, rarity, weight, image_url, is_drawable, COALESCE(sort_order, 9999) AS sort_order
     FROM cards
     WHERE is_drawable = 1 AND weight > 0
     ORDER BY COALESCE(sort_order, 9999), name ASC`,
    []
  );
  const totalWeight = rows.reduce((sum, row) => sum + Math.max(0, Number(row.weight || 0)), 0);
  const rarityOrder = { SSR: 1, "SUPER RARE": 2, SR: 3, RARE: 4, R: 5, NORMAL: 6, N: 7 };
  const cards = rows.map(row => {
    const weight = Math.max(0, Number(row.weight || 0));
    const probability = totalWeight > 0 ? (weight / totalWeight) * 100 : 0;
    const rarity = row.rarity || "NORMAL";
    return {
      id: row.id,
      name: row.name,
      cardName: row.name,
      npcName: row.name,
      rarity,
      rarityCss: normalizeRarityForCss(rarity),
      weight,
      probability,
      probabilityText: `${probability.toFixed(2)}%`,
      imageUrl: normalizeCardImageUrl(row.image_url || "", row.name),
      image_url: normalizeCardImageUrl(row.image_url || "", row.name),
      sortOrder: Number(row.sort_order || 9999)
    };
  });

  const groupsMap = new Map();
  cards.forEach(card => {
    const key = String(card.rarity || "NORMAL").toUpperCase();
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        rarity: card.rarity,
        rarityCss: card.rarityCss,
        totalWeight: 0,
        totalProbability: 0,
        totalProbabilityText: "0.00%",
        count: 0,
        cards: []
      });
    }
    const group = groupsMap.get(key);
    group.totalWeight += card.weight;
    group.totalProbability += card.probability;
    group.count += 1;
    group.cards.push(card);
  });

  const groups = Array.from(groupsMap.values()).map(group => ({
    ...group,
    totalProbabilityText: `${group.totalProbability.toFixed(2)}%`
  })).sort((a, b) => {
    const ao = rarityOrder[String(a.rarity || "").toUpperCase()] || 99;
    const bo = rarityOrder[String(b.rarity || "").toUpperCase()] || 99;
    return ao - bo;
  });

  return {
    success: true,
    totalWeight,
    totalCards: cards.length,
    totalCollectibleCards: cards.length,
    cards,
    groups
  };
}

async function getHomeState(uid) {
  const player = await getOrCreatePlayer(uid);
  const asset = await getAssets(player.id);
  const profile = await getTrainingProfile(player.id);
  const [historyHtml, collectionUniqueCount, totalCollectibleCards] = await Promise.all([
    getLatestHistoryHtml(player.id),
    getCollectionUniqueCount(player.id),
    getTotalCollectibleCards()
  ]);

  return {
    success: true,
    player: publicPlayer(player),
    timesLeft: Number(asset.draw_times || 0),
    energy: Number(profile.energy || 0),
    skillExp: Number(profile.skill_exp || 0),
    trendEnergy: Number(asset.trend_energy || 0),
    availablePoints: Number(profile.total_score || 0),
    totalPoints: Number(profile.total_score || 0),
    historyHtml,
    collectionUniqueCount,
    uniqueCount: collectionUniqueCount,
    totalCollectibleCards,
    totalCards: totalCollectibleCards
  };
}

async function getPlayerCollection(uid) {
  const player = await getOrCreatePlayer(uid);

  const rows = await queryAll(
    `SELECT
       c.id AS card_id,
       c.name AS name,
       c.rarity AS rarity,
       c.image_url AS image_url,
       c.is_drawable AS is_drawable,
       COALESCE(c.sort_order, 9999) AS sort_order,
       COALESCE(pc.quantity, 0) AS quantity
     FROM cards c
     LEFT JOIN player_collection pc
       ON pc.card_id = c.id AND pc.player_id = ?
     WHERE c.is_drawable = 1
     ORDER BY COALESCE(c.sort_order, 9999), c.name ASC`,
    [player.id]
  );

  const ownedCardsMap = {};
  const imageMap = {};

  const cards = rows.map(row => {
    const name = row.name || "";
    const quantity = Number(row.quantity || 0);
    const imageUrl = normalizeCardImageUrl(row.image_url || "", name);

    if (quantity > 0) ownedCardsMap[name] = quantity;
    if (name && imageUrl) imageMap[name] = imageUrl;

    return {
      id: row.card_id,
      name,
      cardName: name,
      npcName: name,
      rarity: row.rarity || "NORMAL",
      count: quantity,
      quantity,
      imageUrl,
      image_url: imageUrl,
      isDrawable: Number(row.is_drawable || 0) === 1,
      sortOrder: Number(row.sort_order || 9999)
    };
  });

  const totalCollectibleCards = cards.filter(card => card.isDrawable).length;
  const uniqueCount = cards.filter(card => card.isDrawable && Number(card.quantity || card.count || 0) > 0).length;

  return {
    success: true,
    ownedCardsMap,
    uniqueCount,
    collectionUniqueCount: uniqueCount,
    totalCards: totalCollectibleCards,
    totalCollectibleCards,
    cards,
    imageMap
  };
}

async function executeGachaBatch(uid, drawCount) {
  const player = await getOrCreatePlayer(uid);
  const now = new Date().toISOString();

  return withTransaction(async () => {
    const asset = await getAssets(player.id);
    const times = Number(asset.draw_times || 0);
    if (times < drawCount) {
      return {
        success: false,
        msg: drawCount >= 10 ? "剩餘次數不足 10 次，無法進行十連開盒！" : "次數不足",
        timesLeft: times
      };
    }

    const cards = await queryAll("SELECT * FROM cards WHERE is_drawable = 1 AND weight > 0 ORDER BY sort_order ASC");
    const results = [];

    await execute("UPDATE player_assets SET draw_times = draw_times - ?, updated_at = ? WHERE player_id = ?", [drawCount, now, player.id]);

    for (let i = 0; i < drawCount; i++) {
      const card = drawOneCard(cards);
      const log = await execute(
        `INSERT INTO gacha_logs (player_id, card_id, card_name, source, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          player.id,
          card.id,
          card.name,
          HISTORY_TYPE_GACHA,
          drawCount >= 10 ? `十連抽第 ${i + 1} 抽，剩餘: ${times - drawCount}` : `剩餘次數: ${times - drawCount}`,
          now
        ]
      );

      await execute(
        `INSERT INTO player_collection (player_id, card_id, card_name, quantity, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(player_id, card_id)
         DO UPDATE SET quantity = player_collection.quantity + 1, updated_at = excluded.updated_at`,
        [player.id, card.id, card.name, now]
      );

      const serialId = Number(log.lastInsertRowid || 0);
      results.push({
        npcName: card.name,
        npcRarity: normalizeRarityForCss(card.rarity),
        serialNumber: serialId ? `No.${pad4(serialId)}` : "",
        imageUrl: normalizeCardImageUrl(card.image_url || "", card.name),
        image_url: normalizeCardImageUrl(card.image_url || "", card.name)
      });
    }

    const newAsset = await getAssets(player.id);
    const [historyHtml, collectionUniqueCount, totalCollectibleCards] = await Promise.all([
      getLatestHistoryHtml(player.id),
      getCollectionUniqueCount(player.id),
      getTotalCollectibleCards()
    ]);

    const response = {
      success: true,
      timesLeft: Number(newAsset.draw_times || 0),
      historyHtml,
      collectionUniqueCount,
      uniqueCount: collectionUniqueCount,
      totalCollectibleCards,
      totalCards: totalCollectibleCards
    };

    if (drawCount === 1) {
      return {
        ...response,
        npcName: results[0].npcName,
        npcRarity: results[0].npcRarity,
        serialNumber: results[0].serialNumber,
        imageUrl: results[0].imageUrl,
        image_url: results[0].image_url || results[0].imageUrl
      };
    }

    return { ...response, results };
  });
}

async function executeGacha(uid) {
  return executeGachaBatch(uid, 1);
}

async function executeGacha10(uid) {
  return executeGachaBatch(uid, 10);
}

async function getPlayerHistory(uid) {
  const player = await getOrCreatePlayer(uid);
  const rows = await queryAll(
    `SELECT id, created_at, card_name
     FROM gacha_logs
     WHERE player_id = ? AND source = ?
     ORDER BY id DESC
     LIMIT 200`,
    [player.id, HISTORY_TYPE_GACHA]
  );
  return rows.map(row => ({
    date: formatTaipeiMMddHHmm(row.created_at),
    name: row.card_name,
    serial: `No.${pad4(row.id)}`
  }));
}

function getBattleChapterInfo(stageId) {
  const cleanStageId = Math.max(1, Math.floor(Number(stageId || 1)));
  const chapter = BATTLE_CHAPTERS.find(ch => cleanStageId >= ch.startStageId && cleanStageId <= ch.endStageId)
    || BATTLE_CHAPTERS[BATTLE_CHAPTERS.length - 1];
  const stageInChapter = Math.max(1, cleanStageId - Number(chapter.startStageId || 1) + 1);
  const isHard = chapter.mode === "hard";
  return {
    chapterId: chapter.chapterId,
    chapterTitle: chapter.title,
    chapterStory: chapter.story,
    chapterNo: chapter.chapterNo,
    mode: chapter.mode,
    modeLabel: chapter.modeLabel,
    isHard,
    startStageId: chapter.startStageId,
    endStageId: chapter.endStageId,
    stageInChapter,
    chapterStageLabel: isHard
      ? `困難 H${chapter.chapterNo}-${stageInChapter}`
      : `第 ${chapter.chapterNo} 章-${stageInChapter} 關`
  };
}

function normalizeBattleStageIdInput(value, fallback = 1) {
  const n = Math.floor(Number(value || 0));
  if (!Number.isFinite(n) || n <= 0) return Math.max(1, Math.floor(Number(fallback || 1)));
  return n;
}


function buildBattleDailyLimits(row) {
  const challengeUsed = Number(row?.challenge_count || 0);
  const bonusChallengeCount = Number(row?.bonus_challenge_count || 0);
  const challengeLimit = BATTLE_DAILY_TICKET_LIMIT + Math.max(0, bonusChallengeCount);
  const normalFirstClearUsed = Number(row?.normal_first_clears || 0);
  const hardFirstClearUsed = Number(row?.hard_first_clears || 0);
  return {
    dateKey: row?.date_key || todayKeyTaipei(),
    challengeBaseLimit: BATTLE_DAILY_TICKET_LIMIT,
    bonusChallengeCount,
    challengeLimit,
    challengeUsed,
    challengeRemaining: Math.max(0, challengeLimit - challengeUsed),
    normalFirstClearLimit: BATTLE_DAILY_NORMAL_FIRST_CLEAR_LIMIT,
    normalFirstClearUsed,
    normalFirstClearRemaining: Math.max(0, BATTLE_DAILY_NORMAL_FIRST_CLEAR_LIMIT - normalFirstClearUsed),
    hardFirstClearLimit: BATTLE_DAILY_HARD_FIRST_CLEAR_LIMIT,
    hardFirstClearUsed,
    hardFirstClearRemaining: Math.max(0, BATTLE_DAILY_HARD_FIRST_CLEAR_LIMIT - hardFirstClearUsed),
    resetText: "每日 00:00 重置"
  };
}

function buildRpgDailyLimits(row) {
  const expeditionUsed = Number(row?.expedition_count || 0);
  const bonusExpeditionCount = Number(row?.bonus_expedition_count || 0);
  const expeditionLimit = RPG_DAILY_TICKET_LIMIT + Math.max(0, bonusExpeditionCount);
  return {
    dateKey: row?.date_key || todayKeyTaipei(),
    expeditionBaseLimit: RPG_DAILY_TICKET_LIMIT,
    bonusExpeditionCount,
    expeditionLimit,
    expeditionUsed,
    expeditionRemaining: Math.max(0, expeditionLimit - expeditionUsed),
    resetText: "每日 00:00 重置"
  };
}

async function getBattleDailyLimitStatus(playerId, uid = "") {
  const dateKey = todayKeyTaipei();
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO battle_daily_status (player_id, date_key, challenge_count, normal_first_clears, hard_first_clears, updated_at)
     VALUES (?, ?, 0, 0, 0, ?)
     ON CONFLICT(player_id, date_key) DO NOTHING`,
    [playerId, dateKey, now]
  );
  const row = await queryOne("SELECT * FROM battle_daily_status WHERE player_id = ? AND date_key = ?", [playerId, dateKey]);
  const limits = buildBattleDailyLimits(row);
  return (await shouldBypassDailyLimits(uid)) ? applyBattleDailyTestBypass(limits) : limits;
}

async function consumeBattleDailyLimit(playerId, stageId, willFirstClear, uid = "") {
  const dateKey = todayKeyTaipei();
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO battle_daily_status (player_id, date_key, challenge_count, normal_first_clears, hard_first_clears, updated_at)
     VALUES (?, ?, 0, 0, 0, ?)
     ON CONFLICT(player_id, date_key) DO NOTHING`,
    [playerId, dateKey, now]
  );

  if (await shouldBypassDailyLimits(uid)) {
    return { ok: true, dailyLimits: await getBattleDailyLimitStatus(playerId, uid), testBypass: true };
  }

  const modeRow = await queryOne("SELECT bc.mode FROM boss_stages s LEFT JOIN battle_chapters bc ON bc.key = s.chapter_key WHERE s.id = ? LIMIT 1", [stageId]);
  const battleMode = normalizeBattleMode(modeRow?.mode || getBattleChapterInfo(stageId).mode);
  const isHardMode = battleMode === "hard";
  const normalInc = willFirstClear && !isHardMode ? 1 : 0;
  const hardInc = willFirstClear && isHardMode ? 1 : 0;
  const before = await queryOne("SELECT * FROM battle_daily_status WHERE player_id = ? AND date_key = ?", [playerId, dateKey]);
  const current = buildBattleDailyLimits(before);

  if (current.challengeRemaining <= 0) {
    return {
      ok: false,
      limitBlocked: true,
      reason: "BATTLE_TICKET_LIMIT",
      msg: `今日爭霸戰挑戰券已用完（${current.challengeUsed}/${current.challengeLimit}），明天 00:00 後重置。`,
      dailyLimits: current
    };
  }
  if (normalInc && current.normalFirstClearRemaining <= 0) {
    return {
      ok: false,
      limitBlocked: true,
      reason: "BATTLE_NORMAL_FIRST_CLEAR_LIMIT",
      msg: `今日普通模式首通上限已達 ${current.normalFirstClearLimit} 關；可以重打已通關關卡，新的普通關卡請明天再推進。`,
      dailyLimits: current
    };
  }
  if (hardInc && current.hardFirstClearRemaining <= 0) {
    return {
      ok: false,
      limitBlocked: true,
      reason: "BATTLE_HARD_FIRST_CLEAR_LIMIT",
      msg: `今日困難模式首通上限已達 ${current.hardFirstClearLimit} 關；可以重打已通關關卡，新的困難關卡請明天再推進。`,
      dailyLimits: current
    };
  }

  const updated = await execute(
    `UPDATE battle_daily_status
     SET challenge_count = challenge_count + 1,
         normal_first_clears = normal_first_clears + ?,
         hard_first_clears = hard_first_clears + ?,
         updated_at = ?
     WHERE player_id = ?
       AND date_key = ?
       AND challenge_count < ( ? + COALESCE(bonus_challenge_count, 0) )
       AND (? = 0 OR normal_first_clears < ?)
       AND (? = 0 OR hard_first_clears < ?)`,
    [normalInc, hardInc, now, playerId, dateKey, BATTLE_DAILY_TICKET_LIMIT, normalInc, BATTLE_DAILY_NORMAL_FIRST_CLEAR_LIMIT, hardInc, BATTLE_DAILY_HARD_FIRST_CLEAR_LIMIT]
  );

  if (Number(updated?.rowsAffected || 0) <= 0) {
    const latest = await getBattleDailyLimitStatus(playerId);
    return {
      ok: false,
      limitBlocked: true,
      reason: "BATTLE_LIMIT_RACE",
      msg: "今日爭霸戰次數或首通上限已達上限，請重新整理後再試。",
      dailyLimits: latest
    };
  }

  const afterRow = await queryOne("SELECT * FROM battle_daily_status WHERE player_id = ? AND date_key = ?", [playerId, dateKey]);
  return { ok: true, dailyLimits: buildBattleDailyLimits(afterRow) };
}

async function getRpgDailyLimitStatus(playerId, uid = "") {
  const dateKey = todayKeyTaipei();
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO rpg_daily_status (player_id, date_key, expedition_count, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(player_id, date_key) DO NOTHING`,
    [playerId, dateKey, now]
  );
  const row = await queryOne("SELECT * FROM rpg_daily_status WHERE player_id = ? AND date_key = ?", [playerId, dateKey]);
  const limits = buildRpgDailyLimits(row);
  return (await shouldBypassDailyLimits(uid)) ? applyRpgDailyTestBypass(limits) : limits;
}

async function consumeRpgDailyLimit(playerId, uid = "") {
  const dateKey = todayKeyTaipei();
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO rpg_daily_status (player_id, date_key, expedition_count, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(player_id, date_key) DO NOTHING`,
    [playerId, dateKey, now]
  );

  if (await shouldBypassDailyLimits(uid)) {
    return { ok: true, dailyLimits: await getRpgDailyLimitStatus(playerId, uid), testBypass: true };
  }

  const before = await queryOne("SELECT * FROM rpg_daily_status WHERE player_id = ? AND date_key = ?", [playerId, dateKey]);
  const current = buildRpgDailyLimits(before);
  if (current.expeditionRemaining <= 0) {
    return {
      ok: false,
      limitBlocked: true,
      reason: "RPG_TICKET_LIMIT",
      msg: `今日遠征券已用完（${current.expeditionUsed}/${current.expeditionLimit}），明天 00:00 後重置。`,
      dailyLimits: current
    };
  }

  const updated = await execute(
    `UPDATE rpg_daily_status
     SET expedition_count = expedition_count + 1,
         updated_at = ?
     WHERE player_id = ?
       AND date_key = ?
       AND expedition_count < ( ? + COALESCE(bonus_expedition_count, 0) )`,
    [now, playerId, dateKey, RPG_DAILY_TICKET_LIMIT]
  );

  if (Number(updated?.rowsAffected || 0) <= 0) {
    const latest = await getRpgDailyLimitStatus(playerId);
    return {
      ok: false,
      limitBlocked: true,
      reason: "RPG_LIMIT_RACE",
      msg: "今日遠征券已用完，請重新整理後再試。",
      dailyLimits: latest
    };
  }

  const afterRow = await queryOne("SELECT * FROM rpg_daily_status WHERE player_id = ? AND date_key = ?", [playerId, dateKey]);
  return { ok: true, dailyLimits: buildRpgDailyLimits(afterRow) };
}


function normalizeBattleChapterKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
function normalizeBattleMode(value) {
  const v = String(value || "").trim().toLowerCase();
  return ["normal", "hard", "event"].includes(v) ? v : "normal";
}
function battleModeLabel(mode) {
  const m = normalizeBattleMode(mode);
  if (m === "hard") return "困難";
  if (m === "event") return "活動";
  return "普通";
}
function normalizeUnlockType(value) {
  const v = String(value || "NONE").trim().toUpperCase();
  return ["NONE", "BATTLE_STAGE", "RPG_DUNGEON"].includes(v) ? v : "NONE";
}
function publicBattleChapter(row, fallbackIndex = 1) {
  const key = normalizeBattleChapterKey(row?.key || row?.chapter_key || `battle_${fallbackIndex}`) || `battle_${fallbackIndex}`;
  const mode = normalizeBattleMode(row?.mode || "normal");
  return {
    key,
    chapterKey: key,
    name: row?.name || row?.chapter_name || key,
    title: row?.name || row?.chapter_name || key,
    description: row?.description || row?.chapter_description || "",
    story: row?.description || row?.chapter_description || "",
    mode,
    modeLabel: row?.mode_label || battleModeLabel(mode),
    sortOrder: Number(row?.sort_order ?? row?.chapter_sort_order ?? fallbackIndex * 10),
    isActive: Number(row?.is_active ?? row?.chapter_active ?? 1) === 1,
    unlockType: normalizeUnlockType(row?.unlock_type || row?.chapter_unlock_type || "NONE"),
    unlockValue: String(row?.unlock_value ?? row?.chapter_unlock_value ?? "")
  };
}
async function getBattleChapterAdminRows(includeInactive = true) {
  const rows = await queryAll(
    `SELECT * FROM battle_chapters
     WHERE (? = 1 OR is_active = 1)
     ORDER BY sort_order ASC, name ASC, key ASC`,
    [includeInactive ? 1 : 0]
  );
  if (rows.length) return rows;
  return BATTLE_CHAPTERS.map((ch, idx) => ({
    key: ch.mode === "hard" ? `hard_${ch.chapterNo}` : `normal_${ch.chapterNo}`,
    name: ch.title,
    description: ch.story,
    mode: ch.mode,
    mode_label: ch.modeLabel,
    sort_order: (idx + 1) * 10,
    is_active: 1,
    unlock_type: ch.mode === "hard" ? "BATTLE_STAGE" : "NONE",
    unlock_value: ch.mode === "hard" ? String(ch.startStageId - 1) : ""
  }));
}
async function isBattleUnlockSatisfied(playerId, unlockType, unlockValue, currentStageId) {
  const type = normalizeUnlockType(unlockType);
  const raw = String(unlockValue || "").trim();
  if (type === "NONE" || !raw) return true;
  if (type === "BATTLE_STAGE") {
    const need = Math.max(0, Math.floor(Number(raw || 0)));
    if (!need) return true;
    if (Number(currentStageId || 1) > need) return true;
    const row = await queryOne("SELECT stage_id FROM battle_rewards WHERE player_id = ? AND stage_id = ? LIMIT 1", [playerId, need]);
    return !!row;
  }
  if (type === "RPG_DUNGEON") {
    const row = await queryOne("SELECT id FROM rpg_adventure_logs WHERE player_id = ? AND dungeon_key = ? AND result = 'WIN' LIMIT 1", [playerId, raw]);
    return !!row;
  }
  return true;
}

function publicBattleStage(row, unlockedMaxStageId, selectedStageId, rewardSet, chapterIndexMap = new Map()) {
  const stageId = Number(row.id || 0);
  const fallbackInfo = getBattleChapterInfo(stageId);
  const chapterKey = normalizeBattleChapterKey(row.chapter_key || row.chapterKey || (stageId <= 75 ? `normal_${Math.ceil(stageId / 25)}` : `hard_${Math.floor((stageId - 76) / 6) + 1}`));
  const chapterNo = chapterIndexMap.get(chapterKey) || fallbackInfo.chapterNo || 1;
  const mode = normalizeBattleMode(row.mode || fallbackInfo.mode || "normal");
  const modeLabel = row.mode_label || fallbackInfo.modeLabel || battleModeLabel(mode);
  const isHard = mode === "hard";
  const stageInChapter = Math.max(1, Number(row.stage_order || fallbackInfo.stageInChapter || 1));
  const rewardTimes = Number(row.reward_draw_times || 0);
  const cleared = rewardSet.has(stageId);
  const locked = stageId > unlockedMaxStageId || Number(row.is_active ?? 1) !== 1 || Number(row.chapter_active ?? 1) !== 1;
  return {
    id: stageId,
    stageId,
    chapterId: chapterNo,
    chapterKey,
    chapterTitle: row.chapter_name || fallbackInfo.chapterTitle,
    chapterStory: row.chapter_description || fallbackInfo.chapterStory,
    chapterNo,
    mode,
    modeLabel,
    isHard,
    stageInChapter,
    chapterStageLabel: isHard ? `困難 H${chapterNo}-${stageInChapter}` : (mode === "event" ? `活動 ${chapterNo}-${stageInChapter}` : `第 ${chapterNo} 章-${stageInChapter} 關`),
    stageName: row.stage_name || `第 ${stageId} 關`,
    bossCardName: row.boss_card_name || "未知角色",
    bossPower: Number(row.boss_power || 1000),
    bossImageUrl: row.boss_image_url || row.image_url || "",
    rewardTimes,
    unlockType: normalizeUnlockType(row.unlock_type || "NONE"),
    unlockValue: String(row.unlock_value || ""),
    cleared,
    claimed: cleared,
    locked,
    current: stageId === selectedStageId,
    nextUnlock: stageId === unlockedMaxStageId && !cleared
  };
}

async function getBattleStage(playerId, selectedStageIdInput = null) {
  const progress = await queryOne("SELECT current_stage_id FROM battle_progress WHERE player_id = ?", [playerId]);
  const currentStageId = Number(progress?.current_stage_id || 1);
  const allStages = await queryAll(
    `SELECT s.*, c.image_url AS boss_image_url,
            bc.key AS chapter_key,
            bc.name AS chapter_name,
            bc.description AS chapter_description,
            bc.mode AS mode,
            bc.mode_label AS mode_label,
            bc.sort_order AS chapter_sort_order,
            bc.is_active AS chapter_active,
            bc.unlock_type AS chapter_unlock_type,
            bc.unlock_value AS chapter_unlock_value
     FROM boss_stages s
     LEFT JOIN battle_chapters bc ON bc.key = COALESCE(NULLIF(s.chapter_key, ''), 'normal_1')
     LEFT JOIN cards c ON c.name = s.boss_card_name
     WHERE COALESCE(s.is_active, 1) = 1 AND COALESCE(bc.is_active, 1) = 1
     ORDER BY COALESCE(bc.sort_order, 999999) ASC, COALESCE(s.stage_order, s.id) ASC, s.id ASC`,
    []
  );
  const maxStageId = Math.max(0, ...allStages.map(r => Number(r.id || 0)));
  const isAllCleared = maxStageId > 0 && currentStageId > maxStageId;
  const unlockedMaxStageId = maxStageId > 0
    ? Math.min(maxStageId, Math.max(1, currentStageId))
    : 0;

  const requestedStageId = normalizeBattleStageIdInput(selectedStageIdInput, Math.min(currentStageId, Math.max(1, maxStageId || 1)));
  const selectedStageId = maxStageId > 0
    ? Math.max(1, Math.min(requestedStageId, unlockedMaxStageId || 1))
    : 1;

  const rewards = await queryAll("SELECT stage_id FROM battle_rewards WHERE player_id = ?", [playerId]);
  const rewardSet = new Set(rewards.map(r => Number(r.stage_id || 0)).filter(Boolean));
  const chapterKeys = [];
  allStages.forEach(row => {
    const key = normalizeBattleChapterKey(row.chapter_key || (Number(row.id || 0) <= 75 ? `normal_${Math.ceil(Number(row.id || 1) / 25)}` : `hard_${Math.floor((Number(row.id || 76) - 76) / 6) + 1}`));
    if (key && !chapterKeys.includes(key)) chapterKeys.push(key);
  });
  const chapterIndexMap = new Map(chapterKeys.map((key, idx) => [key, idx + 1]));
  const stageRows = allStages.map(row => publicBattleStage(row, unlockedMaxStageId, selectedStageId, rewardSet, chapterIndexMap));

  const chaptersMap = new Map();
  stageRows.forEach(stage => {
    const mapKey = stage.chapterKey || String(stage.chapterId);
    if (!chaptersMap.has(mapKey)) {
      chaptersMap.set(mapKey, {
        key: mapKey,
        chapterKey: mapKey,
        chapterId: stage.chapterId,
        chapterNo: stage.chapterNo,
        title: stage.chapterTitle,
        story: stage.chapterStory,
        mode: stage.mode,
        modeLabel: stage.modeLabel,
        isHard: stage.isHard,
        startStageId: stage.stageId,
        endStageId: stage.stageId,
        totalCount: 0,
        clearedCount: 0,
        unlockedCount: 0,
        locked: stage.locked,
        current: false,
        stages: []
      });
    }
    const chapter = chaptersMap.get(mapKey);
    chapter.stages.push(stage);
    chapter.totalCount += 1;
    if (stage.cleared) chapter.clearedCount += 1;
    if (!stage.locked) chapter.unlockedCount += 1;
    if (stage.current) chapter.current = true;
    if (!stage.locked) chapter.locked = false;
    chapter.endStageId = Math.max(chapter.endStageId, stage.stageId);
  });

  let stageData = {
    bossCardName: "未知角色",
    bossPower: 1000,
    bossImageUrl: "",
    stageName: "未知關卡",
    rewardTimes: 0,
    chapterId: 1,
    chapterKey: "normal_1",
    chapterTitle: "第一章｜初見秘寶閣",
    chapterStory: "初次接觸秘寶閣。",
    chapterNo: 1,
    mode: "normal",
    modeLabel: "普通",
    isHard: false,
    stageInChapter: 1,
    chapterStageLabel: "第 1 章-1 關"
  };

  const selected = stageRows.find(s => s.stageId === selectedStageId);
  if (selected) {
    stageData = {
      bossCardName: selected.bossCardName,
      bossPower: selected.bossPower,
      bossImageUrl: selected.bossImageUrl || "",
      stageName: selected.stageName,
      rewardTimes: selected.rewardTimes,
      chapterId: selected.chapterId,
      chapterKey: selected.chapterKey,
      chapterTitle: selected.chapterTitle,
      chapterStory: selected.chapterStory,
      chapterNo: selected.chapterNo,
      mode: selected.mode,
      modeLabel: selected.modeLabel,
      isHard: selected.isHard,
      stageInChapter: selected.stageInChapter,
      chapterStageLabel: selected.chapterStageLabel,
      cleared: selected.cleared,
      locked: selected.locked
    };
  }

  return {
    success: true,
    currentStageId,
    selectedStageId,
    unlockedMaxStageId,
    maxStageId,
    isAllCleared,
    hasRewardClaimed: selected ? !!selected.claimed : true,
    stageData,
    battleChapters: Array.from(chaptersMap.values()).sort((a, b) => a.chapterId - b.chapterId)
  };
}

async function getBattleDashboard(uid, selectedStageIdInput = null) {
  const player = await getOrCreatePlayer(uid);
  const stage = await getBattleStage(player.id, selectedStageIdInput);
  const battleOptions = await getOwnedCardBattleOptionsFast(player.id);
  const progress = await getBattleProgressRow(player.id);
  const repName = String(progress?.representative_card_name || "").trim();
  let battleRepresentative = repName ? battleOptions.find(c => c.name === repName) : null;

  if (repName && !battleRepresentative) {
    await execute(
      "UPDATE battle_progress SET representative_card_name = '', representative_power = 0, updated_at = ? WHERE player_id = ?",
      [new Date().toISOString(), player.id]
    );
  }

  const totalPower = battleOptions.reduce((sum, c) => sum + Number(c.power || 0), 0);
  const representativePower = battleRepresentative ? Number(battleRepresentative.power || 0) : 0;
  const maxStageId = Number(stage.maxStageId || 0);

  return {
    success: !!stage.success,
    ownedCardsMap: Object.fromEntries(battleOptions.map(c => [c.name, Number(c.count || 0)])),
    uniqueCount: battleOptions.length,
    totalPlayerPower: totalPower,
    playerPower: representativePower,
    battleRepresentative: battleRepresentative ? battleRepresentative.name : "",
    battleRepresentativePower: representativePower,
    battleOptions,
    currentStageId: stage.currentStageId,
    selectedStageId: stage.selectedStageId,
    unlockedMaxStageId: stage.unlockedMaxStageId,
    maxStageId,
    totalStages: maxStageId,
    normalStagesPerChapter: BATTLE_NORMAL_STAGES_PER_CHAPTER,
    hardStagesPerChapter: BATTLE_HARD_STAGES_PER_CHAPTER,
    normalMaxStageId: BATTLE_NORMAL_MAX_STAGE_ID,
    hardStartStageId: BATTLE_HARD_START_STAGE_ID,
    hardMaxStageId: BATTLE_HARD_MAX_STAGE_ID,
    dailyLimits: await getBattleDailyLimitStatus(player.id, uid),
    battleChapters: stage.battleChapters || [],
    isAllCleared: stage.isAllCleared,
    hasRewardClaimed: stage.hasRewardClaimed,
    stageData: stage.stageData,
    rewardRuleText: `潮流爭霸戰目前共 ${maxStageId} 關；普通模式 3 章 x 25 關，普通第 75 關通關後解鎖困難模式 3 章 x 6 關。已解鎖關卡可自由選擇重打，首通獎勵只會發放一次。`,
    msg: ""
  };
}

// === T-LO 戰鬥深化 V1：屬性 / 技能 / 暴擊 ===
const TLO_BATTLE_ELEMENTS = ["FIRE", "WATER", "WIND", "LIGHT", "DARK"];
const TLO_ELEMENT_INFO = {
  FIRE: { icon: "🔥", label: "火焰", color: "#ff6b3a" },
  WATER: { icon: "🌊", label: "潮汐", color: "#39c7ff" },
  WIND: { icon: "🍃", label: "疾風", color: "#67ff9a" },
  LIGHT: { icon: "✨", label: "星光", color: "#ffe66d" },
  DARK: { icon: "🌑", label: "暗影", color: "#bf7dff" }
};
const TLO_ELEMENT_ADVANTAGE = { FIRE: "WIND", WIND: "WATER", WATER: "FIRE", LIGHT: "DARK", DARK: "LIGHT" };
const TLO_ELEMENT_SKILLS = {
  FIRE: { name: "熾焰連擊", desc: "燃起潮流火花，造成高額爆發。", multiplier: 1.24 },
  WATER: { name: "潮汐護斬", desc: "以潮流節奏蓄力斬擊。", multiplier: 1.16 },
  WIND: { name: "疾風追擊", desc: "快速突進追加傷害。", multiplier: 1.20 },
  LIGHT: { name: "星光爆發", desc: "聚光登場，暴擊威力提升。", multiplier: 1.27 },
  DARK: { name: "暗影穿刺", desc: "穿透防線造成致命一擊。", multiplier: 1.22 }
};

function stableBattleHash(value) {
  const s = String(value || "TLO");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function normalizeBattleRarity(rarity) {
  return String(rarity || "NORMAL").toUpperCase();
}

function getCardBattleMeta(cardName, rarityInput) {
  const name = String(cardName || "T-LO角色").trim() || "T-LO角色";
  const rarity = normalizeBattleRarity(rarityInput);
  const element = TLO_BATTLE_ELEMENTS[stableBattleHash(name) % TLO_BATTLE_ELEMENTS.length];
  const info = TLO_ELEMENT_INFO[element] || TLO_ELEMENT_INFO.FIRE;
  const skill = TLO_ELEMENT_SKILLS[element] || TLO_ELEMENT_SKILLS.FIRE;
  const rarityBoost = rarity.indexOf("SUPER") >= 0 || rarity.indexOf("SSR") >= 0 ? 1.16 : (rarity.indexOf("RARE") >= 0 || rarity.indexOf("SR") >= 0 ? 1.08 : 1);
  return {
    name,
    rarity,
    element,
    elementIcon: info.icon,
    elementLabel: info.label,
    elementColor: info.color,
    skillName: skill.name,
    skillDesc: skill.desc,
    skillMultiplier: Number((skill.multiplier * rarityBoost).toFixed(3)),
    critBoost: rarityBoost
  };
}

function normalizeBattleFighter(raw, fallbackName, fallbackPower) {
  const source = raw || {};
  const name = String(source.name || source.cardName || source.bossName || fallbackName || "T-LO角色").trim() || "T-LO角色";
  const meta = getCardBattleMeta(name, source.rarity);
  const level = Math.max(1, Math.min(CARD_LEVEL_MAX, Number(source.level || 1)));
  const skillLevel = Math.max(1, Math.min(CARD_SKILL_MAX, Number(source.skillLevel || source.skill_level || 1)));
  const skillLevelBonus = 1 + (skillLevel - 1) * 0.035;
  return {
    ...meta,
    displayName: name,
    imageUrl: source.imageUrl || source.image_url || "",
    star: Number(source.star || 1),
    level,
    skillLevel,
    count: Number(source.count || 1),
    skillMultiplier: Number((meta.skillMultiplier * skillLevelBonus).toFixed(3)),
    critBoost: Number((meta.critBoost + (skillLevel - 1) * 0.012).toFixed(3)),
    power: Math.max(1, Number(source.power || fallbackPower || 1))
  };
}

function buildBattleTeam(teamInput, fallbackName, fallbackPower) {
  const arr = Array.isArray(teamInput) ? teamInput.filter(Boolean) : [];
  const list = arr.length ? arr : [{ name: fallbackName || "T-LO角色", power: fallbackPower || 1 }];
  return list.slice(0, 3).map((item, idx) => normalizeBattleFighter(item, fallbackName || `隊員${idx + 1}`, fallbackPower));
}


function fastBasePowerFromParts(rarityInput, countInput) {
  const rarity = String(rarityInput || "NORMAL").toUpperCase();
  const rule = POWER_RULES[rarity] || POWER_RULES.NORMAL;
  const count = Math.max(0, Number(countInput || 0));
  if (count <= 0) return 0;
  return Number(rule.base || 0) + Math.max(0, count - 1) * Number(rule.repeat || 0);
}

function fastStarPowerFromParts(rarityInput, countInput, starInput) {
  const base = fastBasePowerFromParts(rarityInput, countInput);
  const star = Math.max(1, Math.min(CARD_STAR_MAX, Number(starInput || 1)));
  return Math.round(base * (CARD_STAR_MULTIPLIERS[star] || 1));
}

function fastGrowthPowerFromParts(rarityInput, countInput, starInput, levelInput, skillLevelInput) {
  const starPower = fastStarPowerFromParts(rarityInput, countInput, starInput);
  const level = Math.max(1, Math.min(CARD_LEVEL_MAX, Number(levelInput || 1)));
  const skillLevel = Math.max(1, Math.min(CARD_SKILL_MAX, Number(skillLevelInput || 1)));
  return Math.round(starPower * getLevelMultiplier(level) * getSkillLevelMultiplier(skillLevel));
}


// Supabase 戰鬥流程加速：只讀取單張代表卡 / 遠征隊伍需要的角色，避免每場戰鬥都重算整包卡盒。
function buildBattleOptionFromDbRow(row) {
  const name = row.name || row.card_name;
  const count = Number(row.count || row.quantity || 0);
  const star = Math.max(1, Math.min(CARD_STAR_MAX, Number(row.star || 1)));
  const level = Math.max(1, Math.min(CARD_LEVEL_MAX, Number(row.level || 1)));
  const exp = Math.max(0, Number(row.exp || 0));
  const skillLevel = Math.max(1, Math.min(CARD_SKILL_MAX, Number(row.skill_level || row.skillLevel || 1)));
  const rarity = row.rarity || "NORMAL";
  const battleMeta = getCardBattleMeta(name, rarity);
  return {
    name,
    cardName: name,
    count,
    rarity,
    imageUrl: row.image_url || row.imageUrl || "",
    star,
    level,
    exp,
    expToNext: getCardLevelExpNeed(level),
    skillLevel,
    element: battleMeta.element,
    elementIcon: battleMeta.elementIcon,
    elementLabel: battleMeta.elementLabel,
    skillName: battleMeta.skillName,
    skillDesc: battleMeta.skillDesc,
    power: fastGrowthPowerFromParts(rarity, count, star, level, skillLevel),
    currentPower: fastGrowthPowerFromParts(rarity, count, star, level, skillLevel),
    starPower: fastStarPowerFromParts(rarity, count, star),
    basePower: fastStarPowerFromParts(rarity, count, 1)
  };
}

async function getBattleRepresentativeFast(playerId, progressRow = null) {
  const row = progressRow || await getBattleProgressRow(playerId);
  const cardName = String(row?.representative_card_name || "").trim();
  if (!cardName) return null;

  const cardRow = await queryOne(
    `SELECT
       pc.card_name AS name,
       pc.quantity AS count,
       c.rarity AS rarity,
       c.image_url AS image_url,
       COALESCE(cs.star, 1) AS star,
       COALESCE(cp.level, 1) AS level,
       COALESCE(cp.exp, 0) AS exp,
       COALESCE(cp.skill_level, 1) AS skill_level
     FROM player_collection pc
     JOIN cards c ON c.id = pc.card_id
     LEFT JOIN card_stars cs ON cs.player_id = pc.player_id AND cs.card_id = pc.card_id
     LEFT JOIN card_progression cp ON cp.player_id = pc.player_id AND cp.card_id = pc.card_id
     WHERE pc.player_id = ? AND pc.card_name = ? AND pc.quantity > 0
     LIMIT 1`,
    [playerId, cardName]
  );

  if (!cardRow) {
    await execute(
      "UPDATE battle_progress SET representative_card_name = '', representative_power = 0, updated_at = ? WHERE player_id = ?",
      [new Date().toISOString(), playerId]
    );
    return null;
  }

  const option = buildBattleOptionFromDbRow(cardRow);
  if (Number(row?.representative_power || 0) !== Number(option.power || 0)) {
    await execute(
      "UPDATE battle_progress SET representative_power = ?, updated_at = ? WHERE player_id = ?",
      [Number(option.power || 0), new Date().toISOString(), playerId]
    );
  }
  return option;
}

async function getRpgPartySnapshotFast(playerId) {
  const partyRow = await queryOne("SELECT * FROM rpg_party WHERE player_id = ?", [playerId]);
  const names = partyRow
    ? [partyRow.slot1_card_name, partyRow.slot2_card_name, partyRow.slot3_card_name].map(x => String(x || "").trim()).filter(Boolean)
    : [];

  if (!names.length) {
    const fallback = await getOwnedCardBattleOptionsFast(playerId, 3);
    return {
      party: fallback,
      partyNames: fallback.map(c => c.name),
      teamPower: fallback.reduce((sum, c) => sum + Number(c.power || 0), 0)
    };
  }

  const placeholders = names.map(() => "?").join(", ");
  const rows = await queryAll(
    `SELECT
       pc.card_name AS name,
       pc.quantity AS count,
       c.rarity AS rarity,
       c.image_url AS image_url,
       COALESCE(cs.star, 1) AS star,
       COALESCE(cp.level, 1) AS level,
       COALESCE(cp.exp, 0) AS exp,
       COALESCE(cp.skill_level, 1) AS skill_level
     FROM player_collection pc
     JOIN cards c ON c.id = pc.card_id
     LEFT JOIN card_stars cs ON cs.player_id = pc.player_id AND cs.card_id = pc.card_id
     LEFT JOIN card_progression cp ON cp.player_id = pc.player_id AND cp.card_id = pc.card_id
     WHERE pc.player_id = ? AND pc.card_name IN (${placeholders}) AND pc.quantity > 0`,
    [playerId, ...names]
  );

  const byName = new Map(rows.map(row => [String(row.name || ""), buildBattleOptionFromDbRow(row)]));
  const party = names.map(name => byName.get(name)).filter(Boolean);
  return {
    party,
    partyNames: party.map(c => c.name),
    teamPower: party.reduce((sum, c) => sum + Number(c.power || 0), 0)
  };
}

async function getOwnedCardBattleOptionsFast(playerId, limit = 9999) {
  const rows = await queryAll(
    `SELECT
       pc.card_name AS name,
       pc.quantity AS count,
       c.rarity AS rarity,
       c.image_url AS image_url,
       COALESCE(cs.star, 1) AS star,
       COALESCE(cp.level, 1) AS level,
       COALESCE(cp.exp, 0) AS exp,
       COALESCE(cp.skill_level, 1) AS skill_level
     FROM player_collection pc
     JOIN cards c ON c.id = pc.card_id
     LEFT JOIN card_stars cs ON cs.player_id = pc.player_id AND cs.card_id = pc.card_id
     LEFT JOIN card_progression cp ON cp.player_id = pc.player_id AND cp.card_id = pc.card_id
     WHERE pc.player_id = ? AND pc.quantity > 0`,
    [playerId]
  );

  const cards = rows.map(row => {
    const name = row.name;
    const count = Number(row.count || 0);
    const star = Math.max(1, Math.min(CARD_STAR_MAX, Number(row.star || 1)));
    const level = Math.max(1, Math.min(CARD_LEVEL_MAX, Number(row.level || 1)));
    const exp = Math.max(0, Number(row.exp || 0));
    const skillLevel = Math.max(1, Math.min(CARD_SKILL_MAX, Number(row.skill_level || 1)));
    const rarity = row.rarity || "NORMAL";
    const battleMeta = getCardBattleMeta(name, rarity);
    return {
      name,
      cardName: name,
      count,
      rarity,
      imageUrl: row.image_url || "",
      star,
      level,
      exp,
      expToNext: getCardLevelExpNeed(level),
      skillLevel,
      element: battleMeta.element,
      elementIcon: battleMeta.elementIcon,
      elementLabel: battleMeta.elementLabel,
      skillName: battleMeta.skillName,
      skillDesc: battleMeta.skillDesc,
      power: fastGrowthPowerFromParts(rarity, count, star, level, skillLevel),
      currentPower: fastGrowthPowerFromParts(rarity, count, star, level, skillLevel),
      starPower: fastStarPowerFromParts(rarity, count, star),
      basePower: fastStarPowerFromParts(rarity, count, 1)
    };
  });

  cards.sort((a, b) => {
    if (Number(b.power || 0) !== Number(a.power || 0)) return Number(b.power || 0) - Number(a.power || 0);
    if (Number(b.star || 0) !== Number(a.star || 0)) return Number(b.star || 0) - Number(a.star || 0);
    if (Number(b.level || 0) !== Number(a.level || 0)) return Number(b.level || 0) - Number(a.level || 0);
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return cards.slice(0, Math.max(0, Number(limit || 9999)));
}

async function buildTopBattleTeam(playerId, limit = 3) {
  return getOwnedCardBattleOptionsFast(playerId, limit);
}

async function buildOwnedBattleOptions(playerId) {
  return getOwnedCardBattleOptionsFast(playerId, 9999);
}

async function getBattleProgressRow(playerId) {
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO battle_progress (player_id, current_stage_id, representative_card_name, representative_power, updated_at)
     VALUES (?, 1, '', 0, ?)
     ON CONFLICT(player_id) DO NOTHING`,
    [playerId, now]
  );
  return queryOne("SELECT * FROM battle_progress WHERE player_id = ?", [playerId]);
}

async function getBattleRepresentative(playerId) {
  const row = await getBattleProgressRow(playerId);
  const cardName = String(row?.representative_card_name || "").trim();
  if (!cardName) return null;

  const owned = await getOwnedCardsMap(playerId);
  const count = Number(owned[cardName] || 0);
  if (count <= 0) {
    await execute(
      "UPDATE battle_progress SET representative_card_name = '', representative_power = 0, updated_at = ? WHERE player_id = ?",
      [new Date().toISOString(), playerId]
    );
    return null;
  }

  const stars = await getStarMap(playerId);
  const progress = await getCardProgressMap(playerId);
  const card = await queryOne("SELECT rarity, image_url FROM cards WHERE name = ? LIMIT 1", [cardName]);
  const prog = progress[cardName] || { level: 1, exp: 0, skillLevel: 1 };
  const star = Number(stars[cardName] || 1);
  const power = await calculateSingleCardPowerWithGrowth(playerId, cardName, count, star);

  if (Number(row?.representative_power || 0) !== power) {
    await execute(
      "UPDATE battle_progress SET representative_power = ?, updated_at = ? WHERE player_id = ?",
      [power, new Date().toISOString(), playerId]
    );
  }

  return {
    name: cardName,
    cardName,
    count,
    star,
    level: prog.level,
    exp: prog.exp,
    skillLevel: prog.skillLevel,
    rarity: card?.rarity || "NORMAL",
    imageUrl: card?.image_url || "",
    power
  };
}

async function setBattleRepresentative(uid, cardNameInput) {
  const player = await getOrCreatePlayer(uid);
  const cardName = String(cardNameInput || "").trim();
  if (!cardName) return { success: false, msg: "請先選擇潮流爭霸戰代表角色。", dashboard: await getBattleDashboard(uid) };

  const owned = await getOwnedCardsMap(player.id);
  const count = Number(owned[cardName] || 0);
  if (count <= 0) return { success: false, msg: "你尚未持有這張角色，不能設定為爭霸代表。", dashboard: await getBattleDashboard(uid) };

  const stars = await getStarMap(player.id);
  const power = await calculateSingleCardPowerWithGrowth(player.id, cardName, count, Number(stars[cardName] || 1));
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO battle_progress (player_id, current_stage_id, representative_card_name, representative_power, updated_at)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET
       representative_card_name = excluded.representative_card_name,
       representative_power = excluded.representative_power,
       updated_at = excluded.updated_at`,
    [player.id, cardName, power, now]
  );
  return { success: true, msg: `潮流爭霸戰代表已固定為「${cardName}」。`, dashboard: await getBattleDashboard(uid) };
}

async function refreshBattleRepresentativePowerIfNeeded(playerId, cardName) {
  const row = await getBattleProgressRow(playerId);
  if (!row || String(row.representative_card_name || "") !== String(cardName || "")) return;
  const owned = await getOwnedCardsMap(playerId);
  const stars = await getStarMap(playerId);
  const count = Number(owned[cardName] || 0);
  if (count <= 0) return;
  const newPower = await calculateSingleCardPowerWithGrowth(playerId, cardName, count, stars[cardName] || 1);
  await execute("UPDATE battle_progress SET representative_power = ?, updated_at = ? WHERE player_id = ?", [newPower, new Date().toISOString(), playerId]);
}

async function getOrCreateCardProgression(playerId, cardName) {
  const cleanCard = String(cardName || "").trim();
  if (!cleanCard) return null;
  const card = await queryOne("SELECT id, name FROM cards WHERE name = ? LIMIT 1", [cleanCard]);
  if (!card) return null;
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO card_progression (player_id, card_id, card_name, level, exp, skill_level, updated_at)
     VALUES (?, ?, ?, 1, 0, 1, ?)
     ON CONFLICT(player_id, card_id) DO NOTHING`,
    [playerId, card.id, card.name, now]
  );
  return queryOne("SELECT * FROM card_progression WHERE player_id = ? AND card_id = ?", [playerId, card.id]);
}

function normalizeGrowthRow(row) {
  const level = Math.max(1, Math.min(CARD_LEVEL_MAX, Number(row?.level || 1)));
  const exp = Math.max(0, Number(row?.exp || 0));
  const skillLevel = Math.max(1, Math.min(CARD_SKILL_MAX, Number(row?.skill_level || row?.skillLevel || 1)));
  return { level, exp, skillLevel };
}

function normalizeItemKey(value) {
  const key = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return TLO_ITEM_DEFS[key] ? key : key;
}

function getItemDef(itemKey) {
  const key = normalizeItemKey(itemKey);
  return TLO_ITEM_DEFS[key] || { name: key || "未知道具", desc: "玩家道具" };
}

async function ensureResetItemSchema() {
  if (RESET_ITEM_SCHEMA_READY) return;
  await execute(`CREATE TABLE IF NOT EXISTS player_items (
    player_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (player_id, item_key),
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS card_reset_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    uid TEXT,
    card_id TEXT NOT NULL,
    card_name TEXT NOT NULL,
    old_star INTEGER NOT NULL DEFAULT 1,
    old_skill_level INTEGER NOT NULL DEFAULT 1,
    refunded_energy INTEGER NOT NULL DEFAULT 0,
    refunded_skill_exp INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (player_id) REFERENCES players(id),
    FOREIGN KEY (card_id) REFERENCES cards(id)
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_player_items_player_key ON player_items(player_id, item_key)");
  await execute("CREATE INDEX IF NOT EXISTS idx_card_reset_logs_player_created ON card_reset_logs(player_id, created_at)");
  RESET_ITEM_SCHEMA_READY = true;
}

async function getPlayerItemQuantity(playerId, itemKey) {
  await ensureResetItemSchema();
  const key = normalizeItemKey(itemKey);
  const row = await queryOne("SELECT quantity FROM player_items WHERE player_id = ? AND item_key = ?", [playerId, key]);
  return Math.max(0, Number(row?.quantity || 0));
}

async function addPlayerItem(playerId, itemKey, amountInput, sourceLabel = "道具發放") {
  await ensureResetItemSchema();
  const key = normalizeItemKey(itemKey);
  if (!key) throw new Error("道具代碼錯誤。");
  const amount = Math.max(0, Math.floor(Number(amountInput || 0)));
  if (amount <= 0) return `${getItemDef(key).name} +0`;
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO player_items (player_id, item_key, quantity, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(player_id, item_key)
     DO UPDATE SET quantity = player_items.quantity + excluded.quantity, updated_at = excluded.updated_at`,
    [playerId, key, amount, now]
  );
  await insertTrainingLog(playerId, sourceLabel, 0, 0, `${sourceLabel}：${getItemDef(key).name} +${amount}`, now);
  return `${getItemDef(key).name} +${amount}`;
}

function calculateStarResetRefund(oldStarInput) {
  const oldStar = Math.max(1, Math.min(CARD_STAR_MAX, Number(oldStarInput || 1)));
  let total = 0;
  for (let star = 2; star <= oldStar; star++) total += Number(CARD_STAR_COSTS[star] || 0);
  return total;
}

function calculateSkillResetRefund(oldSkillLevelInput) {
  const oldSkill = Math.max(1, Math.min(CARD_SKILL_MAX, Number(oldSkillLevelInput || 1)));
  let total = 0;
  for (let lv = 1; lv < oldSkill; lv++) total += Number(getSkillUpgradeEnergyCost(lv) || 0);
  return total;
}

async function getResetTicketDashboardPart(playerId) {
  await ensureResetItemSchema();
  return {
    cardResetTicket: await getPlayerItemQuantity(playerId, ITEM_CARD_RESET_TICKET)
  };
}

async function addCharacterExp(playerId, cardNames, expAmount, sourceLabel = "戰鬥經驗") {
  const amount = Math.max(0, Math.floor(Number(expAmount || 0)));
  const uniqueNames = Array.from(new Set((cardNames || []).map(n => String(n || "").trim()).filter(Boolean)));
  if (!amount || !uniqueNames.length) return [];
  const now = new Date().toISOString();
  const results = [];
  for (const name of uniqueNames) {
    const row = await getOrCreateCardProgression(playerId, name);
    if (!row) continue;
    let level = Math.max(1, Math.min(CARD_LEVEL_MAX, Number(row.level || 1)));
    let exp = Math.max(0, Number(row.exp || 0)) + amount;
    let leveled = 0;
    while (level < CARD_LEVEL_MAX) {
      const need = getCardLevelExpNeed(level);
      if (!need || exp < need) break;
      exp -= need;
      level += 1;
      leveled += 1;
    }
    if (level >= CARD_LEVEL_MAX) exp = 0;
    await execute("UPDATE card_progression SET level = ?, exp = ?, updated_at = ? WHERE player_id = ? AND card_name = ?", [level, exp, now, playerId, name]);
    const note = leveled > 0 ? `${name} +${amount} EXP，升到 Lv.${level}` : `${name} +${amount} EXP`;
    await insertTrainingLog(playerId, sourceLabel, 0, 0, note, now);
    results.push({ name, expAdded: amount, level, exp, leveled });
  }
  return results;
}

async function refreshPvpRepresentativePowerIfNeeded(playerId, cardName) {
  const pvp = await getOrCreatePvpPlayer(playerId);
  if (!pvp || pvp.representative_card_name !== cardName) return;
  const owned = await getOwnedCardsMap(playerId);
  const stars = await getStarMap(playerId);
  const count = Number(owned[cardName] || 0);
  if (count <= 0) return;
  const newPower = await calculateSingleCardPowerWithGrowth(playerId, cardName, count, stars[cardName] || 1);
  await execute("UPDATE pvp_players SET representative_power = ?, updated_at = ? WHERE player_id = ?", [newPower, new Date().toISOString(), playerId]);
}

function pickBattleFighter(team, turnIndex) {
  if (!team || !team.length) return normalizeBattleFighter({}, "玩家軍團", 1);
  return team[(Math.max(0, Number(turnIndex || 1)) - 1) % team.length];
}

function getElementMultiplier(attackerElement, defenderElement) {
  if (!attackerElement || !defenderElement || attackerElement === defenderElement) return { multiplier: 1, label: "", type: "neutral" };
  if (TLO_ELEMENT_ADVANTAGE[attackerElement] === defenderElement) return { multiplier: 1.16, label: "屬性克制", type: "advantage" };
  if (TLO_ELEMENT_ADVANTAGE[defenderElement] === attackerElement) return { multiplier: 0.88, label: "屬性受制", type: "disadvantage" };
  return { multiplier: 1, label: "", type: "neutral" };
}

function makeBattleTurnText({ round, actor, fighter, target, damage, isSkill, isCritical, elementResult }) {
  const actorLabel = actor === "player" ? "我方" : "敵方";
  const action = isSkill ? `施展「${fighter.skillName}」` : "發動攻擊";
  const critText = isCritical ? "｜暴擊" : "";
  const elementText = elementResult && elementResult.label ? `｜${elementResult.label}` : "";
  return `第 ${round} 回合：${actorLabel}【${fighter.displayName}】${fighter.elementIcon}${action}${critText}${elementText}，${target.displayName} 受到 ${damage.toLocaleString()} 傷害！`;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function makeTurnBattleAnimation({ playerPower, bossPower, bossName, stageName, win, playerTeam, enemyTeam, playerLabel, enemyLabel }) {
  const pPower = Math.max(1, Number(playerPower || 1));
  const bPower = Math.max(1, Number(bossPower || 1));
  const pTeam = buildBattleTeam(playerTeam, playerLabel || "玩家軍團", pPower);
  const eTeam = buildBattleTeam(enemyTeam, bossName || enemyLabel || "守關 Boss", bPower);
  const playerMaxHp = Math.round(clampNumber(2400 + pPower * 0.31, 1900, 99999));
  const bossMaxHp = Math.round(clampNumber(2400 + bPower * 0.36, 1900, 99999));
  let playerHp = playerMaxHp;
  let bossHp = bossMaxHp;
  const turns = [];
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const playerBase = Math.max(170, Math.round((pPower / Math.max(1, bPower)) * bossMaxHp * 0.155));
  const bossBase = Math.max(150, Math.round((bPower / Math.max(1, pPower)) * playerMaxHp * 0.142));
  const maxRounds = win ? 8 : 7;

  for (let round = 1; round <= maxRounds; round++) {
    const attacker = pickBattleFighter(pTeam, round);
    const defender = pickBattleFighter(eTeam, round);
    const elem = getElementMultiplier(attacker.element, defender.element);
    const skillChance = Math.min(0.42, 0.22 + (attacker.critBoost - 1) * 0.26 + (elem.type === "advantage" ? 0.05 : 0));
    const critChance = Math.min(0.36, 0.12 + (attacker.critBoost - 1) * 0.20 + (elem.type === "advantage" ? 0.04 : 0));
    const isSkill = Math.random() < skillChance;
    const isCritical = Math.random() < critChance || (attacker.element === "LIGHT" && isSkill && Math.random() < 0.28);
    let multiplier = (0.84 + Math.random() * 0.34) * elem.multiplier;
    if (isSkill) multiplier *= attacker.skillMultiplier;
    if (isCritical) multiplier *= 1.55;
    let playerDamage = Math.max(80, Math.round(playerBase * multiplier) + rand(0, 75));

    if (win && round >= 3 && bossHp - playerDamage <= bossMaxHp * 0.18) playerDamage = bossHp;
    if (!win && round >= 3 && bossHp - playerDamage <= bossMaxHp * 0.22) {
      playerDamage = Math.max(60, Math.min(playerDamage, Math.max(1, bossHp - Math.ceil(bossMaxHp * 0.20))));
    }
    bossHp = Math.max(0, bossHp - playerDamage);
    turns.push({
      round,
      actor: "player",
      fighterName: attacker.displayName,
      targetName: defender.displayName,
      element: attacker.element,
      elementIcon: attacker.elementIcon,
      elementLabel: attacker.elementLabel,
      elementColor: attacker.elementColor,
      targetElement: defender.element,
      targetElementLabel: defender.elementLabel,
      elementResult: elem.label,
      elementResultType: elem.type,
      isSkill,
      skillName: isSkill ? attacker.skillName : "",
      isCritical,
      damage: playerDamage,
      playerHpAfter: playerHp,
      bossHpAfter: bossHp,
      text: makeBattleTurnText({ round, actor: "player", fighter: attacker, target: defender, damage: playerDamage, isSkill, isCritical, elementResult: elem })
    });
    if (bossHp <= 0) break;

    const bossAttacker = pickBattleFighter(eTeam, round);
    const bossDefender = pickBattleFighter(pTeam, round);
    const bossElem = getElementMultiplier(bossAttacker.element, bossDefender.element);
    const bossSkillChance = Math.min(0.36, 0.18 + (bossAttacker.critBoost - 1) * 0.18 + (bossElem.type === "advantage" ? 0.04 : 0));
    const bossCritChance = Math.min(0.30, 0.10 + (bossAttacker.critBoost - 1) * 0.16 + (bossElem.type === "advantage" ? 0.03 : 0));
    const bossIsSkill = Math.random() < bossSkillChance;
    const bossIsCritical = Math.random() < bossCritChance || (bossAttacker.element === "DARK" && bossIsSkill && Math.random() < 0.22);
    let bossMultiplier = (0.84 + Math.random() * 0.36) * bossElem.multiplier;
    if (bossIsSkill) bossMultiplier *= bossAttacker.skillMultiplier;
    if (bossIsCritical) bossMultiplier *= 1.48;
    let bossDamage = Math.max(70, Math.round(bossBase * bossMultiplier) + rand(0, 70));

    if (!win && round >= 3 && playerHp - bossDamage <= playerMaxHp * 0.2) bossDamage = playerHp;
    if (win && round >= 3 && playerHp - bossDamage <= playerMaxHp * 0.22) {
      bossDamage = Math.max(50, Math.min(bossDamage, Math.max(1, playerHp - Math.ceil(playerMaxHp * 0.20))));
    }
    playerHp = Math.max(0, playerHp - bossDamage);
    turns.push({
      round,
      actor: "boss",
      fighterName: bossAttacker.displayName,
      targetName: bossDefender.displayName,
      element: bossAttacker.element,
      elementIcon: bossAttacker.elementIcon,
      elementLabel: bossAttacker.elementLabel,
      elementColor: bossAttacker.elementColor,
      targetElement: bossDefender.element,
      targetElementLabel: bossDefender.elementLabel,
      elementResult: bossElem.label,
      elementResultType: bossElem.type,
      isSkill: bossIsSkill,
      skillName: bossIsSkill ? bossAttacker.skillName : "",
      isCritical: bossIsCritical,
      damage: bossDamage,
      playerHpAfter: playerHp,
      bossHpAfter: bossHp,
      text: makeBattleTurnText({ round, actor: "boss", fighter: bossAttacker, target: bossDefender, damage: bossDamage, isSkill: bossIsSkill, isCritical: bossIsCritical, elementResult: bossElem })
    });
    if (playerHp <= 0) break;
  }

  if (win && bossHp > 0) {
    const round = maxRounds + 1;
    const attacker = pickBattleFighter(pTeam, round);
    const defender = pickBattleFighter(eTeam, round);
    const finalDamage = bossHp;
    bossHp = 0;
    turns.push({
      round,
      actor: "player",
      fighterName: attacker.displayName,
      targetName: defender.displayName,
      element: attacker.element,
      elementIcon: attacker.elementIcon,
      elementLabel: attacker.elementLabel,
      elementColor: attacker.elementColor,
      elementResult: "終結一擊",
      elementResultType: "finish",
      isSkill: true,
      skillName: attacker.skillName,
      isCritical: true,
      damage: finalDamage,
      playerHpAfter: playerHp,
      bossHpAfter: bossHp,
      text: `終結一擊：${attacker.displayName}${attacker.elementIcon}施展「${attacker.skillName}」，擊破 ${defender.displayName}！`
    });
  }
  if (!win && playerHp > 0) {
    const round = maxRounds + 1;
    const attacker = pickBattleFighter(eTeam, round);
    const defender = pickBattleFighter(pTeam, round);
    const finalDamage = playerHp;
    playerHp = 0;
    turns.push({
      round,
      actor: "boss",
      fighterName: attacker.displayName,
      targetName: defender.displayName,
      element: attacker.element,
      elementIcon: attacker.elementIcon,
      elementLabel: attacker.elementLabel,
      elementColor: attacker.elementColor,
      elementResult: "終結反擊",
      elementResultType: "finish",
      isSkill: true,
      skillName: attacker.skillName,
      isCritical: true,
      damage: finalDamage,
      playerHpAfter: playerHp,
      bossHpAfter: bossHp,
      text: `終結反擊：${attacker.displayName}${attacker.elementIcon}施展「${attacker.skillName}」，擊退 ${defender.displayName}！`
    });
  }

  return {
    mode: "SKILL_CRIT_ELEMENT_V1",
    stageName: stageName || "T-LO 潮流爭霸戰",
    bossName: bossName || enemyLabel || "守關 Boss",
    playerLabel: playerLabel || "玩家軍團",
    enemyLabel: enemyLabel || bossName || "敵方",
    win: !!win,
    playerMaxHp,
    bossMaxHp,
    playerFinalHp: playerHp,
    bossFinalHp: bossHp,
    playerTeam: pTeam,
    enemyTeam: eTeam,
    turns
  };
}

async function executeBattle(uid, selectedStageIdInput = null) {
  const player = await getOrCreatePlayer(uid);
  const now = new Date().toISOString();

  // Supabase 戰鬥流程加速：交易外先讀必要資料，交易內只做進度/獎勵/紀錄寫入。
  const progress = await getBattleProgressRow(player.id);
  const currentStageId = Number(progress?.current_stage_id || 1);
  const maxRow = await queryOne("SELECT MAX(s.id) AS max_id FROM boss_stages s LEFT JOIN battle_chapters bc ON bc.key = s.chapter_key WHERE COALESCE(s.is_active,1)=1 AND COALESCE(bc.is_active,1)=1", []);
  const maxStageId = Number(maxRow?.max_id || 0);
  if (!maxStageId) {
    return { success: false, msg: "目前尚未建立爭霸戰關卡，請 GM 先設定關卡。" };
  }

  const isAllCleared = currentStageId > maxStageId;
  const unlockedMaxStageId = Math.min(maxStageId, Math.max(1, currentStageId));
  const currentStageIdToFight = normalizeBattleStageIdInput(selectedStageIdInput, unlockedMaxStageId);

  if (currentStageIdToFight > unlockedMaxStageId) {
    return {
      success: false,
      msg: `此關卡尚未解鎖。目前最高可挑戰第 ${unlockedMaxStageId} 關。`,
      currentStageId,
      selectedStageId: currentStageIdToFight,
      unlockedMaxStageId,
      maxStageId,
      isAllCleared,
      dashboard: await getBattleDashboard(uid, unlockedMaxStageId)
    };
  }

  const stageRow = await queryOne("SELECT s.*, bc.is_active AS chapter_active FROM boss_stages s LEFT JOIN battle_chapters bc ON bc.key = s.chapter_key WHERE s.id = ? AND COALESCE(s.is_active,1)=1 AND COALESCE(bc.is_active,1)=1", [currentStageIdToFight]);
  if (!stageRow) {
    return { success: false, msg: "找不到目前爭霸戰關卡，請稍後再試。" };
  }

  const stage = {
    bossCardName: stageRow.boss_card_name,
    bossPower: Number(stageRow.boss_power || 1000),
    stageName: stageRow.stage_name || `第 ${currentStageIdToFight} 關`,
    rewardTimes: Number(stageRow.reward_draw_times || 0)
  };

  const representative = await getBattleRepresentativeFast(player.id, progress);
  if (!representative) {
    return {
      success: false,
      msg: "請先固定一張潮流爭霸戰代表卡。爭霸戰只會由這張代表出戰並獲得經驗。",
      dashboard: await getBattleDashboard(uid)
    };
  }

  const serverPlayerPower = Number(representative.power || 0);
  const playerTeam = [representative];
  const bossCard = await queryOne("SELECT rarity, image_url FROM cards WHERE name = ? LIMIT 1", [stage.bossCardName]);
  const enemyTeam = [{
    name: stage.bossCardName,
    rarity: bossCard?.rarity || "BOSS",
    imageUrl: bossCard?.image_url || "",
    power: stage.bossPower
  }];

  const preExistingReward = await queryOne("SELECT stage_id FROM battle_rewards WHERE player_id = ? AND stage_id = ?", [player.id, currentStageIdToFight]);
  const willWin = serverPlayerPower >= stage.bossPower;
  const willFirstClear = willWin && !preExistingReward;

  return withTransaction(async () => {
    const limitResult = await consumeBattleDailyLimit(player.id, currentStageIdToFight, willFirstClear, uid);
    if (!limitResult.ok) {
      return {
        success: false,
        limitBlocked: true,
        msg: limitResult.msg,
        currentStageId,
        selectedStageId: currentStageIdToFight,
        unlockedMaxStageId,
        maxStageId,
        dailyLimits: limitResult.dailyLimits,
        dashboard: await getBattleDashboard(uid, currentStageIdToFight)
      };
    }

    if (serverPlayerPower < stage.bossPower) {
      await execute(
        `INSERT INTO battle_progress (player_id, current_stage_id, representative_card_name, representative_power, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET representative_card_name = excluded.representative_card_name, representative_power = excluded.representative_power, updated_at = excluded.updated_at`,
        [player.id, currentStageId, representative.name, serverPlayerPower, now]
      );
      const growthRewards = await addCharacterExp(player.id, [representative.name], 35, "潮流爭霸戰經驗");
      return {
        success: false,
        isReset: false,
        growthRewards,
        msg: `💥 代表卡【${representative.name}】戰力不敵【${stage.bossCardName}】的猛烈阻擊！挑戰失敗，但 RPG 章節進度不會重置。`,
        serverPlayerPower,
        currentStageId,
        selectedStageId: currentStageIdToFight,
        unlockedMaxStageId,
        maxStageId,
        dailyLimits: limitResult.dailyLimits,
        dashboard: await getBattleDashboard(uid, currentStageIdToFight),
        battleAnimation: makeTurnBattleAnimation({
          playerPower: serverPlayerPower,
          bossPower: stage.bossPower,
          bossName: stage.bossCardName,
          stageName: stage.stageName,
          win: false,
          playerTeam,
          enemyTeam,
          playerLabel: representative.name,
          enemyLabel: stage.bossCardName
        })
      };
    }

    const nextStageId = currentStageIdToFight >= currentStageId ? currentStageIdToFight + 1 : currentStageId;
    await execute(
      `INSERT INTO battle_progress (player_id, current_stage_id, representative_card_name, representative_power, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET current_stage_id = excluded.current_stage_id, representative_card_name = excluded.representative_card_name, representative_power = excluded.representative_power, updated_at = excluded.updated_at`,
      [player.id, nextStageId, representative.name, serverPlayerPower, now]
    );

    const reward = preExistingReward;
    let currentTimes = null;
    let rewardTxt = "";
    let returnMessage = "";

    if (!reward) {
      await execute("INSERT OR IGNORE INTO battle_rewards (player_id, stage_id, claimed_at) VALUES (?, ?, ?)", [player.id, currentStageIdToFight, now]);
      if (Number(stage.rewardTimes || 0) > 0) {
        const updatedAsset = await queryOne(
          `UPDATE player_assets
           SET draw_times = draw_times + ?, updated_at = ?
           WHERE player_id = ?
           RETURNING draw_times`,
          [Number(stage.rewardTimes || 0), now, player.id]
        );
        currentTimes = Number(updatedAsset?.draw_times || 0);
        await execute(
          `INSERT INTO gacha_logs (player_id, card_id, card_name, source, note, created_at)
           VALUES (?, NULL, ?, ?, ?, ?)`,
          [player.id, "關卡獎勵", `通關: ${stage.stageName}`, `首通獎勵: +${stage.rewardTimes}`, now]
        );
        rewardTxt = `第 ${currentStageIdToFight} 關突破獎勵！抽卡次數 +${stage.rewardTimes} 次！`;
      } else {
        const asset = await getAssets(player.id);
        currentTimes = Number(asset.draw_times || 0);
        rewardTxt = "通關成功！此關為進度關，首通獎勵依 GM 關卡設定發放。";
      }
      returnMessage = `🎉 代表卡【${representative.name}】成功擊敗【${stage.stageName}】！`;
    } else {
      const asset = await getAssets(player.id);
      currentTimes = Number(asset.draw_times || 0);
      rewardTxt = Number(stage.rewardTimes || 0) > 0 ? "⚠️ 此關首通抽卡獎勵已領取，不再重複累加。" : "⚠️ 此關已通過，沒有可重複領取的抽卡獎勵。";
      returnMessage = `🎉 再次成功突破【${stage.stageName}】！`;
    }

    const growthRewards = await addCharacterExp(player.id, [representative.name], 100 + currentStageIdToFight * 8, "潮流爭霸戰經驗");
    return {
      success: true,
      growthRewards,
      msg: returnMessage,
      rewardText: rewardTxt,
      nextStageId,
      currentStageId,
      selectedStageId: currentStageIdToFight,
      unlockedMaxStageId,
      maxStageId,
      dailyLimits: limitResult.dailyLimits,
      newTimesLeft: currentTimes,
      serverPlayerPower,
      representativeCard: representative.name,
      battleAnimation: makeTurnBattleAnimation({
        playerPower: serverPlayerPower,
        bossPower: stage.bossPower,
        bossName: stage.bossCardName,
        stageName: stage.stageName,
        win: true,
        playerTeam,
        enemyTeam,
        playerLabel: representative.name,
        enemyLabel: stage.bossCardName
      })
    };
  });
}

async function getTrainingProfile(playerId) {
  const today = todayKeyTaipei();
  let profile = await queryOne("SELECT * FROM training_profiles WHERE player_id = ?", [playerId]);
  const now = new Date().toISOString();

  if (!profile) {
    await execute(
      `INSERT INTO training_profiles (player_id, energy, total_score, streak, daily_key, title, updated_at)
       VALUES (?, 0, 0, 0, ?, '潮流新人', ?)`,
      [playerId, today, now]
    );
    profile = await queryOne("SELECT * FROM training_profiles WHERE player_id = ?", [playerId]);
  }

  if (String(profile.daily_key || "") !== today) {
    await execute(
      `UPDATE training_profiles
       SET daily_key = ?, memory_plays_today = 0, quiz_done_today = 0, updated_at = ?
       WHERE player_id = ?`,
      [today, now, playerId]
    );
    profile = await queryOne("SELECT * FROM training_profiles WHERE player_id = ?", [playerId]);
  }

  return profile;
}

function publicFreeProfile(profile) {
  const today = todayKeyTaipei();
  return {
    energy: Number(profile.energy || 0),
    totalScore: Number(profile.total_score || 0),
    streak: Number(profile.streak || 0),
    title: profile.title || "潮流新人",
    skillExp: Number(profile.skill_exp || 0),
    checkedInToday: String(profile.last_checkin_date || "") === today,
    memoryPlaysLeft: Math.max(0, FREE_DAILY_MEMORY_LIMIT - Number(profile.memory_plays_today || 0)),
    dailyMemoryLimit: FREE_DAILY_MEMORY_LIMIT
  };
}

async function getTrainingLeaderboard() {
  const rows = await queryAll(
    `SELECT p.uid, t.total_score, t.energy, t.streak, t.title
     FROM training_profiles t
     JOIN players p ON p.id = t.player_id
     ORDER BY t.total_score DESC, t.energy DESC
     LIMIT 10`,
    []
  );
  return rows.map((row, i) => {
    const totalScore = Number(row.total_score || 0);
    return {
      rank: i + 1,
      uid: row.uid,
      totalScore,
      score: totalScore,
      energy: Number(row.energy || 0),
      streak: Number(row.streak || 0),
      title: row.title || "潮流新人"
    };
  });
}


async function insertTrainingLog(playerId, type, score = 0, energy = 0, note = "", createdAt = new Date().toISOString()) {
  // Supabase / Postgres 版 training_logs 有 date_key 欄位。
  // 統一由這裡寫入，避免部分功能在 Supabase 因欄位相容性失敗，造成前端只顯示「系統繁忙」。
  await execute(
    "INSERT INTO training_logs (player_id, date_key, type, score, energy, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      playerId,
      todayKeyTaipei(),
      String(type || ""),
      Math.trunc(Number(score || 0)),
      Math.trunc(Number(energy || 0)),
      String(note || ""),
      createdAt || new Date().toISOString()
    ]
  );
}

function dailyQuiz() {
  const bank = [
    { q: "T-LO 遊戲中，升星主要影響哪個部分？", options: ["正式卡片數量", "遊戲戰力", "Line 好友數", "網頁顏色"], answerIndex: 1 },
    { q: "記憶翻牌完成後主要會獲得什麼？", options: ["潮流能量", "刪除卡片", "降低戰力", "重置進度"], answerIndex: 0 },
    { q: "抽卡結果應該由哪裡決定才安全？", options: ["前端畫面", "玩家瀏覽器", "後端伺服器", "留言板"], answerIndex: 2 }
  ];
  const idx = Number(todayKeyTaipei().slice(-2)) % bank.length;
  return bank[idx];
}

async function getTrainingDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const profile = await getTrainingProfile(player.id);
  const quiz = dailyQuiz();
  return {
    success: true,
    profile: publicFreeProfile(profile),
    quiz: {
      question: quiz.q,
      options: quiz.options,
      done: !!profile.quiz_done_today
    },
    leaderboard: await getTrainingLeaderboard()
  };
}

async function claimDailyCheckIn(uid) {
  const player = await getOrCreatePlayer(uid);
  const today = todayKeyTaipei();
  const yesterday = dateKeyOffsetTaipei(-1);
  const now = new Date().toISOString();

  return withTransaction(async () => {
    let profile = await getTrainingProfile(player.id);
    if (String(profile.last_checkin_date || "") === today) {
      return {
        success: false,
        alreadyClaimed: true,
        msg: "今天已經簽到過了，明天再來領潮流能量！",
        profile: publicFreeProfile(profile),
        leaderboard: await getTrainingLeaderboard()
      };
    }

    const streak = String(profile.last_checkin_date || "") === yesterday ? Number(profile.streak || 0) + 1 : 1;
    const energy = Number(profile.energy || 0) + FREE_CHECKIN_ENERGY;
    const totalScore = Number(profile.total_score || 0) + FREE_CHECKIN_SCORE;
    const title = calculateTrainingTitle(totalScore, streak);

    await execute(
      `UPDATE training_profiles
       SET energy = ?, total_score = ?, streak = ?, last_checkin_date = ?, title = ?, updated_at = ?
       WHERE player_id = ?`,
      [energy, totalScore, streak, today, title, now, player.id]
    );
    await insertTrainingLog(player.id, "每日簽到", FREE_CHECKIN_SCORE, FREE_CHECKIN_ENERGY, `連續簽到 ${streak} 天`, now);

    profile = await getTrainingProfile(player.id);
    return {
      success: true,
      msg: `簽到成功！獲得潮流能量 +${FREE_CHECKIN_ENERGY}、訓練分數 +${FREE_CHECKIN_SCORE}。`,
      profile: publicFreeProfile(profile),
      leaderboard: await getTrainingLeaderboard()
    };
  });
}

async function answerDailyQuiz(uid, answerIndex) {
  const player = await getOrCreatePlayer(uid);
  const now = new Date().toISOString();
  const quiz = dailyQuiz();

  return withTransaction(async () => {
    const profile = await getTrainingProfile(player.id);
    if (profile.quiz_done_today) {
      return {
        success: false,
        msg: "今天已經完成問答了，明天會換新題目！",
        profile: publicFreeProfile(profile),
        quiz: { question: quiz.q, options: quiz.options, done: true },
        leaderboard: await getTrainingLeaderboard()
      };
    }

    const selected = Math.floor(Number(answerIndex));
    const correct = selected === quiz.answerIndex;
    const score = correct ? FREE_QUIZ_CORRECT_SCORE : FREE_QUIZ_WRONG_SCORE;
    const energyReward = correct ? FREE_QUIZ_CORRECT_ENERGY : FREE_QUIZ_WRONG_ENERGY;
    const energy = Number(profile.energy || 0) + energyReward;
    const totalScore = Number(profile.total_score || 0) + score;
    const title = calculateTrainingTitle(totalScore, Number(profile.streak || 0));

    await execute(
      "UPDATE training_profiles SET energy = ?, total_score = ?, quiz_done_today = 1, title = ?, updated_at = ? WHERE player_id = ?",
      [energy, totalScore, title, now, player.id]
    );
    await insertTrainingLog(player.id, "每日問答", score, energyReward, correct ? "答對" : `答錯，正解: ${quiz.options[quiz.answerIndex]}`, now);

    const updated = await getTrainingProfile(player.id);
    return {
      success: true,
      correct,
      correctAnswer: quiz.options[quiz.answerIndex],
      msg: correct ? "答對了！潮流知識過關。" : `答錯了，正確答案是：「${quiz.options[quiz.answerIndex]}」。`,
      profile: publicFreeProfile(updated),
      quiz: { question: quiz.q, options: quiz.options, done: true },
      leaderboard: await getTrainingLeaderboard()
    };
  });
}

async function saveMemoryGameScore(uid, rawScore, moves, seconds) {
  const player = await getOrCreatePlayer(uid);
  const now = new Date().toISOString();

  return withTransaction(async () => {
    const profile = await getTrainingProfile(player.id);
    if (Number(profile.memory_plays_today || 0) >= FREE_DAILY_MEMORY_LIMIT) {
      return {
        success: false,
        msg: "今天的翻牌訓練次數已用完，明天再來挑戰！",
        profile: publicFreeProfile(profile),
        leaderboard: await getTrainingLeaderboard()
      };
    }

    const score = Math.max(0, Math.min(200, Math.floor(Number(rawScore) || 0)));
    const safeMoves = Math.max(0, Math.floor(Number(moves) || 0));
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const energyReward = Math.max(20, Math.min(80, 20 + Math.floor(score / 4)));
    const memoryPlays = Number(profile.memory_plays_today || 0) + 1;
    const energy = Number(profile.energy || 0) + energyReward;
    const totalScore = Number(profile.total_score || 0) + score;
    const maxMemoryScore = Math.max(Number(profile.max_memory_score || 0), score);
    const title = calculateTrainingTitle(totalScore, Number(profile.streak || 0));

    await execute(
      `UPDATE training_profiles
       SET energy = ?, total_score = ?, memory_plays_today = ?, max_memory_score = ?, title = ?, updated_at = ?
       WHERE player_id = ?`,
      [energy, totalScore, memoryPlays, maxMemoryScore, title, now, player.id]
    );
    await insertTrainingLog(player.id, "翻牌記憶", score, energyReward, `步數 ${safeMoves}，秒數 ${safeSeconds}`, now);

    const updated = await getTrainingProfile(player.id);
    return {
      success: true,
      msg: `翻牌完成！獲得潮流能量 +${energyReward}、訓練分數 +${score}。`,
      profile: publicFreeProfile(updated),
      leaderboard: await getTrainingLeaderboard()
    };
  });
}

async function getOrCreateMiniDaily(playerId) {
  const today = todayKeyTaipei();
  const now = new Date().toISOString();
  let row = await queryOne("SELECT * FROM mini_daily_status WHERE player_id = ? AND date_key = ?", [playerId, today]);
  if (!row) {
    await execute(
      "INSERT INTO mini_daily_status (player_id, date_key, shadow_plays_today, fortune_result, message_count_today, updated_at) VALUES (?, ?, 0, '', 0, ?)",
      [playerId, today, now]
    );
    row = await queryOne("SELECT * FROM mini_daily_status WHERE player_id = ? AND date_key = ?", [playerId, today]);
  }
  return row;
}

async function getShadowQuestion(uid) {
  const player = await getOrCreatePlayer(uid);
  const daily = await getOrCreateMiniDaily(player.id);
  if (Number(daily.shadow_plays_today || 0) >= SHADOW_DAILY_LIMIT) {
    return { success: false, msg: "今天的猜影子次數已用完，明天再來挑戰！", playsLeft: 0 };
  }

  const cards = await queryAll(
    "SELECT name, image_url FROM cards WHERE image_url IS NOT NULL AND image_url != '' ORDER BY sort_order ASC LIMIT 120"
  );
  if (!cards.length) return { success: false, msg: "目前沒有可用的角色圖片，請先到 GM 卡牌管理設定圖片。", playsLeft: Math.max(0, SHADOW_DAILY_LIMIT - Number(daily.shadow_plays_today || 0)) };

  const correctRow = cards[Math.floor(Math.random() * cards.length)];
  const correct = correctRow.name;
  const names = cards.map(c => c.name);
  const choices = [correct];
  while (choices.length < 4 && choices.length < names.length) {
    const c = names[Math.floor(Math.random() * names.length)];
    if (!choices.includes(c)) choices.push(c);
  }
  choices.sort(() => Math.random() - 0.5);

  const token = crypto.randomBytes(16).toString("hex");
  shadowAnswerCache.set(token, { answer: correct, expiresAt: Date.now() + 10 * 60 * 1000 });
  return {
    success: true,
    token,
    imageKey: correct,
    imageUrl: correctRow.image_url || "",
    choices,
    playsLeft: Math.max(0, SHADOW_DAILY_LIMIT - Number(daily.shadow_plays_today || 0))
  };
}

async function submitShadowGuess(uid, token, guessName) {
  const player = await getOrCreatePlayer(uid);
  const now = new Date().toISOString();

  return withTransaction(async () => {
    const daily = await getOrCreateMiniDaily(player.id);
    if (Number(daily.shadow_plays_today || 0) >= SHADOW_DAILY_LIMIT) {
      return { success: false, msg: "今天的猜影子次數已用完。", shadowPlaysLeft: 0 };
    }

    const cached = shadowAnswerCache.get(String(token || ""));
    if (!cached || cached.expiresAt < Date.now()) {
      shadowAnswerCache.delete(String(token || ""));
      return { success: false, msg: "題目已過期，請重新產生一題。", expired: true };
    }

    shadowAnswerCache.delete(String(token || ""));
    const answer = cached.answer;
    const guess = String(guessName || "").trim();
    const correct = guess === answer;
    const score = correct ? SHADOW_CORRECT_SCORE : SHADOW_WRONG_SCORE;
    const energy = correct ? SHADOW_CORRECT_ENERGY : SHADOW_WRONG_ENERGY;

    await execute(
      `UPDATE mini_daily_status SET shadow_plays_today = shadow_plays_today + 1, updated_at = ?
       WHERE player_id = ? AND date_key = ?`,
      [now, player.id, todayKeyTaipei()]
    );

    const profile = await getTrainingProfile(player.id);
    const newEnergy = Number(profile.energy || 0) + energy;
    const newScore = Number(profile.total_score || 0) + score;
    const title = calculateTrainingTitle(newScore, Number(profile.streak || 0));
    await execute(
      "UPDATE training_profiles SET energy = ?, total_score = ?, title = ?, updated_at = ? WHERE player_id = ?",
      [newEnergy, newScore, title, now, player.id]
    );
    await insertTrainingLog(player.id, "角色猜影子", score, energy, correct ? `答對: ${answer}` : `答錯: ${guess}，正解: ${answer}`, now);

    const updatedDaily = await getOrCreateMiniDaily(player.id);
    return {
      success: true,
      correct,
      correctAnswer: answer,
      msg: correct ? "答對！你成功認出這張潮流影子卡。" : `答錯了，正確答案是「${answer}」。`,
      scoreAdded: score,
      energyAdded: energy,
      shadowPlaysToday: Number(updatedDaily.shadow_plays_today || 0),
      shadowPlaysLeft: Math.max(0, SHADOW_DAILY_LIMIT - Number(updatedDaily.shadow_plays_today || 0))
    };
  });
}

function drawFortune() {
  const fortunes = [
    { name: "大吉", text: "今天歐氣很高，適合挑戰高難度關卡。", score: 100, energy: 100 },
    { name: "中吉", text: "今天手感穩定，適合累積訓練分數。", score: 80, energy: 80 },
    { name: "小吉", text: "先完成每日訓練，運氣會慢慢升溫。", score: 50, energy: 50 },
    { name: "末吉", text: "今天先暖身，慢慢累積能量。", score: 30, energy: 30 },
    { name: "潮流逆轉籤", text: "低調開局，高機率後面逆轉。", score: 120, energy: 60 }
  ];
  return fortunes[Math.floor(Math.random() * fortunes.length)];
}

async function claimDailyFortune(uid) {
  const player = await getOrCreatePlayer(uid);
  const now = new Date().toISOString();

  return withTransaction(async () => {
    const daily = await getOrCreateMiniDaily(player.id);
    if (daily.fortune_result) {
      return {
        success: false,
        alreadyClaimed: true,
        msg: "今天已經抽過潮流籤了，明天再來試手氣！",
        fortune: daily.fortune_result
      };
    }

    const fortune = drawFortune();
    await execute(
      "UPDATE mini_daily_status SET fortune_result = ?, updated_at = ? WHERE player_id = ? AND date_key = ?",
      [fortune.name, now, player.id, todayKeyTaipei()]
    );

    const profile = await getTrainingProfile(player.id);
    const energy = Number(profile.energy || 0) + fortune.energy;
    const score = Number(profile.total_score || 0) + fortune.score;
    const title = calculateTrainingTitle(score, Number(profile.streak || 0));
    await execute("UPDATE training_profiles SET energy = ?, total_score = ?, title = ?, updated_at = ? WHERE player_id = ?", [energy, score, title, now, player.id]);
    await insertTrainingLog(player.id, "今日潮流籤", fortune.score, fortune.energy, `${fortune.name}｜${fortune.text}`, now);

    return {
      success: true,
      fortune: fortune.name,
      text: fortune.text,
      scoreAdded: fortune.score,
      energyAdded: fortune.energy,
      msg: `今日潮流籤：「${fortune.name}」`
    };
  });
}

async function getMessageBoard() {
  const rows = await queryAll(
    `SELECT masked_uid, message, created_at
     FROM messages
     WHERE status = 'OK'
     ORDER BY id DESC
     LIMIT 15`,
    []
  );
  return rows.map(row => ({
    time: formatTaipeiMMddHHmm(row.created_at),
    uid: row.masked_uid || "玩家",
    message: row.message || ""
  }));
}

function sanitizeBoardMessage(message) {
  return String(message || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 50);
}

async function submitBoardMessage(uid, message) {
  const player = await getOrCreatePlayer(uid);
  const clean = sanitizeBoardMessage(message);
  if (!clean) return { success: false, msg: "留言內容不能空白。", messages: await getMessageBoard() };

  return withTransaction(async () => {
    const daily = await getOrCreateMiniDaily(player.id);
    if (Number(daily.message_count_today || 0) >= MESSAGE_DAILY_LIMIT) {
      return { success: false, msg: "今天留言次數已達上限，明天再留言！", messages: await getMessageBoard() };
    }

    const now = new Date().toISOString();
    await execute("INSERT INTO messages (player_id, masked_uid, message, status, created_at) VALUES (?, ?, ?, 'OK', ?)", [player.id, maskUid(uid), clean, now]);
    await execute("UPDATE mini_daily_status SET message_count_today = message_count_today + 1, updated_at = ? WHERE player_id = ? AND date_key = ?", [now, player.id, todayKeyTaipei()]);

    const updated = await getOrCreateMiniDaily(player.id);
    return {
      success: true,
      msg: "留言已送出。",
      messageLeftToday: Math.max(0, MESSAGE_DAILY_LIMIT - Number(updated.message_count_today || 0)),
      messages: await getMessageBoard()
    };
  });
}

async function buildOwnedPvpCards(playerId) {
  return getOwnedCardBattleOptionsFast(playerId, 9999);
}

async function getRecentPvpLogs(playerId) {
  const rows = await queryAll(
    `SELECT * FROM pvp_logs WHERE player_id = ? ORDER BY id DESC LIMIT 10`,
    [playerId]
  );
  return rows.map(row => ({
    time: formatTaipeiMMddHHmm(row.created_at),
    myCard: row.my_card,
    opponentUid: row.opponent_masked_uid,
    opponentCard: row.opponent_card,
    myPower: Number(row.my_power || 0),
    opponentPower: Number(row.opponent_power || 0),
    result: row.result,
    reward: row.reward
  }));
}

async function getOrCreatePvpPlayer(playerId) {
  const now = new Date().toISOString();
  let row = await queryOne("SELECT * FROM pvp_players WHERE player_id = ?", [playerId]);
  if (!row) {
    await execute(
      "INSERT INTO pvp_players (player_id, representative_card_name, representative_power, fragments, total_wins, total_losses, updated_at) VALUES (?, '', 0, 0, 0, 0, ?)",
      [playerId, now]
    );
    row = await queryOne("SELECT * FROM pvp_players WHERE player_id = ?", [playerId]);
  }
  return row;
}

async function getOrCreatePvpDaily(playerId) {
  const today = todayKeyTaipei();
  const now = new Date().toISOString();
  let row = await queryOne("SELECT * FROM pvp_daily_status WHERE player_id = ? AND date_key = ?", [playerId, today]);
  if (!row) {
    await execute("INSERT INTO pvp_daily_status (player_id, date_key, challenges, wins, fragment_claimed, updated_at) VALUES (?, ?, 0, 0, 0, ?)", [playerId, today, now]);
    row = await queryOne("SELECT * FROM pvp_daily_status WHERE player_id = ? AND date_key = ?", [playerId, today]);
  }
  return row;
}

async function getPvpDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const pvp = await getOrCreatePvpPlayer(player.id);
  const daily = await getOrCreatePvpDaily(player.id);
  const ownedCards = await buildOwnedPvpCards(player.id);

  return {
    success: true,
    ownedCards,
    representative: pvp.representative_card_name || "",
    representativePower: Number(pvp.representative_power || 0),
    fragments: Number(pvp.fragments || 0),
    totalWins: Number(pvp.total_wins || 0),
    totalLosses: Number(pvp.total_losses || 0),
    todayChallenges: Number(daily.challenges || 0),
    todayChallengeLeft: Math.max(0, PVP_DAILY_LIMIT - Number(daily.challenges || 0)),
    todayWins: Number(daily.wins || 0),
    todayFragmentClaimed: !!daily.fragment_claimed,
    dailyLimit: PVP_DAILY_LIMIT,
    dailyWinTarget: PVP_DAILY_WIN_TARGET,
    fragmentsToDraw: PVP_FRAGMENTS_TO_DRAW,
    recentLogs: await getRecentPvpLogs(player.id)
  };
}

async function setPvpRepresentative(uid, cardName) {
  const player = await getOrCreatePlayer(uid);
  const cleanCard = String(cardName || "").trim();
  const owned = await getOwnedCardsMap(player.id);
  const count = Number(owned[cleanCard] || 0);
  if (!cleanCard || count <= 0) return { success: false, msg: "請選擇你已持有的卡片作為 PVP 代表。" };

  const stars = await getStarMap(player.id);
  const power = await calculateSingleCardPowerWithGrowth(player.id, cleanCard, count, stars[cleanCard] || 1);
  await execute(
    `INSERT INTO pvp_players (player_id, representative_card_name, representative_power, fragments, total_wins, total_losses, updated_at)
     VALUES (?, ?, ?, 0, 0, 0, ?)
     ON CONFLICT(player_id) DO UPDATE SET representative_card_name = excluded.representative_card_name, representative_power = excluded.representative_power, updated_at = excluded.updated_at`,
    [player.id, cleanCard, power, new Date().toISOString()]
  );

  return { success: true, msg: `PVP 代表已設定為「${cleanCard}」。`, dashboard: await getPvpDashboard(uid) };
}

async function choosePvpOpponent(myPlayerId, myPower) {
  const rows = await queryAll(
    `SELECT pp.*, p.uid
     FROM pvp_players pp
     JOIN players p ON p.id = pp.player_id
     WHERE pp.player_id != ? AND pp.representative_card_name IS NOT NULL AND pp.representative_card_name != ''
     ORDER BY ABS(pp.representative_power - ?) ASC
     LIMIT 10`,
    [myPlayerId, myPower]
  );
  if (!rows.length) {
    const cards = await queryAll("SELECT name FROM cards WHERE is_drawable = 1 ORDER BY RANDOM() LIMIT 1");
    return {
      uid: "TLO_AI",
      maskedUid: "TLO***AI",
      card: cards[0]?.name || "AJ",
      power: Math.max(100, Math.round(myPower * (0.8 + Math.random() * 0.4)))
    };
  }
  const row = rows[Math.floor(Math.random() * rows.length)];
  return {
    uid: row.uid,
    maskedUid: maskUid(row.uid),
    card: row.representative_card_name,
    power: Number(row.representative_power || 0)
  };
}

async function executePvpBattle(uid) {
  const player = await getOrCreatePlayer(uid);
  const now = new Date().toISOString();

  // Supabase 穩定版：交易內只做必要寫入，不在交易內重拉整個 dashboard。
  // 舊版會在 transaction 裡呼叫 getPvpDashboard，尖峰時會把連線池塞滿。
  const result = await withTransaction(async () => {
    const pvp = await getOrCreatePvpPlayer(player.id);
    const daily = await getOrCreatePvpDaily(player.id);

    if (!pvp.representative_card_name) {
      return { success: false, msg: "請先選擇一張已持有卡作為 PVP 代表。", needDashboard: true };
    }

    if (Number(daily.challenges || 0) >= PVP_DAILY_LIMIT) {
      return { success: false, msg: "今天的 PVP 挑戰次數已用完，明天再戰！", needDashboard: true };
    }

    const owned = await getOwnedCardsMap(player.id);
    const ownedCount = Number(owned[pvp.representative_card_name] || 0);
    if (ownedCount <= 0) {
      await execute("UPDATE pvp_players SET representative_card_name = '', representative_power = 0, updated_at = ? WHERE player_id = ?", [now, player.id]);
      return { success: false, msg: "你的代表卡已不在卡盒中，請重新選擇代表。", needDashboard: true };
    }

    const stars = await getStarMap(player.id);
    const progress = await getCardProgressMap(player.id);
    const myProg = progress[pvp.representative_card_name] || { level: 1, exp: 0, skillLevel: 1 };
    const myStar = stars[pvp.representative_card_name] || 1;
    const myBasePower = await calculateSingleCardPowerWithGrowth(player.id, pvp.representative_card_name, ownedCount, myStar);
    const opponent = await choosePvpOpponent(player.id, myBasePower);
    const myCardInfo = await queryOne("SELECT rarity, image_url FROM cards WHERE name = ? LIMIT 1", [pvp.representative_card_name]);
    const oppCardInfo = await queryOne("SELECT rarity, image_url FROM cards WHERE name = ? LIMIT 1", [opponent.card]);
    const myRoll = Math.round(myBasePower * (0.85 + Math.random() * 0.30) + Math.random() * 120);
    const oppRoll = Math.round(opponent.power * (0.85 + Math.random() * 0.30) + Math.random() * 120);
    const win = myRoll >= oppRoll;

    let rewardText = win ? "勝利 +1" : "本場未獲得勝場";
    let fragments = Number(pvp.fragments || 0);
    let totalWins = Number(pvp.total_wins || 0);
    let totalLosses = Number(pvp.total_losses || 0);
    let dailyWins = Number(daily.wins || 0);
    let fragmentClaimed = Number(daily.fragment_claimed || 0);
    let newTimesLeft = null;

    if (win) {
      totalWins += 1;
      dailyWins += 1;
    } else {
      totalLosses += 1;
    }

    if (win && dailyWins >= PVP_DAILY_WIN_TARGET && !fragmentClaimed) {
      fragmentClaimed = 1;
      fragments += 1;
      rewardText = `今日達成 ${PVP_DAILY_WIN_TARGET} 勝，獲得免費抽卡碎片 +1`;

      if (fragments >= PVP_FRAGMENTS_TO_DRAW) {
        fragments -= PVP_FRAGMENTS_TO_DRAW;
        const asset = await getAssets(player.id);
        newTimesLeft = Number(asset.draw_times || 0) + 1;
        await execute("UPDATE player_assets SET draw_times = ?, updated_at = ? WHERE player_id = ?", [newTimesLeft, now, player.id]);
        rewardText += `，碎片集滿 ${PVP_FRAGMENTS_TO_DRAW} 個，自動兌換抽卡次數 +1`;
      }
    }

    await execute(
      "UPDATE pvp_players SET representative_power = ?, fragments = ?, total_wins = ?, total_losses = ?, updated_at = ? WHERE player_id = ?",
      [myBasePower, fragments, totalWins, totalLosses, now, player.id]
    );
    await execute(
      "UPDATE pvp_daily_status SET challenges = challenges + 1, wins = ?, fragment_claimed = ?, updated_at = ? WHERE player_id = ? AND date_key = ?",
      [dailyWins, fragmentClaimed, now, player.id, todayKeyTaipei()]
    );
    await execute(
      `INSERT INTO pvp_logs (player_id, date_key, my_card, opponent_masked_uid, opponent_card, my_power, opponent_power, result, reward, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [player.id, todayKeyTaipei(), pvp.representative_card_name, opponent.maskedUid, opponent.card, myRoll, oppRoll, win ? "WIN" : "LOSE", rewardText, now]
    );

    const growthRewards = await addCharacterExp(player.id, [pvp.representative_card_name], win ? 90 : 35, "PVP對戰經驗");

    return {
      success: true,
      win,
      myCard: pvp.representative_card_name,
      opponentUid: opponent.maskedUid,
      opponentCard: opponent.card,
      myPower: myRoll,
      opponentPower: oppRoll,
      rewardText,
      newTimesLeft,
      growthRewards,
      battleAnimation: makeTurnBattleAnimation({
        playerPower: myRoll,
        bossPower: oppRoll,
        bossName: `${opponent.maskedUid} 的 ${opponent.card}`,
        stageName: "PVP 玩家對戰",
        win,
        playerTeam: [{ name: pvp.representative_card_name, rarity: myCardInfo?.rarity || "NORMAL", imageUrl: myCardInfo?.image_url || "", star: myStar, level: myProg.level, skillLevel: myProg.skillLevel, count: ownedCount, power: myRoll }],
        enemyTeam: [{ name: opponent.card, rarity: oppCardInfo?.rarity || "NORMAL", imageUrl: oppCardInfo?.image_url || "", power: oppRoll }],
        playerLabel: pvp.representative_card_name,
        enemyLabel: `${opponent.maskedUid} 的 ${opponent.card}`
      })
    };
  });

  if (result && (result.success !== false || result.needDashboard)) {
    try {
      result.dashboard = await getPvpDashboard(uid);
    } catch (err) {
      console.warn("[PVP_DASHBOARD_REFRESH_FAILED]", err?.message || err);
    }
    delete result.needDashboard;
  }
  return result;
}

async function getStarShopDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const profile = await getTrainingProfile(player.id);
  const ownedCards = await getOwnedCardBattleOptionsFast(player.id, 9999);
  const cards = ownedCards.map(card => {
    const star = Math.max(1, Math.min(CARD_STAR_MAX, Number(card.star || 1)));
    const nextStar = star < CARD_STAR_MAX ? star + 1 : null;
    const nextCost = nextStar ? (CARD_STAR_COSTS[nextStar] || 0) : 0;
    return {
      ...card,
      star,
      nextStar,
      nextCost,
      isMax: !nextStar,
      canUpgrade: !!nextStar && Number(profile.energy || 0) >= nextCost
    };
  });

  cards.sort((a,b) => {
    if (b.star !== a.star) return b.star - a.star;
    if (b.power !== a.power) return b.power - a.power;
    return a.name.localeCompare(b.name);
  });

  return {
    success: true,
    profile: publicFreeProfile(profile),
    cards,
    ruleText: "升星只影響遊戲戰力，不增加正式卡片數量，也不列入實體兌獎條件。"
  };
}

async function upgradeCardStar(uid, cardName) {
  const player = await getOrCreatePlayer(uid);
  const cleanCard = String(cardName || "").trim();
  const now = new Date().toISOString();

  return withTransaction(async () => {
    const owned = await getOwnedCardsMap(player.id);
    const count = Number(owned[cleanCard] || 0);
    if (!cleanCard || count <= 0) {
      return { success: false, msg: "你尚未持有這張角色卡，不能升星。", dashboard: await getStarShopDashboard(uid) };
    }

    const card = await queryOne("SELECT * FROM cards WHERE name = ?", [cleanCard]);
    if (!card) return { success: false, msg: "找不到角色資料。", dashboard: await getStarShopDashboard(uid) };

    const existing = await queryOne("SELECT star FROM card_stars WHERE player_id = ? AND card_id = ?", [player.id, card.id]);
    const currentStar = Math.max(1, Math.min(CARD_STAR_MAX, Number(existing?.star || 1)));
    if (currentStar >= CARD_STAR_MAX) {
      return { success: false, msg: "這張角色已經滿星。", dashboard: await getStarShopDashboard(uid) };
    }

    const nextStar = currentStar + 1;
    const cost = CARD_STAR_COSTS[nextStar] || 0;
    const profile = await getTrainingProfile(player.id);
    if (Number(profile.energy || 0) < cost) {
      return { success: false, msg: `潮流能量不足，升到 ${nextStar} 星需要 ${cost} 能量。`, dashboard: await getStarShopDashboard(uid) };
    }

    await execute("UPDATE training_profiles SET energy = energy - ?, updated_at = ? WHERE player_id = ?", [cost, now, player.id]);
    await execute(
      `INSERT INTO card_stars (player_id, card_id, card_name, star, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id, card_id)
       DO UPDATE SET star = excluded.star, card_name = excluded.card_name, updated_at = excluded.updated_at`,
      [player.id, card.id, cleanCard, nextStar, now]
    );
    await insertTrainingLog(player.id, "角色升星", 0, -cost, `${cleanCard} 升至 ${nextStar} 星；此升星不列入實體兌獎`, now);

    const pvp = await getOrCreatePvpPlayer(player.id);
    if (pvp.representative_card_name === cleanCard) {
      const newPower = await calculateSingleCardPowerWithGrowth(player.id, cleanCard, count, nextStar);
      await execute("UPDATE pvp_players SET representative_power = ?, updated_at = ? WHERE player_id = ?", [newPower, now, player.id]);
    }
    await refreshBattleRepresentativePowerIfNeeded(player.id, cleanCard);

    return { success: true, msg: `升星成功！「${cleanCard}」已升到 ${nextStar} 星，消耗潮流能量 ${cost}。`, dashboard: await getStarShopDashboard(uid) };
  });
}

async function getCharacterGrowthDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const profile = await getTrainingProfile(player.id);
  const resetItems = await getResetTicketDashboardPart(player.id);
  const ownedCards = await getOwnedCardBattleOptionsFast(player.id, 9999);
  const cards = ownedCards.map(card => {
    const level = Math.max(1, Math.min(CARD_LEVEL_MAX, Number(card.level || 1)));
    const skillLevel = Math.max(1, Math.min(CARD_SKILL_MAX, Number(card.skillLevel || 1)));
    const exp = Math.max(0, Number(card.exp || 0));
    const trainCost = level >= CARD_LEVEL_MAX ? 0 : getCardTrainingEnergyCost(level);
    const skillCost = skillLevel >= CARD_SKILL_MAX ? 0 : getSkillUpgradeEnergyCost(skillLevel);
    const resetRefundEnergy = calculateStarResetRefund(star);
    const resetRefundSkillExp = calculateSkillResetRefund(skillLevel);
    const canReset = resetItems.cardResetTicket > 0 && (star > 1 || skillLevel > 1);
    return {
      ...card,
      maxStar: CARD_STAR_MAX,
      maxLevel: CARD_LEVEL_MAX,
      maxSkillLevel: CARD_SKILL_MAX,
      level,
      exp,
      expToNext: getCardLevelExpNeed(level),
      skillLevel,
      trainCost,
      skillCost,
      resetRefundEnergy,
      resetRefundSkillExp,
      canReset,
      canTrain: level < CARD_LEVEL_MAX && Number(profile.energy || 0) >= trainCost,
      canUpgradeSkill: skillLevel < CARD_SKILL_MAX && (Number(profile.energy || 0) + Number(profile.skill_exp || 0)) >= skillCost
    };
  });

  cards.sort((a, b) => {
    if (Number(b.power || 0) !== Number(a.power || 0)) return Number(b.power || 0) - Number(a.power || 0);
    if (Number(b.star || 0) !== Number(a.star || 0)) return Number(b.star || 0) - Number(a.star || 0);
    if (Number(b.level || 0) !== Number(a.level || 0)) return Number(b.level || 0) - Number(a.level || 0);
    return a.name.localeCompare(b.name);
  });

  return {
    success: true,
    profile: publicFreeProfile(profile),
    maxStar: CARD_STAR_MAX,
    maxLevel: CARD_LEVEL_MAX,
    maxSkillLevel: CARD_SKILL_MAX,
    itemCounts: resetItems,
    cards,
    ruleText: "角色等級、技能等級與星級只影響遊戲內戰力，不增加正式卡片數量，也不列入實體兌獎條件。"
  };
}

async function trainCardLevel(uid, cardName) {
  const player = await getOrCreatePlayer(uid);
  const cleanCard = String(cardName || "").trim();
  if (!cleanCard) return { success: false, msg: "請選擇角色。", dashboard: await getCharacterGrowthDashboard(uid) };

  return withTransaction(async () => {
    const owned = await getOwnedCardsMap(player.id);
    const count = Number(owned[cleanCard] || 0);
    if (count <= 0) return { success: false, msg: "你尚未持有這張角色卡。", dashboard: await getCharacterGrowthDashboard(uid) };
    const row = await getOrCreateCardProgression(player.id, cleanCard);
    if (!row) return { success: false, msg: "找不到角色資料。", dashboard: await getCharacterGrowthDashboard(uid) };
    const prog = normalizeGrowthRow(row);
    if (prog.level >= CARD_LEVEL_MAX) return { success: false, msg: "角色等級已滿。", dashboard: await getCharacterGrowthDashboard(uid) };
    const cost = getCardTrainingEnergyCost(prog.level);
    const profile = await getTrainingProfile(player.id);
    if (Number(profile.energy || 0) < cost) return { success: false, msg: `潮流能量不足，本次特訓需要 ${cost} 能量。`, dashboard: await getCharacterGrowthDashboard(uid) };

    const expGain = getCardLevelExpNeed(prog.level);
    const now = new Date().toISOString();
    await execute("UPDATE training_profiles SET energy = energy - ?, updated_at = ? WHERE player_id = ?", [cost, now, player.id]);
    const gains = await addCharacterExp(player.id, [cleanCard], expGain, "角色特訓");
    await insertTrainingLog(player.id, "角色特訓消耗", 0, -cost, `${cleanCard} 特訓消耗潮流能量 ${cost}`, now);
    await refreshPvpRepresentativePowerIfNeeded(player.id, cleanCard);
    await refreshBattleRepresentativePowerIfNeeded(player.id, cleanCard);
    const g = gains[0];
    return { success: true, msg: g && g.leveled ? `${cleanCard} 特訓成功，升到 Lv.${g.level}！` : `${cleanCard} 獲得 ${expGain} EXP。`, dashboard: await getCharacterGrowthDashboard(uid) };
  });
}

async function upgradeCardSkill(uid, cardName) {
  const player = await getOrCreatePlayer(uid);
  const cleanCard = String(cardName || "").trim();
  if (!cleanCard) return { success: false, msg: "請選擇角色。", dashboard: await getCharacterGrowthDashboard(uid) };

  return withTransaction(async () => {
    const owned = await getOwnedCardsMap(player.id);
    const count = Number(owned[cleanCard] || 0);
    if (count <= 0) return { success: false, msg: "你尚未持有這張角色卡。", dashboard: await getCharacterGrowthDashboard(uid) };
    const row = await getOrCreateCardProgression(player.id, cleanCard);
    if (!row) return { success: false, msg: "找不到角色資料。", dashboard: await getCharacterGrowthDashboard(uid) };
    const prog = normalizeGrowthRow(row);
    if (prog.skillLevel >= CARD_SKILL_MAX) return { success: false, msg: "技能等級已滿。", dashboard: await getCharacterGrowthDashboard(uid) };
    const cost = getSkillUpgradeEnergyCost(prog.skillLevel);
    const profile = await getTrainingProfile(player.id);
    const skillExp = Number(profile.skill_exp || 0);
    const energyNow = Number(profile.energy || 0);
    if (skillExp + energyNow < cost) return { success: false, msg: `技能經驗 / 潮流能量不足，技能升級需要 ${cost}。`, dashboard: await getCharacterGrowthDashboard(uid) };

    const now = new Date().toISOString();
    const nextSkill = prog.skillLevel + 1;
    const useSkillExp = Math.min(skillExp, cost);
    const useEnergy = Math.max(0, cost - useSkillExp);
    await execute("UPDATE training_profiles SET skill_exp = skill_exp - ?, energy = energy - ?, updated_at = ? WHERE player_id = ?", [useSkillExp, useEnergy, now, player.id]);
    await execute("UPDATE card_progression SET skill_level = ?, updated_at = ? WHERE player_id = ? AND card_name = ?", [nextSkill, now, player.id, cleanCard]);
    await insertTrainingLog(player.id, "技能升級", 0, -useEnergy, `${cleanCard} 技能升到 Lv.${nextSkill}；消耗技能經驗 ${useSkillExp}、潮流能量 ${useEnergy}`, now);
    await refreshPvpRepresentativePowerIfNeeded(player.id, cleanCard);
    await refreshBattleRepresentativePowerIfNeeded(player.id, cleanCard);
    return { success: true, msg: `${cleanCard} 技能升級成功！技能 Lv.${nextSkill}`, dashboard: await getCharacterGrowthDashboard(uid) };
  });
}


async function useCardResetTicket(uid, cardName) {
  const player = await getOrCreatePlayer(uid);
  const cleanCard = String(cardName || "").trim();
  if (!cleanCard) return { success: false, msg: "請選擇要重置的角色。", dashboard: await getCharacterGrowthDashboard(uid) };

  return withTransaction(async () => {
    await ensureResetItemSchema();
    const ticketCount = await getPlayerItemQuantity(player.id, ITEM_CARD_RESET_TICKET);
    if (ticketCount <= 0) return { success: false, msg: "你沒有卡牌重置券。", dashboard: await getCharacterGrowthDashboard(uid) };

    const owned = await getOwnedCardsMap(player.id);
    const count = Number(owned[cleanCard] || 0);
    if (count <= 0) return { success: false, msg: "你尚未持有這張角色卡。", dashboard: await getCharacterGrowthDashboard(uid) };

    const card = await queryOne("SELECT * FROM cards WHERE name = ? LIMIT 1", [cleanCard]);
    if (!card) return { success: false, msg: "找不到角色資料。", dashboard: await getCharacterGrowthDashboard(uid) };

    const starRow = await queryOne("SELECT star FROM card_stars WHERE player_id = ? AND card_id = ?", [player.id, card.id]);
    const progRow = await getOrCreateCardProgression(player.id, cleanCard);
    const oldStar = Math.max(1, Math.min(CARD_STAR_MAX, Number(starRow?.star || 1)));
    const prog = normalizeGrowthRow(progRow);
    const oldSkillLevel = Math.max(1, Math.min(CARD_SKILL_MAX, Number(prog.skillLevel || 1)));

    if (oldStar <= 1 && oldSkillLevel <= 1) {
      return { success: false, msg: "這張角色目前已是 1 星 / 技能 Lv.1，不需要重置。", dashboard: await getCharacterGrowthDashboard(uid) };
    }

    const refundedEnergy = calculateStarResetRefund(oldStar);
    const refundedSkillExp = calculateSkillResetRefund(oldSkillLevel);
    const now = new Date().toISOString();

    await execute("UPDATE player_items SET quantity = quantity - 1, updated_at = ? WHERE player_id = ? AND item_key = ? AND quantity > 0", [now, player.id, ITEM_CARD_RESET_TICKET]);
    await execute("DELETE FROM card_stars WHERE player_id = ? AND card_id = ?", [player.id, card.id]);
    await execute("UPDATE card_progression SET skill_level = 1, updated_at = ? WHERE player_id = ? AND card_id = ?", [now, player.id, card.id]);
    await getTrainingProfile(player.id);
    await execute("UPDATE training_profiles SET energy = energy + ?, skill_exp = skill_exp + ?, updated_at = ? WHERE player_id = ?", [refundedEnergy, refundedSkillExp, now, player.id]);
    await execute(
      `INSERT INTO card_reset_logs (player_id, uid, card_id, card_name, old_star, old_skill_level, refunded_energy, refunded_skill_exp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [player.id, player.uid, card.id, card.name, oldStar, oldSkillLevel, refundedEnergy, refundedSkillExp, now]
    );
    await insertTrainingLog(player.id, "卡牌重置", 0, refundedEnergy, `${card.name} 使用卡牌重置券：${oldStar}星→1星，技能Lv.${oldSkillLevel}→Lv.1；退還潮流能量 ${refundedEnergy}、技能經驗 ${refundedSkillExp}`, now);
    await refreshPvpRepresentativePowerIfNeeded(player.id, card.name);
    await refreshBattleRepresentativePowerIfNeeded(player.id, card.name);
    return {
      success: true,
      msg: `已重置「${card.name}」：星等回到 1 星、技能回到 Lv.1；退還潮流能量 ${refundedEnergy.toLocaleString()}、技能經驗 ${refundedSkillExp.toLocaleString()}。`,
      refundedEnergy,
      refundedSkillExp,
      remainingTickets: Math.max(0, ticketCount - 1),
      dashboard: await getCharacterGrowthDashboard(uid)
    };
  });
}


// =========================
// LAUNCH WELFARE / DAILY MISSIONS / NEWBIE MISSIONS
// =========================
const OPENING_REWARDS = [
  { day: 1, title: "第 1 天｜開服 10 抽", desc: "開服第一天登入獎勵。", reward: { type: "DRAW_TIMES", amount: 10 } },
  { day: 2, title: "第 2 天｜潮流能量補給", desc: "角色養成用能量。", reward: { type: "ENERGY", amount: 300 } },
  { day: 3, title: "第 3 天｜隨機 R 卡", desc: "從可抽取的 R 卡中隨機獲得 1 張。", reward: { type: "RANDOM_RARE_CARD", amount: 1 } },
  { day: 4, title: "第 4 天｜開服 10 抽", desc: "第二波開服抽卡支援。", reward: { type: "DRAW_TIMES", amount: 10 } },
  { day: 5, title: "第 5 天｜技能經驗", desc: "可用於角色技能升級，會優先消耗技能經驗。", reward: { type: "SKILL_EXP", amount: 180 } },
  { day: 6, title: "第 6 天｜開服 10 抽", desc: "第三波開服抽卡支援。", reward: { type: "DRAW_TIMES", amount: 10 } },
  { day: 7, title: "第 7 天｜指定 SR 卡：凌凌", desc: "開服第七天指定 SR 卡獎勵。", reward: { type: "CARD", cardName: "凌凌", amount: 1 } }
];

const DAILY_MISSION_DEFS = [
  { key: "daily_checkin", title: "每日簽到", desc: "完成今日簽到 1 次。", target: 1, reward: { type: "ENERGY", amount: 30 } },
  { key: "daily_boss", title: "潮流爭霸戰", desc: "挑戰潮流爭霸戰 1 次。", target: 1, reward: { type: "SCORE", amount: 80 } },
  { key: "daily_expedition", title: "遠征異世界", desc: "完成遠征異世界 1 次。", target: 1, reward: { type: "ENERGY", amount: 60 } },
  { key: "daily_pvp", title: "玩家對戰", desc: "完成 PVP 玩家對戰 1 次。", target: 1, reward: { type: "PVP_FRAGMENT", amount: 1 } },
  { key: "daily_growth", title: "角色養成", desc: "完成角色特訓或技能升級 1 次。", target: 1, reward: { type: "SKILL_EXP", amount: 30 } },
  { key: "daily_minigame", title: "小遊戲訓練", desc: "完成任一小遊戲 / 問答 / 運勢 1 次。", target: 1, reward: { type: "SCORE", amount: 50 } }
];

const NEWBIE_MISSION_DEFS = [
  { key: "first_gacha", title: "第一次抽卡", desc: "完成任意抽卡 1 次。", target: 1, reward: { type: "ENERGY", amount: 100 } },
  { key: "own_three_cards", title: "收集 3 張角色", desc: "卡盒中持有不同角色達 3 張。", target: 3, reward: { type: "SCORE", amount: 150 } },
  { key: "first_boss_clear", title: "首次突破爭霸戰", desc: "通關任意潮流爭霸戰關卡 1 次。", target: 1, reward: { type: "ENERGY", amount: 150 } },
  { key: "first_expedition_win", title: "首次遠征勝利", desc: "遠征異世界勝利 1 次。", target: 1, reward: { type: "SKILL_EXP", amount: 80 } },
  { key: "first_pvp", title: "首次玩家對戰", desc: "完成 PVP 玩家對戰 1 次。", target: 1, reward: { type: "PVP_FRAGMENT", amount: 3 } },
  { key: "first_star", title: "第一次升星", desc: "任一角色升到 2 星以上。", target: 2, reward: { type: "ENERGY", amount: 150 } },
  { key: "first_level", title: "第一次角色升級", desc: "任一角色升到 Lv.2 以上。", target: 2, reward: { type: "SKILL_EXP", amount: 100 } },
  { key: "first_skill", title: "第一次技能升級", desc: "任一角色技能升到 Lv.2 以上。", target: 2, reward: { type: "SCORE", amount: 250 } }
];

const ACHIEVEMENT_DEFS = [
  { key: "collect_3", category: "收集", title: "潮流入門收藏家", desc: "持有不同角色達 3 張。", stat: "unique_cards", target: 3, reward: { type: "ENERGY", amount: 120 } },
  { key: "collect_5", category: "收集", title: "五感開盒者", desc: "持有不同角色達 5 張。", stat: "unique_cards", target: 5, reward: { type: "SCORE", amount: 180 } },
  { key: "collect_8", category: "收集", title: "半套收藏突破", desc: "持有不同角色達 8 張。", stat: "unique_cards", target: 8, reward: { type: "SKILL_EXP", amount: 100 } },
  { key: "collect_10", category: "收集", title: "十角集結", desc: "持有不同角色達 10 張。", stat: "unique_cards", target: 10, reward: { type: "ENERGY", amount: 260 } },
  { key: "collect_15", category: "收集", title: "卡盒拓荒者", desc: "持有不同角色達 15 張。", stat: "unique_cards", target: 15, reward: { type: "SKILL_EXP", amount: 160 } },
  { key: "collect_20", category: "收集", title: "潮流圖鑑家", desc: "持有不同角色達 20 張。", stat: "unique_cards", target: 20, reward: { type: "ENERGY", amount: 420 } },
  { key: "collect_30", category: "收集", title: "收藏擴張者", desc: "持有不同角色達 30 張。", stat: "unique_cards", target: 30, reward: { type: "SCORE", amount: 650 } },
  { key: "collect_all", category: "收集", title: "全圖鑑制霸", desc: "持有目前所有可抽取角色。此目標會自動跟著 GM 新增卡片調整。", stat: "unique_cards", target: "TOTAL_COLLECTIBLE_CARDS", reward: { type: "ENERGY", amount: 900 } },

  { key: "total_cards_10", category: "持卡量", title: "卡盒起步", desc: "總持卡數達 10 張。", stat: "total_cards", target: 10, reward: { type: "SCORE", amount: 150 } },
  { key: "total_cards_50", category: "持卡量", title: "堆疊收藏", desc: "總持卡數達 50 張。", stat: "total_cards", target: 50, reward: { type: "SKILL_EXP", amount: 140 } },
  { key: "total_cards_100", category: "持卡量", title: "百卡倉庫", desc: "總持卡數達 100 張。", stat: "total_cards", target: 100, reward: { type: "ENERGY", amount: 420 } },
  { key: "total_cards_200", category: "持卡量", title: "大量囤卡者", desc: "總持卡數達 200 張。", stat: "total_cards", target: 200, reward: { type: "SCORE", amount: 900 } },
  { key: "total_cards_300", category: "持卡量", title: "潮流卡庫王", desc: "總持卡數達 300 張。", stat: "total_cards", target: 300, reward: { type: "ENERGY", amount: 1000 } },

  { key: "gacha_1", category: "抽卡", title: "第一個盲盒", desc: "累計抽卡紀錄達 1 次。", stat: "gacha_total", target: 1, reward: { type: "SCORE", amount: 80 } },
  { key: "gacha_10", category: "抽卡", title: "初次開盒", desc: "累計抽卡紀錄達 10 次。", stat: "gacha_total", target: 10, reward: { type: "SCORE", amount: 200 } },
  { key: "gacha_50", category: "抽卡", title: "開盒熟手", desc: "累計抽卡紀錄達 50 次。", stat: "gacha_total", target: 50, reward: { type: "SKILL_EXP", amount: 180 } },
  { key: "gacha_100", category: "抽卡", title: "百抽潮流魂", desc: "累計抽卡紀錄達 100 次。", stat: "gacha_total", target: 100, reward: { type: "ENERGY", amount: 450 } },
  { key: "gacha_300", category: "抽卡", title: "三百抽狂熱", desc: "累計抽卡紀錄達 300 次。", stat: "gacha_total", target: 300, reward: { type: "SCORE", amount: 900 } },
  { key: "gacha_500", category: "抽卡", title: "五百抽執念", desc: "累計抽卡紀錄達 500 次。", stat: "gacha_total", target: 500, reward: { type: "SKILL_EXP", amount: 500 } },
  { key: "gacha_1000", category: "抽卡", title: "千抽傳說", desc: "累計抽卡紀錄達 1000 次。", stat: "gacha_total", target: 1000, reward: { type: "ENERGY", amount: 1500 } },

  { key: "boss_1", category: "爭霸戰", title: "踏入爭霸", desc: "潮流爭霸戰通關累計 1 關。", stat: "boss_clears", target: 1, reward: { type: "SCORE", amount: 120 } },
  { key: "boss_5", category: "爭霸戰", title: "爭霸初勝者", desc: "潮流爭霸戰通關累計 5 關。", stat: "boss_clears", target: 5, reward: { type: "SCORE", amount: 250 } },
  { key: "boss_10", category: "爭霸戰", title: "十關突破", desc: "潮流爭霸戰通關累計 10 關。", stat: "boss_clears", target: 10, reward: { type: "ENERGY", amount: 260 } },
  { key: "boss_15", category: "爭霸戰", title: "Boss 獵人", desc: "潮流爭霸戰通關累計 15 關。", stat: "boss_clears", target: 15, reward: { type: "ENERGY", amount: 350 } },
  { key: "boss_25", category: "爭霸戰", title: "第一章完結", desc: "潮流爭霸戰通關累計 25 關。", stat: "boss_clears", target: 25, reward: { type: "SKILL_EXP", amount: 260 } },
  { key: "boss_50", category: "爭霸戰", title: "第二章征服", desc: "潮流爭霸戰通關累計 50 關。", stat: "boss_clears", target: 50, reward: { type: "SKILL_EXP", amount: 420 } },
  { key: "boss_75", category: "爭霸戰", title: "三章制霸者", desc: "潮流爭霸戰通關累計 75 關。", stat: "boss_clears", target: 75, reward: { type: "ENERGY", amount: 1200 } },
  { key: "boss_all", category: "爭霸戰", title: "全關卡制霸", desc: "通關目前所有已建立的爭霸戰關卡。此目標會跟著 GM 關卡數自動調整。", stat: "boss_clears", target: "TOTAL_BOSS_STAGES", reward: { type: "SCORE", amount: 1600 } },

  { key: "expedition_1", category: "遠征", title: "異世界出發", desc: "遠征異世界勝利 1 次。", stat: "rpg_wins", target: 1, reward: { type: "ENERGY", amount: 150 } },
  { key: "expedition_5", category: "遠征", title: "遠征見習生", desc: "遠征異世界勝利 5 次。", stat: "rpg_wins", target: 5, reward: { type: "SCORE", amount: 220 } },
  { key: "expedition_10", category: "遠征", title: "遠征老手", desc: "遠征異世界勝利 10 次。", stat: "rpg_wins", target: 10, reward: { type: "SKILL_EXP", amount: 200 } },
  { key: "expedition_30", category: "遠征", title: "異世界征服者", desc: "遠征異世界勝利 30 次。", stat: "rpg_wins", target: 30, reward: { type: "ENERGY", amount: 500 } },
  { key: "expedition_50", category: "遠征", title: "遠征指揮官", desc: "遠征異世界勝利 50 次。", stat: "rpg_wins", target: 50, reward: { type: "SCORE", amount: 750 } },
  { key: "expedition_100", category: "遠征", title: "異世界遠征王", desc: "遠征異世界勝利 100 次。", stat: "rpg_wins", target: 100, reward: { type: "ENERGY", amount: 1200 } },

  { key: "pvp_total_1", category: "對戰", title: "初入競技場", desc: "完成 PVP 對戰 1 次。", stat: "pvp_total", target: 1, reward: { type: "PVP_FRAGMENT", amount: 1 } },
  { key: "pvp_total_10", category: "對戰", title: "競技常客", desc: "完成 PVP 對戰 10 次。", stat: "pvp_total", target: 10, reward: { type: "SCORE", amount: 250 } },
  { key: "pvp_total_50", category: "對戰", title: "五十戰磨練", desc: "完成 PVP 對戰 50 次。", stat: "pvp_total", target: 50, reward: { type: "PVP_FRAGMENT", amount: 5 } },
  { key: "pvp_win_1", category: "對戰", title: "初次勝利", desc: "PVP 總勝場達 1 勝。", stat: "pvp_wins", target: 1, reward: { type: "PVP_FRAGMENT", amount: 1 } },
  { key: "pvp_win_10", category: "對戰", title: "競技場熟手", desc: "PVP 總勝場達 10 勝。", stat: "pvp_wins", target: 10, reward: { type: "SCORE", amount: 300 } },
  { key: "pvp_win_30", category: "對戰", title: "競技場霸主", desc: "PVP 總勝場達 30 勝。", stat: "pvp_wins", target: 30, reward: { type: "ENERGY", amount: 500 } },

  { key: "star_2", category: "養成", title: "第一次升星", desc: "任一角色達到 2 星。", stat: "max_star", target: 2, reward: { type: "ENERGY", amount: 150 } },
  { key: "star_5", category: "養成", title: "五星養成者", desc: "任一角色達到 5 星。", stat: "max_star", target: 5, reward: { type: "SKILL_EXP", amount: 180 } },
  { key: "star_10", category: "養成", title: "十星傳說", desc: "任一角色達到 10 星。", stat: "max_star", target: 10, reward: { type: "ENERGY", amount: 700 } },
  { key: "level_2", category: "養成", title: "第一次角色升級", desc: "任一角色達到 Lv.2。", stat: "max_level", target: 2, reward: { type: "SKILL_EXP", amount: 100 } },
  { key: "level_10", category: "養成", title: "Lv.10 訓練生", desc: "任一角色達到 Lv.10。", stat: "max_level", target: 10, reward: { type: "SCORE", amount: 260 } },
  { key: "level_30", category: "養成", title: "菁英訓練", desc: "任一角色達到 Lv.30。", stat: "max_level", target: 30, reward: { type: "SKILL_EXP", amount: 260 } },
  { key: "level_50", category: "養成", title: "滿級角色誕生", desc: "任一角色達到 Lv.50。", stat: "max_level", target: 50, reward: { type: "SCORE", amount: 900 } },
  { key: "skill_2", category: "養成", title: "第一次技能升級", desc: "任一角色技能達到 Lv.2。", stat: "max_skill", target: 2, reward: { type: "SCORE", amount: 250 } },
  { key: "skill_5", category: "養成", title: "技能專精", desc: "任一角色技能達到 Lv.5。", stat: "max_skill", target: 5, reward: { type: "SKILL_EXP", amount: 320 } },
  { key: "skill_10", category: "養成", title: "技能大師", desc: "任一角色技能達到 Lv.10。", stat: "max_skill", target: 10, reward: { type: "ENERGY", amount: 650 } }
];

function taipeiDateKeyFromIso(isoString) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(isoString));
    return `${parts.find(p => p.type === "year").value}${parts.find(p => p.type === "month").value}${parts.find(p => p.type === "day").value}`;
  } catch (_) {
    return "";
  }
}

async function countRowsForToday(sql, args = []) {
  const today = todayKeyTaipei();
  const rows = await queryAll(sql, args);
  return rows.filter(r => taipeiDateKeyFromIso(r.created_at) === today).length;
}

function rewardToText(reward) {
  if (!reward) return "無獎勵";
  if (reward.type === "DRAW_TIMES") return `抽卡次數 +${reward.amount}`;
  if (reward.type === "ENERGY") return `潮流能量 +${reward.amount}`;
  if (reward.type === "SCORE") return `訓練分數 +${reward.amount}`;
  if (reward.type === "SKILL_EXP") return `技能經驗 +${reward.amount}`;
  if (reward.type === "PVP_FRAGMENT") return `PVP 碎片 +${reward.amount}`;
  if (reward.type === "CARD") return `指定卡片【${reward.cardName}】x${reward.amount || 1}`;
  if (reward.type === "RANDOM_RARE_CARD") return `隨機 R 卡 x${reward.amount || 1}`;
  return "營運獎勵";
}

async function addCardRewardToPlayer(playerId, cardName, amount = 1, source = "任務獎勵") {
  const clean = String(cardName || "").trim();
  const card = await queryOne("SELECT * FROM cards WHERE name = ? LIMIT 1", [clean]);
  if (!card) throw new Error(`找不到卡片：${clean}`);
  const now = new Date().toISOString();
  const qty = Math.max(1, Math.floor(Number(amount || 1)));
  await execute(
    `INSERT INTO player_collection (player_id, card_id, card_name, quantity, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id, card_id) DO UPDATE SET quantity = player_collection.quantity + excluded.quantity, updated_at = excluded.updated_at`,
    [playerId, card.id, card.name, qty, now]
  );
  await execute(
    `INSERT INTO gacha_logs (player_id, card_id, card_name, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [playerId, card.id, card.name, source, `${source}：獲得 ${card.name} x${qty}`, now]
  );
  return `卡片【${card.name}】x${qty}`;
}

async function pickRandomRareCardName() {
  const rows = await queryAll(
    `SELECT name FROM cards
     WHERE is_drawable = 1 AND (UPPER(rarity) = 'R' OR UPPER(rarity) = 'RARE')
     ORDER BY sort_order ASC, name ASC`,
    []
  );
  if (!rows.length) {
    const fallback = await queryOne("SELECT name FROM cards WHERE is_drawable = 1 ORDER BY weight DESC, sort_order ASC LIMIT 1", []);
    if (!fallback) throw new Error("目前沒有可發放的卡片。");
    return fallback.name;
  }
  return rows[Math.floor(Math.random() * rows.length)].name;
}

async function applyPlayerReward(playerId, reward, sourceLabel = "任務獎勵") {
  const now = new Date().toISOString();
  const type = String(reward?.type || "").toUpperCase();
  const amount = Math.max(0, Math.floor(Number(reward?.amount || 0)));
  if (type === "DRAW_TIMES") {
    await getAssets(playerId);
    await execute("UPDATE player_assets SET draw_times = draw_times + ?, updated_at = ? WHERE player_id = ?", [amount, now, playerId]);
    return `抽卡次數 +${amount}`;
  }
  if (type === "ENERGY") {
    await getTrainingProfile(playerId);
    await execute("UPDATE training_profiles SET energy = energy + ?, updated_at = ? WHERE player_id = ?", [amount, now, playerId]);
    await insertTrainingLog(playerId, sourceLabel, 0, amount, `${sourceLabel}：潮流能量 +${amount}`, now);
    return `潮流能量 +${amount}`;
  }
  if (type === "SCORE") {
    const profile = await getTrainingProfile(playerId);
    const newScore = Number(profile.total_score || 0) + amount;
    const title = calculateTrainingTitle(newScore, Number(profile.streak || 0));
    await execute("UPDATE training_profiles SET total_score = ?, title = ?, updated_at = ? WHERE player_id = ?", [newScore, title, now, playerId]);
    await insertTrainingLog(playerId, sourceLabel, amount, 0, `${sourceLabel}：訓練分數 +${amount}`, now);
    return `訓練分數 +${amount}`;
  }
  if (type === "SKILL_EXP") {
    await getTrainingProfile(playerId);
    await execute("UPDATE training_profiles SET skill_exp = skill_exp + ?, updated_at = ? WHERE player_id = ?", [amount, now, playerId]);
    await insertTrainingLog(playerId, sourceLabel, 0, 0, `${sourceLabel}：技能經驗 +${amount}`, now);
    return `技能經驗 +${amount}`;
  }
  if (type === "POINTS") {
    const profile = await getTrainingProfile(playerId);
    const newScore = Number(profile.total_score || 0) + amount;
    const title = calculateTrainingTitle(newScore, Number(profile.streak || 0));
    await execute("UPDATE training_profiles SET total_score = ?, title = ?, updated_at = ? WHERE player_id = ?", [newScore, title, now, playerId]);
    await insertTrainingLog(playerId, sourceLabel, amount, 0, `${sourceLabel}：訓練總分 +${amount}`, now);
    return `訓練總分 +${amount}`;
  }
  if (type === "BATTLE_TICKET") {
    await getBattleDailyLimitStatus(playerId);
    await execute("UPDATE battle_daily_status SET bonus_challenge_count = bonus_challenge_count + ?, updated_at = ? WHERE player_id = ? AND date_key = ?", [amount, now, playerId, todayKeyTaipei()]);
    return `今日爭霸戰挑戰券 +${amount}`;
  }
  if (type === "RPG_TICKET") {
    await getRpgDailyLimitStatus(playerId);
    await execute("UPDATE rpg_daily_status SET bonus_expedition_count = bonus_expedition_count + ?, updated_at = ? WHERE player_id = ? AND date_key = ?", [amount, now, playerId, todayKeyTaipei()]);
    return `今日遠征券 +${amount}`;
  }
  if (type === "PVP_FRAGMENT") {
    await getOrCreatePvpPlayer(playerId);
    await execute("UPDATE pvp_players SET fragments = fragments + ?, updated_at = ? WHERE player_id = ?", [amount, now, playerId]);
    return `PVP 碎片 +${amount}`;
  }
  if (type === "ITEM") {
    return addPlayerItem(playerId, reward.itemKey || reward.cardName || ITEM_CARD_RESET_TICKET, amount || 1, sourceLabel);
  }
  if (type === "CARD") {
    return addCardRewardToPlayer(playerId, reward.cardName, reward.amount || 1, sourceLabel);
  }
  if (type === "RANDOM_RARE_CARD") {
    const cardName = await pickRandomRareCardName();
    return addCardRewardToPlayer(playerId, cardName, reward.amount || 1, sourceLabel);
  }
  return "已領取獎勵";
}

async function getMissionStats(playerId) {
  const today = todayKeyTaipei();
  const profile = await getTrainingProfile(playerId);
  const pvpDaily = await queryOne("SELECT * FROM pvp_daily_status WHERE player_id = ? AND date_key = ?", [playerId, today]);
  const gachaCount = await queryOne("SELECT COUNT(*) AS n FROM gacha_logs WHERE player_id = ?", [playerId]);
  const uniqueCount = await getCollectionUniqueCount(playerId);
  const battleClears = await queryOne("SELECT COUNT(*) AS n FROM battle_rewards WHERE player_id = ?", [playerId]);
  const rpgWins = await queryOne("SELECT COUNT(*) AS n FROM rpg_adventure_logs WHERE player_id = ? AND result = 'WIN'", [playerId]);
  const pvpAll = await queryOne("SELECT COUNT(*) AS n FROM pvp_logs WHERE player_id = ?", [playerId]);
  const maxStar = await queryOne("SELECT MAX(star) AS n FROM card_stars WHERE player_id = ?", [playerId]);
  const maxLevel = await queryOne("SELECT MAX(level) AS n FROM card_progression WHERE player_id = ?", [playerId]);
  const maxSkill = await queryOne("SELECT MAX(skill_level) AS n FROM card_progression WHERE player_id = ?", [playerId]);

  const bossToday = await countRowsForToday(
    "SELECT created_at FROM training_logs WHERE player_id = ? AND type = '潮流爭霸戰經驗' ORDER BY id DESC LIMIT 80",
    [playerId]
  );
  const rpgToday = await countRowsForToday(
    "SELECT created_at FROM rpg_adventure_logs WHERE player_id = ? ORDER BY id DESC LIMIT 80",
    [playerId]
  );
  const growthToday = await countRowsForToday(
    "SELECT created_at FROM training_logs WHERE player_id = ? AND type IN ('角色特訓消耗','技能升級','角色升星') ORDER BY id DESC LIMIT 80",
    [playerId]
  );
  const miniToday = await countRowsForToday(
    "SELECT created_at FROM training_logs WHERE player_id = ? AND type IN ('翻牌記憶','角色猜影子','今日潮流籤','每日問答') ORDER BY id DESC LIMIT 80",
    [playerId]
  );

  return {
    today,
    profile,
    daily: {
      daily_checkin: String(profile.last_checkin_date || "") === today ? 1 : 0,
      daily_boss: bossToday,
      daily_expedition: rpgToday,
      daily_pvp: Number(pvpDaily?.challenges || 0),
      daily_growth: growthToday,
      daily_minigame: miniToday
    },
    newbie: {
      first_gacha: Number(gachaCount?.n || 0),
      own_three_cards: Number(uniqueCount || 0),
      first_boss_clear: Number(battleClears?.n || 0),
      first_expedition_win: Number(rpgWins?.n || 0),
      first_pvp: Number(pvpAll?.n || 0),
      first_star: Number(maxStar?.n || 1),
      first_level: Number(maxLevel?.n || 1),
      first_skill: Number(maxSkill?.n || 1)
    }
  };
}

function buildMissionRows(defs, stats, claimedSet) {
  return defs.map(def => {
    const progress = Math.max(0, Math.floor(Number(stats[def.key] || 0)));
    const target = Math.max(1, Math.floor(Number(def.target || 1)));
    const claimed = claimedSet.has(def.key);
    return {
      key: def.key,
      title: def.title,
      desc: def.desc,
      progress,
      target,
      completed: progress >= target,
      claimed,
      claimable: progress >= target && !claimed,
      rewardText: rewardToText(def.reward)
    };
  });
}

async function getMissionDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const stats = await getMissionStats(player.id);
  const today = stats.today;

  const launchClaims = await queryAll("SELECT day_number, date_key, reward_summary, claimed_at FROM launch_reward_claims WHERE player_id = ? ORDER BY day_number ASC", [player.id]);
  const launchClaimed = new Map(launchClaims.map(r => [Number(r.day_number), r]));
  const claimedToday = launchClaims.some(r => String(r.date_key || "") === today);
  const openingRewards = OPENING_REWARDS.map(row => {
    const claimed = launchClaimed.has(row.day);
    const prevClaimed = row.day === 1 || launchClaimed.has(row.day - 1);
    return {
      day: row.day,
      title: row.title,
      desc: row.desc,
      rewardText: rewardToText(row.reward),
      claimed,
      claimable: !claimed && prevClaimed && !claimedToday,
      locked: !claimed && (!prevClaimed || claimedToday)
    };
  });

  const dailyClaims = await queryAll("SELECT mission_key FROM mission_reward_claims WHERE player_id = ? AND mission_group = 'daily' AND date_key = ?", [player.id, today]);
  const newbieClaims = await queryAll("SELECT mission_key FROM mission_reward_claims WHERE player_id = ? AND mission_group = 'newbie' AND date_key = ''", [player.id]);
  const dailyClaimedSet = new Set(dailyClaims.map(r => r.mission_key));
  const newbieClaimedSet = new Set(newbieClaims.map(r => r.mission_key));

  return {
    success: true,
    today,
    profile: publicFreeProfile(stats.profile),
    openingRewards,
    dailyMissions: buildMissionRows(DAILY_MISSION_DEFS, stats.daily, dailyClaimedSet),
    newbieMissions: buildMissionRows(NEWBIE_MISSION_DEFS, stats.newbie, newbieClaimedSet),
    note: "每日任務與新手任務不會發放抽卡次數；抽卡次數僅由開服7日福利、關卡、兌換碼或 GM 發放。"
  };
}

async function claimOpeningReward(uid, dayNumberInput) {
  const player = await getOrCreatePlayer(uid);
  const day = Math.floor(Number(dayNumberInput || 0));
  const rewardDef = OPENING_REWARDS.find(r => r.day === day);
  if (!rewardDef) return { success: false, msg: "找不到這一天的開服福利。" };

  return withTransaction(async () => {
    const today = todayKeyTaipei();
    const existing = await queryOne("SELECT day_number FROM launch_reward_claims WHERE player_id = ? AND day_number = ?", [player.id, day]);
    if (existing) return { success: false, msg: "這一天的開服福利已經領過了。", alreadyClaimed: true, day };
    if (day > 1) {
      const prev = await queryOne("SELECT day_number FROM launch_reward_claims WHERE player_id = ? AND day_number = ?", [player.id, day - 1]);
      if (!prev) return { success: false, msg: "請先領取前一天的開服福利。", day };
    }
    const todayClaim = await queryOne("SELECT day_number FROM launch_reward_claims WHERE player_id = ? AND date_key = ? LIMIT 1", [player.id, today]);
    if (todayClaim) return { success: false, msg: "今天已經領過一份開服福利，明天再繼續領。", day };

    const now = new Date().toISOString();
    const summary = await applyPlayerReward(player.id, rewardDef.reward, "開服7日福利");
    await execute("INSERT INTO launch_reward_claims (player_id, day_number, date_key, reward_summary, claimed_at) VALUES (?, ?, ?, ?, ?)", [player.id, day, today, summary, now]);
    const profile = await getTrainingProfile(player.id);
    return { success: true, msg: `已領取 ${rewardDef.title}：${summary}`, day, claimedDay: day, profile: publicFreeProfile(profile) };
  });
}

async function claimMissionReward(uid, groupInput, keyInput) {
  const player = await getOrCreatePlayer(uid);
  const group = String(groupInput || "").trim() === "newbie" ? "newbie" : "daily";
  const key = String(keyInput || "").trim();
  const defs = group === "daily" ? DAILY_MISSION_DEFS : NEWBIE_MISSION_DEFS;
  const def = defs.find(d => d.key === key);
  if (!def) return { success: false, msg: "找不到任務。" };

  return withTransaction(async () => {
    const stats = await getMissionStats(player.id);
    const statGroup = group === "daily" ? stats.daily : stats.newbie;
    const progress = Math.max(0, Math.floor(Number(statGroup[key] || 0)));
    const target = Math.max(1, Math.floor(Number(def.target || 1)));
    if (progress < target) {
      return { success: false, msg: "任務尚未完成。", group, key, progress, target };
    }

    const today = stats.today || todayKeyTaipei();
    const dateKey = group === "daily" ? today : "";
    const exists = await queryOne(
      "SELECT mission_key FROM mission_reward_claims WHERE player_id = ? AND mission_group = ? AND mission_key = ? AND date_key = ?",
      [player.id, group, key, dateKey]
    );
    if (exists) return { success: false, msg: "這個任務獎勵已經領取。", group, key, alreadyClaimed: true };

    const now = new Date().toISOString();
    const summary = await applyPlayerReward(player.id, def.reward, group === "daily" ? "每日任務" : "新手任務");
    await execute(
      "INSERT INTO mission_reward_claims (player_id, mission_group, mission_key, date_key, reward_summary, claimed_at) VALUES (?, ?, ?, ?, ?, ?)",
      [player.id, group, key, dateKey, summary, now]
    );
    const profile = await getTrainingProfile(player.id);
    return { success: true, msg: `任務獎勵已領取：${summary}`, group, key, claimedKey: key, profile: publicFreeProfile(profile) };
  });
}

async function getAchievementStats(playerId) {
  const stats = await getMissionStats(playerId);
  const pvp = await queryOne("SELECT total_wins FROM pvp_players WHERE player_id = ?", [playerId]);
  const collectionQty = await queryOne("SELECT COALESCE(SUM(quantity), 0) AS n FROM player_collection WHERE player_id = ?", [playerId]);
  const totalCollectibleCards = await getTotalCollectibleCards();
  const totalBossRow = await queryOne("SELECT COUNT(*) AS n FROM boss_stages", []);
  return {
    unique_cards: Number(stats.newbie.own_three_cards || 0),
    total_cards: Number(collectionQty?.n || 0),
    gacha_total: Number(stats.newbie.first_gacha || 0),
    boss_clears: Number(stats.newbie.first_boss_clear || 0),
    rpg_wins: Number(stats.newbie.first_expedition_win || 0),
    pvp_total: Number(stats.newbie.first_pvp || 0),
    pvp_wins: Number(pvp?.total_wins || 0),
    max_star: Number(stats.newbie.first_star || 1),
    max_level: Number(stats.newbie.first_level || 1),
    max_skill: Number(stats.newbie.first_skill || 1),
    total_collectible_cards: Number(totalCollectibleCards || 0),
    total_boss_stages: Number(totalBossRow?.n || 0)
  };
}

function buildAchievementRows(defs, stats, claimedSet) {
  return defs.map(def => {
    const progress = Math.max(0, Math.floor(Number(stats[def.stat] || 0)));
    let rawTarget = def.target;
    if (rawTarget === "TOTAL_COLLECTIBLE_CARDS") rawTarget = stats.total_collectible_cards;
    if (rawTarget === "TOTAL_BOSS_STAGES") rawTarget = stats.total_boss_stages;
    const target = Math.max(1, Math.floor(Number(rawTarget || 1)));
    const claimed = claimedSet.has(def.key);
    return {
      key: def.key,
      category: def.category,
      title: def.title,
      desc: def.desc,
      progress,
      target,
      completed: progress >= target,
      claimed,
      claimable: progress >= target && !claimed,
      rewardText: rewardToText(def.reward)
    };
  });
}

async function getAchievementDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const stats = await getAchievementStats(player.id);
  const claims = await queryAll("SELECT achievement_key FROM achievement_claims WHERE player_id = ?", [player.id]);
  const claimedSet = new Set(claims.map(r => r.achievement_key));
  const rows = buildAchievementRows(ACHIEVEMENT_DEFS, stats, claimedSet);
  const total = rows.length;
  const claimedCount = rows.filter(r => r.claimed).length;
  const completedCount = rows.filter(r => r.completed).length;
  return {
    success: true,
    stats,
    total,
    claimedCount,
    completedCount,
    achievements: rows,
    note: "成就系統不發放抽卡次數，主要提供潮流能量、技能經驗、訓練分數與 PVP 碎片。"
  };
}

async function claimAchievementReward(uid, keyInput) {
  const player = await getOrCreatePlayer(uid);
  const key = String(keyInput || "").trim();
  const def = ACHIEVEMENT_DEFS.find(d => d.key === key);
  if (!def) return { success: false, msg: "找不到這個成就。" };

  return withTransaction(async () => {
    const stats = await getAchievementStats(player.id);
    const progress = Math.max(0, Math.floor(Number(stats[def.stat] || 0)));
    let rawTarget = def.target;
    if (rawTarget === "TOTAL_COLLECTIBLE_CARDS") rawTarget = stats.total_collectible_cards;
    if (rawTarget === "TOTAL_BOSS_STAGES") rawTarget = stats.total_boss_stages;
    const target = Math.max(1, Math.floor(Number(rawTarget || 1)));
    if (progress < target) return { success: false, msg: "成就尚未完成。", key, progress, target };

    const exists = await queryOne("SELECT achievement_key FROM achievement_claims WHERE player_id = ? AND achievement_key = ?", [player.id, key]);
    if (exists) return { success: false, msg: "這個成就獎勵已經領取。", key, alreadyClaimed: true };

    const now = new Date().toISOString();
    const summary = await applyPlayerReward(player.id, def.reward, "成就獎勵");
    await execute(
      "INSERT INTO achievement_claims (player_id, achievement_key, reward_summary, claimed_at) VALUES (?, ?, ?, ?)",
      [player.id, key, summary, now]
    );
    const profile = await getTrainingProfile(player.id);
    return { success: true, msg: `成就獎勵已領取：${summary}`, key, claimedKey: key, profile: publicFreeProfile(profile) };
  });
}



// =========================
// GM ADMIN PANEL API
// =========================
const ADMIN_SESSION_HOURS = 12;

const ADMIN_SESSION_CACHE_TTL_MS = Number(process.env.ADMIN_SESSION_CACHE_TTL_MS || 30000);
const ADMIN_SESSION_TOUCH_INTERVAL_MS = Number(process.env.ADMIN_SESSION_TOUCH_INTERVAL_MS || 300000);
const ADMIN_SESSION_CACHE = new Map();

function getCachedAdminSession(token) {
  const cached = ADMIN_SESSION_CACHE.get(token);
  if (!cached) return null;
  const now = Date.now();
  if (cached.cacheUntil <= now) {
    ADMIN_SESSION_CACHE.delete(token);
    return null;
  }
  if (new Date(String(cached.admin.expires_at)).getTime() < now) {
    ADMIN_SESSION_CACHE.delete(token);
    return null;
  }
  return cached.admin;
}

function setCachedAdminSession(token, admin) {
  ADMIN_SESSION_CACHE.set(token, {
    admin,
    cacheUntil: Date.now() + ADMIN_SESSION_CACHE_TTL_MS
  });
}

function clearAdminSessionCache(token) {
  if (token) ADMIN_SESSION_CACHE.delete(String(token || "").trim());
  else ADMIN_SESSION_CACHE.clear();
}


function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function clampInt(value, min = 0, max = 999999999) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) throw new Error("請輸入有效數字。");
  return Math.max(min, Math.min(max, n));
}

function publicAdmin(admin) {
  return {
    username: admin.username,
    displayName: admin.display_name || admin.username,
    role: admin.role || "GM",
    lastLoginAt: admin.last_login_at || ""
  };
}

function getAdminToken(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String((req.body && (req.body.adminToken || req.body.authToken)) || "").trim();
}

function adminExpiryDate() {
  const d = new Date();
  d.setHours(d.getHours() + ADMIN_SESSION_HOURS);
  return d;
}

async function createAdminSession(adminId) {
  const now = new Date().toISOString();
  const expiresAt = adminExpiryDate().toISOString();
  const token = crypto.randomBytes(32).toString("hex");
  await execute(
    `INSERT INTO admin_sessions (token, admin_id, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?)`,
    [token, adminId, now, expiresAt, now]
  );
  return { token, expiresAt };
}

async function getAdminBySessionToken(token) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return null;

  const cached = getCachedAdminSession(cleanToken);
  if (cached) return cached;

  const row = await queryOne(
    `SELECT s.token, s.expires_at, s.last_used_at, a.*
     FROM admin_sessions s
     JOIN admin_users a ON a.id = s.admin_id
     WHERE s.token = ?
     LIMIT 1`,
    [cleanToken]
  );
  if (!row) return null;
  if (new Date(String(row.expires_at)).getTime() < Date.now()) {
    await execute("DELETE FROM admin_sessions WHERE token = ?", [cleanToken]);
    clearAdminSessionCache(cleanToken);
    return null;
  }

  const lastUsedMs = new Date(String(row.last_used_at || row.created_at || 0)).getTime() || 0;
  if (Date.now() - lastUsedMs > ADMIN_SESSION_TOUCH_INTERVAL_MS) {
    const touchedAt = new Date().toISOString();
    await execute("UPDATE admin_sessions SET last_used_at = ? WHERE token = ?", [touchedAt, cleanToken]);
    row.last_used_at = touchedAt;
  }

  setCachedAdminSession(cleanToken, row);
  return row;
}

async function requireAdmin(req) {
  const token = getAdminToken(req);
  const admin = await getAdminBySessionToken(token);
  if (!admin) {
    const err = new Error("請先登入 GM 後台。");
    err.statusCode = 401;
    throw err;
  }
  return { token, admin };
}

async function adminAudit(adminId, action, targetUid, detail) {
  await execute(
    `INSERT INTO admin_audit_logs (admin_id, action, target_uid, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [adminId || null, String(action || ""), targetUid || null, safeJson(detail || {}), new Date().toISOString()]
  );
}

async function findPlayerByUidLoose(uidInput) {
  const uid = normalizeUid(uidInput);
  const player = await queryOne("SELECT * FROM players WHERE LOWER(uid) = LOWER(?) LIMIT 1", [uid]);
  if (!player) throw new Error("找不到玩家：" + uid);
  return player;
}

async function adminLogin(usernameInput, passwordInput) {
  const username = String(usernameInput || "").trim();
  const password = String(passwordInput || "");
  if (!username || !password) return { success: false, msg: "請輸入 GM 帳號與密碼。" };

  const admin = await queryOne("SELECT * FROM admin_users WHERE username = ? LIMIT 1", [username]);
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    return { success: false, msg: "GM 帳號或密碼錯誤。" };
  }

  const now = new Date().toISOString();
  await execute("UPDATE admin_users SET last_login_at = ? WHERE id = ?", [now, admin.id]);
  const fresh = await queryOne("SELECT * FROM admin_users WHERE id = ?", [admin.id]);
  const session = await createAdminSession(admin.id);
  await adminAudit(admin.id, "GM_LOGIN", null, { username });

  return {
    success: true,
    msg: "GM 登入成功",
    token: session.token,
    expiresAt: session.expiresAt,
    admin: publicAdmin(fresh)
  };
}

async function adminLogout(adminCtx) {
  await execute("DELETE FROM admin_sessions WHERE token = ?", [adminCtx.token]);
  clearAdminSessionCache(adminCtx.token);
  await adminAudit(adminCtx.admin.id, "GM_LOGOUT", null, { username: adminCtx.admin.username });
  return { success: true, msg: "GM 已登出" };
}

async function adminMe(adminCtx) {
  return { success: true, admin: publicAdmin(adminCtx.admin) };
}

async function adminChangeOwnPassword(adminCtx, oldPasswordInput, newPasswordInput) {
  const oldPassword = String(oldPasswordInput || "");
  const newPassword = validatePassword(newPasswordInput);
  const admin = await queryOne("SELECT * FROM admin_users WHERE id = ?", [adminCtx.admin.id]);
  if (!admin || !verifyPassword(oldPassword, admin.password_hash)) {
    return { success: false, msg: "原 GM 密碼錯誤。" };
  }
  await execute("UPDATE admin_users SET password_hash = ? WHERE id = ?", [hashPassword(newPassword), admin.id]);
  await execute("DELETE FROM admin_sessions WHERE admin_id = ? AND token <> ?", [admin.id, adminCtx.token]);
  clearAdminSessionCache();
  await adminAudit(admin.id, "GM_CHANGE_OWN_PASSWORD", null, { username: admin.username });
  return { success: true, msg: "GM 密碼已更新。" };
}

async function adminSearchPlayers(adminCtx, keywordInput) {
  const keyword = String(keywordInput || "").trim();
  const like = `%${keyword}%`;
  const rows = await queryAll(
    `SELECT p.id, p.uid, p.display_name, p.created_at, p.last_login_at,
            COALESCE(a.draw_times, 0) AS draw_times,
            COALESCE(t.total_score, 0) AS total_score,
            COALESCE(t.energy, 0) AS energy,
            COALESCE(b.current_stage_id, 1) AS current_stage_id,
            COALESCE(v.total_wins, 0) AS total_wins,
            COALESCE(v.total_losses, 0) AS total_losses
     FROM players p
     LEFT JOIN player_assets a ON a.player_id = p.id
     LEFT JOIN training_profiles t ON t.player_id = p.id
     LEFT JOIN battle_progress b ON b.player_id = p.id
     LEFT JOIN pvp_players v ON v.player_id = p.id
     WHERE (? = '' OR p.uid LIKE ? OR p.display_name LIKE ?)
     ORDER BY COALESCE(p.last_login_at, p.created_at) DESC
     LIMIT 30`,
    [keyword, like, like]
  );
  return { success: true, rows: rows.map(r => ({
    uid: r.uid,
    displayName: r.display_name || r.uid,
    drawTimes: Number(r.draw_times || 0),
    totalScore: Number(r.total_score || 0),
    energy: Number(r.energy || 0),
    currentStageId: Number(r.current_stage_id || 1),
    totalWins: Number(r.total_wins || 0),
    totalLosses: Number(r.total_losses || 0),
    createdAt: r.created_at || "",
    lastLoginAt: r.last_login_at || ""
  })) };
}

async function adminGetPlayer(adminCtx, uidInput) {
  const player = await findPlayerByUidLoose(uidInput);
  const assets = await getAssets(player.id);
  const training = await queryOne("SELECT * FROM training_profiles WHERE player_id = ?", [player.id]);
  const pvp = await queryOne("SELECT * FROM pvp_players WHERE player_id = ?", [player.id]);
  const battle = await queryOne("SELECT * FROM battle_progress WHERE player_id = ?", [player.id]);
  const collection = await queryAll(
    `SELECT pc.card_name, pc.quantity, c.rarity, c.sort_order, COALESCE(cs.star, 1) AS star
     FROM player_collection pc
     LEFT JOIN cards c ON c.id = pc.card_id
     LEFT JOIN card_stars cs ON cs.player_id = pc.player_id AND cs.card_id = pc.card_id
     WHERE pc.player_id = ? AND pc.quantity > 0
     ORDER BY COALESCE(c.sort_order, 9999), pc.card_name`,
    [player.id]
  );
  const gachaLogs = await queryAll(
    `SELECT card_name, source, note, created_at FROM gacha_logs
     WHERE player_id = ? ORDER BY id DESC LIMIT 20`,
    [player.id]
  );
  const trainingLogs = await queryAll(
    `SELECT type, score, energy, note, created_at FROM training_logs
     WHERE player_id = ? ORDER BY id DESC LIMIT 20`,
    [player.id]
  );
  const pvpLogs = await queryAll(
    `SELECT my_card, opponent_masked_uid, opponent_card, my_power, opponent_power, result, reward, created_at FROM pvp_logs
     WHERE player_id = ? ORDER BY id DESC LIMIT 20`,
    [player.id]
  );

  return {
    success: true,
    player: {
      uid: player.uid,
      displayName: player.display_name || player.uid,
      recoveryCode: player.recovery_code || "",
      createdAt: player.created_at || "",
      lastLoginAt: player.last_login_at || "",
      mustChangePassword: Number(player.must_change_password || 0) === 1
    },
    assets: {
      drawTimes: Number(assets.draw_times || 0),
      trendEnergy: Number(assets.trend_energy || 0),
      totalTopup: Number(assets.total_topup || 0),
      availablePoints: Number(assets.available_points || 0),
      totalPoints: Number(assets.total_points || 0),
      usedPoints: Number(assets.used_points || 0),
      updatedAt: assets.updated_at || ""
    },
    training: training ? {
      energy: Number(training.energy || 0),
      totalScore: Number(training.total_score || 0),
      streak: Number(training.streak || 0),
      skillExp: Number(training.skill_exp || 0),
      title: training.title || "潮流新人",
      maxMemoryScore: Number(training.max_memory_score || 0),
      updatedAt: training.updated_at || ""
    } : null,
    pvp: pvp ? {
      representativeCardName: pvp.representative_card_name || "",
      representativePower: Number(pvp.representative_power || 0),
      fragments: Number(pvp.fragments || 0),
      totalWins: Number(pvp.total_wins || 0),
      totalLosses: Number(pvp.total_losses || 0)
    } : null,
    battle: battle ? { currentStageId: Number(battle.current_stage_id || 1), updatedAt: battle.updated_at || "" } : null,
    collection: collection.map(c => ({
      cardName: c.card_name,
      quantity: Number(c.quantity || 0),
      rarity: c.rarity || "NORMAL",
      star: Number(c.star || 1)
    })),
    logs: { gachaLogs, trainingLogs, pvpLogs }
  };
}

async function adminUpdateDrawTimes(adminCtx, uidInput, drawTimesInput, noteInput) {
  const player = await findPlayerByUidLoose(uidInput);
  const oldAsset = await getAssets(player.id);
  const oldValue = Number(oldAsset.draw_times || 0);
  const newValue = clampInt(drawTimesInput, 0, 999999999);
  const now = new Date().toISOString();
  await execute("UPDATE player_assets SET draw_times = ?, updated_at = ? WHERE player_id = ?", [newValue, now, player.id]);
  await adminAudit(adminCtx.admin.id, "UPDATE_DRAW_TIMES", player.uid, { oldValue, newValue, note: String(noteInput || "") });
  return { success: true, msg: `已把 ${player.uid} 的抽卡次數改成 ${newValue}`, oldValue, newValue, player: await adminGetPlayer(adminCtx, player.uid) };
}

async function adminAddDrawTimes(adminCtx, uidInput, deltaInput, noteInput) {
  const player = await findPlayerByUidLoose(uidInput);
  const oldAsset = await getAssets(player.id);
  const oldValue = Number(oldAsset.draw_times || 0);
  const delta = clampInt(deltaInput, -999999999, 999999999);
  const newValue = Math.max(0, oldValue + delta);
  const now = new Date().toISOString();
  await execute("UPDATE player_assets SET draw_times = ?, updated_at = ? WHERE player_id = ?", [newValue, now, player.id]);
  await adminAudit(adminCtx.admin.id, "ADD_DRAW_TIMES", player.uid, { oldValue, delta, newValue, note: String(noteInput || "") });
  return { success: true, msg: `已把 ${player.uid} 的抽卡次數由 ${oldValue} 調整為 ${newValue}`, oldValue, delta, newValue, player: await adminGetPlayer(adminCtx, player.uid) };
}

async function adminUpdateTraining(adminCtx, uidInput, patchInput, noteInput) {
  const player = await findPlayerByUidLoose(uidInput);
  await execute("INSERT OR IGNORE INTO training_profiles (player_id, energy, total_score, streak, daily_key, title, updated_at) VALUES (?, 0, 0, 0, '', '潮流新人', ?)", [player.id, new Date().toISOString()]);
  const old = await queryOne("SELECT * FROM training_profiles WHERE player_id = ?", [player.id]);
  const patch = patchInput && typeof patchInput === "object" ? patchInput : {};
  const energy = patch.energy === undefined || patch.energy === "" ? Number(old.energy || 0) : clampInt(patch.energy, 0, 999999999);
  const totalScore = patch.totalScore === undefined || patch.totalScore === "" ? Number(old.total_score || 0) : clampInt(patch.totalScore, 0, 999999999);
  const streak = patch.streak === undefined || patch.streak === "" ? Number(old.streak || 0) : clampInt(patch.streak, 0, 999999999);
  const title = String(patch.title || calculateTrainingTitle(totalScore, streak)).trim().slice(0, 40) || calculateTrainingTitle(totalScore, streak);
  const now = new Date().toISOString();
  await execute("UPDATE training_profiles SET energy = ?, total_score = ?, streak = ?, title = ?, updated_at = ? WHERE player_id = ?", [energy, totalScore, streak, title, now, player.id]);
  await adminAudit(adminCtx.admin.id, "UPDATE_TRAINING", player.uid, { old: { energy: Number(old.energy || 0), totalScore: Number(old.total_score || 0), streak: Number(old.streak || 0), title: old.title }, newValue: { energy, totalScore, streak, title }, note: String(noteInput || "") });
  return { success: true, msg: `已更新 ${player.uid} 的訓練/排行榜資料`, player: await adminGetPlayer(adminCtx, player.uid) };
}


async function adminGrantSkillExp(adminCtx, uidInput, amountInput, noteInput) {
  const player = await findPlayerByUidLoose(uidInput);
  await getTrainingProfile(player.id);
  const old = await queryOne("SELECT skill_exp FROM training_profiles WHERE player_id = ?", [player.id]);
  const oldValue = Number(old?.skill_exp || 0);
  const delta = clampInt(amountInput, -999999999, 999999999);
  if (delta === 0) throw new Error("請輸入要發放或扣除的技能經驗數量。");
  const newValue = Math.max(0, oldValue + delta);
  const now = new Date().toISOString();
  await execute("UPDATE training_profiles SET skill_exp = ?, updated_at = ? WHERE player_id = ?", [newValue, now, player.id]);
  await insertTrainingLog(player.id, delta >= 0 ? "GM發放技能經驗" : "GM扣除技能經驗", 0, 0, `GM調整技能經驗：${delta >= 0 ? "+" : ""}${delta}，目前 ${newValue}。${String(noteInput || "")}`, now);
  await adminAudit(adminCtx.admin.id, "GRANT_SKILL_EXP", player.uid, { oldValue, delta, newValue, note: String(noteInput || "") });
  return { success: true, msg: `已將 ${player.uid} 的技能經驗由 ${oldValue} 調整為 ${newValue}`, oldValue, delta, newValue, player: await adminGetPlayer(adminCtx, player.uid) };
}

async function adminSetCardQuantity(adminCtx, uidInput, cardNameInput, quantityInput, noteInput) {
  const player = await findPlayerByUidLoose(uidInput);
  const cardName = String(cardNameInput || "").trim();
  if (!cardName) throw new Error("請輸入卡片名稱。");
  const card = await queryOne("SELECT * FROM cards WHERE name = ? LIMIT 1", [cardName]);
  if (!card) throw new Error("找不到卡片：" + cardName);
  const quantity = clampInt(quantityInput, 0, 999999999);
  const old = await queryOne("SELECT quantity FROM player_collection WHERE player_id = ? AND card_id = ?", [player.id, card.id]);
  const oldValue = Number(old?.quantity || 0);
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO player_collection (player_id, card_id, card_name, quantity, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id, card_id)
     DO UPDATE SET card_name = excluded.card_name, quantity = excluded.quantity, updated_at = excluded.updated_at`,
    [player.id, card.id, card.name, quantity, now]
  );
  if (quantity <= 0) {
    await execute("DELETE FROM card_stars WHERE player_id = ? AND card_id = ?", [player.id, card.id]);
  }
  await adminAudit(adminCtx.admin.id, "SET_CARD_QUANTITY", player.uid, { cardName: card.name, oldValue, newValue: quantity, note: String(noteInput || "") });
  return { success: true, msg: `已把 ${player.uid} 的「${card.name}」數量改成 ${quantity}`, player: await adminGetPlayer(adminCtx, player.uid) };
}


async function adminGiftCard(adminCtx, uidInput, cardNameInput, quantityInput, noteInput) {
  const player = await findPlayerByUidLoose(uidInput);
  const cardName = String(cardNameInput || "").trim();
  if (!cardName) throw new Error("請選擇要贈與的卡片。");
  const card = await queryOne("SELECT * FROM cards WHERE name = ? LIMIT 1", [cardName]);
  if (!card) throw new Error("找不到卡片：" + cardName);

  const qty = clampInt(quantityInput, 1, 999999999);
  const old = await queryOne("SELECT quantity FROM player_collection WHERE player_id = ? AND card_id = ?", [player.id, card.id]);
  const oldValue = Number(old?.quantity || 0);
  const newValue = oldValue + qty;
  const now = new Date().toISOString();

  await execute(
    `INSERT INTO player_collection (player_id, card_id, card_name, quantity, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id, card_id)
     DO UPDATE SET card_name = excluded.card_name, quantity = player_collection.quantity + excluded.quantity, updated_at = excluded.updated_at`,
    [player.id, card.id, card.name, qty, now]
  );

  await adminAudit(adminCtx.admin.id, "GIFT_CARD", player.uid, {
    cardName: card.name,
    quantity: qty,
    oldValue,
    newValue,
    note: String(noteInput || "")
  });

  return {
    success: true,
    msg: `已贈與 ${player.uid}「${card.name}」x${qty}，目前持有 ${newValue} 張。`,
    oldValue,
    quantity: qty,
    newValue,
    player: await adminGetPlayer(adminCtx, player.uid)
  };
}

async function adminResetPlayerPassword(adminCtx, uidInput, newPasswordInput, noteInput) {
  const player = await findPlayerByUidLoose(uidInput);
  const newPassword = validatePassword(newPasswordInput);
  const now = new Date().toISOString();
  await execute("UPDATE players SET password_hash = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?", [hashPassword(newPassword), now, player.id]);
  await execute("DELETE FROM player_sessions WHERE player_id = ?", [player.id]);
  await adminAudit(adminCtx.admin.id, "RESET_PLAYER_PASSWORD", player.uid, { forceChange: true, note: String(noteInput || "") });
  return { success: true, msg: `已重設 ${player.uid} 的密碼，該玩家重新登入後會被提醒更改密碼。` };
}

async function adminListCards(adminCtx) {
  const rows = await queryAll("SELECT id, name, rarity, weight, image_url, is_drawable, sort_order FROM cards ORDER BY sort_order ASC, name ASC", []);
  return { success: true, rows: rows.map(c => ({
    id: c.id,
    name: c.name,
    rarity: c.rarity,
    weight: Number(c.weight || 0),
    imageUrl: normalizeCardImageUrl(c.image_url || "", c.name),
    image_url: normalizeCardImageUrl(c.image_url || "", c.name),
    isDrawable: Number(c.is_drawable || 0) === 1,
    sortOrder: Number(c.sort_order || 0)
  })) };
}


function normalizeCardId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 50);
}

async function makeNextCardId() {
  const raw = "CARD_" + Date.now().toString(36).toUpperCase();
  let candidate = raw;
  let i = 1;
  while (await queryOne("SELECT id FROM cards WHERE id = ? LIMIT 1", [candidate])) {
    candidate = raw + "_" + i;
    i += 1;
  }
  return candidate;
}

function normalizeCardRarity(value) {
  const rarity = String(value || "NORMAL").trim().toUpperCase();
  const allowed = new Set(["NORMAL", "RARE", "SUPER RARE", "SSR", "UR", "BOSS"]);
  if (allowed.has(rarity)) return rarity;
  return rarity.slice(0, 40) || "NORMAL";
}

async function adminUpsertCard(adminCtx, input) {
  const data = input && typeof input === "object" ? input : {};
  const name = String(data.name || "").trim().slice(0, 80);
  if (!name) throw new Error("請輸入卡片名稱。");

  const existingByName = await queryOne("SELECT * FROM cards WHERE name = ? LIMIT 1", [name]);
  let cardId = normalizeCardId(data.id || data.cardId || "");
  if (!cardId) {
    cardId = existingByName ? existingByName.id : await makeNextCardId();
  }

  const existingById = await queryOne("SELECT * FROM cards WHERE id = ? LIMIT 1", [cardId]);
  if (existingById && existingById.name !== name) {
    throw new Error(`卡片 ID「${cardId}」已被「${existingById.name}」使用，請換一個 ID。`);
  }

  const rarity = normalizeCardRarity(data.rarity);
  const weight = clampInt(data.weight ?? 0, 0, 999999999);
  const imageUrl = normalizeCardImageUrl(data.imageUrl || data.image_url || data.imgUrl || data.img || data.image || "", name).slice(0, 500);
  const isDrawable = data.isDrawable === false || data.isDrawable === 0 || data.isDrawable === "0" ? 0 : 1;
  const maxSort = await queryOne("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM cards", []);
  const defaultSort = Number(maxSort?.max_sort || 0) + 1;
  const sortOrder = data.sortOrder === undefined || data.sortOrder === "" ? (existingByName ? Number(existingByName.sort_order || 0) : defaultSort) : clampInt(data.sortOrder, 0, 999999999);

  await execute(
    `INSERT INTO cards (id, name, rarity, weight, image_url, is_drawable, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       rarity = excluded.rarity,
       weight = excluded.weight,
       image_url = excluded.image_url,
       is_drawable = excluded.is_drawable,
       sort_order = excluded.sort_order`,
    [cardId, name, rarity, weight, imageUrl, isDrawable, sortOrder]
  );

  await adminAudit(adminCtx.admin.id, existingByName ? "UPDATE_CARD" : "CREATE_CARD", null, {
    old: existingByName || null,
    newValue: { id: cardId, name, rarity, weight, imageUrl, isDrawable: isDrawable === 1, sortOrder }
  });

  return { success: true, msg: existingByName ? `已更新卡片：${name}` : `已新增卡片：${name}`, cards: await adminListCards(adminCtx) };
}

async function adminUpdateCardSettings(adminCtx, cardNameInput, patchInput, noteInput) {
  const cardName = String(cardNameInput || "").trim();
  if (!cardName) throw new Error("請輸入卡片名稱。");
  const card = await queryOne("SELECT * FROM cards WHERE name = ? LIMIT 1", [cardName]);
  if (!card) throw new Error("找不到卡片：" + cardName);
  const patch = patchInput && typeof patchInput === "object" ? patchInput : {};
  const weight = patch.weight === undefined || patch.weight === "" ? Number(card.weight || 0) : clampInt(patch.weight, 0, 999999999);
  const isDrawable = patch.isDrawable === undefined ? Number(card.is_drawable || 0) : (patch.isDrawable ? 1 : 0);
  await execute("UPDATE cards SET weight = ?, is_drawable = ? WHERE id = ?", [weight, isDrawable, card.id]);
  await adminAudit(adminCtx.admin.id, "UPDATE_CARD_SETTINGS", null, { cardName: card.name, old: { weight: Number(card.weight || 0), isDrawable: Number(card.is_drawable || 0) === 1 }, newValue: { weight, isDrawable: isDrawable === 1 }, note: String(noteInput || "") });
  return { success: true, msg: `已更新「${card.name}」卡池設定`, cards: await adminListCards(adminCtx) };
}


function normalizeDungeonKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 60);
}


function normalizeRpgChapterKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 60);
}

function normalizeRpgUnlockType(value) {
  const v = String(value || "NONE").trim().toUpperCase();
  if (["NONE", "BATTLE_STAGE", "RPG_DUNGEON"].includes(v)) return v;
  return "NONE";
}

function publicRpgChapter(row) {
  return {
    key: row.key,
    chapterKey: row.key,
    name: row.name || "異世界入口",
    description: row.description || "",
    sortOrder: Number(row.sort_order || 0),
    isActive: Number(row.is_active || 0) === 1,
    unlockType: normalizeRpgUnlockType(row.unlock_type || "NONE"),
    unlockValue: String(row.unlock_value || "")
  };
}

function publicRpgDungeon(row, unlockInfo = {}) {
  const bossName = row.boss_card_name || row.name;
  const meta = getCardBattleMeta(bossName, row.boss_rarity || row.rarity || "BOSS");
  const bossImageUrl = row.boss_image_url || row.image_url ? normalizeCardImageUrl(row.boss_image_url || row.image_url, bossName) : "";
  return {
    key: row.key,
    name: row.name,
    description: row.description || "",
    chapterKey: row.chapter_key || "isekai_entry",
    chapterName: row.chapter_name || "異世界入口",
    stageOrder: Number(row.stage_order || row.sort_order || 0),
    sortOrder: Number(row.sort_order || 0),
    unlockType: normalizeRpgUnlockType(row.unlock_type || "NONE"),
    unlockValue: String(row.unlock_value || ""),
    bossCardName: bossName,
    bossName,
    bossImageUrl,
    boss_image_url: bossImageUrl,
    imageUrl: bossImageUrl,
    image_url: bossImageUrl,
    requiredPower: Number(row.required_power || 0),
    rewardScore: Number(row.reward_score || 0),
    rewardEnergy: Number(row.reward_energy || 0),
    rewardDrawChance: Number(row.reward_draw_chance || 0),
    rewardDrawTimes: Number(row.reward_draw_times || 0),
    isActive: Number(row.is_active || 0) === 1,
    cleared: !!unlockInfo.cleared,
    unlocked: unlockInfo.unlocked !== false,
    locked: unlockInfo.unlocked === false,
    lockReason: unlockInfo.lockReason || "",
    element: meta.element,
    elementIcon: meta.elementIcon,
    elementLabel: meta.elementLabel,
    skillName: meta.skillName
  };
}

async function getRpgUnlockContext(playerId) {
  const battleRows = await queryAll("SELECT stage_id FROM battle_rewards WHERE player_id = ?", [playerId]);
  const rpgRows = await queryAll("SELECT DISTINCT dungeon_key FROM rpg_adventure_logs WHERE player_id = ? AND result = 'WIN'", [playerId]);
  return {
    battleClears: new Set(battleRows.map(r => Number(r.stage_id || 0)).filter(Boolean)),
    rpgWins: new Set(rpgRows.map(r => String(r.dungeon_key || "")).filter(Boolean))
  };
}

function checkRpgUnlock(entity, ctx, label) {
  const type = normalizeRpgUnlockType(entity && entity.unlock_type);
  const rawValue = String((entity && entity.unlock_value) || "").trim();
  if (type === "NONE") return { unlocked: true, lockReason: "" };
  if (type === "BATTLE_STAGE") {
    const stageId = Number(rawValue || 0);
    if (stageId > 0 && ctx.battleClears.has(stageId)) return { unlocked: true, lockReason: "" };
    return { unlocked: false, lockReason: `需先通關爭霸戰第 ${stageId || "指定"} 關，才能進入${label || "此區域"}。` };
  }
  if (type === "RPG_DUNGEON") {
    if (rawValue && ctx.rpgWins.has(rawValue)) return { unlocked: true, lockReason: "" };
    return { unlocked: false, lockReason: `需先通關指定遠征關卡，才能進入${label || "此區域"}。` };
  }
  return { unlocked: true, lockReason: "" };
}

async function getActiveRpgChapters() {
  const rows = await queryAll(
    `SELECT * FROM rpg_chapters
     WHERE is_active = 1
     ORDER BY sort_order ASC, name ASC, key ASC`,
    []
  );
  if (rows.length) return rows;
  return [{ key: "isekai_entry", name: "異世界入口", description: "尚未建立異世界章節，系統暫時使用預設入口。", sort_order: 1, is_active: 1, unlock_type: "NONE", unlock_value: "" }];
}


async function adminListBattleChapters(adminCtx) {
  const rows = await getBattleChapterAdminRows(true);
  return { success: true, rows: rows.map((r, idx) => ({
    ...publicBattleChapter(r, idx + 1),
    createdAt: r.created_at || "",
    updatedAt: r.updated_at || ""
  })) };
}
async function adminUpsertBattleChapter(adminCtx, input) {
  const data = input && typeof input === "object" ? input : {};
  const name = String(data.name || "").trim().slice(0, 80);
  if (!name) throw new Error("請輸入爭霸戰章節名稱。");
  const key = normalizeBattleChapterKey(data.key || data.chapterKey || name);
  if (!key) throw new Error("章節 Key 無效，請使用英文、數字、底線或連字號。");
  const mode = normalizeBattleMode(data.mode);
  const modeLabel = String(data.modeLabel || data.mode_label || battleModeLabel(mode)).trim().slice(0, 20);
  const description = String(data.description || "").trim().slice(0, 300);
  const sortOrder = Math.floor(Number(data.sortOrder ?? data.sort_order ?? 0));
  const isActive = (data.isActive ?? data.is_active ?? true) ? 1 : 0;
  const unlockType = normalizeUnlockType(data.unlockType || data.unlock_type || "NONE");
  const unlockValue = String(data.unlockValue ?? data.unlock_value ?? "").trim().slice(0, 80);
  const now = new Date().toISOString();
  const old = await queryOne("SELECT * FROM battle_chapters WHERE key = ? LIMIT 1", [key]);
  await execute(
    `INSERT INTO battle_chapters (key, name, description, mode, mode_label, sort_order, is_active, unlock_type, unlock_value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       mode = excluded.mode,
       mode_label = excluded.mode_label,
       sort_order = excluded.sort_order,
       is_active = excluded.is_active,
       unlock_type = excluded.unlock_type,
       unlock_value = excluded.unlock_value,
       updated_at = excluded.updated_at`,
    [key, name, description, mode, modeLabel, sortOrder, isActive, unlockType, unlockValue, now, now]
  );
  await adminAudit(adminCtx.admin.id, old ? "UPDATE_BATTLE_CHAPTER" : "CREATE_BATTLE_CHAPTER", null, { key, name, mode, sortOrder, isActive: !!isActive, unlockType, unlockValue });
  return { success: true, msg: `已儲存爭霸戰章節：${name}`, rows: (await adminListBattleChapters(adminCtx)).rows };
}
async function adminSetBattleChapterActive(adminCtx, keyInput, activeInput) {
  const key = normalizeBattleChapterKey(keyInput);
  const row = await queryOne("SELECT * FROM battle_chapters WHERE key = ? LIMIT 1", [key]);
  if (!row) throw new Error("找不到爭霸戰章節：" + key);
  const active = activeInput ? 1 : 0;
  await execute("UPDATE battle_chapters SET is_active = ?, updated_at = ? WHERE key = ?", [active, new Date().toISOString(), key]);
  await adminAudit(adminCtx.admin.id, "SET_BATTLE_CHAPTER_ACTIVE", null, { key, oldValue: Number(row.is_active || 0) === 1, newValue: !!active });
  return { success: true, msg: `${row.name} 已${active ? "啟用" : "停用"}`, rows: (await adminListBattleChapters(adminCtx)).rows };
}

async function adminListBossStages(adminCtx) {
  const rows = await queryAll(
    `SELECT s.*, c.rarity, c.image_url, bc.name AS chapter_name, bc.mode AS chapter_mode, bc.mode_label AS chapter_mode_label, bc.sort_order AS chapter_sort_order
     FROM boss_stages s
     LEFT JOIN battle_chapters bc ON bc.key = s.chapter_key
     LEFT JOIN cards c ON c.name = s.boss_card_name
     ORDER BY COALESCE(bc.sort_order, 999999) ASC, COALESCE(s.stage_order, s.id) ASC, s.id ASC`,
    []
  );
  return { success: true, rows: rows.map(r => ({
    stageId: Number(r.id),
    stageName: r.stage_name || `第 ${Number(r.id)} 關`,
    chapterKey: r.chapter_key || "normal_1",
    chapterName: r.chapter_name || "未分章節",
    stageOrder: Number(r.stage_order || 0),
    mode: normalizeBattleMode(r.chapter_mode || "normal"),
    modeLabel: r.chapter_mode_label || battleModeLabel(r.chapter_mode),
    bossCardName: r.boss_card_name || "",
    bossPower: Number(r.boss_power || 0),
    rewardDrawTimes: Number(r.reward_draw_times || 0),
    unlockType: normalizeUnlockType(r.unlock_type || "NONE"),
    unlockValue: r.unlock_value || "",
    isActive: Number(r.is_active ?? 1) === 1,
    bossRarity: r.rarity || "BOSS",
    imageUrl: r.image_url ? normalizeCardImageUrl(r.image_url, r.boss_card_name || r.name) : "",
    image_url: r.image_url ? normalizeCardImageUrl(r.image_url, r.boss_card_name || r.name) : ""
  })) };
}

async function adminUpsertBossStage(adminCtx, input) {
  const data = input && typeof input === "object" ? input : {};
  const stageId = clampInt(data.stageId, 1, 9999);
  const bossCardName = String(data.bossCardName || "").trim();
  if (!bossCardName) throw new Error("請指定 Boss 卡片名稱。");
  const bossCard = await queryOne("SELECT id, name FROM cards WHERE name = ? LIMIT 1", [bossCardName]);
  if (!bossCard) throw new Error("找不到 Boss 卡片：" + bossCardName);
  const bossPower = clampInt(data.bossPower, 1, 999999999);
  const rewardDrawTimes = clampInt(data.rewardDrawTimes ?? 0, 0, 999999999);
  const chapterKey = normalizeBattleChapterKey(data.chapterKey || data.chapter_key || "normal_1") || "normal_1";
  const chapter = await queryOne("SELECT key FROM battle_chapters WHERE key = ? LIMIT 1", [chapterKey]);
  if (!chapter) throw new Error("找不到爭霸戰章節：" + chapterKey);
  const stageOrder = clampInt(data.stageOrder ?? data.stage_order ?? stageId, 0, 999999);
  const unlockType = normalizeUnlockType(data.unlockType || data.unlock_type || "NONE");
  const unlockValue = String(data.unlockValue ?? data.unlock_value ?? "").trim().slice(0, 80);
  const isActive = (data.isActive ?? data.is_active ?? true) ? 1 : 0;
  const stageName = String(data.stageName || `第 ${stageId} 關｜${bossCard.name}`).trim().slice(0, 100);
  const old = await queryOne("SELECT * FROM boss_stages WHERE id = ? LIMIT 1", [stageId]);
  await execute(
    `INSERT INTO boss_stages (id, chapter_key, stage_order, boss_card_id, boss_card_name, boss_power, stage_name, reward_draw_times, unlock_type, unlock_value, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       chapter_key = excluded.chapter_key,
       stage_order = excluded.stage_order,
       boss_card_id = excluded.boss_card_id,
       boss_card_name = excluded.boss_card_name,
       boss_power = excluded.boss_power,
       stage_name = excluded.stage_name,
       reward_draw_times = excluded.reward_draw_times,
       unlock_type = excluded.unlock_type,
       unlock_value = excluded.unlock_value,
       is_active = excluded.is_active`,
    [stageId, chapterKey, stageOrder, bossCard.id, bossCard.name, bossPower, stageName, rewardDrawTimes, unlockType, unlockValue, isActive]
  );
  await adminAudit(adminCtx.admin.id, old ? "UPDATE_BOSS_STAGE" : "CREATE_BOSS_STAGE", null, {
    stageId, old, newValue: { stageName, chapterKey, stageOrder, bossCardName: bossCard.name, bossPower, rewardDrawTimes, unlockType, unlockValue, isActive: !!isActive }
  });
  return { success: true, msg: `已儲存潮流爭霸戰第 ${stageId} 關`, stages: await adminListBossStages(adminCtx) };
}


async function adminListRpgChapters(adminCtx) {
  const rows = await queryAll(
    `SELECT * FROM rpg_chapters
     ORDER BY sort_order ASC, name ASC, key ASC`, []
  );
  return { success: true, rows: rows.map(publicRpgChapter) };
}

async function adminUpsertRpgChapter(adminCtx, input) {
  const data = input && typeof input === "object" ? input : {};
  const name = String(data.name || "").trim().slice(0, 80);
  if (!name) throw new Error("請輸入異世界名稱。");
  const key = normalizeRpgChapterKey(data.key || name);
  if (!key) throw new Error("異世界 key 無效，請使用英文、數字或底線。");
  const description = String(data.description || "").trim().slice(0, 300);
  const sortOrder = clampInt(data.sortOrder ?? 0, 0, 999999999);
  const isActive = data.isActive === false || data.isActive === 0 || data.isActive === "0" ? 0 : 1;
  const unlockType = normalizeRpgUnlockType(data.unlockType || "NONE");
  const unlockValue = String(data.unlockValue || "").trim().slice(0, 80);
  const now = new Date().toISOString();
  const old = await queryOne("SELECT * FROM rpg_chapters WHERE key = ? LIMIT 1", [key]);

  await execute(
    `INSERT INTO rpg_chapters (key, name, description, sort_order, is_active, unlock_type, unlock_value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       sort_order = excluded.sort_order,
       is_active = excluded.is_active,
       unlock_type = excluded.unlock_type,
       unlock_value = excluded.unlock_value,
       updated_at = excluded.updated_at`,
    [key, name, description, sortOrder, isActive, unlockType, unlockValue, now, now]
  );

  await adminAudit(adminCtx.admin.id, old ? "UPDATE_RPG_CHAPTER" : "CREATE_RPG_CHAPTER", null, {
    key, old, newValue: { name, description, sortOrder, isActive: !!isActive, unlockType, unlockValue }
  });
  return { success: true, msg: `已儲存異世界章節：${name}`, chapters: await adminListRpgChapters(adminCtx), dungeons: await adminListRpgDungeons(adminCtx) };
}

async function adminSetRpgChapterActive(adminCtx, keyInput, activeInput) {
  const key = normalizeRpgChapterKey(keyInput);
  if (!key) throw new Error("請輸入異世界 key。");
  const row = await queryOne("SELECT * FROM rpg_chapters WHERE key = ? LIMIT 1", [key]);
  if (!row) throw new Error("找不到異世界章節：" + key);
  const isActive = activeInput ? 1 : 0;
  await execute("UPDATE rpg_chapters SET is_active = ?, updated_at = ? WHERE key = ?", [isActive, new Date().toISOString(), key]);
  await adminAudit(adminCtx.admin.id, "SET_RPG_CHAPTER_ACTIVE", null, { key, oldValue: Number(row.is_active || 0) === 1, newValue: !!isActive });
  return { success: true, msg: `${row.name} 已${isActive ? "啟用" : "停用"}`, chapters: await adminListRpgChapters(adminCtx), dungeons: await adminListRpgDungeons(adminCtx) };
}

async function adminListRpgDungeons(adminCtx) {
  const rows = await queryAll(
    `SELECT d.*, ch.name AS chapter_name, ch.sort_order AS chapter_sort_order, c.rarity, c.image_url
     FROM rpg_dungeons d
     LEFT JOIN rpg_chapters ch ON ch.key = COALESCE(NULLIF(d.chapter_key, ''), 'isekai_entry')
     LEFT JOIN cards c ON c.name = COALESCE(NULLIF(d.boss_card_name, ''), d.name)
     ORDER BY COALESCE(ch.sort_order, 999999) ASC, d.stage_order ASC, d.sort_order ASC, d.key ASC`,
    []
  );
  return { success: true, rows: rows.map(r => ({
    key: r.key,
    name: r.name,
    description: r.description || "",
    chapterKey: r.chapter_key || "isekai_entry",
    chapterName: r.chapter_name || "異世界入口",
    stageOrder: Number(r.stage_order || r.sort_order || 0),
    bossCardName: r.boss_card_name || "",
    requiredPower: Number(r.required_power || 0),
    rewardScore: Number(r.reward_score || 0),
    rewardEnergy: Number(r.reward_energy || 0),
    rewardDrawChance: Number(r.reward_draw_chance || 0),
    rewardDrawTimes: Number(r.reward_draw_times || 0),
    rewardCardName: r.reward_card_name || "",
    rewardCardChance: Number(r.reward_card_chance || 0),
    rewardCardQuantity: Number(r.reward_card_quantity || 1),
    unlockType: normalizeRpgUnlockType(r.unlock_type || "NONE"),
    unlockValue: String(r.unlock_value || ""),
    isActive: Number(r.is_active || 0) === 1,
    sortOrder: Number(r.sort_order || 0),
    bossRarity: r.rarity || "BOSS",
    imageUrl: r.image_url ? normalizeCardImageUrl(r.image_url, r.boss_card_name || r.name) : ""
  })) };
}

async function adminUpsertRpgDungeon(adminCtx, input) {
  const data = input && typeof input === "object" ? input : {};
  const name = String(data.name || "").trim().slice(0, 100);
  if (!name) throw new Error("請輸入遠征異世界關卡名稱。");
  const key = normalizeDungeonKey(data.key || name);
  if (!key) throw new Error("關卡 key 無效，請使用英文、數字或底線。");
  const chapterKey = normalizeRpgChapterKey(data.chapterKey || data.chapter_key || "isekai_entry") || "isekai_entry";
  const chapter = await queryOne("SELECT * FROM rpg_chapters WHERE key = ? LIMIT 1", [chapterKey]);
  if (!chapter) throw new Error("找不到異世界章節：" + chapterKey + "，請先到章節管理新增。");
  const bossCardName = String(data.bossCardName || "").trim();
  if (!bossCardName) throw new Error("請指定遠征 Boss 卡片名稱。");
  const bossCard = await queryOne("SELECT id, name FROM cards WHERE name = ? LIMIT 1", [bossCardName]);
  if (!bossCard) throw new Error("找不到 Boss 卡片：" + bossCardName);
  const description = String(data.description || "").trim().slice(0, 300);
  const requiredPower = clampInt(data.requiredPower, 0, 999999999);
  const rewardScore = clampInt(data.rewardScore ?? 0, 0, 999999999);
  const rewardEnergy = clampInt(data.rewardEnergy ?? 0, 0, 999999999);
  const rewardDrawChance = clampInt(data.rewardDrawChance ?? 0, 0, 100);
  const rewardDrawTimes = clampInt(data.rewardDrawTimes ?? 0, 0, 999999999);
  const rewardCardNameInput = String(data.rewardCardName || data.reward_card_name || "").trim();
  let rewardCardName = "";
  if (rewardCardNameInput) {
    const rewardCard = await queryOne("SELECT name FROM cards WHERE name = ? LIMIT 1", [rewardCardNameInput]);
    if (!rewardCard) throw new Error("找不到活動掉落卡片：" + rewardCardNameInput);
    rewardCardName = rewardCard.name;
  }
  const rewardCardChance = rewardCardName ? clampInt(data.rewardCardChance ?? data.reward_card_chance ?? 0, 0, 100) : 0;
  const rewardCardQuantity = rewardCardName ? clampInt(data.rewardCardQuantity ?? data.reward_card_quantity ?? 1, 1, 999999999) : 1;
  const unlockType = normalizeRpgUnlockType(data.unlockType || "NONE");
  const unlockValue = String(data.unlockValue || "").trim().slice(0, 80);
  const isActive = data.isActive === false || data.isActive === 0 || data.isActive === "0" ? 0 : 1;
  const sortOrder = clampInt(data.sortOrder ?? data.stageOrder ?? 0, 0, 999999999);
  const stageOrder = clampInt(data.stageOrder ?? sortOrder, 0, 999999999);
  const old = await queryOne("SELECT * FROM rpg_dungeons WHERE key = ? LIMIT 1", [key]);
  await execute(
    `INSERT INTO rpg_dungeons (key, name, description, chapter_key, stage_order, boss_card_name, required_power, reward_score, reward_energy, reward_draw_chance, reward_draw_times, reward_card_name, reward_card_chance, reward_card_quantity, unlock_type, unlock_value, is_active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       chapter_key = excluded.chapter_key,
       stage_order = excluded.stage_order,
       boss_card_name = excluded.boss_card_name,
       required_power = excluded.required_power,
       reward_score = excluded.reward_score,
       reward_energy = excluded.reward_energy,
       reward_draw_chance = excluded.reward_draw_chance,
       reward_draw_times = excluded.reward_draw_times,
       reward_card_name = excluded.reward_card_name,
       reward_card_chance = excluded.reward_card_chance,
       reward_card_quantity = excluded.reward_card_quantity,
       unlock_type = excluded.unlock_type,
       unlock_value = excluded.unlock_value,
       is_active = excluded.is_active,
       sort_order = excluded.sort_order`,
    [key, name, description, chapterKey, stageOrder, bossCard.name, requiredPower, rewardScore, rewardEnergy, rewardDrawChance, rewardDrawTimes, rewardCardName, rewardCardChance, rewardCardQuantity, unlockType, unlockValue, isActive, sortOrder]
  );
  await adminAudit(adminCtx.admin.id, old ? "UPDATE_RPG_DUNGEON" : "CREATE_RPG_DUNGEON", null, {
    key, old, newValue: { name, description, chapterKey, stageOrder, bossCardName: bossCard.name, requiredPower, rewardScore, rewardEnergy, rewardDrawChance, rewardDrawTimes, rewardCardName, rewardCardChance, rewardCardQuantity, unlockType, unlockValue, isActive: !!isActive, sortOrder }
  });
  return { success: true, msg: `已儲存遠征異世界關卡：${name}`, dungeons: await adminListRpgDungeons(adminCtx) };
}

async function adminSetRpgDungeonActive(adminCtx, keyInput, activeInput) {
  const key = normalizeDungeonKey(keyInput);
  if (!key) throw new Error("請輸入關卡 key。");
  const row = await queryOne("SELECT * FROM rpg_dungeons WHERE key = ? LIMIT 1", [key]);
  if (!row) throw new Error("找不到遠征異世界關卡：" + key);
  const isActive = activeInput ? 1 : 0;
  await execute("UPDATE rpg_dungeons SET is_active = ? WHERE key = ?", [isActive, key]);
  await adminAudit(adminCtx.admin.id, "SET_RPG_DUNGEON_ACTIVE", null, { key, oldValue: Number(row.is_active || 0) === 1, newValue: !!isActive });
  return { success: true, msg: `${row.name} 已${isActive ? "啟用" : "停用"}`, dungeons: await adminListRpgDungeons(adminCtx) };
}

async function adminGetAuditLogs(adminCtx, targetUidInput = "") {
  const target = String(targetUidInput || "").trim();
  const rows = await queryAll(
    `SELECT l.id, l.action, l.target_uid, l.detail, l.created_at, a.username
     FROM admin_audit_logs l
     LEFT JOIN admin_users a ON a.id = l.admin_id
     WHERE (? = '' OR l.target_uid = ?)
     ORDER BY l.id DESC
     LIMIT 100`,
    [target, target]
  );
  return { success: true, rows: rows.map(r => ({
    id: Number(r.id),
    adminUsername: r.username || "SYSTEM",
    action: r.action,
    targetUid: r.target_uid || "",
    detail: r.detail || "",
    createdAt: r.created_at || ""
  })) };
}


// =========================
// OPS / REDEEM / RPG API
// =========================
const EXPORT_TABLES = new Set([
  "players", "player_assets", "cards", "gacha_logs", "player_collection", "card_stars", "card_progression",
  "battle_chapters", "boss_stages", "battle_progress", "battle_rewards", "training_profiles", "training_logs", "mini_daily_status",
  "messages", "pvp_players", "pvp_daily_status", "pvp_logs", "redeem_codes", "redeem_redemptions",
  "rpg_party", "rpg_chapters", "rpg_dungeons", "rpg_adventure_logs", "shop_items", "shop_item_rewards", "shop_purchase_logs", "player_items", "card_reset_logs", "admin_audit_logs", "app_settings"
]);

function normalizeRedeemCode(code) {
  return String(code || "").trim().toUpperCase().replace(/\s+/g, "").slice(0, 40);
}

async function setSetting(key, value) {
  const cleanKey = String(key);
  const cleanValue = String(value ?? "");
  await execute(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [cleanKey, cleanValue, new Date().toISOString()]
  );
  setAppSettingCache(cleanKey, cleanValue);
}

async function getSetting(key, fallback = "") {
  const cleanKey = String(key);
  const cached = getAppSettingCache(cleanKey);
  if (cached !== null) return cached;
  const row = await queryOne("SELECT value FROM app_settings WHERE key = ? LIMIT 1", [cleanKey]);
  const value = row ? String(row.value ?? "") : String(fallback ?? "");
  setAppSettingCache(cleanKey, value);
  return value;
}

async function getPublicSettings() {
  return {
    success: true,
    maintenanceEnabled: (await getSetting("maintenance_enabled", "0")) === "1",
    maintenanceMessage: await getSetting("maintenance_message", "系統維護中，請稍後再試。"),
    announcementTitle: await getSetting("announcement_title", "T-LO 公告"),
    announcementBody: await getSetting("announcement_body", "歡迎來到 T-LO 潮流盲盒開榜現場。")
  };
}

async function isMaintenanceEnabled() {
  return (await getSetting("maintenance_enabled", "0")) === "1";
}

async function getMaintenanceTestUidSet() {
  // 先讀 app_settings，沒有設定時使用環境變數；環境變數預設 guang。
  const raw = await getSetting("maintenance_test_uids", DEFAULT_MAINTENANCE_TEST_UIDS);
  const set = parseMaintenanceTestUids(raw);
  if (!set.size) return parseMaintenanceTestUids(DEFAULT_MAINTENANCE_TEST_UIDS);
  return set;
}

async function isMaintenanceTestUid(uid) {
  const cleanUid = normalizeMaintenanceUid(uid);
  if (!cleanUid) return false;
  const set = await getMaintenanceTestUidSet();
  return set.has(cleanUid);
}

async function shouldBypassDailyLimits(uid) {
  if (!TEST_ACCOUNT_BYPASS_LIMITS) return false;
  if (!(await isMaintenanceEnabled())) return false;
  return await isMaintenanceTestUid(uid);
}

function applyBattleDailyTestBypass(limits) {
  return {
    ...limits,
    maintenanceTestAccount: true,
    testBypass: true,
    challengeRemaining: 9999,
    normalFirstClearRemaining: 9999,
    hardFirstClearRemaining: 9999,
    resetText: "維護測試帳號：不消耗每日爭霸戰限制"
  };
}

function applyRpgDailyTestBypass(limits) {
  return {
    ...limits,
    maintenanceTestAccount: true,
    testBypass: true,
    expeditionRemaining: 9999,
    resetText: "維護測試帳號：不消耗每日遠征限制"
  };
}

async function assertServiceOpen(uid = "") {
  if (await isMaintenanceEnabled()) {
    if (await isMaintenanceTestUid(uid)) return;
    const err = new Error(await getSetting("maintenance_message", "系統維護中，請稍後再試。"));
    err.statusCode = 503;
    err.maintenance = true;
    throw err;
  }
}

async function adminGetOpsSettings(adminCtx) {
  return await getPublicSettings();
}

async function adminUpdateOpsSettings(adminCtx, patchInput) {
  const patch = patchInput && typeof patchInput === "object" ? patchInput : {};
  await setSetting("maintenance_enabled", patch.maintenanceEnabled ? "1" : "0");
  await setSetting("maintenance_message", String(patch.maintenanceMessage || "系統維護中，請稍後再試。").slice(0, 300));
  if (Object.prototype.hasOwnProperty.call(patch, "maintenanceTestUids")) {
    const cleanList = Array.from(parseMaintenanceTestUids(patch.maintenanceTestUids)).join(",");
    await setSetting("maintenance_test_uids", cleanList || DEFAULT_MAINTENANCE_TEST_UIDS);
  }
  await setSetting("announcement_title", String(patch.announcementTitle || "T-LO 公告").slice(0, 60));
  await setSetting("announcement_body", String(patch.announcementBody || "").slice(0, 1000));
  await adminAudit(adminCtx.admin.id, "UPDATE_OPS_SETTINGS", null, patch);
  return { success: true, msg: "公告 / 維護模式已更新", settings: await getPublicSettings() };
}

function publicRedeemCode(row) {
  return {
    id: Number(row.id),
    code: row.code,
    title: row.title || "",
    rewardType: row.reward_type,
    rewardValue: Number(row.reward_value || 0),
    cardName: row.card_name || "",
    maxUses: Number(row.max_uses || 0),
    perPlayerLimit: Number(row.per_player_limit || 1),
    isActive: Number(row.is_active || 0) === 1,
    startsAt: row.starts_at || "",
    expiresAt: row.expires_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    usedCount: Number(row.used_count || 0)
  };
}

function validateRewardType(type) {
  const t = String(type || "").trim().toUpperCase();
  if (!["DRAW_TIMES", "CARD", "SCORE", "ENERGY"].includes(t)) {
    throw new Error("獎勵類型錯誤。可用：DRAW_TIMES、CARD、SCORE、ENERGY");
  }
  return t;
}

async function adminCreateRedeemCode(adminCtx, input) {
  const data = input && typeof input === "object" ? input : {};
  const code = normalizeRedeemCode(data.code);
  if (!code) throw new Error("請輸入兌換碼。");
  const existing = await queryOne("SELECT id FROM redeem_codes WHERE code = ? LIMIT 1", [code]);
  if (existing) throw new Error("兌換碼已存在：" + code);

  const rewardType = validateRewardType(data.rewardType);
  const rewardValue = clampInt(data.rewardValue ?? 0, 0, 999999999);
  const cardName = String(data.cardName || "").trim();
  if (rewardType === "CARD") {
    if (!cardName) throw new Error("卡片獎勵必須輸入卡片名稱。");
    const card = await queryOne("SELECT id FROM cards WHERE name = ? LIMIT 1", [cardName]);
    if (!card) throw new Error("找不到卡片：" + cardName);
  }
  if (rewardType !== "CARD" && rewardValue <= 0) throw new Error("獎勵數量必須大於 0。");

  const now = new Date().toISOString();
  await execute(
    `INSERT INTO redeem_codes (code, title, reward_type, reward_value, card_name, max_uses, per_player_limit, starts_at, expires_at, is_active, created_by_admin_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      code,
      String(data.title || code).trim().slice(0, 80),
      rewardType,
      rewardValue,
      cardName,
      clampInt(data.maxUses ?? 0, 0, 999999999),
      1,
      String(data.startsAt || "").trim() || null,
      String(data.expiresAt || "").trim() || null,
      data.isActive === false ? 0 : 1,
      adminCtx.admin.id,
      now,
      now
    ]
  );
  await adminAudit(adminCtx.admin.id, "CREATE_REDEEM_CODE", null, { code, rewardType, rewardValue, cardName });
  return { success: true, msg: `已建立兌換碼 ${code}`, codes: await adminListRedeemCodes(adminCtx) };
}

async function adminListRedeemCodes(adminCtx) {
  const rows = await queryAll(
    `SELECT rc.*, COUNT(rr.id) AS used_count
     FROM redeem_codes rc
     LEFT JOIN redeem_redemptions rr ON rr.code_id = rc.id
     GROUP BY rc.id
     ORDER BY rc.id DESC
     LIMIT 200`, []
  );
  return { success: true, rows: rows.map(publicRedeemCode) };
}

async function adminSetRedeemCodeActive(adminCtx, codeInput, activeInput) {
  const code = normalizeRedeemCode(codeInput);
  const row = await queryOne("SELECT * FROM redeem_codes WHERE code = ? LIMIT 1", [code]);
  if (!row) throw new Error("找不到兌換碼：" + code);
  const isActive = activeInput ? 1 : 0;
  await execute("UPDATE redeem_codes SET is_active = ?, updated_at = ? WHERE id = ?", [isActive, new Date().toISOString(), row.id]);
  await adminAudit(adminCtx.admin.id, "SET_REDEEM_ACTIVE", null, { code, isActive: !!isActive });
  return { success: true, msg: `已${isActive ? "啟用" : "停用"}兌換碼 ${code}`, codes: await adminListRedeemCodes(adminCtx) };
}

async function adminGetRedeemLogs(adminCtx, codeInput = "") {
  const code = normalizeRedeemCode(codeInput);
  const rows = await queryAll(
    `SELECT rr.id, rc.code, rc.title, p.uid, rr.reward_summary, rr.created_at
     FROM redeem_redemptions rr
     JOIN redeem_codes rc ON rc.id = rr.code_id
     JOIN players p ON p.id = rr.player_id
     WHERE (? = '' OR rc.code = ?)
     ORDER BY rr.id DESC
     LIMIT 200`,
    [code, code]
  );
  return { success: true, rows: rows.map(r => ({
    id: Number(r.id), code: r.code, title: r.title || "", uid: r.uid, rewardSummary: r.reward_summary || "", createdAt: r.created_at || ""
  })) };
}

async function applyRedeemReward(player, codeRow) {
  const now = new Date().toISOString();
  const rewardType = String(codeRow.reward_type || "").toUpperCase();
  const rewardValue = Number(codeRow.reward_value || 0);
  const codeLabel = String(codeRow.code || "");

  if (rewardType === "DRAW_TIMES") {
    const asset = await getAssets(player.id);
    const newValue = Number(asset.draw_times || 0) + rewardValue;
    await execute("UPDATE player_assets SET draw_times = ?, updated_at = ? WHERE player_id = ?", [newValue, now, player.id]);
    await execute(
      `INSERT INTO gacha_logs (player_id, card_id, card_name, source, note, created_at)
       VALUES (?, NULL, ?, ?, ?, ?)`,
      [player.id, "兌換碼補償", "兌換碼 / 補償碼", `${codeLabel}｜抽卡次數 +${rewardValue}`, now]
    );
    return { summary: `抽卡次數 +${rewardValue}`, timesLeft: newValue };
  }

  if (rewardType === "CARD") {
    const cardName = String(codeRow.card_name || "").trim();
    const card = await queryOne("SELECT * FROM cards WHERE name = ? LIMIT 1", [cardName]);
    if (!card) throw new Error("兌換碼設定的卡片不存在：" + cardName);
    const qty = rewardValue > 0 ? rewardValue : 1;
    await execute(
      `INSERT INTO player_collection (player_id, card_id, card_name, quantity, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id, card_id)
       DO UPDATE SET quantity = player_collection.quantity + excluded.quantity, card_name = excluded.card_name, updated_at = excluded.updated_at`,
      [player.id, card.id, card.name, qty, now]
    );
    await execute(
      `INSERT INTO gacha_logs (player_id, card_id, card_name, source, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [player.id, card.id, card.name, "兌換碼 / 補償碼", `${codeLabel}｜指定卡片 +${qty}`, now]
    );
    return { summary: `指定卡片「${card.name}」+${qty}` };
  }

  if (rewardType === "SCORE" || rewardType === "ENERGY") {
    await getTrainingProfile(player.id);
    const profile = await queryOne("SELECT * FROM training_profiles WHERE player_id = ?", [player.id]);
    const newScore = Number(profile.total_score || 0) + (rewardType === "SCORE" ? rewardValue : 0);
    const newEnergy = Number(profile.energy || 0) + (rewardType === "ENERGY" ? rewardValue : 0);
    const title = calculateTrainingTitle(newScore, Number(profile.streak || 0));
    await execute("UPDATE training_profiles SET total_score = ?, energy = ?, title = ?, updated_at = ? WHERE player_id = ?", [newScore, newEnergy, title, now, player.id]);
    await insertTrainingLog(player.id, "兌換碼補償", rewardType === "SCORE" ? rewardValue : 0, rewardType === "ENERGY" ? rewardValue : 0, codeLabel, now);
    return { summary: rewardType === "SCORE" ? `排行榜分數 +${rewardValue}` : `潮流能量 +${rewardValue}` };
  }

  throw new Error("兌換碼獎勵類型錯誤。");
}

async function redeemCode(uid, codeInput) {
  const player = await getOrCreatePlayer(uid);
  const code = normalizeRedeemCode(codeInput);
  if (!code) return { success: false, msg: "請輸入兌換碼。" };

  return withTransaction(async () => {
    const row = await queryOne("SELECT * FROM redeem_codes WHERE code = ? LIMIT 1", [code]);
    if (!row || Number(row.is_active || 0) !== 1) return { success: false, msg: "兌換碼不存在或已停用。" };

    const nowMs = Date.now();
    if (row.starts_at && new Date(String(row.starts_at)).getTime() > nowMs) return { success: false, msg: "兌換碼尚未開始使用。" };
    if (row.expires_at && new Date(String(row.expires_at)).getTime() < nowMs) return { success: false, msg: "兌換碼已過期。" };

    const totalUsed = await queryOne("SELECT COUNT(*) AS c FROM redeem_redemptions WHERE code_id = ?", [row.id]);
    const maxUses = Number(row.max_uses || 0);
    if (maxUses > 0 && Number(totalUsed?.c || 0) >= maxUses) return { success: false, msg: "兌換碼已被領完。" };

    const mine = await queryOne("SELECT COUNT(*) AS c FROM redeem_redemptions WHERE code_id = ? AND player_id = ?", [row.id, player.id]);
    if (Number(mine?.c || 0) >= Math.max(1, Number(row.per_player_limit || 1))) return { success: false, msg: "你已經領過這組兌換碼。" };

    const reward = await applyRedeemReward(player, row);
    await execute(
      "INSERT INTO redeem_redemptions (code_id, player_id, reward_summary, created_at) VALUES (?, ?, ?, ?)",
      [row.id, player.id, reward.summary, new Date().toISOString()]
    );
    return { success: true, msg: `兌換成功：${reward.summary}`, rewardSummary: reward.summary, timesLeft: reward.timesLeft ?? undefined };
  });
}

async function adminExportTable(adminCtx, tableNameInput) {
  const table = String(tableNameInput || "").trim();
  if (!EXPORT_TABLES.has(table)) throw new Error("不允許匯出的資料表：" + table);
  const rows = await queryAll(`SELECT * FROM ${table} LIMIT 20000`, []);
  await adminAudit(adminCtx.admin.id, "EXPORT_TABLE", null, { table, rows: rows.length });
  return { success: true, table, rows, exportedAt: new Date().toISOString() };
}

async function adminExportAllData(adminCtx) {
  const result = {};
  for (const table of EXPORT_TABLES) {
    result[table] = await queryAll(`SELECT * FROM ${table} LIMIT 20000`, []);
  }
  await adminAudit(adminCtx.admin.id, "EXPORT_ALL_DATA", null, { tables: Object.keys(result) });
  return { success: true, exportedAt: new Date().toISOString(), tables: result };
}

async function getRpgPartyNames(playerId) {
  const party = await queryOne("SELECT * FROM rpg_party WHERE player_id = ?", [playerId]);
  if (party) return [party.slot1_card_name, party.slot2_card_name, party.slot3_card_name].filter(Boolean);

  const ranked = await getOwnedCardBattleOptionsFast(playerId, 3);
  return ranked.slice(0, 3).map(x => x.name);
}


async function getRpgDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const cardOptions = await getOwnedCardBattleOptionsFast(player.id, 9999);
  const partyRow = await queryOne("SELECT * FROM rpg_party WHERE player_id = ?", [player.id]);
  const partyNames = partyRow
    ? [partyRow.slot1_card_name, partyRow.slot2_card_name, partyRow.slot3_card_name].filter(Boolean)
    : cardOptions.slice(0, 3).map(c => c.name);

  let teamPower = 0;
  const party = [];
  for (const name of partyNames) {
    const opt = cardOptions.find(c => c.name === name);
    if (opt) { party.push(opt); teamPower += Number(opt.power || 0); }
  }

  const chaptersRaw = await getActiveRpgChapters();
  const dungeonsRaw = await queryAll(
    `SELECT d.*, ch.name AS chapter_name, ch.description AS chapter_description, ch.sort_order AS chapter_sort_order,
            ch.is_active AS chapter_is_active, ch.unlock_type AS chapter_unlock_type, ch.unlock_value AS chapter_unlock_value,
            c.rarity AS boss_rarity, c.image_url AS boss_image_url
     FROM rpg_dungeons d
     LEFT JOIN rpg_chapters ch ON ch.key = COALESCE(NULLIF(d.chapter_key, ''), 'isekai_entry')
     LEFT JOIN cards c ON c.name = COALESCE(NULLIF(d.boss_card_name, ''), d.name)
     WHERE d.is_active = 1 AND COALESCE(ch.is_active, 1) = 1
     ORDER BY COALESCE(ch.sort_order, 999999) ASC, d.stage_order ASC, d.sort_order ASC, d.key ASC`,
    []
  );
  const unlockCtx = await getRpgUnlockContext(player.id);
  const logs = await queryAll("SELECT * FROM rpg_adventure_logs WHERE player_id = ? ORDER BY id DESC LIMIT 10", [player.id]);
  const chapterMap = new Map();

  for (const ch of chaptersRaw) {
    const pub = publicRpgChapter(ch);
    const chapterUnlock = checkRpgUnlock({ unlock_type: pub.unlockType, unlock_value: pub.unlockValue }, unlockCtx, `【${pub.name}】`);
    chapterMap.set(pub.key, {
      ...pub,
      unlocked: chapterUnlock.unlocked,
      locked: !chapterUnlock.unlocked,
      lockReason: chapterUnlock.lockReason,
      totalCount: 0,
      clearedCount: 0,
      stages: []
    });
  }

  const dungeons = dungeonsRaw.map(d => {
    const chapterKey = d.chapter_key || "isekai_entry";
    if (!chapterMap.has(chapterKey)) {
      const chapterUnlock = checkRpgUnlock({ unlock_type: d.chapter_unlock_type, unlock_value: d.chapter_unlock_value }, unlockCtx, `【${d.chapter_name || "異世界入口"}】`);
      chapterMap.set(chapterKey, {
        key: chapterKey,
        chapterKey,
        name: d.chapter_name || "異世界入口",
        description: d.chapter_description || "",
        sortOrder: Number(d.chapter_sort_order || 0),
        isActive: Number(d.chapter_is_active || 1) === 1,
        unlockType: normalizeRpgUnlockType(d.chapter_unlock_type || "NONE"),
        unlockValue: String(d.chapter_unlock_value || ""),
        unlocked: chapterUnlock.unlocked,
        locked: !chapterUnlock.unlocked,
        lockReason: chapterUnlock.lockReason,
        totalCount: 0,
        clearedCount: 0,
        stages: []
      });
    }
    const chapter = chapterMap.get(chapterKey);
    const stageUnlock = checkRpgUnlock(d, unlockCtx, `【${d.name}】`);
    const cleared = unlockCtx.rpgWins.has(String(d.key || ""));
    const unlocked = chapter.unlocked && stageUnlock.unlocked;
    const lockReason = !chapter.unlocked ? chapter.lockReason : (stageUnlock.lockReason || "");
    const pub = publicRpgDungeon({ ...d, chapter_name: chapter.name }, { cleared, unlocked, lockReason });
    chapter.totalCount += 1;
    if (cleared) chapter.clearedCount += 1;
    chapter.stages.push(pub);
    return pub;
  });

  const chapters = Array.from(chapterMap.values())
    .map(ch => ({ ...ch, stages: ch.stages.sort((a, b) => Number(a.stageOrder || 0) - Number(b.stageOrder || 0) || String(a.key).localeCompare(String(b.key))) }))
    .filter(ch => ch.isActive && (ch.stages.length > 0 || ch.key === "isekai_entry"))
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.key).localeCompare(String(b.key)));

  return {
    success: true,
    dailyLimits: await getRpgDailyLimitStatus(player.id, uid),
    teamPower,
    party,
    partyNames: party.map(c => c.name),
    cardOptions,
    chapters,
    rpgChapters: chapters,
    dungeons,
    logs: logs.map(l => ({ dungeonName: l.dungeon_name, result: l.result, teamPower: Number(l.team_power || 0), enemyPower: Number(l.enemy_power || 0), rewardSummary: l.reward_summary || "", createdAt: l.created_at || "" }))
  };
}

async function setRpgTeam(uid, namesInput) {
  const player = await getOrCreatePlayer(uid);
  const input = Array.isArray(namesInput) ? namesInput : [];
  const names = [];
  for (const raw of input) {
    const name = String(raw || "").trim();
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= 3) break;
  }
  if (!names.length) return { success: false, msg: "請至少選擇一張隊伍角色。", dashboard: await getRpgDashboard(uid) };
  const owned = await getOwnedCardsMap(player.id);
  for (const name of names) {
    if (Number(owned[name] || 0) <= 0) throw new Error("你尚未持有角色：" + name);
  }
  await execute(
    `INSERT INTO rpg_party (player_id, slot1_card_name, slot2_card_name, slot3_card_name, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET
       slot1_card_name = excluded.slot1_card_name,
       slot2_card_name = excluded.slot2_card_name,
       slot3_card_name = excluded.slot3_card_name,
       updated_at = excluded.updated_at`,
    [player.id, names[0] || null, names[1] || null, names[2] || null, new Date().toISOString()]
  );
  return { success: true, msg: "遠征異世界隊伍已儲存。", dashboard: await getRpgDashboard(uid) };
}

async function executeRpgAdventure(uid, dungeonKeyInput) {
  const player = await getOrCreatePlayer(uid);
  const key = String(dungeonKeyInput || "").trim();
  const dungeon = await queryOne(
    `SELECT d.*, ch.name AS chapter_name, ch.is_active AS chapter_is_active,
            ch.unlock_type AS chapter_unlock_type, ch.unlock_value AS chapter_unlock_value
     FROM rpg_dungeons d
     LEFT JOIN rpg_chapters ch ON ch.key = COALESCE(NULLIF(d.chapter_key, ''), 'isekai_entry')
     WHERE d.key = ? AND d.is_active = 1
     LIMIT 1`,
    [key]
  );
  if (!dungeon) throw new Error("找不到遠征異世界關卡。");
  if (Number(dungeon.chapter_is_active ?? 1) !== 1) {
    return { success: false, msg: "此異世界章節目前未開放。", dashboard: await getRpgDashboard(uid) };
  }
  const unlockCtx = await getRpgUnlockContext(player.id);
  const chapterUnlock = checkRpgUnlock({ unlock_type: dungeon.chapter_unlock_type, unlock_value: dungeon.chapter_unlock_value }, unlockCtx, `【${dungeon.chapter_name || "異世界入口"}】`);
  if (!chapterUnlock.unlocked) {
    return { success: false, msg: chapterUnlock.lockReason || "此異世界章節尚未解鎖。", dashboard: await getRpgDashboard(uid) };
  }
  const dungeonUnlock = checkRpgUnlock(dungeon, unlockCtx, `【${dungeon.name || "遠征關卡"}】`);
  if (!dungeonUnlock.unlocked) {
    return { success: false, msg: dungeonUnlock.lockReason || "此遠征關卡尚未解鎖。", dashboard: await getRpgDashboard(uid) };
  }

  // Supabase 戰鬥流程加速：只讀取目前隊伍 3 張卡，不再每場遠征先拉整包 RPG dashboard。
  const partyInfo = await getRpgPartySnapshotFast(player.id);
  const teamPower = Number(partyInfo.teamPower || 0);
  if (!partyInfo.party.length) {
    return { success: false, msg: "請先設定遠征異世界隊伍。", dashboard: await getRpgDashboard(uid) };
  }

  const partySnapshot = partyInfo.party.map(c => ({
    name: c.name,
    rarity: c.rarity,
    imageUrl: c.imageUrl,
    star: c.star,
    count: c.count,
    power: c.power
  }));

  return withTransaction(async () => {
    const limitResult = await consumeRpgDailyLimit(player.id, uid);
    if (!limitResult.ok) {
      return {
        success: false,
        limitBlocked: true,
        msg: limitResult.msg,
        dailyLimits: limitResult.dailyLimits,
        dashboard: await getRpgDashboard(uid)
      };
    }

    const enemyPower = Number(dungeon.required_power || 0);
    const rpgBossName = String(dungeon.boss_card_name || dungeon.name || "關卡敵人").trim();
    const rpgBossCard = await queryOne("SELECT name, rarity, image_url FROM cards WHERE name = ? LIMIT 1", [rpgBossName]);
    const rpgBossImageUrl = rpgBossCard && rpgBossCard.image_url ? normalizeCardImageUrl(rpgBossCard.image_url, rpgBossName) : "";
    const baseChance = enemyPower <= 0 ? 1 : Math.min(0.95, Math.max(0.15, teamPower / (enemyPower * 1.25)));
    const win = Math.random() < baseChance;
    const now = new Date().toISOString();
    let rewardSummary = "未取得獎勵";
    let newTimesLeft = null;

    if (win) {
      await getTrainingProfile(player.id);
      const profile = await queryOne("SELECT * FROM training_profiles WHERE player_id = ?", [player.id]);
      const rewardScore = Number(dungeon.reward_score || 0);
      const rewardEnergy = Number(dungeon.reward_energy || 0);
      const newScore = Number(profile.total_score || 0) + rewardScore;
      const newEnergy = Number(profile.energy || 0) + rewardEnergy;
      const title = calculateTrainingTitle(newScore, Number(profile.streak || 0));
      await execute("UPDATE training_profiles SET total_score = ?, energy = ?, title = ?, updated_at = ? WHERE player_id = ?", [newScore, newEnergy, title, now, player.id]);
      rewardSummary = `分數 +${rewardScore}、能量 +${rewardEnergy}`;

      const guaranteedDrawTimes = Math.max(0, Number(dungeon.reward_draw_times || 0));
      if (guaranteedDrawTimes > 0) {
        const updatedAsset = await queryOne(
          `UPDATE player_assets
           SET draw_times = draw_times + ?, updated_at = ?
           WHERE player_id = ?
           RETURNING draw_times`,
          [guaranteedDrawTimes, now, player.id]
        );
        newTimesLeft = Number(updatedAsset?.draw_times || 0);
        rewardSummary += `、抽卡次數 +${guaranteedDrawTimes}`;
      }

      const chance = Math.max(0, Math.min(100, Number(dungeon.reward_draw_chance || 0)));
      if (chance > 0 && Math.floor(Math.random() * 100) < chance) {
        const updatedAsset = await queryOne(
          `UPDATE player_assets
           SET draw_times = draw_times + 1, updated_at = ?
           WHERE player_id = ?
           RETURNING draw_times`,
          [now, player.id]
        );
        newTimesLeft = Number(updatedAsset?.draw_times || 0);
        rewardSummary += "、幸運掉落抽卡次數 +1";
      }

      const rewardCardName = String(dungeon.reward_card_name || "").trim();
      const rewardCardChance = Math.max(0, Math.min(100, Number(dungeon.reward_card_chance || 0)));
      const rewardCardQuantity = Math.max(1, Math.floor(Number(dungeon.reward_card_quantity || 1)));
      if (rewardCardName && rewardCardChance > 0 && Math.floor(Math.random() * 100) < rewardCardChance) {
        const rewardCard = await queryOne("SELECT name FROM cards WHERE name = ? LIMIT 1", [rewardCardName]);
        if (rewardCard) {
          const cardText = await addCardRewardToPlayer(player.id, rewardCard.name, rewardCardQuantity, `遠征活動掉落：${dungeon.name}`);
          rewardSummary += `、活動卡片掉落 ${cardText}`;
        }
      }

      await insertTrainingLog(player.id, "遠征異世界", rewardScore, rewardEnergy, `${dungeon.name}｜${rewardSummary}`, now);
    }

    await execute(
      `INSERT INTO rpg_adventure_logs (player_id, dungeon_key, dungeon_name, result, team_power, enemy_power, reward_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [player.id, key, dungeon.name, win ? "WIN" : "LOSE", teamPower, enemyPower, rewardSummary, now]
    );

    const growthRewards = await addCharacterExp(player.id, partySnapshot.map(c => c.name), win ? Math.max(120, Number(dungeon.reward_score || 0)) : 45, "遠征異世界經驗");

    return {
      success: true,
      win,
      msg: win ? `攻略成功！${rewardSummary}` : "攻略失敗，建議升星或調整隊伍後再挑戰。",
      teamPower,
      enemyPower,
      rewardSummary,
      dailyLimits: limitResult.dailyLimits,
      newTimesLeft,
      growthRewards,
      bossName: rpgBossName,
      bossCardName: rpgBossName,
      bossImageUrl: rpgBossImageUrl,
      boss_image_url: rpgBossImageUrl,
      imageUrl: rpgBossImageUrl,
      image_url: rpgBossImageUrl,
      party: partySnapshot,
      partyNames: partySnapshot.map(c => c.name),
      battleAnimation: makeTurnBattleAnimation({
        playerPower: teamPower,
        bossPower: enemyPower,
        bossName: rpgBossName,
        stageName: dungeon.name,
        win,
        playerTeam: partySnapshot,
        enemyTeam: [{ name: rpgBossName, rarity: (rpgBossCard && rpgBossCard.rarity) || "BOSS", imageUrl: rpgBossImageUrl, power: enemyPower }],
        playerLabel: "遠征隊伍",
        enemyLabel: rpgBossName
      })
    };
  });
}


// ===============================
// T-LO SHOP SYSTEM v6
// 商品由資料庫管理；儲值商城可使用綠界 AIO 導轉付款。
// ===============================
const SHOP_CATEGORY_LABELS = {
  ENERGY: "能量商店",
  POINTS: "訓練總分商店",
  TOPUP: "儲值商城"
};
const SHOP_PRICE_LABELS = {
  ENERGY: "能量",
  POINTS: "訓練總分",
  CASH: "新台幣"
};
const SHOP_REWARD_LABELS = {
  DRAW_TIMES: "抽卡次數",
  ENERGY: "潮流能量",
  POINTS: "訓練總分",
  SKILL_EXP: "技能經驗",
  BATTLE_TICKET: "今日爭霸戰挑戰券",
  RPG_TICKET: "今日遠征券",
  ITEM: "道具",
  CARD: "指定卡片"
};
const SHOP_LIMIT_LABELS = {
  NONE: "不限購",
  DAILY: "每日限購",
  WEEKLY: "每週限購",
  MONTHLY: "每月限購",
  ONCE: "永久限購"
};



// ===============================
// ECPay AIO 全方位金流導轉付款
// HashKey / HashIV 僅能放在 Railway Variables，不可放前端。
// 此版已移除站內付 2.0 Web SDK / Token / PayToken 流程，改用 AioCheckOut/V5 導轉綠界官方付款頁。
// ===============================
const ECPAY_CONFIG = {
  enabled: String(process.env.ECPAY_ENABLED || "false").toLowerCase() === "true",
  env: String(process.env.ECPAY_ENV || "stage").toLowerCase() === "prod" ? "prod" : "stage",
  merchantId: String(process.env.ECPAY_MERCHANT_ID || "").trim(),
  platformId: String(process.env.ECPAY_PLATFORM_ID || "").trim(),
  hashKey: String(process.env.ECPAY_HASH_KEY || "").trim(),
  hashIV: String(process.env.ECPAY_HASH_IV || "").trim(),
  frontendUrl: String(process.env.PUBLIC_FRONTEND_URL || "").replace(/\/+$/, ""),
  backendUrl: String(process.env.PUBLIC_BACKEND_URL || "").replace(/\/+$/, ""),
  aioChoosePayment: String(process.env.ECPAY_AIO_CHOOSE_PAYMENT || process.env.ECPAY_CHOOSE_PAYMENT || "ALL").trim() || "ALL",
  aioIgnorePayment: String(process.env.ECPAY_AIO_IGNORE_PAYMENT || "WebATM#ApplePay#BNPL#WeiXin#TWQR").trim(),
  allowSimulatedPaid: String(process.env.ECPAY_ALLOW_SIMULATED_PAID || "false").toLowerCase() === "true"
};
function getEcpayAioActionUrl() {
  return ECPAY_CONFIG.env === "prod"
    ? "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5"
    : "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5";
}
function assertEcpayReady() {
  if (!ECPAY_CONFIG.enabled) throw new Error("綠界 AIO 付款尚未啟用。請先在 Railway 設定 ECPAY_ENABLED=true。");
  if (!ECPAY_CONFIG.merchantId || !ECPAY_CONFIG.hashKey || !ECPAY_CONFIG.hashIV) throw new Error("綠界 MerchantID / HashKey / HashIV 尚未設定完整。");
  if (!ECPAY_CONFIG.frontendUrl || !ECPAY_CONFIG.backendUrl) throw new Error("PUBLIC_FRONTEND_URL / PUBLIC_BACKEND_URL 尚未設定。");
}
function ecpayTaipeiDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value || "00";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
function ecpayOrderNo() {
  const base = Date.now().toString(36).toUpperCase();
  const rnd = crypto.randomBytes(3).toString("hex").toUpperCase();
  return (`TL${base}${rnd}`).replace(/[^A-Z0-9]/g, "").slice(0, 20);
}
function cleanEcpayText(value, max = 100) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function ecpayAioEncode(value) {
  return encodeURIComponent(String(value))
    .toLowerCase()
    .replace(/%20/g, "+")
    .replace(/%2d/g, "-")
    .replace(/%5f/g, "_")
    .replace(/%2e/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2a/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");
}
function makeEcpayCheckMacValue(params = {}) {
  const filtered = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (String(key).toLowerCase() === "checkmacvalue") return;
    if (value === undefined || value === null) return;
    filtered[key] = String(value);
  });
  const sortedKeys = Object.keys(filtered).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const raw = sortedKeys.map(k => `${k}=${filtered[k]}`).join("&");
  const withKey = `HashKey=${ECPAY_CONFIG.hashKey}&${raw}&HashIV=${ECPAY_CONFIG.hashIV}`;
  const encoded = ecpayAioEncode(withKey);
  return crypto.createHash("sha256").update(encoded).digest("hex").toUpperCase();
}
function assertEcpayCheckMac(payload = {}) {
  const received = String(payload.CheckMacValue || payload.checkmacvalue || "").trim().toUpperCase();
  if (!received) throw new Error("綠界回傳缺少 CheckMacValue。");
  const calculated = makeEcpayCheckMacValue(payload);
  if (received !== calculated) throw new Error("綠界 CheckMacValue 驗證失敗。");
  return true;
}
function publicEcpayConfig() {
  return {
    enabled: ECPAY_CONFIG.enabled,
    env: ECPAY_CONFIG.env,
    mode: "AIO",
    formAction: getEcpayAioActionUrl(),
    choosePayment: ECPAY_CONFIG.aioChoosePayment,
    ignorePayment: ECPAY_CONFIG.aioIgnorePayment,
    paymentNote: `綠界 AIO 導轉付款：ChoosePayment=${ECPAY_CONFIG.aioChoosePayment}${ECPAY_CONFIG.aioIgnorePayment ? `，IgnorePayment=${ECPAY_CONFIG.aioIgnorePayment}` : ""}。`
  };
}
function normalizeEcpayAioPaymentType(value) {
  const raw = String(value || "").trim();
  const up = raw.toUpperCase();
  if (up.includes("CREDIT")) return "Credit";
  if (up.includes("ATM")) return "ATM";
  if (up.includes("CVS")) return "CVS";
  if (up.includes("BARCODE")) return "BARCODE";
  return raw || "AIO";
}
function buildEcpayAioFields({ orderNo, item, amount, player, productKey }) {
  const fields = {
    MerchantID: ECPAY_CONFIG.merchantId,
    MerchantTradeNo: orderNo,
    MerchantTradeDate: ecpayTaipeiDateTime(),
    PaymentType: "aio",
    TotalAmount: String(amount),
    TradeDesc: cleanEcpayText("TLO商城儲值", 200),
    ItemName: cleanEcpayText(item.name || productKey, 380) || productKey,
    ReturnURL: `${ECPAY_CONFIG.backendUrl}/api/ecpay/return`,
    ChoosePayment: ECPAY_CONFIG.aioChoosePayment,
    EncryptType: "1",
    ClientBackURL: ECPAY_CONFIG.frontendUrl,
    OrderResultURL: `${ECPAY_CONFIG.backendUrl}/api/ecpay/result`,
    NeedExtraPaidInfo: "Y",
    CustomField1: String(player.uid || "").slice(0, 50),
    CustomField2: String(productKey || "").slice(0, 50),
    PaymentInfoURL: `${ECPAY_CONFIG.backendUrl}/api/ecpay/payment-info`
  };
  if (ECPAY_CONFIG.platformId) fields.PlatformID = ECPAY_CONFIG.platformId;
  if (ECPAY_CONFIG.aioIgnorePayment) fields.IgnorePayment = ECPAY_CONFIG.aioIgnorePayment;
  fields.CheckMacValue = makeEcpayCheckMacValue(fields);
  return fields;
}

function normalizeShopKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
function normalizeShopCategory(value) {
  const v = String(value || "").trim().toUpperCase();
  return ["ENERGY", "POINTS", "TOPUP"].includes(v) ? v : "ENERGY";
}
function normalizeShopPriceType(value) {
  const v = String(value || "").trim().toUpperCase();
  return ["ENERGY", "POINTS", "CASH"].includes(v) ? v : "ENERGY";
}
function normalizeShopLimitType(value) {
  const v = String(value || "").trim().toUpperCase();
  return ["NONE", "DAILY", "WEEKLY", "MONTHLY", "ONCE"].includes(v) ? v : "NONE";
}
function normalizeShopRewardType(value) {
  const v = String(value || "").trim().toUpperCase();
  return ["DRAW_TIMES", "ENERGY", "POINTS", "SKILL_EXP", "BATTLE_TICKET", "RPG_TICKET", "ITEM", "CARD"].includes(v) ? v : "";
}
function normalizeTaipeiDatePartsForShop(dateKey) {
  const raw = String(dateKey || "").trim();
  let y = 0, m = 0, d = 0;
  if (/^\d{8}$/.test(raw)) {
    y = Number(raw.slice(0, 4));
    m = Number(raw.slice(4, 6));
    d = Number(raw.slice(6, 8));
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    y = Number(raw.slice(0, 4));
    m = Number(raw.slice(5, 7));
    d = Number(raw.slice(8, 10));
  } else {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    y = Number(parts.find(p => p.type === "year")?.value || now.getUTCFullYear());
    m = Number(parts.find(p => p.type === "month")?.value || 1);
    d = Number(parts.find(p => p.type === "day")?.value || 1);
  }
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || y < 2000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) {
    const fallback = new Date();
    y = fallback.getUTCFullYear();
    m = fallback.getUTCMonth() + 1;
    d = fallback.getUTCDate();
  }
  const pad = n => String(Math.max(1, Math.floor(Number(n || 1)))).padStart(2, "0");
  return { y, m, d, ymd: `${y}-${pad(m)}-${pad(d)}`, ym: `${y}-${pad(m)}` };
}

function getShopPeriodKey(limitType) {
  const today = todayKeyTaipei();
  const type = normalizeShopLimitType(limitType);
  if (type === "DAILY") return today;
  if (type === "ONCE") return "ONCE";
  const parts = normalizeTaipeiDatePartsForShop(today);
  if (type === "MONTHLY") return `MONTH:${parts.ym}`;
  if (type === "WEEKLY") {
    const dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
    if (!Number.isFinite(dt.getTime())) return `WEEK:${parts.ymd}`;
    const day = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() - day + 1);
    const monday = dt.toISOString().slice(0, 10);
    return `WEEK:${monday}`;
  }
  return "";
}
function formatShopReward(reward) {
  const type = normalizeShopRewardType(reward?.reward_type || reward?.rewardType);
  const value = Math.max(0, Math.floor(Number(reward?.reward_value ?? reward?.rewardValue ?? 0)));
  const cardName = String(reward?.card_name || reward?.cardName || "").trim();
  if (type === "CARD") return `${SHOP_REWARD_LABELS[type] || type}：${cardName || "未指定"} x${value}`;
  if (type === "ITEM") return `${getItemDef(cardName || ITEM_CARD_RESET_TICKET).name} x${value}`;
  return `${SHOP_REWARD_LABELS[type] || type} +${value}`;
}
async function getShopAssetSnapshot(playerId, uid = "") {
  const asset = await getAssets(playerId);
  const profile = await getTrainingProfile(playerId);
  const [battleDailyLimits, rpgDailyLimits] = await Promise.all([
    getBattleDailyLimitStatus(playerId, uid),
    getRpgDailyLimitStatus(playerId, uid)
  ]);
  return {
    drawTimes: Number(asset.draw_times || 0),
    energy: Number(profile.energy || 0),
    points: Number(profile.total_score || 0),
    trainingScore: Number(profile.total_score || 0),
    skillExp: Number(profile.skill_exp || 0),
    memoryPlaysLeft: Math.max(0, FREE_DAILY_MEMORY_LIMIT - Number(profile.memory_plays_today || 0)),
    dailyMemoryLimit: FREE_DAILY_MEMORY_LIMIT,
    maxMemoryScore: Number(profile.max_memory_score || 0),
    battleDailyLimits,
    rpgDailyLimits
  };
}
async function getShopPurchaseCount(playerId, productKey, limitType) {
  const periodKey = getShopPeriodKey(limitType);
  if (!periodKey) return { used: 0, periodKey: "" };
  const row = await queryOne(
    "SELECT COUNT(*) AS cnt FROM shop_purchase_logs WHERE player_id = ? AND product_key = ? AND period_key = ?",
    [playerId, productKey, periodKey]
  );
  return { used: Number(row?.cnt || 0), periodKey };
}
async function loadShopItems(includeInactive = false) {
  const rows = await queryAll(
    `SELECT * FROM shop_items
     WHERE (? = 1 OR is_active = 1)
     ORDER BY CASE category WHEN 'ENERGY' THEN 1 WHEN 'POINTS' THEN 2 WHEN 'TOPUP' THEN 3 ELSE 9 END, sort_order ASC, product_key ASC`,
    [includeInactive ? 1 : 0]
  );
  if (!rows.length) return [];
  const keys = rows.map(r => r.product_key);
  const placeholders = keys.map(() => "?").join(",");
  const rewardRows = await queryAll(
    `SELECT * FROM shop_item_rewards WHERE product_key IN (${placeholders}) ORDER BY product_key ASC, sort_order ASC, id ASC`,
    keys
  );
  const rewardMap = new Map();
  rewardRows.forEach(r => {
    const key = String(r.product_key || "");
    if (!rewardMap.has(key)) rewardMap.set(key, []);
    rewardMap.get(key).push({
      id: Number(r.id || 0),
      productKey: key,
      rewardType: String(r.reward_type || ""),
      rewardValue: Number(r.reward_value || 0),
      cardName: String(r.card_name || ""),
      itemKey: String(r.reward_type || "").toUpperCase() === "ITEM" ? String(r.card_name || ITEM_CARD_RESET_TICKET) : "",
      sortOrder: Number(r.sort_order || 0),
      reward_type: String(r.reward_type || ""),
      reward_value: Number(r.reward_value || 0),
      card_name: String(r.card_name || "")
    });
  });
  return rows.map(r => {
    const rewards = rewardMap.get(String(r.product_key || "")) || [];
    return {
      productKey: r.product_key,
      product_key: r.product_key,
      category: r.category,
      categoryLabel: SHOP_CATEGORY_LABELS[r.category] || r.category,
      name: r.name,
      description: r.description || "",
      priceType: r.price_type,
      price_type: r.price_type,
      priceLabel: SHOP_PRICE_LABELS[r.price_type] || r.price_type,
      priceAmount: Number(r.price_amount || 0),
      price_amount: Number(r.price_amount || 0),
      limitType: r.limit_type || "NONE",
      limit_type: r.limit_type || "NONE",
      limitLabel: SHOP_LIMIT_LABELS[r.limit_type] || r.limit_type || "不限購",
      limitCount: Number(r.limit_count || 0),
      limit_count: Number(r.limit_count || 0),
      isActive: Number(r.is_active || 0) === 1,
      is_active: Number(r.is_active || 0) === 1,
      isPaymentEnabled: Number(r.is_payment_enabled || 0) === 1,
      is_payment_enabled: Number(r.is_payment_enabled || 0) === 1,
      sortOrder: Number(r.sort_order || 0),
      sort_order: Number(r.sort_order || 0),
      tag: r.tag || "",
      rewards,
      rewardText: rewards.map(formatShopReward).join("、") || "未設定獎勵",
      createdAt: r.created_at || "",
      updatedAt: r.updated_at || ""
    };
  });
}
function buildShopCategories(items) {
  return ["ENERGY", "POINTS", "TOPUP"].map(key => ({
    key,
    label: SHOP_CATEGORY_LABELS[key] || key,
    items: items.filter(item => item.category === key)
  }));
}
async function publicShopItemForPlayer(item, playerId) {
  const limit = await getShopPurchaseCount(playerId, item.productKey, item.limitType);
  const limitCount = Number(item.limitCount || 0);
  const hasLimit = item.limitType !== "NONE" && limitCount > 0;
  const remaining = hasLimit ? Math.max(0, limitCount - limit.used) : null;
  const isCash = item.priceType === "CASH";
  const cashDisabled = isCash && (!ECPAY_CONFIG.enabled || !item.isPaymentEnabled);
  return {
    ...item,
    purchaseUsed: limit.used,
    purchaseRemaining: remaining,
    periodKey: limit.periodKey,
    canBuyByLimit: !hasLimit || remaining > 0,
    canBuy: (!isCash || !cashDisabled) && (!hasLimit || remaining > 0),
    paymentDisabled: cashDisabled,
    paymentMode: isCash ? "ECPAY" : "IN_GAME",
    paymentNote: cashDisabled ? (ECPAY_CONFIG.enabled ? "此儲值商品尚未在 GM 後台開啟付款。" : "綠界 AIO 付款尚未啟用。") : (isCash ? "可導轉綠界官方付款頁：信用卡一次付清 / ATM / 超商代碼 / 超商條碼。" : "")
  };
}

async function buildPersonalAssetDashboard(player, uid) {
  const [assets, pvpDaily, collectionUniqueCount, totalCollectibleCards, achievementStats, achievementClaims] = await Promise.all([
    getShopAssetSnapshot(player.id, uid),
    getOrCreatePvpDaily(player.id),
    getCollectionUniqueCount(player.id),
    getTotalCollectibleCards(),
    getAchievementStats(player.id),
    queryAll("SELECT achievement_key FROM achievement_claims WHERE player_id = ?", [player.id])
  ]);
  const completedAchievements = buildAchievementRows(ACHIEVEMENT_DEFS, achievementStats, new Set(achievementClaims.map(r => r.achievement_key))).filter(r => r.completed).length;
  assets.pvpDailyLimits = {
    used: Number(pvpDaily?.challenges || 0),
    limit: PVP_DAILY_LIMIT,
    remaining: Math.max(0, PVP_DAILY_LIMIT - Number(pvpDaily?.challenges || 0))
  };
  const resetItems = await getResetTicketDashboardPart(player.id);
  const virtualItems = [
    { key: "draw_times", name: "抽卡次數", amount: Number(assets.drawTimes || 0), desc: "可於抽卡頁使用。" },
    { key: "energy", name: "潮流能量", amount: Number(assets.energy || 0), desc: "用於能量商店與角色養成。" },
    { key: "points", name: "訓練總分", amount: Number(assets.points || assets.trainingScore || 0), desc: "可於訓練總分商店兌換補給。" },
    { key: "skill_exp", name: "技能經驗", amount: Number(assets.skillExp || 0), desc: "用於角色技能升級。" },
    { key: "card_reset_ticket", name: "卡牌重置券", amount: Number(resetItems.cardResetTicket || 0), desc: "可重置角色星等與技能並退還資源。" },
    { key: "memory_plays", name: "翻牌次數", amount: Number(assets.memoryPlaysLeft || 0), desc: `今日剩餘 / 上限 ${Number(assets.dailyMemoryLimit || 0)}` },
    { key: "battle_ticket", name: "爭霸戰挑戰券", amount: Number(assets.battleDailyLimits?.challengeRemaining || 0), desc: `今日剩餘 / 上限 ${Number(assets.battleDailyLimits?.challengeLimit || BATTLE_DAILY_TICKET_LIMIT)}` },
    { key: "rpg_ticket", name: "遠征券", amount: Number(assets.rpgDailyLimits?.expeditionRemaining || 0), desc: `今日剩餘 / 上限 ${Number(assets.rpgDailyLimits?.expeditionLimit || RPG_DAILY_TICKET_LIMIT)}` },
    { key: "pvp_ticket", name: "PVP 挑戰券", amount: assets.pvpDailyLimits.remaining, desc: `今日剩餘 / 上限 ${PVP_DAILY_LIMIT}` }
  ];
  return {
    assets,
    virtualItems,
    collectionUniqueCount: Number(collectionUniqueCount || 0),
    totalCollectibleCards: Number(totalCollectibleCards || 0),
    achievementCompletedCount: completedAchievements,
    achievementTotalCount: ACHIEVEMENT_DEFS.length
  };
}

async function getPersonalDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const profile = await ensurePlayerProfile(player, true);
  const assetPart = await buildPersonalAssetDashboard(player, uid);
  return {
    success: true,
    player: publicPlayer(player),
    profile: publicPlayerProfile(profile),
    statusOptions: [
      { key: "ONLINE", label: "在線" },
      { key: "OFFLINE", label: "離線" },
      { key: "BUSY", label: "忙碌" }
    ],
    ...assetPart
  };
}

async function updatePlayerProfile(uid, input = {}) {
  const player = await getOrCreatePlayer(uid);
  const displayName = cleanProfileText(input.displayName ?? input.display_name ?? player.display_name ?? player.uid, PROFILE_DISPLAY_NAME_MAX) || player.uid;
  const bio = cleanProfileText(input.bio ?? "", PROFILE_BIO_MAX);
  const status = normalizeSocialStatus(input.status || "ONLINE");
  const now = new Date().toISOString();
  await ensurePlayerProfile(player, false);
  await execute(
    "UPDATE player_profiles SET display_name = ?, bio = ?, status = ?, last_seen_at = ?, updated_at = ? WHERE player_id = ?",
    [displayName, bio, status, now, now, player.id]
  );
  await execute("UPDATE players SET display_name = ? WHERE id = ?", [displayName, player.id]);
  return { success: true, msg: "個人資料已更新。", dashboard: await getPersonalDashboard(uid) };
}

async function setPlayerPresenceStatus(uid, statusInput) {
  const player = await getOrCreatePlayer(uid);
  const status = normalizeSocialStatus(statusInput);
  const now = new Date().toISOString();
  await ensurePlayerProfile(player, false);
  await execute("UPDATE player_profiles SET status = ?, last_seen_at = ?, updated_at = ? WHERE player_id = ?", [status, now, now, player.id]);
  return { success: true, msg: `狀態已切換為${SOCIAL_STATUS_LABELS[status] || "在線"}。`, dashboard: await getSocialDashboard(uid) };
}

async function areFriends(playerId, otherId) {
  const row = await queryOne("SELECT friend_id FROM friendships WHERE player_id = ? AND friend_id = ?", [playerId, otherId]);
  return !!row;
}

async function getSocialDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const profile = await ensurePlayerProfile(player, true);
  const incomingRows = await queryAll(
    `SELECT fr.id, fr.created_at, p.uid, COALESCE(pp.display_name, p.display_name, p.uid) AS display_name, COALESCE(pp.bio, '') AS bio, COALESCE(pp.status, 'ONLINE') AS status, pp.last_seen_at
     FROM friend_requests fr
     JOIN players p ON p.id = fr.requester_id
     LEFT JOIN player_profiles pp ON pp.player_id = p.id
     WHERE fr.receiver_id = ? AND fr.status = 'PENDING'
     ORDER BY fr.created_at DESC LIMIT 30`,
    [player.id]
  );
  const outgoingRows = await queryAll(
    `SELECT fr.id, fr.created_at, p.uid, COALESCE(pp.display_name, p.display_name, p.uid) AS display_name, COALESCE(pp.bio, '') AS bio, COALESCE(pp.status, 'ONLINE') AS status, pp.last_seen_at
     FROM friend_requests fr
     JOIN players p ON p.id = fr.receiver_id
     LEFT JOIN player_profiles pp ON pp.player_id = p.id
     WHERE fr.requester_id = ? AND fr.status = 'PENDING'
     ORDER BY fr.created_at DESC LIMIT 30`,
    [player.id]
  );
  const friendRows = await queryAll(
    `SELECT fs.created_at, p.id AS player_id, p.uid, COALESCE(pp.display_name, p.display_name, p.uid) AS display_name, COALESCE(pp.bio, '') AS bio, COALESCE(pp.status, 'ONLINE') AS status, pp.last_seen_at
     FROM friendships fs
     JOIN players p ON p.id = fs.friend_id
     LEFT JOIN player_profiles pp ON pp.player_id = p.id
     WHERE fs.player_id = ?
     ORDER BY CASE COALESCE(pp.status, 'ONLINE') WHEN 'ONLINE' THEN 1 WHEN 'BUSY' THEN 2 ELSE 3 END, pp.last_seen_at DESC, p.uid ASC
     LIMIT 200`,
    [player.id]
  );
  return {
    success: true,
    profile: publicPlayerProfile(profile),
    incomingRequests: incomingRows.map(r => publicPlayerProfile({ ...r, player_id: "" }, { requestId: Number(r.id || 0), requestedAt: r.created_at || "" })),
    outgoingRequests: outgoingRows.map(r => publicPlayerProfile({ ...r, player_id: "" }, { requestId: Number(r.id || 0), requestedAt: r.created_at || "" })),
    friends: friendRows.map(r => publicPlayerProfile(r, { friendSince: r.created_at || "" })),
    counts: { incoming: incomingRows.length, outgoing: outgoingRows.length, friends: friendRows.length },
    note: "社交系統目前只開放好友、邀請與狀態，不包含私訊功能。"
  };
}

async function sendFriendRequest(uid, targetUidInput) {
  const player = await getOrCreatePlayer(uid);
  const targetUid = normalizeUid(targetUidInput);
  if (!targetUid) return { success: false, msg: "請輸入對方玩家 UID。", dashboard: await getSocialDashboard(uid) };
  if (normalizeUid(player.uid) === targetUid) return { success: false, msg: "不能加自己為好友。", dashboard: await getSocialDashboard(uid) };
  const target = await queryOne("SELECT * FROM players WHERE uid = ?", [targetUid]);
  if (!target) return { success: false, msg: "找不到這個玩家 UID。", dashboard: await getSocialDashboard(uid) };
  await ensurePlayerProfile(player, true);
  await ensurePlayerProfile(target, false);
  if (await areFriends(player.id, target.id)) return { success: false, msg: "你們已經是好友。", dashboard: await getSocialDashboard(uid) };

  return withTransaction(async () => {
    const incoming = await queryOne("SELECT * FROM friend_requests WHERE requester_id = ? AND receiver_id = ? AND status = 'PENDING'", [target.id, player.id]);
    const now = new Date().toISOString();
    if (incoming) {
      await execute("UPDATE friend_requests SET status = 'ACCEPTED', responded_at = ? WHERE id = ?", [now, incoming.id]);
      await execute("INSERT OR IGNORE INTO friendships (player_id, friend_id, created_at) VALUES (?, ?, ?)", [player.id, target.id, now]);
      await execute("INSERT OR IGNORE INTO friendships (player_id, friend_id, created_at) VALUES (?, ?, ?)", [target.id, player.id, now]);
      return { success: true, msg: `已接受 ${target.uid} 的邀請，成為好友。`, dashboard: await getSocialDashboard(uid) };
    }
    const existing = await queryOne("SELECT * FROM friend_requests WHERE requester_id = ? AND receiver_id = ?", [player.id, target.id]);
    if (existing && String(existing.status || "") === "PENDING") {
      return { success: false, msg: "你已經送出好友邀請，等待對方同意。", dashboard: await getSocialDashboard(uid) };
    }
    if (existing) {
      await execute("UPDATE friend_requests SET status = 'PENDING', created_at = ?, responded_at = NULL WHERE id = ?", [now, existing.id]);
    } else {
      await execute("INSERT INTO friend_requests (requester_id, receiver_id, status, created_at) VALUES (?, ?, 'PENDING', ?)", [player.id, target.id, now]);
    }
    return { success: true, msg: `已送出好友邀請給 ${target.uid}。`, dashboard: await getSocialDashboard(uid) };
  });
}

async function respondFriendRequest(uid, requestIdInput, actionInput) {
  const player = await getOrCreatePlayer(uid);
  const requestId = Math.floor(Number(requestIdInput || 0));
  const action = String(actionInput || "").trim().toUpperCase() === "ACCEPT" ? "ACCEPT" : "REJECT";
  if (!requestId) return { success: false, msg: "好友邀請編號錯誤。", dashboard: await getSocialDashboard(uid) };
  return withTransaction(async () => {
    const req = await queryOne("SELECT * FROM friend_requests WHERE id = ? AND receiver_id = ?", [requestId, player.id]);
    if (!req || String(req.status || "") !== "PENDING") return { success: false, msg: "找不到待處理的好友邀請。", dashboard: await getSocialDashboard(uid) };
    const now = new Date().toISOString();
    if (action === "ACCEPT") {
      await execute("UPDATE friend_requests SET status = 'ACCEPTED', responded_at = ? WHERE id = ?", [now, requestId]);
      await execute("INSERT OR IGNORE INTO friendships (player_id, friend_id, created_at) VALUES (?, ?, ?)", [player.id, req.requester_id, now]);
      await execute("INSERT OR IGNORE INTO friendships (player_id, friend_id, created_at) VALUES (?, ?, ?)", [req.requester_id, player.id, now]);
      return { success: true, msg: "已接受好友邀請。", dashboard: await getSocialDashboard(uid) };
    }
    await execute("UPDATE friend_requests SET status = 'REJECTED', responded_at = ? WHERE id = ?", [now, requestId]);
    return { success: true, msg: "已拒絕好友邀請。", dashboard: await getSocialDashboard(uid) };
  });
}

async function removeFriend(uid, friendUidInput) {
  const player = await getOrCreatePlayer(uid);
  const friendUid = normalizeUid(friendUidInput);
  const friend = await queryOne("SELECT * FROM players WHERE uid = ?", [friendUid]);
  if (!friend) return { success: false, msg: "找不到這位好友。", dashboard: await getSocialDashboard(uid) };
  await execute("DELETE FROM friendships WHERE (player_id = ? AND friend_id = ?) OR (player_id = ? AND friend_id = ?)", [player.id, friend.id, friend.id, player.id]);
  return { success: true, msg: `已解除與 ${friend.uid} 的好友關係。`, dashboard: await getSocialDashboard(uid) };
}

async function getShopDashboard(uid) {
  const player = await getOrCreatePlayer(uid);
  const [assets, baseItems] = await Promise.all([
    getShopAssetSnapshot(player.id, uid),
    loadShopItems(false)
  ]);
  const items = [];
  for (const item of baseItems) items.push(await publicShopItemForPlayer(item, player.id));
  return {
    success: true,
    player: publicPlayer(player),
    assets,
    categories: buildShopCategories(items),
    items,
    paymentEnabled: ECPAY_CONFIG.enabled,
    ecpay: publicEcpayConfig(),
    paymentNotice: ECPAY_CONFIG.enabled ? "儲值商城已啟用綠界 AIO 導轉付款：信用卡一次付清 / ATM / 超商代碼 / 超商條碼。" : "儲值商城目前僅展示商品與限購規則，綠界 AIO 付款尚未啟用。",
    msg: ""
  };
}

async function getShopPaymentUsage(playerId, productKey, periodKey) {
  if (!periodKey) return 0;
  const row = await queryOne(
    `SELECT COUNT(*) AS cnt FROM payment_orders
     WHERE player_id = ? AND product_key = ? AND period_key = ?
       AND status IN ('PENDING','AIO_READY','OFFLINE_PENDING','ATM_PENDING','CVS_PENDING','BARCODE_PENDING','PAID','GRANTED')`,
    [playerId, productKey, periodKey]
  ).catch(() => ({ cnt: 0 }));
  return Number(row?.cnt || 0);
}
async function validateCashShopPurchase(player, productKey) {
  assertEcpayReady();
  const items = await loadShopItems(true);
  const item = items.find(x => x.productKey === productKey);
  if (!item || !item.isActive) throw new Error("商品不存在或已下架。");
  if (item.priceType !== "CASH") throw new Error("此商品不是儲值商品。");
  if (!item.isPaymentEnabled) throw new Error("此儲值商品尚未在 GM 後台開啟付款。");
  const limit = await getShopPurchaseCount(player.id, productKey, item.limitType);
  const pendingUsed = await getShopPaymentUsage(player.id, productKey, limit.periodKey);
  const limitCount = Number(item.limitCount || 0);
  if (item.limitType !== "NONE" && limitCount > 0 && (limit.used + pendingUsed) >= limitCount) {
    throw new Error(`${item.name} 已達${SHOP_LIMIT_LABELS[item.limitType] || "限購"}上限。`);
  }
  const amount = Math.max(0, Math.floor(Number(item.priceAmount || 0)));
  if (amount <= 0) throw new Error("儲值商品金額必須大於 0。");
  return { item, limit, amount };
}

async function createEcpayOrder(uid, productKeyInput) {
  const productKey = normalizeShopKey(productKeyInput);
  if (!productKey) return { success: false, msg: "商品代碼錯誤。", dashboard: await getShopDashboard(uid) };
  const player = await getOrCreatePlayer(uid);
  try {
    const { item, limit, amount } = await validateCashShopPurchase(player, productKey);
    const now = new Date().toISOString();
    const orderNo = ecpayOrderNo();
    const fields = buildEcpayAioFields({ orderNo, item, amount, player, productKey });
    await execute(
      `INSERT INTO payment_orders (order_no, player_id, uid, product_key, amount, currency, provider, status, period_key, raw_create_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'TWD', 'ECPAY_AIO', 'AIO_READY', ?, ?, ?, ?)`,
      [orderNo, player.id, player.uid, productKey, amount, limit.periodKey || getShopPeriodKey(item.limitType), JSON.stringify(fields), now, now]
    );
    return {
      success: true,
      mode: "AIO",
      orderNo,
      productKey,
      itemName: item.name,
      amount,
      formAction: getEcpayAioActionUrl(),
      fields,
      ecpay: publicEcpayConfig(),
      msg: "已建立綠界 AIO 付款表單，將導轉至綠界官方付款頁。"
    };
  } catch (err) {
    return { success: false, msg: String(err.message || err), dashboard: await getShopDashboard(uid) };
  }
}
async function grantPaidShopOrder(orderNo, decoded = {}) {
  return withTransaction(async () => {
    const order = await queryOne("SELECT * FROM payment_orders WHERE order_no = ?", [orderNo]);
    if (!order) throw new Error("找不到付款訂單。");
    if (Number(order.reward_granted || 0) === 1) return { granted: false, summary: "已發獎過，略過重複通知。" };
    const item = (await loadShopItems(true)).find(x => x.productKey === order.product_key);
    if (!item) throw new Error("找不到付款商品設定。");
    const now = new Date().toISOString();
    const rewards = [];
    for (const reward of item.rewards || []) {
      rewards.push(await applyPlayerReward(order.player_id, { type: reward.rewardType, amount: reward.rewardValue, cardName: reward.cardName, itemKey: reward.itemKey }, `綠界付款：${item.name}`));
    }
    const rewardSummary = rewards.join("、") || "付款成功";
    await execute(
      `INSERT INTO shop_purchase_logs (player_id, product_key, purchase_type, date_key, period_key, price_type, price_amount, reward_summary, created_at)
       VALUES (?, ?, 'ECPAY', ?, ?, 'CASH', ?, ?, ?)`,
      [order.player_id, order.product_key, todayKeyTaipei(), order.period_key || getShopPeriodKey(item.limitType), Number(order.amount || 0), rewardSummary, now]
    );
    await execute("UPDATE payment_orders SET status = 'GRANTED', reward_granted = 1, paid_at = COALESCE(paid_at, ?), granted_at = ?, updated_at = ? WHERE order_no = ?", [now, now, now, orderNo]);
    return { granted: true, summary: rewardSummary };
  });
}
function extractAioOrderNo(payload = {}) {
  return String(payload.MerchantTradeNo || payload.merchanttradeno || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
}
export async function handleEcpayPaymentInfoPayload(payload = {}) {
  assertEcpayReady();
  assertEcpayCheckMac(payload);
  const orderNo = extractAioOrderNo(payload);
  if (!orderNo) throw new Error("綠界取號通知缺少 MerchantTradeNo。");
  const order = await queryOne("SELECT * FROM payment_orders WHERE order_no = ?", [orderNo]);
  if (!order) throw new Error("找不到付款訂單。");
  const paymentType = normalizeEcpayAioPaymentType(payload.PaymentType);
  const now = new Date().toISOString();
  let status = "OFFLINE_PENDING";
  if (paymentType === "ATM") status = "ATM_PENDING";
  else if (paymentType === "CVS") status = "CVS_PENDING";
  else if (paymentType === "BARCODE") status = "BARCODE_PENDING";
  await execute(
    "UPDATE payment_orders SET status = ?, payment_type = ?, provider_trade_no = COALESCE(NULLIF(?, ''), provider_trade_no), raw_callback_payload = ?, updated_at = ? WHERE order_no = ?",
    [status, paymentType, String(payload.TradeNo || ""), JSON.stringify(payload), now, orderNo]
  );
  return { success: true, orderNo, status, payload };
}
export async function handleEcpayReturnPayload(payload = {}) {
  assertEcpayReady();
  assertEcpayCheckMac(payload);
  const orderNo = extractAioOrderNo(payload);
  if (!orderNo) throw new Error("綠界回傳缺少 MerchantTradeNo。");
  const order = await queryOne("SELECT * FROM payment_orders WHERE order_no = ?", [orderNo]);
  if (!order) throw new Error("找不到付款訂單。");
  const tradeAmt = Number(payload.TradeAmt ?? payload.TotalAmount ?? order.amount);
  if (Number(order.amount || 0) !== tradeAmt) throw new Error("付款金額與訂單金額不一致。");
  const now = new Date().toISOString();
  await execute(
    "UPDATE payment_orders SET raw_return_payload = ?, provider_trade_no = COALESCE(NULLIF(?, ''), provider_trade_no), payment_type = COALESCE(NULLIF(?, ''), payment_type), updated_at = ? WHERE order_no = ?",
    [JSON.stringify(payload), String(payload.TradeNo || ""), normalizeEcpayAioPaymentType(payload.PaymentType), now, orderNo]
  );
  const rtnCode = Number(payload.RtnCode || 0);
  const simulated = Number(payload.SimulatePaid || 0) === 1;
  if (rtnCode === 1 && (!simulated || ECPAY_CONFIG.allowSimulatedPaid)) {
    await execute("UPDATE payment_orders SET status = 'PAID', paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE order_no = ?", [now, now, orderNo]);
    const grant = await grantPaidShopOrder(orderNo, payload);
    return { success: true, orderNo, decoded: payload, grant };
  }
  if (simulated && !ECPAY_CONFIG.allowSimulatedPaid) {
    await execute("UPDATE payment_orders SET status = 'SIMULATED_ONLY', updated_at = ? WHERE order_no = ?", [now, orderNo]);
    return { success: true, orderNo, decoded: payload, grant: { granted: false, summary: "模擬付款通知已接收，但未啟用 ECPAY_ALLOW_SIMULATED_PAID，未發獎。" } };
  }
  await execute("UPDATE payment_orders SET status = 'FAILED', updated_at = ? WHERE order_no = ?", [now, orderNo]);
  return { success: false, orderNo, decoded: payload, msg: payload.RtnMsg || "付款未成功。" };
}
export async function handleEcpayResultPayload(payload = {}) {
  assertEcpayReady();
  const orderNo = extractAioOrderNo(payload);
  if (orderNo) {
    await execute("UPDATE payment_orders SET raw_result_payload = ?, updated_at = ? WHERE order_no = ?", [JSON.stringify(payload), new Date().toISOString(), orderNo]);
  }
  return { success: Number(payload.RtnCode || 0) === 1, orderNo, decoded: payload };
}

async function buyShopItem(uid, productKeyInput) {
  const productKey = normalizeShopKey(productKeyInput);
  if (!productKey) return { success: false, msg: "商品代碼錯誤。", dashboard: await getShopDashboard(uid) };
  const player = await getOrCreatePlayer(uid);

  return withTransaction(async () => {
    const items = await loadShopItems(true);
    const item = items.find(x => x.productKey === productKey);
    if (!item || !item.isActive) return { success: false, msg: "商品不存在或已下架。", dashboard: await getShopDashboard(uid) };
    if (item.priceType === "CASH") {
      return { success: false, msg: "儲值商城現金商品需透過綠界 AIO 付款，請在商城按「前往綠界付款頁」。", dashboard: await getShopDashboard(uid) };
    }
    const limit = await getShopPurchaseCount(player.id, productKey, item.limitType);
    const limitCount = Number(item.limitCount || 0);
    if (item.limitType !== "NONE" && limitCount > 0 && limit.used >= limitCount) {
      return { success: false, msg: `${item.name} 已達${SHOP_LIMIT_LABELS[item.limitType] || "限購"}上限。`, dashboard: await getShopDashboard(uid) };
    }

    const now = new Date().toISOString();
    const price = Math.max(0, Number(item.priceAmount || 0));
    if (item.priceType === "ENERGY") {
      const profile = await getTrainingProfile(player.id);
      if (Number(profile.energy || 0) < price) return { success: false, msg: `潮流能量不足，需要 ${price}。`, dashboard: await getShopDashboard(uid) };
      await execute("UPDATE training_profiles SET energy = energy - ?, updated_at = ? WHERE player_id = ?", [price, now, player.id]);
      await insertTrainingLog(player.id, "商城購買", 0, -price, `購買 ${item.name}：消耗潮流能量 ${price}`, now);
    } else if (item.priceType === "POINTS") {
      const profile = await getTrainingProfile(player.id);
      if (Number(profile.total_score || 0) < price) return { success: false, msg: `訓練總分不足，需要 ${price}。`, dashboard: await getShopDashboard(uid) };
      const newScore = Math.max(0, Number(profile.total_score || 0) - price);
      const title = calculateTrainingTitle(newScore, Number(profile.streak || 0));
      await execute("UPDATE training_profiles SET total_score = ?, title = ?, updated_at = ? WHERE player_id = ?", [newScore, title, now, player.id]);
      await insertTrainingLog(player.id, "商城購買", -price, 0, `購買 ${item.name}：消耗訓練總分 ${price}`, now);
    } else {
      return { success: false, msg: "此商品目前無法購買。", dashboard: await getShopDashboard(uid) };
    }

    const rewards = [];
    for (const reward of item.rewards || []) {
      rewards.push(await applyPlayerReward(player.id, { type: reward.rewardType, amount: reward.rewardValue, cardName: reward.cardName, itemKey: reward.itemKey }, `商城購買：${item.name}`));
    }
    const rewardSummary = rewards.join("、") || "已購買";
    await execute(
      `INSERT INTO shop_purchase_logs (player_id, product_key, purchase_type, date_key, period_key, price_type, price_amount, reward_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [player.id, productKey, "PLAYER", todayKeyTaipei(), limit.periodKey || getShopPeriodKey(item.limitType), item.priceType, price, rewardSummary, now]
    );
    return { success: true, msg: `${item.name} 購買成功：${rewardSummary}`, dashboard: await getShopDashboard(uid) };
  });
}
async function adminListShopItems(adminCtx) {
  const items = await loadShopItems(true);
  return { success: true, rows: items, categories: buildShopCategories(items) };
}
async function adminUpsertShopItem(adminCtx, input = {}) {
  const productKey = normalizeShopKey(input.productKey || input.product_key || input.key || input.name);
  if (!productKey) throw new Error("請輸入商品 Key。");
  const name = String(input.name || "").trim();
  if (!name) throw new Error("請輸入商品名稱。");
  const category = normalizeShopCategory(input.category);
  const priceType = normalizeShopPriceType(input.priceType || input.price_type || (category === "TOPUP" ? "CASH" : category));
  const limitType = normalizeShopLimitType(input.limitType || input.limit_type);
  const priceAmount = Math.max(0, Math.floor(Number(input.priceAmount ?? input.price_amount ?? 0)));
  const limitCount = Math.max(0, Math.floor(Number(input.limitCount ?? input.limit_count ?? 0)));
  const sortOrder = Math.floor(Number(input.sortOrder ?? input.sort_order ?? 0));
  const isActive = (input.isActive ?? input.is_active ?? true) ? 1 : 0;
  const isPaymentEnabled = (input.isPaymentEnabled ?? input.is_payment_enabled ?? false) ? 1 : 0;
  const description = String(input.description || "").trim();
  const tag = String(input.tag || "").trim();
  const rawRewards = Array.isArray(input.rewards) ? input.rewards : [];
  const rewards = rawRewards.map((r, idx) => ({
    rewardType: normalizeShopRewardType(r.rewardType || r.reward_type || r.type),
    rewardValue: Math.max(0, Math.floor(Number(r.rewardValue ?? r.reward_value ?? r.amount ?? 0))),
    cardName: String(r.cardName || r.card_name || r.itemKey || r.item_key || "").trim(),
    sortOrder: Math.floor(Number(r.sortOrder ?? r.sort_order ?? ((idx + 1) * 10)))
  })).filter(r => r.rewardType && r.rewardValue > 0);
  if (!rewards.length) throw new Error("請至少設定一個有效獎勵。");
  for (const reward of rewards) {
    if (reward.rewardType === "CARD") {
      if (!reward.cardName) throw new Error("指定卡片獎勵需要填寫 cardName。");
      const card = await queryOne("SELECT name FROM cards WHERE name = ? LIMIT 1", [reward.cardName]);
      if (!card) throw new Error("找不到指定卡片：" + reward.cardName);
      reward.cardName = card.name;
    }
    if (reward.rewardType === "ITEM") {
      reward.cardName = normalizeItemKey(reward.cardName || ITEM_CARD_RESET_TICKET);
      if (!TLO_ITEM_DEFS[reward.cardName]) throw new Error("不支援的道具代碼：" + reward.cardName);
    }
  }
  const now = new Date().toISOString();
  const old = await queryOne("SELECT * FROM shop_items WHERE product_key = ?", [productKey]);
  await execute(
    `INSERT INTO shop_items (product_key, category, name, description, price_type, price_amount, limit_type, limit_count, is_active, is_payment_enabled, sort_order, tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_key) DO UPDATE SET
       category = excluded.category,
       name = excluded.name,
       description = excluded.description,
       price_type = excluded.price_type,
       price_amount = excluded.price_amount,
       limit_type = excluded.limit_type,
       limit_count = excluded.limit_count,
       is_active = excluded.is_active,
       is_payment_enabled = excluded.is_payment_enabled,
       sort_order = excluded.sort_order,
       tag = excluded.tag,
       updated_at = excluded.updated_at`,
    [productKey, category, name, description, priceType, priceAmount, limitType, limitCount, isActive, isPaymentEnabled, sortOrder, tag, now, now]
  );
  await execute("DELETE FROM shop_item_rewards WHERE product_key = ?", [productKey]);
  for (const r of rewards) {
    await execute("INSERT INTO shop_item_rewards (product_key, reward_type, reward_value, card_name, sort_order) VALUES (?, ?, ?, ?, ?)", [productKey, r.rewardType, r.rewardValue, r.cardName || null, r.sortOrder]);
  }
  await adminAudit(adminCtx.admin.id, old ? "UPDATE_SHOP_ITEM" : "CREATE_SHOP_ITEM", null, { productKey, name, category, priceType, priceAmount, limitType, limitCount, isActive: !!isActive, isPaymentEnabled: !!isPaymentEnabled, rewards });
  return { success: true, msg: `已儲存商城商品：${name}`, rows: (await adminListShopItems(adminCtx)).rows };
}
async function adminSetShopItemActive(adminCtx, productKeyInput, activeInput) {
  const productKey = normalizeShopKey(productKeyInput);
  const row = await queryOne("SELECT * FROM shop_items WHERE product_key = ?", [productKey]);
  if (!row) throw new Error("找不到商城商品：" + productKey);
  const active = activeInput ? 1 : 0;
  await execute("UPDATE shop_items SET is_active = ?, updated_at = ? WHERE product_key = ?", [active, new Date().toISOString(), productKey]);
  await adminAudit(adminCtx.admin.id, "SET_SHOP_ITEM_ACTIVE", null, { productKey, oldValue: Number(row.is_active || 0) === 1, newValue: !!active });
  return { success: true, msg: `${row.name} 已${active ? "上架" : "下架"}`, rows: (await adminListShopItems(adminCtx)).rows };
}
async function adminTestGrantShopItem(adminCtx, uidInput, productKeyInput) {
  const player = await findPlayerByUidLoose(uidInput);
  const productKey = normalizeShopKey(productKeyInput);
  return withTransaction(async () => {
    const items = await loadShopItems(true);
    const item = items.find(x => x.productKey === productKey);
    if (!item) throw new Error("找不到商城商品：" + productKey);
    const now = new Date().toISOString();
    const rewards = [];
    for (const reward of item.rewards || []) rewards.push(await applyPlayerReward(player.id, { type: reward.rewardType, amount: reward.rewardValue, cardName: reward.cardName, itemKey: reward.itemKey }, `GM測試發獎：${item.name}`));
    const rewardSummary = rewards.join("、") || "已發放";
    await execute(
      `INSERT INTO shop_purchase_logs (player_id, product_key, purchase_type, date_key, period_key, price_type, price_amount, reward_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [player.id, productKey, "GM_TEST", todayKeyTaipei(), `GM_TEST:${Date.now()}`, item.priceType, 0, rewardSummary, now]
    );
    await adminAudit(adminCtx.admin.id, "TEST_GRANT_SHOP_ITEM", player.uid, { productKey, itemName: item.name, rewardSummary });
    return { success: true, msg: `已測試發放給 ${player.uid}：${rewardSummary}`, rows: (await adminListShopItems(adminCtx)).rows };
  });
}

const methods = {
  getPublicSettings,
  getMissionDashboard,
  claimOpeningReward,
  claimMissionReward,
  getAchievementDashboard,
  claimAchievementReward,
  redeemCode,
  getRpgDashboard,
  getShopDashboard,
  getPersonalDashboard,
  updatePlayerProfile,
  setPlayerPresenceStatus,
  getSocialDashboard,
  sendFriendRequest,
  respondFriendRequest,
  removeFriend,
  buyShopItem,
  createEcpayOrder,
  setRpgTeam,
  executeRpgAdventure,
  adminGetOpsSettings,
  adminUpdateOpsSettings,
  adminCreateRedeemCode,
  adminListRedeemCodes,
  adminSetRedeemCodeActive,
  adminGetRedeemLogs,
  adminExportTable,
  adminExportAllData,
  adminLogin,
  adminLogout,
  adminMe,
  adminChangeOwnPassword,
  adminSearchPlayers,
  adminGetPlayer,
  adminUpdateDrawTimes,
  adminAddDrawTimes,
  adminUpdateTraining,
  adminGrantSkillExp,
  adminSetCardQuantity,
  adminGiftCard,
  adminResetPlayerPassword,
  adminListCards,
  adminUpsertCard,
  adminUpdateCardSettings,
  adminListBattleChapters,
  adminListBossStages,
  adminUpsertBattleChapter,
  adminSetBattleChapterActive,
  adminUpsertBossStage,
  adminListRpgChapters,
  adminUpsertRpgChapter,
  adminSetRpgChapterActive,
  adminListRpgDungeons,
  adminUpsertRpgDungeon,
  adminSetRpgDungeonActive,
  adminListShopItems,
  adminUpsertShopItem,
  adminSetShopItemActive,
  adminTestGrantShopItem,
  adminGetAuditLogs,
  loginAccount,
  registerAccount,
  changePassword,
  getCurrentAuthUser,
  logoutAccount,
  getHomeState,
  getPlayerCollection,
  getCardProbabilityTable,
  getBattleDashboard,
  setBattleRepresentative,
  executeBattle,
  executeGacha,
  executeGacha10,
  getPlayerHistory,
  getTrainingDashboard,
  claimDailyCheckIn,
  answerDailyQuiz,
  saveMemoryGameScore,
  getShadowQuestion,
  submitShadowGuess,
  claimDailyFortune,
  getMessageBoard,
  submitBoardMessage,
  getPvpDashboard,
  setPvpRepresentative,
  executePvpBattle,
  getStarShopDashboard,
  upgradeCardStar,
  getCharacterGrowthDashboard,
  trainCardLevel,
  upgradeCardSkill,
  useCardResetTicket
};

const publicMethods = new Set(["loginAccount", "registerAccount", "adminLogin", "getPublicSettings"]);
const adminMethods = new Set([
  "adminLogout",
  "adminMe",
  "adminChangeOwnPassword",
  "adminSearchPlayers",
  "adminGetPlayer",
  "adminUpdateDrawTimes",
  "adminAddDrawTimes",
  "adminUpdateTraining",
  "adminGrantSkillExp",
  "adminSetCardQuantity",
  "adminGiftCard",
  "adminResetPlayerPassword",
  "adminListCards",
  "adminUpsertCard",
  "adminUpdateCardSettings",
  "adminListBattleChapters",
  "adminListBossStages",
  "adminUpsertBattleChapter",
  "adminSetBattleChapterActive",
  "adminUpsertBossStage",
  "adminListRpgChapters",
  "adminUpsertRpgChapter",
  "adminSetRpgChapterActive",
  "adminListRpgDungeons",
  "adminUpsertRpgDungeon",
  "adminSetRpgDungeonActive",
  "adminListShopItems",
  "adminUpsertShopItem",
  "adminSetShopItemActive",
  "adminTestGrantShopItem",
  "adminGetAuditLogs",
  "adminGetOpsSettings",
  "adminUpdateOpsSettings",
  "adminCreateRedeemCode",
  "adminListRedeemCodes",
  "adminSetRedeemCodeActive",
  "adminGetRedeemLogs",
  "adminExportTable",
  "adminExportAllData"
]);

router.post("/", async (req, res) => {
  try {
    const { method, args = [] } = req.body || {};
    if (!method || !methods[method]) {
      return res.status(404).json({ success: false, msg: `未知 API 方法：${method}` });
    }

    let finalArgs = Array.isArray(args) ? args.slice() : [];
    let auth = null;

    if (adminMethods.has(method)) {
      auth = await requireAdmin(req);
      finalArgs = [auth, ...finalArgs];
    } else if (!publicMethods.has(method)) {
      auth = await requireAuth(req);
      if (finalArgs.length === 0) {
        finalArgs.push(auth.player.uid);
      } else {
        // 保護玩家資料：登入後所有遊戲 API 一律使用 session 對應的 UID，避免前端竄改 uid。
        finalArgs[0] = auth.player.uid;
      }

      if (method === "logoutAccount") {
        finalArgs[1] = auth.token;
      }
      touchPlayerPresence(auth.player).catch(() => {});
    }

    // 維修模式只限制「玩家端遊戲 API」，不能限制 GM 後台。
    // 使用 startsWith("admin") 做雙保險，避免之後新增 GM API 忘記加入 adminMethods 時被維修模式鎖住。
    // adminLogin 必須永遠放行，否則開啟維修後 GM 會被鎖在後台外面，無法關閉維修。
    const isAdminApi = method === "adminLogin" || method.startsWith("admin");
    const maintenanceAllowedMethods = new Set([
      "getPublicSettings",
      "logoutAccount",
      "getCurrentAuthUser",
      "changePassword"
    ]);
    if (!isAdminApi && !maintenanceAllowedMethods.has(method)) {
      await assertServiceOpen(auth?.player?.uid || "");
    }

    const rpcScope = adminMethods.has(method)
      ? `admin:${auth?.admin?.id || "public"}`
      : (auth?.player?.id ? `player:${auth.player.id}` : `public:${req.ip || "unknown"}`);

    const waitMs = checkRpcRateLimit(method, rpcScope);
    if (waitMs > 0) {
      return res.json({
        success: false,
        msg: `操作太頻繁，請 ${Math.max(1, Math.ceil(waitMs / 1000))} 秒後再試。`
      });
    }

    const cacheTtl = RPC_READ_CACHE_TTL.get(method) || 0;
    let cacheKey = "";
    if (cacheTtl > 0 && !RPC_WRITE_METHODS.has(method)) {
      cacheKey = makeRpcCacheKey(method, rpcScope, finalArgs);
      const cached = getRpcReadCache(cacheKey);
      if (cached) return res.json(cached);

      const inFlight = RPC_INFLIGHT_READS.get(cacheKey);
      if (inFlight) {
        const sharedResult = await inFlight;
        return res.json(sharedResult);
      }
    }

    const startedAt = Date.now();
    let result;
    if (cacheKey && !RPC_WRITE_METHODS.has(method)) {
      if (RPC_INFLIGHT_READS.size >= RPC_INFLIGHT_MAX_ITEMS) {
        const first = RPC_INFLIGHT_READS.keys().next().value;
        if (first) RPC_INFLIGHT_READS.delete(first);
      }
      const job = Promise.resolve().then(() => methods[method](...finalArgs));
      RPC_INFLIGHT_READS.set(cacheKey, job);
      try {
        result = await job;
      } finally {
        clearRpcInflight(cacheKey);
      }
    } else {
      result = await methods[method](...finalArgs);
    }
    const elapsedMs = Date.now() - startedAt;

    if (RPC_WRITE_METHODS.has(method) && result && result.success !== false) {
      clearRpcReadCacheAfterWrite(method, rpcScope);
    } else if (cacheKey && result && result.success !== false) {
      setRpcReadCache(cacheKey, result, cacheTtl);
    }

    if (elapsedMs > 1200) {
      console.warn(`[SLOW_RPC] ${method} ${elapsedMs}ms`);
    }

    res.json(result);
  } catch (err) {
    console.error("RPC error:", err);
    if (isTransientDbError(err)) {
      return res.json({
        success: false,
        msg: "伺服器忙碌中，請稍等 3 秒後再試一次。"
      });
    }
    const code = err.statusCode || 400;
    if (err.maintenance) {
      return res.status(code).json({ success: false, maintenance: true, msg: String(err.message || err) });
    }
    res.status(code).json({ success: false, msg: String(err.message || err) });
  }
});

export default router;
