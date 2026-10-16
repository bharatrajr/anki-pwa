// Statistics screen: today, streak heatmap, reviews over the last 30 days, forecast,
// true retention and card counts. Charts are inline SVG with hover/focus tooltips,
// a legend for multi-series charts and a table view for each.

import { h } from './components.js';
import { computeStats } from '../stats/stats.js';
import { dayToDate } from '../util/time.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function render(app) {
  const col = app.col;
  app.setTitle('Statistics');
  const params = app.params();
  const did = Number(params.get('did')) || null;

  const deckSel = h('select', { class: 'input', 'aria-label': 'Deck' },
    h('option', { value: '', selected: !did }, 'Whole collection'),
    [...col.decks.values()].filter((d) => !d.dyn).sort((a, b) => a.name.localeCompare(b.name)).map((d) => h('option', { value: String(d.id), selected: d.id === did }, d.name.replaceAll('::', ' › '))));
  deckSel.addEventListener('change', () => app.go(deckSel.value ? `/stats?did=${deckSel.value}` : '/stats'));
  const status = h('p', { class: 'small muted' }, 'Counting…');
  app.main.append(h('div', { class: 'viz-filters' }, deckSel), status);

  const s = await computeStats(col, did);
  const chartW = Math.max(300, Math.min(730, app.main.clientWidth - 30));
  status.remove();
  const crt = col.col.crt;
  const dateOf = (day) => dayToDate(day, crt);
  const shortDate = (day) => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const t = s.today;
  const mins = Math.round(t.timeMs / 60000);

  // ---- today (stat tiles) ----
  const tile = (value, label) => h('div', { class: 'stat-tile' }, h('b', {}, value), h('span', {}, label));
  app.main.append(section('Today',
    h('div', { class: 'stat-tiles' },
      tile(String(t.count), t.count === 1 ? 'card studied' : 'cards studied'),
      tile(`${mins} min`, 'time'),
      tile(t.reviewTotal ? `${Math.round((t.reviewPass / t.reviewTotal) * 100)}%` : '—', 'reviews correct'),
      tile(String(s.streak), s.streak === 1 ? 'day streak' : 'day streak')),
    t.count ? h('p', { class: 'small muted', style: { margin: '10px 0 0' } },
      `${t.newCards} new · ${t.learn} learning · ${t.review} review · ${t.relearn} relearn${t.filtered ? ` · ${t.filtered} filtered` : ''} · ${t.again} pressed Again`) : null));

  // ---- heatmap ----
  app.main.append(section('Reviews in the last year', heatmap(s, dateOf),
    h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, `Studied on ${s.studiedDays} of the last 365 days · ${s.totalReviews} reviews in total.`)));

  // ---- recent reviews ----
  const recentSeries = [['learn', 'Learning'], ['young', 'Young'], ['mature', 'Mature'], ['relearn', 'Relearning'], ['filtered', 'Filtered']];
  app.main.append(section('Reviews per day (last 30 days)',
    stackedBars(s.recent.map((d) => ({ label: shortDate(d.day), values: recentSeries.map(([k]) => d[k]) })), recentSeries.map(([, l]) => l), { firstLabel: '30 days ago', lastLabel: 'Today', W: chartW })));

  // ---- forecast ----
  const fcSeries = [['learn', 'Learning'], ['young', 'Young'], ['mature', 'Mature']];
  app.main.append(section('Due in the next 30 days',
    stackedBars(s.forecast.map((d, i) => ({ label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : shortDate(d.day), values: fcSeries.map(([k]) => d[k]) })), fcSeries.map(([, l]) => l), { firstLabel: 'Today', lastLabel: 'In 30 days', W: chartW }),
    s.overdue ? h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, `${s.overdue} overdue card${s.overdue === 1 ? '' : 's'} are counted in today.`) : null));

  // ---- retention ----
  const pct = (b) => (b.total ? `${((b.pass / b.total) * 100).toFixed(1)}%` : '—');
  const both = (r) => ({ pass: r.young.pass + r.mature.pass, total: r.young.total + r.mature.total });
  app.main.append(section('True retention',
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Share of review answers that weren’t Again. Young cards have an interval under 21 days, mature cards 21 days or more. With FSRS this should be close to your desired retention.'),
    h('table', { class: 'info num' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Young'), h('th', {}, 'Mature'), h('th', {}, 'All'), h('th', {}, 'Reviews'))),
      h('tbody', {}, s.retention.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.label), h('td', {}, pct(r.young)), h('td', {}, pct(r.mature)), h('td', {}, pct(both(r))), h('td', {}, String(both(r).total)))))),
    s.avgRetrievability !== null ? h('p', { class: 'small muted', style: { margin: '10px 0 0' } }, `Average chance of recalling a review card right now (FSRS): ${(s.avgRetrievability * 100).toFixed(1)}%.`) : null));

  // ---- card counts ----
  const c = s.counts;
  const countRows = [['New', c.new], ['Learning', c.learning], ['Relearning', c.relearning], ['Young', c.young], ['Mature', c.mature], ['Suspended', c.suspended], ['Buried', c.buried]];
  app.main.append(section('Card counts',
    h('table', { class: 'info num' }, h('tbody', {},
      countRows.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, String(v)), h('td', {}, c.total ? `${Math.round((v / c.total) * 100)}%` : '—'))),
      h('tr', {}, h('th', { scope: 'row' }, 'Total'), h('td', {}, h('b', {}, String(c.total))), h('td', {}, ''))))));
}

