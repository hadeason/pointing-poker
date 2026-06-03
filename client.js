// Pointing Poker — client logic
(function () {
  'use strict';

  var myId = null;
  var myVote = null;
  var myName = '';
  var myRole = 'mid';
  var isHost = false;
  var state = {
    voters: [],
    revealed: false,
    hostId: null,
    sessionActive: false,
    scale: 'fibonacci',
    scales: {},
    reaction: null,
    roundStartedAt: null,
    sessionStartedAt: null,
    history: [],
  };
  var eventSource = null;
  var lastReactionAt = 0;
  var timerInterval = null;

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  function fmtDuration(ms) {
    if (!ms || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtRole(r) {
    return { junior: 'JR', mid: 'MID', senior: 'SR', other: 'OTHER' }[r] || 'OTHER';
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  // ---------- join flow ----------
  $('join-btn').addEventListener('click', join);
  $('name-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
  $('host-key-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
  $('rejoin-btn').addEventListener('click', function () {
    $('ended-screen').style.display = 'none';
    $('join-screen').style.display = 'flex';
    $('join-error').textContent = '';
    $('waiting-msg').classList.remove('show');
  });

  function join() {
    var name = $('name-input').value.trim();
    var hostKey = $('host-key-input').value.trim();
    var role = $('role-input').value;
    if (!name) return;
    $('join-error').textContent = '';
    $('waiting-msg').classList.remove('show');
    post('/join', { name: name, hostKey: hostKey, role: role }).then(function (data) {
      if (data.error) {
        if (data.error.indexOf('Waiting for host') >= 0) {
          $('waiting-msg').classList.add('show');
        } else {
          $('join-error').textContent = data.error;
        }
        return;
      }
      myId = data.id;
      myName = name;
      myRole = role;
      isHost = data.isHost;
      $('my-name').textContent = name;
      $('my-role-badge').textContent = fmtRole(role);
      $('my-role-badge').className = 'role-badge ' + role;
      $('join-screen').style.display = 'none';
      $('game-screen').style.display = 'block';
      connectSSE();
      startTimers();
    });
  }

  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/events?id=' + myId);
    eventSource.addEventListener('state', function (e) {
      state = JSON.parse(e.data);
      render();
      maybeFireReaction();
    });
    eventSource.addEventListener('ended', function (e) {
      var payload = {};
      try { payload = JSON.parse(e.data); } catch (_) {}
      if (eventSource) { eventSource.close(); eventSource = null; }
      stopTimers();
      myId = null; myVote = null; isHost = false;
      $('game-screen').style.display = 'none';
      $('ended-screen').style.display = 'flex';
      renderSummary(payload.summary || null, payload.history || []);
    });
    eventSource.onerror = function () {
      if (eventSource) eventSource.close();
      setTimeout(function () { if (myId) connectSSE(); }, 2000);
    };
  }

  // ---------- vote / host actions ----------
  function castVote(val) {
    if (state.revealed) return;
    var vote = (myVote === val) ? null : val;
    post('/vote', { id: myId, vote: vote });
    myVote = vote;
    renderCards();
  }

  $('scale-select').addEventListener('change', function () {
    if (!isHost) return;
    var newScale = $('scale-select').value;
    if (newScale === state.scale) return;
    if (!confirm('Switching the scale clears the current round. Continue?')) {
      $('scale-select').value = state.scale;
      return;
    }
    post('/scale', { id: myId, scale: newScale });
  });

  $('reveal-btn').addEventListener('click', function () {
    post('/reveal', { id: myId });
  });
  $('reset-btn').addEventListener('click', function () {
    post('/reset', { id: myId });
    myVote = null;
    renderCards();
  });
  $('end-btn').addEventListener('click', function () {
    if (confirm('End the session? This will show a summary and kick everyone out.')) {
      post('/end', { id: myId });
    }
  });
  $('accept-btn').addEventListener('click', function () {
    var sel = $('accept-estimate-select');
    var est = sel ? sel.value : null;
    post('/accept', { id: myId, estimate: est }).then(function () {
      myVote = null;
      renderCards();
    });
  });
  $('pick-defenders-btn').addEventListener('click', function () {
    post('/pick-defenders', { id: myId });
  });

  // ---------- render ----------
  function render() {
    isHost = (state.hostId === myId);
    $('host-badge').style.display = isHost ? 'inline' : 'none';
    $('host-controls').style.display = isHost ? 'flex' : 'none';
    $('host-tips').style.display = isHost ? 'block' : 'none';
    $('scale-host-note').style.display = isHost ? 'inline' : 'none';
    $('scale-select').disabled = !isHost;
    $('voter-count').textContent = state.voters.length + ' voter' + (state.voters.length !== 1 ? 's' : '');

    if (!state.revealed) {
      var me = state.voters.find(function (v) { return v.id === myId; });
      if (me && !me.voted) myVote = null;
    }

    renderScalePicker();
    renderCards();
    renderVoters();
    renderResults();
    renderSidebarMetrics();

    // Update my role badge in case host changed it
    var meVoter = state.voters.find(function (v) { return v.id === myId; });
    if (meVoter) {
      myRole = meVoter.role;
      $('my-role-badge').textContent = fmtRole(myRole);
      $('my-role-badge').className = 'role-badge ' + myRole;
    }
  }

  function renderScalePicker() {
    var sel = $('scale-select');
    if (sel.dataset.populated !== JSON.stringify(Object.keys(state.scales || {}))) {
      sel.innerHTML = '';
      Object.keys(state.scales || {}).forEach(function (key) {
        var opt = document.createElement('option');
        opt.value = key;
        opt.textContent = state.scales[key].label;
        sel.appendChild(opt);
      });
      sel.dataset.populated = JSON.stringify(Object.keys(state.scales || {}));
    }
    if (sel.value !== state.scale) sel.value = state.scale;
  }

  function renderCards() {
    var cardsEl = $('cards');
    var scale = state.scales[state.scale];
    if (!scale) { cardsEl.innerHTML = ''; return; }
    var values = scale.values;
    // Force exactly 2 rows: ceil(N/2) columns.
    cardsEl.style.setProperty('--cols', Math.ceil(values.length / 2));
    // Rebuild if values changed
    var current = Array.from(cardsEl.querySelectorAll('.card')).map(function (c) { return c.dataset.val; });
    var same = current.length === values.length && current.every(function (v, i) { return v === values[i]; });
    if (!same) {
      cardsEl.innerHTML = '';
      values.forEach(function (val) {
        var card = document.createElement('div');
        card.className = 'card';
        card.textContent = val;
        card.dataset.val = val;
        card.addEventListener('click', function () { castVote(val); });
        cardsEl.appendChild(card);
      });
    }
    Array.from(cardsEl.querySelectorAll('.card')).forEach(function (c) {
      c.classList.toggle('selected', c.dataset.val === myVote);
    });
  }

  function renderVoters() {
    var grid = $('voter-grid');
    grid.innerHTML = '';
    state.voters.forEach(function (v) {
      var el = document.createElement('div');
      var classes = ['voter'];
      if (v.voted) classes.push('has-voted');
      if (v.isCalledOn) classes.push('called-on');
      if (v.isDefender) classes.push('defender');
      if (isHost) classes.push('host-clickable');
      el.className = classes.join(' ');
      var initial = v.name.charAt(0);
      var voteHtml;
      if (state.revealed) {
        voteHtml = v.vote !== null ? esc(v.vote) : '–';
      } else {
        voteHtml = v.voted ? '<div class="hidden-dot"></div>' : '';
      }
      var hostTag = v.isHost ? ' <span class="host-badge">Host</span>' : '';
      var roleTag = '<span class="role-badge ' + esc(v.role) + '">' + fmtRole(v.role) + '</span>';
      el.innerHTML =
        '<div class="voter-avatar">' + esc(initial) + '</div>' +
        '<div class="voter-name">' + esc(v.name) + hostTag + '</div>' +
        '<div class="badges">' + roleTag + '</div>' +
        '<div class="voter-vote">' + voteHtml + '</div>';
      if (isHost) {
        el.addEventListener('click', function (e) {
          if (e.shiftKey) {
            // Shift+click cycles role
            var order = ['junior', 'mid', 'senior', 'other'];
            var next = order[(order.indexOf(v.role) + 1) % order.length];
            post('/role', { id: myId, targetId: v.id, role: next });
          } else {
            post('/call-on', { id: myId, targetId: v.id });
          }
        });
        el.title = 'Click: call on. Shift+click: cycle role (jr→mid→sr→other).';
      }
      grid.appendChild(el);
    });
  }

  function computeResultStats() {
    var scaleDef = state.scales[state.scale];
    var votes = state.voters.map(function (v) { return v.vote; }).filter(function (x) { return x !== null && x !== undefined && x !== '?'; });
    if (votes.length === 0) return { empty: true };

    var stats = { empty: false, distinctVotes: Array.from(new Set(votes)) };
    if (scaleDef && scaleDef.numeric) {
      var nums = votes.map(parseFloat).filter(function (n) { return !Number.isNaN(n); });
      if (nums.length) {
        var sum = nums.reduce(function (a, b) { return a + b; }, 0);
        stats.avg = (sum / nums.length).toFixed(1);
        var sorted = nums.slice().sort(function (a, b) { return a - b; });
        stats.median = sorted.length % 2 === 0
          ? ((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2).toFixed(1)
          : sorted[Math.floor(sorted.length / 2)];
        stats.min = sorted[0];
        stats.max = sorted[sorted.length - 1];
      }
    }
    // Most common
    var counts = {};
    votes.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
    var sortedCounts = Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; });
    stats.mostCommon = sortedCounts[0][0];
    stats.consensus = stats.distinctVotes.length === 1;
    return stats;
  }

  function renderResults() {
    var box = $('results-summary');
    var body = $('results-body');
    var acceptRow = $('accept-row');
    if (!state.revealed) {
      box.classList.remove('show');
      acceptRow.style.display = 'none';
      return;
    }
    var stats = computeResultStats();
    if (stats.empty) {
      box.classList.add('show');
      body.innerHTML = '<div class="results-row"><span class="results-label">No numeric votes cast</span></div>';
    } else {
      var html = '';
      if (stats.avg != null) {
        html += '<div class="results-row"><span class="results-label">Average</span><span class="results-value">' + stats.avg + '</span></div>';
        html += '<div class="results-row"><span class="results-label">Median</span><span class="results-value">' + stats.median + '</span></div>';
        html += '<div class="results-row"><span class="results-label">Range</span><span class="results-value">' + stats.min + ' – ' + stats.max + '</span></div>';
      }
      html += '<div class="results-row"><span class="results-label">Most common</span><span class="results-value">' + esc(stats.mostCommon) + '</span></div>';
      html += '<div class="results-row"><span class="results-label">Consensus</span><span class="results-value">' + (stats.consensus ? '✅ Yes!' : '❌ No') + '</span></div>';
      body.innerHTML = html;
    }
    box.classList.add('show');

    if (isHost) {
      acceptRow.style.display = 'flex';
      var sel = $('accept-estimate-select');
      var scale = state.scales[state.scale];
      var values = scale ? scale.values.filter(function (v) { return v !== '?'; }) : [];
      var castVotes = state.voters.map(function (v) { return v.vote; }).filter(function (x) { return x && x !== '?'; });
      var preferred = null;
      if (!stats.empty) preferred = stats.mostCommon;
      // Rebuild options if needed
      var currentOpts = Array.from(sel.options).map(function (o) { return o.value; });
      var same = currentOpts.length === values.length && currentOpts.every(function (v, i) { return v === values[i]; });
      if (!same) {
        sel.innerHTML = '';
        values.forEach(function (v) {
          var opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          sel.appendChild(opt);
        });
      }
      if (preferred && values.indexOf(preferred) >= 0) sel.value = preferred;
    } else {
      acceptRow.style.display = 'none';
    }
  }

  // ---------- sidebar + timers ----------
  function startTimers() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(renderSidebarMetrics, 1000);
  }
  function stopTimers() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  function renderSidebarMetrics() {
    var now = Date.now();
    var roundMs = state.roundStartedAt ? (now - state.roundStartedAt) : 0;
    var sessionMs = state.sessionStartedAt ? (now - state.sessionStartedAt) : 0;
    $('round-timer').textContent = fmtDuration(roundMs);
    $('session-time').textContent = fmtDuration(sessionMs);

    var history = state.history || [];
    $('rounds-done').textContent = String(history.length);
    var avg = history.length
      ? Math.round(history.reduce(function (a, r) { return a + r.durationMs; }, 0) / history.length)
      : 0;
    $('avg-round-time').textContent = fmtDuration(avg);
    $('team-consensus-count').textContent = String(history.filter(function (r) { return r.teamConsensus; }).length);
    $('senior-consensus-count').textContent = String(history.filter(function (r) { return r.seniorConsensus; }).length);
  }

  // ---------- reactions: confetti + sad faces ----------
  function maybeFireReaction() {
    var r = state.reaction;
    if (!r || !r.at || r.at === lastReactionAt) return;
    lastReactionAt = r.at;
    if (r.type === 'consensus' || r.type === 'senior-consensus') {
      fireConfetti(r.type === 'senior-consensus' ? 80 : 140);
    } else if (r.type === 'discrepancy') {
      fireAlarm(20);
    }
  }

  function fireConfetti(count) {
    var layer = $('particle-layer');
    var colors = ['#43b458', '#7bca8a', '#0c1416', '#5a6b6e', '#d8e2e0', '#132229', '#38a04a'];
    for (var i = 0; i < count; i++) {
      var p = document.createElement('div');
      p.className = 'particle confetti';
      p.style.left = (Math.random() * 100) + 'vw';
      p.style.top = (-20 - Math.random() * 40) + 'px';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDuration = (1.8 + Math.random() * 1.6) + 's';
      p.style.animationDelay = (Math.random() * 0.3) + 's';
      p.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
      layer.appendChild(p);
      setTimeout(function (el) { return function () { el.remove(); }; }(p), 3500);
    }
  }

  function fireAlarm(count) {
    var layer = $('particle-layer');
    var icons = ['🚨', '🆘', '⚠️', '💔', '😢', '😞', '😔', '😭'];
    // Red border flash on the screen
    var flash = document.createElement('div');
    flash.className = 'alarm-flash';
    document.body.appendChild(flash);
    setTimeout(function () { flash.remove(); }, 1800);
    // Falling alarm icons + sad faces
    for (var i = 0; i < count; i++) {
      var p = document.createElement('div');
      p.className = 'particle alarm';
      p.textContent = icons[Math.floor(Math.random() * icons.length)];
      p.style.left = (Math.random() * 100) + 'vw';
      p.style.top = (-40 - Math.random() * 80) + 'px';
      p.style.animationDuration = (2.0 + Math.random() * 1.2) + 's';
      p.style.animationDelay = (Math.random() * 0.4) + 's';
      layer.appendChild(p);
      setTimeout(function (el) { return function () { el.remove(); }; }(p), 4000);
    }
  }

  // ---------- summary screen ----------
  function renderSummary(summary, history) {
    var tiles = $('summary-tiles');
    var perWrap = $('per-scale-wrap');
    var tbody = $('round-table-body');
    tiles.innerHTML = '';
    perWrap.innerHTML = '';
    tbody.innerHTML = '';
    if (!summary) {
      tiles.innerHTML = '<div class="summary-tile"><div class="value">0</div><div class="label">Rounds</div></div>';
      return;
    }
    var addTile = function (value, label) {
      var t = document.createElement('div');
      t.className = 'summary-tile';
      t.innerHTML = '<div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div>';
      tiles.appendChild(t);
    };
    addTile(fmtDuration(summary.totalMs), 'Total time');
    addTile(summary.totalRounds, 'Rounds');
    addTile(summary.totalTeamConsensus, 'Team consensus');
    addTile(summary.totalSeniorConsensus, 'Senior consensus');

    Object.keys(summary.perScale).forEach(function (key) {
      var s = summary.perScale[key];
      var card = document.createElement('div');
      card.className = 'per-scale';
      card.innerHTML =
        '<h4>' + esc(s.label) + '</h4>' +
        '<div class="per-scale-grid">' +
          '<div class="cell"><div class="v">' + esc(s.rounds) + '</div><div class="l">Rounds</div></div>' +
          (s.avgEstimate != null ? '<div class="cell"><div class="v">' + esc(s.avgEstimate) + '</div><div class="l">Avg estimate</div></div>' : '') +
          (s.mostCommon != null ? '<div class="cell"><div class="v">' + esc(s.mostCommon) + '</div><div class="l">Most common</div></div>' : '') +
          '<div class="cell"><div class="v">' + esc(s.teamConsensus) + '</div><div class="l">Team consensus</div></div>' +
          '<div class="cell"><div class="v">' + esc(s.seniorConsensus) + '</div><div class="l">Senior consensus</div></div>' +
          '<div class="cell"><div class="v">' + fmtDuration(s.avgDurationMs) + '</div><div class="l">Avg time / round</div></div>' +
        '</div>';
      perWrap.appendChild(card);
    });

    (summary.rounds || []).forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(r.roundNumber) + '</td>' +
        '<td>' + esc(r.scaleLabel) + '</td>' +
        '<td>' + fmtDuration(r.durationMs) + '</td>' +
        '<td>' + (r.acceptedEstimate != null ? esc(r.acceptedEstimate) : '—') + '</td>' +
        '<td>' + (r.seniorConsensus ? '✅' : '—') + '</td>' +
        '<td>' + (r.teamConsensus ? '✅' : '—') + '</td>';
      tbody.appendChild(tr);
    });
  }

  // ---------- cleanup ----------
  window.addEventListener('beforeunload', function () {
    if (myId) navigator.sendBeacon('/leave', JSON.stringify({ id: myId }));
  });
})();
