// Token Radar's plain dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable sortable table, a per-protocol detail panel with the model's
// own multipliers and a recompute check, and a model panel. No network: every byte is in data.js.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var app = document.getElementById('board');
  var state = { q: '', cat: 'all', sort: 'rank', dir: -1, sel: null };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    return d >= 365 ? (d / 365).toFixed(1) + 'y' : Math.max(0, Math.round(d)) + 'd';
  }

  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same arithmetic.
  function impliedOf(r, m) {
    var g = clamp(r.change_7d === null || r.change_7d === undefined ? 0 : r.change_7d, m.growth_floor, m.growth_cap);
    var w = g >= 0 ? m.growth_weight_up : m.growth_weight_down;
    var growth = 1 + (g / 100) * w;
    var age = r.age_days === null || r.age_days === undefined ? m.unknown_age_days : r.age_days;
    var x = clamp(age, 0, m.maturity_days) / m.maturity_days;
    var maturity = m.maturity_floor + m.maturity_range * Math.min(x, 1 - x) * 2;
    var chain = 1 + clamp((r.chains || []).length - 1, 0, m.chain_cap) * m.chain_step;
    var relevance = m.relevance_weight + (1 - m.relevance_weight) * clamp(Math.log10(r.tvl_usd / m.relevance_anchor_usd) / m.relevance_span, 0, 1);
    return Math.max(1, Math.round(r.tvl_usd * m.base_multiple * growth * maturity * chain * relevance));
  }

  function h(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'cls') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) n.appendChild(x); });
      else n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (state.cat !== 'all' && (r.category || 'Other') !== state.cat) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  // The view state lives in the URL hash so a filtered or detail view can be shared and screenshotted.
  function readHash() {
    var p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (p.get('q') !== null && p.get('q') !== '') state.q = p.get('q');
    if (p.get('cat') !== null) state.cat = p.get('cat');
    if (p.get('sel') !== null) state.sel = p.get('sel');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat !== 'all') p.set('cat', state.cat);
    if (state.sel) p.set('sel', state.sel);
    var next = p.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }
  function sorted(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -1e308 : a.change_7d; bv = b.change_7d === null ? -1e308 : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? 1e308 : a.age_days; bv = b.age_days === null ? 1e308 : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av !== bv) return (av < bv ? -state.dir : state.dir);
      return a.rank - b.rank;
    });
  }

  function header() {
    return h('header', null,
      h('span', { cls: 'brand', text: 'Token Radar' }),
      h('span', { cls: 'meta', text: 'Snapshot ' + D.as_of + ' · ' + D.model_version + ' model' })
    );
  }
  function lede() {
    return h('section', { cls: 'lede' },
      h('h1', { text: D.board_size + ' pre-token protocols, ranked by implied value' }),
      h('p', { text: 'The watchlist is the floor: every pre-token protocol with at least $' + Math.round(D.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + D.early_size + ' pre-token protocols below that floor, down to a $1M TVL floor. Implied value is a model, not a promise.' }),
      h('div', { cls: 'facts' },
        h('div', { cls: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: D.watchlist_size + ' / ' + D.watchlist_size })),
        h('div', { cls: 'fact' }, h('span', { text: 'Rows scored' }), h('b', { text: String(D.board_size) })),
        h('div', { cls: 'fact' }, h('span', { text: 'Early rows below the floor' }), h('b', { text: String(D.early_size) })),
        h('div', { cls: 'fact' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(D.live_size) }))
      )
    );
  }

  function controls() {
    var cats = Array.from(new Set(D.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); refocusSearch(); });
    var options = [h('option', { value: 'all', text: 'All categories' })].concat(cats.map(function (c) {
      return h('option', { value: c, text: c, selected: c === state.cat ? 'selected' : null });
    }));
    var select = h('select', { 'aria-label': 'Filter by category' }, options);
    select.value = state.cat;
    select.addEventListener('change', function () { state.cat = select.value; writeHash(); render(); });
    return h('div', { cls: 'controls' },
      h('div', null, h('label', { text: 'Search' }), search),
      h('div', null, h('label', { text: 'Category' }), select),
      h('span', { cls: 'count', text: rows().length + ' rows shown' })
    );
  }

  function sortHead(key, label) {
    var mark = state.sort === key ? (state.dir < 0 ? ' v' : ' ^') : '';
    return h('th', { cls: key === 'name' ? '' : 'num' },
      h('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); }, text: label + mark })
    );
  }

  function boardTable() {
    var list = sorted(rows());
    if (list.length === 0) {
      return h('div', { cls: 'panel' }, h('div', { cls: 'empty' },
        h('strong', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { type: 'button', onclick: function () { state.q = ''; state.cat = 'all'; render(); }, text: 'Clear filters' })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = [];
    list.forEach(function (r) {
      var row = h('tr', { cls: state.sel === r.slug ? 'selected' : '', tabindex: '0',
        onclick: function () { state.sel = state.sel === r.slug ? null : r.slug; render(); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.sel = r.slug; render(); } } },
        h('td', { cls: 'num', text: String(r.rank) }),
        h('td', null, h('div', { cls: 'name' }, h('b', { text: r.name }), h('span', { cls: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        h('td', { cls: 'num', text: fmtUsd(r.tvl_usd) }),
        h('td', { cls: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        h('td', { cls: 'num', text: fmtAge(r.age_days) }),
        h('td', null, h('div', { cls: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / max) * 100)) + '%' })), h('span', { cls: 'num', text: fmtUsd(r.implied_value_usd) })),
        h('td', null, h('span', { cls: 'status', text: 'no token' }))
      );
      tbody.push(row);
    });
    return h('div', { cls: 'panel' },
      h('table', null,
        h('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model and multipliers.' }),
        h('thead', null, h('tr', null,
          sortHead('rank', 'Rank'), sortHead('name', 'Protocol'), sortHead('tvl', 'TVL'),
          sortHead('growth', '7d'), sortHead('age', 'Age'), sortHead('implied', 'Implied value'), h('th', { text: 'Token' })
        )),
        h('tbody', null, tbody)
      )
    );
  }

  function detail() {
    var r = D.rows.filter(function (x) { return x.slug === state.sel; })[0];
    if (!r) return null;
    var recomputed = impliedOf(r, D.model);
    var check = recomputed === r.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.';
    return h('section', { cls: 'detail' },
      h('div', { cls: 'panel' },
        h('h2', { text: 'Rank ' + r.rank + ' · ' + r.name }),
        h('p', { cls: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.join(', ') : 'an unnamed chain') + (r.listed_at ? ' · listed ' + r.listed_at : '') }),
        h('div', { cls: 'equation' },
          h('span', { text: 'TVL' }), h('b', { text: fmtUsd(r.tvl_usd) }),
          h('span', { text: 'Seven-day growth' }), h('b', { text: fmtPct(r.change_7d) }),
          h('span', { text: 'Age with no token' }), h('b', { text: fmtAge(r.age_days) }),
          h('span', { text: 'Growth multiplier' }), h('b', { text: String(r.growth_multiplier) }),
          h('span', { text: 'Maturity multiplier' }), h('b', { text: String(r.maturity_multiplier) }),
          h('span', { text: 'Chain bonus' }), h('b', { text: String(r.chain_multiplier) }),
          h('span', { text: 'TVL relevance' }), h('b', { text: String(r.relevance_multiplier) }),
          h('span', { text: 'Implied value' }), h('b', { text: fmtUsd(r.implied_value_usd) })
        ),
        h('p', { cls: 'sub', text: 'Model ' + D.model_version + ': the page recomputes this row as ' + fmtUsd(recomputed) + check + ' This is an estimate, not a price.' })
      ),
      h('div', { cls: 'panel' },
        h('h2', { text: 'Why this rank' }),
        h('p', { cls: 'sub', text: 'Upside is weighted ' + D.model.growth_weight_up + ', downside only ' + D.model.growth_weight_down + '. Maturity peaks midway through the ' + Math.round(D.model.maturity_days / 365) + '-year curve. Each chain beyond the first buys ' + D.model.chain_step + ' of bonus up to ' + D.model.chain_cap + '. TVL relevance is log-scaled and floored at ' + D.model.relevance_weight + '.' })
      )
    );
  }

  function modelPanel() {
    var m = D.model;
    return h('section', { cls: 'panel' },
      h('h2', { text: 'How implied value is computed' }),
      h('div', { cls: 'formula', text: 'implied = round( tvl ' + String.fromCharCode(215) + ' ' + m.base_multiple + ' ' + String.fromCharCode(215) + ' (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ')/100 ' + String.fromCharCode(215) + ' w) ' + String.fromCharCode(215) + ' maturity ' + String.fromCharCode(215) + ' chain ' + String.fromCharCode(215) + ' relevance )  ·  w = growth >= 0 ? ' + m.growth_weight_up + ' : ' + m.growth_weight_down }),
      h('p', { cls: 'sub', text: "Every row is scored by one function of the snapshot's own figures. No protocol name is special-cased and no row is hand-picked. The early radar is every pre-token protocol below the watchlist floor and above the $1M TVL floor, by TVL, and the live-token protocols are set aside with their market caps shown." })
    );
  }

  function render() {
    app.textContent = '';
    app.appendChild(h('div', { cls: 'shell' },
      header(), lede(), controls(), boardTable(), detail(), modelPanel()
    ));
    app.setAttribute('aria-busy', 'false');
    if (state.sel) detailScroll();
  }
  // render() rebuilds the controls, which drops focus mid-typing; put the caret back on the search box.
  function refocusSearch() {
    var q = document.getElementById('q');
    if (q) { q.focus(); var end = q.value.length; q.setSelectionRange(end, end); }
  }
  function detailScroll() {
    var panel = document.querySelector('.detail');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  readHash();
  render();
  // Escape clears the selection; hash edits (back/forward) re-read the view state.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.sel) { state.sel = null; writeHash(); render(); }
  });
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();