function section(title, ...kids) {
  return h('section', { class: 'section' }, h('h2', {}, title), h('div', { class: 'card-surface viz-root', style: { padding: '12px 14px' } }, ...kids));
}

/** Shared tooltip for chart marks with data-tip. */
function withTooltip(wrap) {
  const tip = h('div', { class: 'viz-tip', role: 'status', hidden: true });
  wrap.append(tip);
  const show = (el) => {
    tip.innerHTML = el.getAttribute('data-tip');
    tip.hidden = false;
    const r = el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2 - w.left, 70), w.width - 70);
    tip.style.left = `${x}px`;
    tip.style.top = `${r.top - w.top - 8}px`;
  };
  wrap.addEventListener('pointerover', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) show(el); });
  wrap.addEventListener('pointerleave', () => { tip.hidden = true; });
  wrap.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) show(el); });
  wrap.addEventListener('focusout', () => { tip.hidden = true; });
  return wrap;
}

function heatmap(s, dateOf) {
  const today = s.timing.today;
  const cell = 11, gap = 2, weeks = 53;
  const todayDate = dateOf(today);
  const end = today + (6 - todayDate.getDay()); // finish on Saturday of this week
  const start = end - weeks * 7 + 1;
  const max = Math.max(1, ...s.heat.values());
  const level = (n) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999)));
  let rects = '';
  for (let d = start; d <= end; d++) {
    if (d > today) continue;
    const i = d - start, x = Math.floor(i / 7) * (cell + gap), y = (i % 7) * (cell + gap);
    const n = s.heat.get(d) || 0;
    const label = `${dateOf(d).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}: <b>${n}</b> review${n === 1 ? '' : 's'}`;
    rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" class="heat-${level(n)}${d === today ? ' heat-today' : ''}" data-tip="${esc(label)}"/>`;
  }
  const width = weeks * (cell + gap), height = 7 * (cell + gap);
  const scroller = h('div', { class: 'heat-scroll' });
  scroller.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Reviews per day over the last year">${rects}</svg>`;
  const legend = h('div', { class: 'heat-legend small muted' }, 'Less', ...[0, 1, 2, 3, 4].map((l) => h('span', { class: `heat-swatch heat-${l}`, 'aria-hidden': 'true' })), 'More');
  const wrap = withTooltip(h('div', { class: 'viz-wrap' }, scroller, legend));
  requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });
  return wrap;
}

/** Stacked bars: rows [{label, values[]}], series names in fixed palette order. */
function stackedBars(rows, series, { firstLabel, lastLabel, W = 600 }) {
  const H = 170, padL = 34, padB = 22, padT = 8;
  const totals = rows.map((r) => r.values.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const nice = niceMax(max);
  const plotW = W - padL - 4, plotH = H - padB - padT;
  const bw = plotW / rows.length;
  const barW = Math.max(3, bw - 2);
  let svg = '';
  for (const frac of [0, 0.5, 1]) {
    const y = padT + plotH - frac * plotH;
    svg += `<line x1="${padL}" x2="${W - 4}" y1="${y}" y2="${y}" class="viz-grid"/>`;
    svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" class="viz-axis">${Math.round(nice * frac)}</text>`;
  }
  rows.forEach((r, i) => {
    const x = padL + i * bw + (bw - barW) / 2;
    let y = padT + plotH;
    const segs = r.values.map((v, si) => ({ v, si })).filter((x) => x.v > 0);
    segs.forEach(({ v, si }, k) => {
      const hgt = (v / nice) * plotH;
      const top = k === segs.length - 1;
      const gapPx = k > 0 ? 2 : 0; // surface gap between stacked fills
      const hh = Math.max(0, hgt - gapPx);
      y -= hgt;
      svg += top && hh > 4
        ? `<path d="${roundedTop(x, y, barW, hh, Math.min(4, barW / 2))}" class="viz-s${si + 1}"/>`
        : `<rect x="${x}" y="${y}" width="${barW}" height="${hh}" class="viz-s${si + 1}"/>`;
    });
    const tip = `<b>${esc(r.label)}</b>: ${totals[i]}${segs.length ? '<br>' + segs.map(({ v, si }) => `${esc(series[si])} ${v}`).join(' · ') : ''}`;
    svg += `<rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${plotH}" class="viz-hit" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(`${r.label}: ${totals[i]}`)}"/>`;
  });
  svg += `<text x="${padL}" y="${H - 6}" class="viz-axis">${esc(firstLabel)}</text><text x="${W - 4}" y="${H - 6}" text-anchor="end" class="viz-axis">${esc(lastLabel)}</text>`;
  const chart = h('div', { class: 'viz-chart' });
  chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked bar chart" style="width:100%;height:auto;display:block">${svg}</svg>`;
  const legend = h('div', { class: 'viz-legend' }, series.map((name, i) => h('span', {}, h('span', { class: `viz-key viz-s${i + 1}`, 'aria-hidden': 'true' }), name)));
  const table = h('details', { class: 'viz-table' }, h('summary', {}, 'Show as table'),
    h('table', { class: 'info num' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Day'), series.map((n) => h('th', {}, n)), h('th', {}, 'Total'))),
      h('tbody', {}, rows.map((r, i) => h('tr', {}, h('th', { scope: 'row' }, r.label), r.values.map((v) => h('td', {}, String(v))), h('td', {}, String(totals[i])))))));
  return withTooltip(h('div', { class: 'viz-wrap' }, legend, chart, table));
}

function roundedTop(x, y, w, hgt, r) {
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
