# 卡牌連線討伐戰整合完成報告

## 已整合內容

### 前端 tlo-frontend-main
- 新增 `css/link-battle.css`
  - BOSS WARNING 動畫
  - BOSS 攻擊紅光 / 震動 / 扭曲效果
  - 玩家卡牌合成大卡撞擊 BOSS 動畫
  - 連線戰手機版 UI
- 新增 `js/link-battle.js`
  - 玩家端連線戰入口
  - 關卡列表讀取
  - 開始挑戰
  - 卡牌選取 / 後端驗證連線
  - 玩家攻擊動畫
  - BOSS WARNING / 反擊動畫
  - 洗牌 / 提示
  - Normal / RARE / SUPER RARE / SSR / UR 對應音效
- 修改 `index.html`
  - 戰鬥大廳新增「卡牌連線討伐戰」入口
  - 新增連線戰 Modal
  - 引入 `css/link-battle.css`
  - 引入 `js/link-battle.js`
- 修改 `js/api-bridge.js`
  - 新增 `getLinkBattleDashboard` 讀取型 RPC dedupe 支援

### 後端 tlo-backend-main
- 新增 `src/utils/linkBattleDefaults.js`
  - 30 關預設難度
  - 預設 BOSS 資料
- 新增 `src/utils/linkBattleEngine.js`
  - 進入限制
  - 稀有度轉換：Normal / RARE / SUPER RARE / SSR / UR
  - 盤面生成
  - 中等版連線判定：同卡、同層、未覆蓋、直線或一次轉彎
  - Combo 倍率與 Bonus
  - BOSS HP = 本場卡牌基礎傷害總和 × GM HP倍率
  - 洗牌 / 可連線檢查
- 修改 `src/routes/rpc.js`
  - 玩家 API：
    - `getLinkBattleDashboard`
    - `startLinkBattle`
    - `resolveLinkBattleMove`
    - `useLinkBattleHint`
    - `shuffleLinkBattle`
  - GM API：
    - `adminListLinkBattleStages`
    - `adminListLinkBattleBosses`
    - `adminUpsertLinkBattleStage`
    - `adminSetLinkBattleStageActive`
    - `adminUpsertLinkBattleBoss`
  - 自動建立資料表與預設關卡 / BOSS
- 修改 schema：
  - `schema.sql`
  - `schema.supabase.sql`
  - `src/schema.sql`
  - `src/schema.supabase.sql`
- 新增 `scripts/test-link-battle-engine.js`

### GM 後台
- 修改 `admin.html`
  - 新增「連線討伐戰」分頁
  - 可編輯 BOSS
  - 可編輯關卡 HP倍率、卡牌數、層數、時間、錯誤、洗牌、提示、Combo 秒數、稀有度權重
  - 可啟用 / 停用關卡
  - 備份匯出選單加入 link battle 相關資料表

## 音效來源確認
目前玩家端音效路徑使用前端根目錄既有檔案：
- `./audio/boss_warning.mp3`
- `./audio/boss_attack.mp3`
- `./audio/boss_hit_player.mp3`
- `./audio/card_merge.mp3`
- `./audio/card_hit_boss.mp3`
- `./audio/combo_bonus.mp3`
- `./audio/battle_victory.mp3`
- `./audio/battle_failed.mp3`
- `./audio/player_attack_normal.mp3`
- `./audio/player_attack_rare.mp3`
- `./audio/player_attack_super_rare.mp3`
- `./audio/player_attack_ssr.mp3`
- `./audio/player_attack_ur.mp3`

目前素材已統一放在 `audio/`，`js/link-battle.js` 內 `AUDIO` map 已改為讀取 `./audio/`。

## 已執行檢查
- 後端：`npm run check`
- 後端：`node scripts/test-link-battle-engine.js`
- 前端：`node --check js/api-bridge.js`
- 前端：`node --check js/link-battle.js`
- 前端：抽出 `index.html` inline script 進行 `node --check`
- 前端：抽出 `admin.html` inline script 進行 `node --check`

## 給 Codex 的檢查重點
1. 請確認 Railway / Supabase 環境第一次呼叫 `getLinkBattleDashboard` 時，`ensureLinkBattleSchema()` 可成功建立資料表。
2. 請確認現有 cards 表可以成功新增 `allow_link_battle` 欄位。
3. 請確認 `player_collection.quantity > 0` 的卡牌才會進入連線戰圖鑑可用卡。
4. 請確認前端音效檔案在部署後仍位於根目錄；若搬移，需修改 `js/link-battle.js` 的 `AUDIO` map。
5. 請使用正式測試帳號至少解鎖 4 種卡牌後進入「戰鬥 → 卡牌連線討伐戰」。
