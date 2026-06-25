(function () {
  'use strict';

  var state = {
    dashboard: null,
    selectedStageId: null,
    runId: null,
    battle: null,
    selectedTileId: null,
    isAnimating: false,
    timerId: null,
    timeLeft: 0,
    hintedIds: new Set()
  };

  var AUDIO_BASE_PATH = './audio/';
  var AUDIO = {
    boss_warning: AUDIO_BASE_PATH + 'boss_warning.mp3',
    boss_attack: AUDIO_BASE_PATH + 'boss_attack.mp3',
    boss_hit_player: AUDIO_BASE_PATH + 'boss_hit_player.mp3',
    card_merge: AUDIO_BASE_PATH + 'card_merge.mp3',
    card_hit_boss: AUDIO_BASE_PATH + 'card_hit_boss.mp3',
    combo_bonus: AUDIO_BASE_PATH + 'combo_bonus.mp3',
    battle_victory: AUDIO_BASE_PATH + 'battle_victory.mp3',
    battle_failed: AUDIO_BASE_PATH + 'battle_failed.mp3',
    player_attack_normal: AUDIO_BASE_PATH + 'player_attack_normal.mp3',
    player_attack_rare: AUDIO_BASE_PATH + 'player_attack_rare.mp3',
    player_attack_super_rare: AUDIO_BASE_PATH + 'player_attack_super_rare.mp3',
    player_attack_ssr: AUDIO_BASE_PATH + 'player_attack_ssr.mp3',
    player_attack_ur: AUDIO_BASE_PATH + 'player_attack_ur.mp3'
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }
  function sleep(ms) { return new Promise(function(resolve){ setTimeout(resolve, ms); }); }

  function playAudio(key) {
    try {
      var src = AUDIO[key];
      if (!src) return;
      var a = new Audio(src);
      a.volume = key.indexOf('boss') >= 0 ? 0.72 : 0.58;
      var result = a.play();
      if (result && typeof result.catch === 'function') result.catch(function(){});
    } catch (_) {}
  }

  function playAttackByRarity(rarity) {
    var key = 'player_attack_' + String(rarity || 'Normal').toLowerCase().replace(/\s+/g, '_');
    if (!AUDIO[key]) key = 'player_attack_normal';
    playAudio(key);
  }

  function callRpc(method, args) {
    return new Promise(function(resolve, reject) {
      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[method].apply(null, args || []);
    });
  }

  function formatTime(sec) {
    var n = Math.max(0, Math.floor(Number(sec || 0)));
    var m = Math.floor(n / 60);
    var s = n % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function setMsg(html, color) {
    var el = $('link-battle-msg');
    if (!el) return;
    el.style.color = color || '#aaa';
    el.innerHTML = html || '';
  }

  function setButtonsDisabled(disabled) {
    ['link-battle-start-btn','link-battle-hint-btn','link-battle-shuffle-btn'].forEach(function(id) {
      var el = $(id);
      if (el) el.disabled = !!disabled;
    });
  }

  function isBattleActive() {
    return !!(state.battle && state.battle.status !== 'victory' && state.battle.status !== 'failed');
  }

  function updateShellMode() {
    var shell = $('link-battle-shell');
    if (!shell) return;
    shell.classList.toggle('in-battle', isBattleActive());
    var startBtn = $('link-battle-start-btn');
    if (startBtn) startBtn.style.display = isBattleActive() ? 'none' : '';
  }

  function openModal() {
    var modal = $('link-battle-modal');
    if (modal) modal.style.display = 'flex';
    loadDashboard();
  }

  function closeModal() {
    stopTimer();
    var modal = $('link-battle-modal');
    if (modal) modal.style.display = 'none';
  }

  function stopTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
  }

  function startTimer(seconds) {
    stopTimer();
    state.timeLeft = Number(seconds || 0);
    updateTimerText();
    if (state.timeLeft <= 0) return;
    state.timerId = setInterval(function() {
  var TLO_LINK_BATTLE_BUILD = '20260626-formal-ui-v2';
  try { console.info('[TLO LinkBattle] build', TLO_LINK_BATTLE_BUILD); } catch (e) {}
      if (!state.battle || state.battle.status === 'victory' || state.battle.status === 'failed') return stopTimer();
      state.timeLeft -= 1;
      updateTimerText();
      if (state.timeLeft <= 0) {
        stopTimer();
        state.battle.status = 'failed';
        setMsg('<b style="color:#ff7777">時間結束，挑戰失敗。</b>', '#ff7777');
        playAudio('battle_failed');
        setButtonsDisabled(true);
      }
    }, 1000);
  }

  function updateTimerText() {
    var el = $('link-battle-time');
    if (el) el.textContent = formatTime(state.timeLeft);
  }

  async function loadDashboard(stageId) {
    setMsg('正在讀取卡牌連線討伐戰資料...', '#00fff0');
    try {
      var res = await callRpc('getLinkBattleDashboard', [window.playerUID || window.TLO_PLAYER_UID || '', stageId || state.selectedStageId || null]);
      if (!res || !res.success) throw new Error((res && res.msg) || '讀取失敗');
      state.dashboard = res;
      state.selectedStageId = res.selectedStageId || (res.selectedStage && res.selectedStage.stageId) || state.selectedStageId;
      renderDashboard();
      if (!res.canEnter) {
        setMsg(escapeHtml(res.msg || '你的圖鑑卡牌不足，至少解鎖 4 種卡牌後，才能進入卡牌連線討伐戰。').replace(/\n/g,'<br>'), '#ffdd77');
      } else {
        setMsg('請選擇關卡並開始挑戰。', '#aaa');
      }
    } catch (err) {
      setMsg('讀取失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    }
  }

  function renderDashboard() {
    var list = $('link-battle-stage-list');
    var dash = state.dashboard || {};
    var stages = dash.stages || [];
    if (list) {
      list.innerHTML = stages.map(function(stage) {
        var cls = ['link-battle-stage-btn'];
        if (stage.stageId === state.selectedStageId) cls.push('current');
        if (stage.cleared) cls.push('cleared');
        if (!stage.unlocked) cls.push('locked');
        return '<button class="' + cls.join(' ') + '" ' + (!stage.unlocked ? 'disabled' : '') + ' onclick="TLOLinkBattle.selectStage(\'' + escapeHtml(stage.stageId) + '\')">' + Number(stage.stageOrder || 0) + '</button>';
      }).join('') || '<span class="muted">尚無開放關卡。</span>';
    }
    var stage = stages.find(function(s){ return s.stageId === state.selectedStageId; }) || dash.selectedStage || stages[0];
    if (stage) renderStagePreview(stage);
    var startBtn = $('link-battle-start-btn');
    if (startBtn) startBtn.disabled = !dash.canEnter || !stage || !stage.unlocked;
    updateShellMode();
  }

  function renderStagePreview(stage) {
    var boss = stage.boss || {};
    var bg = $('link-battle-boss-bg');
    if (bg) bg.style.backgroundImage = boss.bossBackground || boss.bossImage ? 'url("' + (boss.bossBackground || boss.bossImage) + '")' : '';
    if ($('link-battle-stage-name')) $('link-battle-stage-name').textContent = stage.stageName || '卡牌連線討伐戰';
    if ($('link-battle-boss-name')) $('link-battle-boss-name').textContent = boss.bossName || '連線戰 BOSS';
    if ($('link-battle-boss-hp-text')) $('link-battle-boss-hp-text').textContent = '尚未開始';
    if ($('link-battle-player-hp')) $('link-battle-player-hp').textContent = '--';
    if ($('link-battle-combo')) $('link-battle-combo').textContent = '0';
    if ($('link-battle-rage-fill')) $('link-battle-rage-fill').style.width = '0%';
    if ($('link-battle-hpfill')) $('link-battle-hpfill').style.width = '100%';
    if ($('link-battle-time')) $('link-battle-time').textContent = formatTime(stage.timeLimitSeconds || 0);
    var center = $('link-battle-boss-center');
    if (center) center.innerHTML = '<span class="link-battle-boss-silhouette">BOSS</span>';
  }

  function selectStage(stageId) {
    state.selectedStageId = stageId;
    renderDashboard();
  }

  async function startBattle() {
    if (state.isAnimating) return;
    setButtonsDisabled(true);
    setMsg('正在產生連線卡牌盤面...', '#00fff0');
    try {
      var res = await callRpc('startLinkBattle', [window.playerUID || window.TLO_PLAYER_UID || '', state.selectedStageId]);
      if (!res || !res.success) {
        if (res && res.dashboard) state.dashboard = res.dashboard;
        renderDashboard();
        setMsg(escapeHtml((res && res.msg) || '無法開始挑戰').replace(/\n/g,'<br>'), '#ffdd77');
        setButtonsDisabled(false);
        return;
      }
      state.runId = res.runId;
      state.battle = res.state;
      state.selectedTileId = null;
      state.hintedIds = new Set();
      renderBattleState();
      startTimer(state.battle.stage && state.battle.stage.timeLimitSeconds);
      setMsg('連線相同卡牌，合成攻擊 BOSS！', '#00fff0');
      setButtonsDisabled(false);
    } catch (err) {
      setMsg('開始失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
      setButtonsDisabled(false);
    }
  }

  function renderBattleState() {
    var b = state.battle || {};
    var boss = b.boss || (b.stage && b.stage.boss) || {};
    var bg = $('link-battle-boss-bg');
    if (bg) bg.style.backgroundImage = boss.bossBackground || boss.bossImage ? 'url("' + (boss.bossBackground || boss.bossImage) + '")' : '';
    if ($('link-battle-stage-name')) $('link-battle-stage-name').textContent = (b.stage && b.stage.stageName) || '卡牌連線討伐戰';
    if ($('link-battle-boss-name')) $('link-battle-boss-name').textContent = boss.bossName || '連線戰 BOSS';
    var hpPct = b.bossMaxHp > 0 ? Math.max(0, Math.min(100, Math.round(Number(b.bossHp || 0) / Number(b.bossMaxHp || 1) * 100))) : 0;
    if ($('link-battle-hpfill')) $('link-battle-hpfill').style.width = hpPct + '%';
    if ($('link-battle-boss-hp-text')) $('link-battle-boss-hp-text').textContent = Math.max(0, Number(b.bossHp || 0)).toLocaleString() + ' / ' + Number(b.bossMaxHp || 0).toLocaleString();
    if ($('link-battle-player-hp')) $('link-battle-player-hp').textContent = Math.max(0, Number(b.playerHp || 0)).toLocaleString() + ' / ' + Number(b.playerMaxHp || 0).toLocaleString();
    if ($('link-battle-combo')) $('link-battle-combo').textContent = Number(b.combo || 0);
    if ($('link-battle-error')) $('link-battle-error').textContent = Number(b.errorCount || 0) + ' / ' + Number((b.stage && b.stage.errorLimit) || 0);
    if ($('link-battle-shuffle-left')) $('link-battle-shuffle-left').textContent = Number(b.shuffleLeft || 0);
    if ($('link-battle-hint-left')) $('link-battle-hint-left').textContent = Number(b.hintLeft || 0);
    var rageLimit = Number((b.stage && b.stage.bossRageLimit) || 100);
    var ragePct = Math.max(0, Math.min(100, Math.round(Number(b.bossRage || 0) / rageLimit * 100)));
    if ($('link-battle-rage-fill')) $('link-battle-rage-fill').style.width = ragePct + '%';
    var center = $('link-battle-boss-center');
    if (center) center.innerHTML = boss.bossImage || boss.bossBackground ? '' : '<span class="link-battle-boss-silhouette">BOSS</span>';
    renderBoard();
    var active = !state.isAnimating && b.status !== 'victory' && b.status !== 'failed';
    if ($('link-battle-hint-btn')) $('link-battle-hint-btn').disabled = !active || Number(b.hintLeft || 0) <= 0;
    if ($('link-battle-shuffle-btn')) $('link-battle-shuffle-btn').disabled = !active || Number(b.shuffleLeft || 0) <= 0;
    updateShellMode();
  }

  function getBoardDimensions(board) {
    var layers = (board || []).length || 1;
    var rows = 1;
    var cols = 1;
    (board || []).forEach(function(layer) {
      rows = Math.max(rows, (layer || []).length || 0);
      (layer || []).forEach(function(row) { cols = Math.max(cols, (row || []).length || 0); });
    });
    return { layers: layers, rows: rows, cols: cols };
  }

  function flattenBoardForRender(board) {
    var tiles = [];
    for (var layer = 0; layer < (board || []).length; layer++) {
      for (var row = 0; row < (board[layer] || []).length; row++) {
        for (var col = 0; col < (board[layer][row] || []).length; col++) {
          var tile = board[layer][row][col];
          if (tile) tiles.push(Object.assign({}, tile, { layer: layer, row: row, col: col, selectable: isTileSelectable(tile) }));
        }
      }
    }
    return tiles;
  }

  function renderBoard() {
    var wrap = $('link-battle-board');
    if (!wrap) return;
    var b = state.battle || {};
    var data = b.boardData || {};
    var board = (data.board || b.board || []);
    if (!board.length) {
      wrap.innerHTML = '<div class="link-battle-board-empty">選擇關卡後開始挑戰。</div>';
      return;
    }

    var dims = getBoardDimensions(board);
    var renderTiles = (data.tiles && data.tiles.length ? data.tiles : flattenBoardForRender(board)).map(function(tile) {
      return Object.assign({}, tile, {
        layer: Number(tile.layer || 0),
        row: Number(tile.row || 0),
        col: Number(tile.col || 0)
      });
    });

    var wrapWidth = Math.max(300, wrap.clientWidth || 360);
    var usableWidth = Math.max(280, wrapWidth - 22);
    var densityWidth = (dims.cols * 0.84) + (dims.layers * 0.24);
    var tileW = Math.floor(usableWidth / Math.max(5.2, densityWidth));
    tileW = Math.max(34, Math.min(58, tileW));
    var tileH = Math.round(tileW * 1.46);
    var colStep = Math.round(tileW * 0.82);
    var rowStep = Math.round(tileH * 0.60);
    var layerOffsetX = Math.round(tileW * 0.18);
    var layerOffsetY = Math.round(tileH * 0.13);
    var boardW = 20 + ((dims.cols - 1) * colStep) + tileW + ((dims.layers - 1) * layerOffsetX);
    var boardH = 20 + ((dims.layers - 1) * layerOffsetY) + ((dims.rows - 1) * rowStep) + tileH;

    renderTiles.sort(function(a, b) {
      if (a.layer !== b.layer) return a.layer - b.layer;
      if (a.row !== b.row) return a.row - b.row;
      return a.col - b.col;
    });

    var html = '<div class="link-battle-stacked-board" style="width:' + boardW + 'px;height:' + boardH + 'px;--tile-w:' + tileW + 'px;--tile-h:' + tileH + 'px;">';
    renderTiles.forEach(function(tile) {
      var x = 10 + (tile.col * colStep) + (tile.layer * layerOffsetX);
      var y = 10 + ((dims.layers - 1 - tile.layer) * layerOffsetY) + (tile.row * rowStep);
      var z = (tile.layer * 1000) + (tile.row * 20) + tile.col;
      html += renderTile(tile, 'left:' + x + 'px;top:' + y + 'px;z-index:' + z + ';');
    });
    html += '</div>';
    wrap.innerHTML = html;
  }

  function isTileSelectable(tile) {
    var tiles = (state.battle && state.battle.boardData && state.battle.boardData.tiles) || [];
    var current = tiles.find(function(t){ return t.tile_id === tile.tile_id; });
    return current ? !!current.selectable : true;
  }

  function rarityClass(rarity) {
    return 'link-battle-rarity-' + String(rarity || 'Normal').replace(/\s+/g, '-');
  }

  function renderTile(tile, positionStyle) {
    var selectable = tile.selectable != null ? !!tile.selectable : isTileSelectable(tile);
    var cls = ['link-battle-tile', rarityClass(tile.rarity)];
    if (!selectable) cls.push('covered');
    if (tile.locked_until && new Date(String(tile.locked_until)).getTime() > Date.now()) cls.push('locked');
    if (state.selectedTileId === tile.tile_id) cls.push('selected');
    if (state.hintedIds.has(tile.tile_id)) cls.push('hinted');
    var img = tile.image_url
      ? '<img src="' + escapeHtml(tile.image_url) + '" alt="' + escapeHtml(tile.card_name) + '" draggable="false">'
      : '<div class="link-battle-tile-fallback">🎴</div>';
    return '<button class="' + cls.join(' ') + '" style="' + (positionStyle || '') + '" title="' + escapeHtml(tile.card_name) + '" aria-label="' + escapeHtml(tile.card_name) + '" data-tile-id="' + escapeHtml(tile.tile_id) + '" ' + (!selectable || state.isAnimating ? 'disabled' : '') + ' onclick="TLOLinkBattle.pickTile(\'' + escapeHtml(tile.tile_id) + '\')">' + img + '</button>';
  }

  function findTile(tileId) {
    var tiles = (state.battle && state.battle.boardData && state.battle.boardData.tiles) || [];
    return tiles.find(function(t){ return t.tile_id === tileId; }) || null;
  }

  async function pickTile(tileId) {
    if (state.isAnimating || !state.battle || !state.runId) return;
    if (!state.selectedTileId) {
      state.selectedTileId = tileId;
      renderBoard();
      return;
    }
    if (state.selectedTileId === tileId) {
      state.selectedTileId = null;
      renderBoard();
      return;
    }
    var tileA = findTile(state.selectedTileId);
    var tileB = findTile(tileId);
    var aId = state.selectedTileId;
    state.selectedTileId = null;
    state.hintedIds = new Set();
    state.isAnimating = true;
    renderBattleState();
    try {
      var res = await callRpc('resolveLinkBattleMove', [window.playerUID || window.TLO_PLAYER_UID || '', state.runId, aId, tileId]);
      if (!res || !res.success) throw new Error((res && res.msg) || '連線失敗');
      if (res.effects && res.effects.playerAttack) await playPlayerAttack(res.effects.playerAttack, tileA || tileB);
      if (res.effects && res.effects.invalid) {
        playAudio('boss_hit_player');
        setMsg('連線失敗：' + escapeHtml(res.effects.invalid.reason || ''), '#ff7777');
      }
      state.battle = res.state;
      state.battle.status = res.status;
      renderBattleState();
      if (res.effects && res.effects.bossCounter) await playBossCounter(res.effects.bossCounter);
      handleBattleEnd(res.status, res.reason);
    } catch (err) {
      setMsg('操作失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    } finally {
      state.isAnimating = false;
      renderBattleState();
    }
  }

  async function playPlayerAttack(effect, tile) {
    playAudio('card_merge');
    await sleep(120);
    playAttackByRarity(effect.rarity);
    var card = $('link-battle-attack-card');
    if (card) {
      card.innerHTML = tile && tile.image_url ? '<img src="' + escapeHtml(tile.image_url) + '" alt="">' : '<div style="font-size:42px">🎴</div>';
      card.className = 'link-battle-attack-card active';
    }
    await sleep(520);
    playAudio('card_hit_boss');
    showDamage(effect.damage, effect.comboBonus);
    var shell = $('link-battle-shell');
    if (shell) {
      shell.classList.add('boss-shake');
      setTimeout(function(){ shell.classList.remove('boss-shake'); }, 560);
    }
    await sleep(320);
    if (card) card.className = 'link-battle-attack-card';
    if (Number(effect.comboBonus || 0) > 0) playAudio('combo_bonus');
  }

  function showDamage(damage, comboBonus) {
    var shell = $('link-battle-shell');
    if (!shell) return;
    var el = document.createElement('div');
    el.className = 'link-battle-float-damage';
    el.innerHTML = '-' + Number(damage || 0).toLocaleString() + (Number(comboBonus || 0) > 0 ? '<div style="font-size:13px;color:#ffdd77">Combo Bonus +' + Number(comboBonus || 0).toLocaleString() + '</div>' : '');
    shell.appendChild(el);
    setTimeout(function(){ if (el && el.parentNode) el.parentNode.removeChild(el); }, 950);
  }

  async function playBossCounter(effect) {
    playAudio('boss_warning');
    var warning = $('link-battle-warning');
    if (warning) warning.classList.add('active');
    await sleep(900);
    if (warning) warning.classList.remove('active');
    playAudio('boss_attack');
    var shell = $('link-battle-shell');
    if (shell) {
      shell.classList.add('boss-redflash', 'boss-shake', 'boss-distort');
      setTimeout(function(){ shell.classList.remove('boss-redflash', 'boss-shake', 'boss-distort'); }, 720);
    }
    if (effect && Number(effect.playerHpDamage || 0) > 0) playAudio('boss_hit_player');
    setMsg('BOSS反擊：' + escapeHtml(effect.label || effect.skill || '攻擊'), '#ff7777');
    await sleep(760);
  }

  function handleBattleEnd(status, reason) {
    if (status === 'victory') {
      stopTimer();
      playAudio('battle_victory');
      setMsg('<b style="color:#00ff7f">討伐成功！Combo讓你提前擊破 BOSS。</b>', '#00ff7f');
      setButtonsDisabled(true);
      loadDashboard(state.selectedStageId);
    } else if (status === 'failed') {
      stopTimer();
      playAudio('battle_failed');
      setMsg('<b style="color:#ff7777">挑戰失敗：' + escapeHtml(reason || 'FAILED') + '</b>', '#ff7777');
      setButtonsDisabled(true);
    }
  }

  async function useHint() {
    if (state.isAnimating || !state.runId) return;
    state.isAnimating = true;
    try {
      var res = await callRpc('useLinkBattleHint', [window.playerUID || window.TLO_PLAYER_UID || '', state.runId]);
      if (!res || !res.success) throw new Error((res && res.msg) || '提示失敗');
      state.battle = res.state;
      state.battle.status = res.status;
      state.hintedIds = new Set([res.hint.tileAId, res.hint.tileBId]);
      renderBattleState();
      setMsg('已高亮一組可連線卡牌。使用提示會清空 Combo，並增加 BOSS 怒氣。', '#ffdd77');
      if (res.effects && res.effects.bossCounter) await playBossCounter(res.effects.bossCounter);
      handleBattleEnd(res.status);
    } catch (err) {
      setMsg('提示失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    } finally {
      state.isAnimating = false;
      renderBattleState();
    }
  }

  async function shuffleBoard() {
    if (state.isAnimating || !state.runId) return;
    state.isAnimating = true;
    try {
      var res = await callRpc('shuffleLinkBattle', [window.playerUID || window.TLO_PLAYER_UID || '', state.runId]);
      if (!res || !res.success) throw new Error((res && res.msg) || '洗牌失敗');
      state.battle = res.state;
      state.battle.status = res.status;
      state.hintedIds = new Set();
      renderBattleState();
      setMsg('已重新洗牌。洗牌會增加 BOSS 怒氣。', '#ffdd77');
      if (res.effects && res.effects.bossCounter) await playBossCounter(res.effects.bossCounter);
      handleBattleEnd(res.status);
    } catch (err) {
      setMsg('洗牌失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    } finally {
      state.isAnimating = false;
      renderBattleState();
    }
  }

  var resizeRenderTimer = null;
  window.addEventListener('resize', function() {
    if (!state.battle) return;
    clearTimeout(resizeRenderTimer);
    resizeRenderTimer = setTimeout(renderBoard, 120);
  });

  window.TLOLinkBattle = {
    openModal: openModal,
    closeModal: closeModal,
    loadDashboard: loadDashboard,
    selectStage: selectStage,
    startBattle: startBattle,
    pickTile: pickTile,
    useHint: useHint,
    shuffleBoard: shuffleBoard
  };
  window.openLinkBattleModal = openModal;
})();
