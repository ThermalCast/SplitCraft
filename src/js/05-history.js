  // 05-history.js — Log + History rendering, charts, refreshLogAndHistory
  // =========================================================================
  // Log + History rendering
  // =========================================================================
  // What to store when an editable set row is saved.
  //
  // The inputs display weight at ONE decimal (displayWeight rounds there), but
  // stored weights carry more: the Fitbod importer rounds to two (54.43kg is a
  // real value from a real export) and a lb-denominated set converts to
  // something like 45.359237. Reading the box back therefore LOSES precision —
  // and because a row saves on `change` to EITHER field, editing only the reps
  // rewrote the weight as well.
  //
  // That was not cosmetic. suggestForExercise() compares session weights with
  // sameWeight(), a 0.05kg tolerance, to decide whether consecutive sessions
  // sit on the same rung of the ladder. A 54.43 -> 54.4 rewrite is 0.03,
  // close to that tolerance, so correcting a typo in your reps could silently
  // reset the consecutive-clean-sessions streak and the app went back to
  // asking for a weight you had already earned.
  //
  // So: when the number in the box still matches what the box was rendered
  // with, the user did not touch the weight and the stored value is kept
  // exactly as it was.
  function weightToStore(displayedValue, originalKg) {
    if (isFinite(originalKg) && displayedValue === displayWeight(originalKg)) return originalKg;
    return toKg(displayedValue);
  }

  // allowDelete is false for History rows: past days render without a delete
  // button at all \u2014 once a day isn't today anymore, DELETION is locked. This
  // flag governs deletion and nothing else.
  //
  // Inline weight/reps editing of standard sets deliberately still works in
  // History (see "History is delete-locked" in the design summary): fixing a
  // number you fat-fingered last Tuesday is cheap and reversible, whereas
  // deleting a set you no longer have any record of is not. The comment here
  // used to claim the whole row was "locked in ... only today's log stays
  // correctable", which described neither the code nor the intent and made the
  // live inputs in History look like a leak rather than a feature.
  function renderExerciseGroup(exercise, exEntry, workoutId, allowDelete = true) {
    const wrap = document.createElement('div');
    wrap.className = 'exercise-group';
    const title = document.createElement('div');
    title.className = 'ex-name';
    title.textContent = exercise ? exercise.name : 'Unknown exercise';
    wrap.appendChild(title);
    exEntry.sets.forEach((s, i) => {
      const row = document.createElement('div');
      const delBtn = allowDelete
        ? `<button class="del" data-wid="${workoutId}" data-exid="${exEntry.exerciseId}" data-idx="${i}" data-action="delete-set" title="Delete set">\u00d7</button>`
        : '';
      if (s.type === 'standard') {
        row.className = 'plan-log-row done-set';
        row.dataset.wid = workoutId;
        row.dataset.exid = exEntry.exerciseId;
        row.dataset.idx = i;
        // Full-precision stored weight, so a reps-only edit can put it back
        // untouched — see weightToStore().
        row.dataset.kg = s.entries[0].weight;
        row.innerHTML = `
          <span class="set-idx">${i + 1}</span>
          ${s.entries[0].weight < 0 ? `<button type="button" class="sign-btn negative" data-action="toggle-sign" title="Toggle negative \u2014 for assisted reps, enter how much weight is taken off you">\u00b1</button>` : ''}
          <input type="number" inputmode="decimal" step="0.5" class="set-edit-weight" data-action="edit-set" aria-label="Weight" value="${displayWeight(s.entries[0].weight)}">
          <input type="number" inputmode="numeric" step="1" min="1" class="set-edit-reps" data-action="edit-set" aria-label="Reps" value="${s.entries[0].reps}">
          ${delBtn}
        `;
      } else {
        row.className = 'set-row';
        const badge = `<span class="type-badge ${s.type}">${s.type}</span>`;
        row.innerHTML = `
          <span class="set-idx">${i + 1}</span>
          <span class="set-data">${badge}${esc(formatSetLine(s))}</span>
          ${delBtn}
        `;
      }
      wrap.appendChild(row);
    });
    return wrap;
  }

  function startOfWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay(); // 0=Sun..6=Sat
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); // back up to Monday
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // `allWorkouts` is optional — see refreshActiveWorkoutSection() for why.
  async function renderWeekProgress(allWorkouts) {
    const target = await getSetting('planDaysPerWeek', 4);
    const today = todayStr();
    const weekStart = startOfWeek(today);
    const workouts = allWorkouts || await getAllWorkouts();
    const doneThisWeek = workouts.filter(w => w.date >= weekStart && w.date <= today && w.exercises.length > 0).length;
    const remaining = Math.max(0, target - doneThisWeek);
    const todayName = new Date(today + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });
    const el = document.getElementById('week-progress-text');
    el.textContent = remaining === 0
      ? `${todayName} \u2014 ${doneThisWeek}/${target} done. Target hit!`
      : `${todayName} \u2014 ${doneThisWeek}/${target} done, ${remaining} to go.`;
    const fill = document.getElementById('week-progress-fill');
    fill.style.width = `${target > 0 ? Math.min(100, (doneThisWeek / target) * 100) : 0}%`;
    fill.classList.toggle('complete', remaining === 0);
  }

  // =========================================================================
  // History tab
  //
  // One range picker drives both the charts and the session list, so the
  // graphs always describe exactly the sessions listed underneath them.
  // Defaults to 30 days: with a full Fitbod import "all time" is hundreds of
  // sessions, which makes the list unscannable and flattens every chart.
  //
  // Charts are hand-rolled inline SVG (plus flex bars for the horizontal
  // ones). No charting library — this stays a single self-contained file
  // with nothing to fetch, which is the whole point of the app.
  // =========================================================================
  let historyRangeDays = 30;      // null = all time
  let historySearch = '';         // exercise-name filter, '' = everything
  let historyExerciseId = null;   // sticky pick for the progress chart
  let historyMuscleId = null;     // sticky pick for the sets-per-muscle trend chart
  let historyShowAll = false;     // past the soft cap on list length
  let historyRanged = [];         // workouts currently in range (chart source)
  let historyExercisesById = {};
  const HISTORY_LIST_CAP = 40;
  // Which sessions the user has expanded, keyed by date. Survives the
  // re-render that follows editing a set, which would otherwise snap the
  // session you're working in shut.
  const openSessions = new Set();
  // Completed exercises the user has re-opened to edit. Survives the
  // re-render that follows every log, so fixing a mis-logged set doesn't get
  // undone by the refresh it triggers.
  const expandedExercises = new Set();
  // Set by the log handlers, consumed by the next render. Without it the
  // reveal would also fire on first paint and scroll a freshly opened page
  // down past the session card for no reason.
  let revealNextOnRender = false;

  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function dateStrDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return ymd(d);
  }
  // Assisted sets carry a negative weight (load taken off you). Those must
  // not SUBTRACT from total volume, so each entry is floored at zero — which
  // also matches how plain bodyweight sets (weight 0, e.g. everything Fitbod
  // exports with multiplier 0) have always counted.
  // Volume for one set, in kg-reps, using the REAL load moved.
  //
  // This used to be `Math.max(0, weight) * reps`, which floored assisted work
  // (stored negative) to zero and counted a weighted pull-up as only the
  // weight hanging off the belt. Every bodyweight and assisted set therefore
  // contributed nothing to daily or weekly volume — three sets of dips read
  // as no work at all. Once bodyweight is known, effectiveLoadKg() gives the
  // honest number and the floor is only needed for the case it was really
  // guarding: an assisted set with no bodyweight on file, where the load is
  // genuinely unknown and a negative would subtract from the day's total.
  function setVolumeKg(s, exercise) {
    return s.entries.reduce((a, en) => a + Math.max(0, effectiveLoadKg(exercise, en.weight)) * en.reps, 0);
  }
  function workoutStats(w, exercisesById) {
    const lookup = exercisesById || historyExercisesById;
    let sets = 0, volumeKg = 0;
    w.exercises.forEach(ex => ex.sets.forEach(s => {
      sets++;
      volumeKg += setVolumeKg(s, lookup[ex.exerciseId]);
    }));
    return { exercises: w.exercises.length, sets, volumeKg };
  }
  function compactNum(n) {
    const a = Math.abs(n);
    if (a >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 10000) return Math.round(n / 1000) + 'k';
    if (a >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n * 10) / 10);
  }
  function shortDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Both time-axis charts tick on MONTH boundaries rather than on every Nth
  // bucket, so the x axis reads the same way regardless of how the data
  // happens to bucket (weekly bars, monthly bars, or irregular session
  // dates on the line chart).
  function monthLabelFor(d, showYear) {
    return d.toLocaleDateString(undefined, showYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  }
  function monthStarts(tMin, tMax) {
    const out = [];
    const d = new Date(tMin);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    while (d.getTime() <= tMax) { out.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
    return out;
  }
  function spansYears(tMin, tMax) {
    return new Date(tMin).getFullYear() !== new Date(tMax).getFullYear();
  }
  // Every tick gets a mark; text is thinned to whatever fits without
  // colliding, so a two-year range still shows readable labels.
  function tickMarksSVG(ticks, xOf, axisY, H, rightEdge) {
    let out = '';
    let lastLabelX = -Infinity;
    ticks.forEach(tk => {
      const x = xOf(tk);
      out += `<line class="chart-tick" x1="${x.toFixed(1)}" y1="${axisY}" x2="${x.toFixed(1)}" y2="${axisY + 4}"/>`;
      if (x - lastLabelX >= 28 && x <= rightEdge - 11) {
        out += `<text class="chart-axis" x="${(x + 2).toFixed(1)}" y="${H - 6}" text-anchor="start">${esc(tk.label)}</text>`;
        lastLabelX = x;
      }
    });
    return out;
  }

  // Vertical bars. `bars` is [{label, value}] (label feeds the hover
  // <title>); `ticks` is [{i, label}] placed at bucket i's left edge.
  function barChartSVG(bars, fmt, ticks) {
    const W = 320, H = 118, padL = 32, padR = 3, padT = 8, padB = 20;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = Math.max(...bars.map(b => b.value), 1);
    const n = bars.length;
    const slot = plotW / n;
    const bw = Math.max(3, Math.min(34, slot - 4));
    let out = '';
    [0, 0.5, 1].forEach(f => {
      const y = padT + plotH - plotH * f;
      out += `<line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
      out += `<text class="chart-axis" x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmt(max * f))}</text>`;
    });
    bars.forEach((b, i) => {
      const h = (b.value / max) * plotH;
      const x = padL + slot * i + (slot - bw) / 2;
      // Empty buckets still get a 1px stub so a gap in training reads as a
      // gap rather than as missing data.
      const drawH = b.value > 0 ? Math.max(h, 2) : 1;
      out += `<rect class="chart-bar${b.value > 0 ? '' : ' dim'}" x="${x.toFixed(1)}" y="${(padT + plotH - drawH).toFixed(1)}" width="${bw.toFixed(1)}" height="${drawH.toFixed(1)}" rx="2"><title>${esc(b.label)}: ${esc(fmt(b.value))}</title></rect>`;
    });
    out += tickMarksSVG(ticks || [], tk => padL + slot * tk.i, padT + plotH, H, W - padR);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`;
  }

  // `series` is [{points:[{t,v,label}], cls, dots}] — t is a timestamp.
  function lineChartSVG(series, fmt, ticks) {
    const W = 320, H = 118, padL = 32, padR = 5, padT = 8, padB = 20;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const all = series.flatMap(s => s.points);
    if (all.length === 0) return '';
    const tMin = Math.min(...all.map(p => p.t)), tMax = Math.max(...all.map(p => p.t));
    const rawMin = Math.min(...all.map(p => p.v));
    let vMin = rawMin, vMax = Math.max(...all.map(p => p.v));
    if (vMax === vMin) { vMax += 1; vMin -= 1; }
    const headroom = (vMax - vMin) * 0.12;
    vMax += headroom; vMin -= headroom;
    // Sign handling. Normal loads sit on a zero floor. Assisted work is
    // stored negative, so flooring at 0 would put vMin above vMax and invert
    // the whole scale — instead, keep 0 IN VIEW, because for an assisted lift
    // the zero line is the goal: the point where you're doing it unassisted.
    // A history that crosses zero (assisted -> bodyweight -> weighted) is one
    // continuous line through the baseline, which is exactly right.
    if (rawMin >= 0) vMin = Math.max(0, vMin);
    else vMax = Math.max(vMax, 0);
    const X = t => padL + (tMax === tMin ? plotW / 2 : ((t - tMin) / (tMax - tMin)) * plotW);
    const Y = v => padT + plotH - ((v - vMin) / (vMax - vMin)) * plotH;
    let out = '';
    [0, 0.5, 1].forEach(f => {
      const val = vMin + (vMax - vMin) * f;
      const y = Y(val);
      out += `<line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
      out += `<text class="chart-axis" x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmt(val))}</text>`;
    });
    // Emphasised baseline wherever 0 is on screen: it separates "load you
    // carried" from "load taken off you", and for assisted work it's the
    // target the line is climbing toward.
    if (vMin < 0 && vMax >= 0) {
      const yZero = Y(0);
      out += `<line class="chart-zero" x1="${padL}" y1="${yZero.toFixed(1)}" x2="${W - padR}" y2="${yZero.toFixed(1)}"/>`;
    }
    series.forEach(s => {
      if (s.points.length === 0) return;
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
      out += `<path class="chart-line ${s.cls || ''}" d="${d}"/>`;
      if (s.dots) {
        s.points.forEach(p => {
          out += `<circle class="chart-dot" cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.6"><title>${esc(p.label)}</title></circle>`;
        });
      }
    });
    if (ticks && ticks.length > 1) {
      // A month start before tMin clamps to the axis so the leading partial
      // month still gets named.
      out += tickMarksSVG(ticks, tk => Math.max(padL, X(tk.t)), padT + plotH, H, W - padR);
    } else {
      // Range sits inside a single month — day labels say more than one
      // repeated month name would.
      out += `<text class="chart-axis" x="${padL}" y="${H - 6}" text-anchor="start">${esc(shortDate(tMin))}</text>`;
      if (tMax !== tMin) out += `<text class="chart-axis" x="${W - padR}" y="${H - 6}" text-anchor="end">${esc(shortDate(tMax))}</text>`;
    }
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`;
  }

  function renderHistoryCharts(ranged, exercisesById) {
    historyRanged = ranged;
    historyExercisesById = exercisesById;
    // Nothing in range: hide the whole block rather than stack four
    // near-identical "no data" cards above the empty session list.
    document.getElementById('history-charts').style.display = ranged.length ? 'block' : 'none';
    if (ranged.length === 0) return;
    renderHistorySummary();
    renderVolumeChart();
    renderMuscleChart();
    renderMuscleTrendChart();
    renderProgressChart();
  }

  function renderHistorySummary() {
    const el = document.getElementById('history-summary');
    let sets = 0, volumeKg = 0, durTotal = 0, durCount = 0;
    historyRanged.forEach(w => {
      const st = workoutStats(w);
      sets += st.sets; volumeKg += st.volumeKg;
      if (w.durationMs) { durTotal += w.durationMs; durCount++; }
    });
    const avgDur = durCount ? formatDuration(durTotal / durCount) : '—';
    el.innerHTML = `
      <div class="summary-grid">
        <div class="sum"><span class="stat-label">Sessions</span><span class="stat-value">${historyRanged.length}</span></div>
        <div class="sum"><span class="stat-label">Working sets</span><span class="stat-value muted">${sets}</span></div>
        <div class="sum"><span class="stat-label">Total volume</span><span class="stat-value">${compactNum(fromKg(volumeKg))} ${esc(weightUnit)}</span></div>
        <div class="sum"><span class="stat-label">Avg session</span><span class="stat-value muted">${esc(avgDur)}</span></div>
      </div>
    `;
  }

  // Shared bucketing for every time-axis chart in History (training volume,
  // sets-per-muscle-over-time): weekly bars up to a ~120-day span, monthly
  // beyond it — 52 weekly bars on a phone is an unreadable picket fence — plus
  // one tick per month boundary. Extracted from what used to be
  // renderVolumeChart()'s own bucket-building so a second time-series chart
  // can't quietly drift onto different bucket edges or tick placement.
  //
  // Returns `{ mode, buckets, idx, ticks, keyOf }`: `buckets` is
  // `[{key, value}]` with `value` zeroed for the caller to accumulate into;
  // `idx` maps a bucket key to its index; `keyOf(dateStr)` buckets one date
  // the same way; `ticks` is `[{i, label}]` for tickMarksSVG/barChartSVG.
  function timeBuckets(dates) {
    const sorted = dates.slice().sort();
    const first = sorted[0];
    const last = todayStr() > sorted[sorted.length - 1] ? todayStr() : sorted[sorted.length - 1];
    const spanDays = Math.round((Date.parse(last + 'T00:00:00') - Date.parse(first + 'T00:00:00')) / 86400000);
    const mode = spanDays <= 120 ? 'week' : 'month';

    const buckets = [];
    if (mode === 'week') {
      let cur = startOfWeek(first);
      const end = startOfWeek(last);
      while (cur <= end) {
        buckets.push({ key: cur, value: 0 });
        const d = new Date(cur + 'T00:00:00'); d.setDate(d.getDate() + 7); cur = ymd(d);
      }
    } else {
      const d = new Date(first + 'T00:00:00'); d.setDate(1);
      const endD = new Date(last + 'T00:00:00'); endD.setDate(1);
      while (d <= endD) { buckets.push({ key: ymd(d), value: 0 }); d.setMonth(d.getMonth() + 1); }
    }
    const idx = Object.fromEntries(buckets.map((b, i) => [b.key, i]));
    const keyOf = (dateStr) => mode === 'week' ? startOfWeek(dateStr) : dateStr.slice(0, 8) + '01';

    // One tick per month: the first bucket whose month differs from the
    // previous one. In monthly mode that's every bucket; in weekly mode it's
    // the week that opens each month.
    const tFirst = Date.parse(buckets[0].key + 'T00:00:00');
    const tLast = Date.parse(buckets[buckets.length - 1].key + 'T00:00:00');
    const showYear = spansYears(tFirst, tLast);
    const ticks = [];
    let prevMonthKey = null;
    buckets.forEach((b, i) => {
      const d = new Date(b.key + 'T00:00:00');
      const monthKey = d.getFullYear() * 12 + d.getMonth();
      if (monthKey !== prevMonthKey) {
        ticks.push({ i, label: monthLabelFor(d, showYear) });
        prevMonthKey = monthKey;
      }
    });

    return { mode, buckets, idx, ticks, keyOf };
  }

  function renderVolumeChart() {
    const el = document.getElementById('chart-volume');
    const { mode, buckets, idx, ticks, keyOf } = timeBuckets(historyRanged.map(w => w.date));
    historyRanged.forEach(w => {
      const key = keyOf(w.date);
      if (idx[key] != null) buckets[idx[key]].value += fromKg(workoutStats(w).volumeKg);
    });

    const bars = buckets.map(b => {
      const d = new Date(b.key + 'T00:00:00');
      return {
        value: b.value,
        label: mode === 'week'
          ? `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
          : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      };
    });

    el.innerHTML = barChartSVG(bars, compactNum, ticks)
      + `<div class="chart-legend"><span><i></i>${mode === 'week' ? 'Weekly' : 'Monthly'} volume (${esc(weightUnit)})</span></div>`;
  }

  // "Am I training everything, and enough of it?" — the one question a
  // muscle breakdown should answer. A raw set TOTAL can't: 40 sets means
  // something completely different over one week than over six months. So
  // this normalises to sets per week, which is the unit strength/hypertrophy
  // guidance is actually written in (commonly ~10-20 hard sets per muscle per
  // week), making the bars directly comparable to a target instead of just to
  // each other.
  //
  // Divided by the weeks you actually TRAINED in the range (first to last
  // session), not the calendar length of the range — picking "last year" with
  // eight months of data shouldn't dilute every number by a third.
  function renderMuscleChart() {
    const el = document.getElementById('chart-muscles');
    const musclesById = Object.fromEntries(MUSCLES.map(m => [m.id, m]));
    const counts = {};
    historyRanged.forEach(w => w.exercises.forEach(ex => {
      const rec = historyExercisesById[ex.exerciseId];
      const mid = rec ? rec.primaryMuscle : 'unclassified';
      counts[mid] = (counts[mid] || 0) + ex.sets.length;
    }));
    const rows = Object.entries(counts)
      .map(([mid, count]) => ({ name: (musclesById[mid] || { name: 'Other' }).name, count }))
      .sort((a, b) => b.count - a.count);
    if (rows.length === 0) { el.innerHTML = '<div class="empty" style="border:none;">No sets in this range.</div>'; return; }

    const dates = historyRanged.map(w => w.date).sort();
    const spanDays = (Date.parse(dates[dates.length - 1] + 'T00:00:00') - Date.parse(dates[0] + 'T00:00:00')) / 86400000;
    const weeks = Math.max(1, spanDays / 7);
    const perWeek = r => r.count / weeks;
    const max = Math.max(...rows.map(perWeek));

    const fmtWeek = v => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
    el.innerHTML = `<div class="bar-list">${rows.map(r => {
      const pw = perWeek(r);
      return `
      <div class="bar-row" title="${esc(r.name)}: ${r.count} sets total over ${Math.round(weeks * 10) / 10} weeks">
        <span class="bar-name">${esc(r.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${max > 0 ? ((pw / max) * 100).toFixed(1) : 0}%"></span></span>
        <span class="bar-val">${fmtWeek(pw)}</span>
      </div>`;
    }).join('')}</div>
      <div class="hint" style="margin-top:10px;">Average <strong>sets per week</strong> for each muscle, over the ${Math.round(weeks * 10) / 10} week(s) you trained in this range. Use it to spot what you're under- or over-training: most hypertrophy guidance lands around 10&ndash;20 hard sets per muscle per week. Each set counts once, against its exercise's <em>primary</em> muscle only &mdash; a bench press scores as chest, not chest + triceps + delts. Anything showing as <em>Unclassified</em> needs a muscle assigned on the Exercises tab.</div>`;
  }

  // "How has THIS ONE muscle's volume of work moved over time?" — the muscle
  // chart above answers "right now, everything at once"; this answers
  // "trending which way, for the one I picked." Bucketed exactly like
  // renderVolumeChart() (via the shared timeBuckets()), so the two time-axis
  // charts in this tab can never disagree about where a week or month starts.
  //
  // Sets, not volume, for the same reason renderMuscleChart() uses sets:
  // volume is dominated by heavy compounds and is zero for bodyweight work,
  // so a volume-based trend would make an unloaded muscle group look like it
  // isn't trained at all.
  function renderMuscleTrendChart() {
    const el = document.getElementById('chart-muscle-trend');
    const sel = document.getElementById('history-muscle');
    const musclesById = Object.fromEntries(MUSCLES.map(m => [m.id, m]));

    // Only muscles that actually appear in range, ordered by set count so the
    // default selection is whatever's most trained rather than alphabetical.
    const counts = {};
    historyRanged.forEach(w => w.exercises.forEach(ex => {
      const rec = historyExercisesById[ex.exerciseId];
      const mid = rec ? rec.primaryMuscle : 'unclassified';
      counts[mid] = (counts[mid] || 0) + ex.sets.length;
    }));
    const options = Object.entries(counts)
      .map(([mid, count]) => ({ id: mid, count, name: (musclesById[mid] || { name: 'Unclassified' }).name }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    if (options.length === 0) {
      sel.innerHTML = '<option>No sets in this range</option>';
      sel.disabled = true;
      el.innerHTML = '<div class="empty" style="border:none;">Nothing to chart in this range.</div>';
      return;
    }
    sel.disabled = false;
    if (!options.some(o => o.id === historyMuscleId)) historyMuscleId = options[0].id;
    sel.innerHTML = options.map(o =>
      `<option value="${esc(o.id)}"${o.id === historyMuscleId ? ' selected' : ''}>${esc(o.name)} (${o.count})</option>`
    ).join('');

    const { mode, buckets, idx, ticks, keyOf } = timeBuckets(historyRanged.map(w => w.date));
    historyRanged.forEach(w => {
      const key = keyOf(w.date);
      if (idx[key] == null) return;
      w.exercises.forEach(ex => {
        const rec = historyExercisesById[ex.exerciseId];
        const mid = rec ? rec.primaryMuscle : 'unclassified';
        if (mid === historyMuscleId) buckets[idx[key]].value += ex.sets.length;
      });
    });

    const bars = buckets.map(b => {
      const d = new Date(b.key + 'T00:00:00');
      return {
        value: b.value,
        label: mode === 'week'
          ? `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
          : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      };
    });

    el.innerHTML = barChartSVG(bars, compactNum, ticks)
      + `<div class="chart-legend"><span><i></i>Sets per ${mode === 'week' ? 'week' : 'month'}</span></div>
      <div class="hint" style="margin-top:8px;">Sets, not volume &mdash; volume is dominated by heavy compounds and zero for bodyweight work. Each set counts once, against its exercise's <em>primary</em> muscle only.</div>`;
  }

  // Top set weight + estimated 1RM (Epley: w x (1 + reps/30)) per session.
  // Est. 1RM is the more honest progress signal — it moves when you add reps
  // at the same weight, which top-set weight alone can't show.
  function renderProgressChart() {
    const el = document.getElementById('chart-progress');
    const sel = document.getElementById('history-exercise');

    const counts = new Map();
    historyRanged.forEach(w => w.exercises.forEach(ex => {
      // Every set type counts here — a drop/myo set is still one working
      // set, represented by its first entry (see workingEntry()).
      const n = ex.sets.filter(s => workingEntry(s)).length;
      if (n) counts.set(ex.exerciseId, (counts.get(ex.exerciseId) || 0) + n);
    }));
    const options = [...counts.entries()]
      .map(([id, count]) => ({ id, count, name: (historyExercisesById[id] || {}).name || 'Unknown exercise' }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    if (options.length === 0) {
      sel.innerHTML = '<option>No exercises logged in this range</option>';
      sel.disabled = true;
      el.innerHTML = '<div class="empty" style="border:none;">Nothing to chart in this range.</div>';
      return;
    }
    sel.disabled = false;
    if (!options.some(o => o.id === historyExerciseId)) historyExerciseId = options[0].id;
    sel.innerHTML = options.map(o =>
      `<option value="${o.id}"${o.id === historyExerciseId ? ' selected' : ''}>${esc(o.name)} (${o.count})</option>`
    ).join('');

    // Plotted against the REAL load moved. For a bodyweight or assisted
    // exercise with bodyweight on file that is `bodyweight + logged`, so a
    // -45 assisted pull-up at 80 bodyweight charts as the 35 it actually is,
    // and Epley applies instead of being suppressed. Without bodyweight the
    // logged number is all there is, and behaviour is unchanged.
    const chartExercise = historyExercisesById[historyExerciseId];
    const usesBodyweight = ['bodyweight', 'assisted'].includes(exerciseEquipment(chartExercise)) && bodyweightKg > 0;
    const byDate = new Map();
    historyRanged.forEach(w => {
      const ex = w.exercises.find(e => e.exerciseId === historyExerciseId);
      if (!ex) return;
      let topW = null, top1 = null;
      ex.sets.forEach(s => {
        const en = workingEntry(s);
        if (!en) return;
        const load = effectiveLoadKg(chartExercise, en.weight);
        if (topW === null || load > topW) topW = load;
        const est = load * (1 + en.reps / 30);
        if (top1 === null || est > top1) top1 = est;
      });
      if (topW !== null) byDate.set(w.date, { topW, top1 });
    });
    const dates = [...byDate.keys()].sort();
    if (dates.length === 0) { el.innerHTML = '<div class="empty" style="border:none;">No standard sets logged for this exercise.</div>'; return; }

    const mk = (pick, suffix) => dates.map(d => {
      const v = displayWeight(pick(byDate.get(d)));
      return { t: Date.parse(d + 'T00:00:00'), v, label: `${shortDate(Date.parse(d + 'T00:00:00'))}: ${v}${weightUnit} ${suffix}` };
    });
    const tFirst = Date.parse(dates[0] + 'T00:00:00');
    const tLast = Date.parse(dates[dates.length - 1] + 'T00:00:00');
    const showYear = spansYears(tFirst, tLast);
    const ticks = monthStarts(tFirst, tLast).map(d => ({ t: d.getTime(), label: monthLabelFor(d, showYear) }));

    // Epley only means anything for a load you're lifting. Assisted work is
    // logged negative, where the formula runs backwards (more reps reads as
    // a "lower" 1RM), so that series is dropped rather than drawn wrong.
    const allPositive = dates.every(d => byDate.get(d).topW > 0);
    const loadNote = usesBodyweight
      ? `<div class="hint" style="margin-top:8px;">Includes your bodyweight (${displayWeight(bodyweightKg)}${weightUnit}), so this is the total load moved rather than the number logged against the set.</div>`
      : '';
    const series = [{ points: mk(r => r.topW, 'top set'), dots: true }];
    if (allPositive) series.unshift({ points: mk(r => r.top1, 'est. 1RM'), cls: 'est' });
    const svg = lineChartSVG(series, compactNum, ticks);

    const firstTop = displayWeight(byDate.get(dates[0]).topW);
    const lastTop = displayWeight(byDate.get(dates[dates.length - 1]).topW);
    const delta = Math.round((lastTop - firstTop) * 10) / 10;
    // For assisted work, a rising number means LESS assistance, so the same
    // delta gets read the other way round in plain language.
    const up = allPositive ? 'Top set up' : 'Assistance down';
    const down = allPositive ? 'Top set down' : 'Assistance up';
    const flat = allPositive ? 'Top set unchanged' : 'Assistance unchanged';
    const trend = dates.length < 2 ? 'Only one session in range.'
      : delta > 0 ? `${up} ${delta}${weightUnit} across ${dates.length} sessions.`
      : delta < 0 ? `${down} ${Math.abs(delta)}${weightUnit} across ${dates.length} sessions.`
      : `${flat} across ${dates.length} sessions.`;

    el.innerHTML = svg + `
      <div class="chart-legend">
        <span><i></i>${allPositive ? 'Top set' : 'Assisted load'} (${esc(weightUnit)})</span>
        ${allPositive ? '<span><i class="est"></i>Est. 1RM</span>' : '<span><i class="zero"></i>0 = unassisted</span>'}
      </div>
      <div class="hint" style="margin-top:6px;">${esc(trend)}</div>` + loadNote;
  }

  document.getElementById('history-range').addEventListener('change', (e) => {
    historyRangeDays = e.target.value === 'all' ? null : Number(e.target.value);
    historyShowAll = false;
    refreshLogAndHistory();
  });
  // Only the progress chart depends on this, so re-render just that rather
  // than putting the whole app through refreshLogAndHistory.
  document.getElementById('history-exercise').addEventListener('change', (e) => {
    historyExerciseId = Number(e.target.value);
    renderProgressChart();
  });
  // Only the muscle-trend chart depends on this, same reasoning as above.
  document.getElementById('history-muscle').addEventListener('change', (e) => {
    historyMuscleId = e.target.value;
    renderMuscleTrendChart();
  });
  // Debounced: refreshLogAndHistory() re-renders four charts and the whole
  // session list, and doing that per keystroke on a phone is visibly janky.
  let historySearchTimer = null;
  document.getElementById('history-search').addEventListener('input', (e) => {
    const value = e.target.value.trim();
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(() => {
      historySearch = value;
      historyShowAll = false;   // a new filter starts at the top of its own list
      refreshLogAndHistory();
    }, 200);
  });

  // Delegated actions for #history-list, wired once (see delegate() in
  // 03-helpers.js) instead of the three `querySelectorAll(...).forEach(...)`
  // passes this used to run on every repaint.
  //
  // 'delete-set' mirrors the pre-existing wiring for `button.del` inside
  // this container: renderExerciseGroup() is always called here with
  // allowDelete=false (see "History is delete-locked" in the design
  // summary), so no delete button is ever actually rendered in this list —
  // the action exists for symmetry with the active workout's identical
  // handler and is harmless dead wiring either way, exactly as the old
  // per-render forEach was.
  const HISTORY_CLICK_ACTIONS = {
    'delete-set': async (el) => {
      const today = todayStr();
      const exerciseId = Number(el.dataset.exid);
      const removed = await deleteSet(Number(el.dataset.wid), exerciseId, Number(el.dataset.idx));
      refreshLogAndHistory();
      if (removed) {
        toast('Set deleted', 'ok', { duration: 6000, action: { label: 'Undo', onClick: async () => {
          await restoreSet(today, exerciseId, removed);
          await refreshLogAndHistory();
        } } });
      }
    },
    'load-more': () => { historyShowAll = true; refreshLogAndHistory(); },
    'toggle-sign': TOGGLE_SIGN_ACTIONS['toggle-sign'],
  };
  // Fires on `change` (blur/Enter) for the weight/reps inputs of an
  // editable standard-set row — see "Editing a logged set" in the design
  // summary. Both inputs carry `data-action="edit-set"`; the row (and its
  // wid/exid/idx/kg) is found via closest() rather than captured in a
  // render-time closure.
  const HISTORY_CHANGE_ACTIONS = {
    'edit-set': async (el) => {
      const row = el.closest('.plan-log-row');
      if (!row) return;
      // Bail rather than throw if a row is missing its sibling input. One
      // malformed row used to abort every remaining wiring pass; see the
      // matching guard this replaces.
      const wInput = row.querySelector('.set-edit-weight');
      const rInput = row.querySelector('.set-edit-reps');
      if (!wInput || !rInput) return;
      const weight = parseFloat(wInput.value);
      const reps = parseInt(rInput.value, 10);
      if (isNaN(weight) || isNaN(reps)) return;
      const workoutId = Number(row.dataset.wid);
      const exerciseId = Number(row.dataset.exid);
      const setIndex = Number(row.dataset.idx);
      const originalKg = parseFloat(row.dataset.kg);
      await updateStandardSet(workoutId, exerciseId, setIndex, weightToStore(weight, originalKg), reps);
      refreshLogAndHistory();
    },
  };
  // Fires on `input` (every keystroke) for the same weight field — reuses
  // the 'edit-set' data-action already on it (see the comment on delegate()
  // in 03-helpers.js for why the same attribute value can serve two
  // independent per-event-type registries), but only for the cosmetic
  // sign-class sync; syncSignClass() no-ops when there's no preceding
  // sign-btn, which is what makes it safe on the reps field too.
  const HISTORY_INPUT_ACTIONS = {
    'edit-set': (el) => syncSignClass(el),
  };

  async function refreshLogAndHistory() {
    const workouts = await getAllWorkouts();
    const exercises = await getAllRecords('exercises');
    const exercisesById = Object.fromEntries(exercises.map(e => [e.id, e]));
    const today = todayStr();

    const todayWorkout = workouts.find(w => w.date === today);
    const volumeKg = todayWorkout ? workoutStats(todayWorkout, exercisesById).volumeKg : 0;
    document.getElementById('volume-value').textContent = `${Math.round(fromKg(volumeKg)).toLocaleString()} ${weightUnit}`;

    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '';

    // Charts and the session list share this one filtered set. Today is
    // included: it's real training data, and a volume chart that ignored the
    // session you just finished would look broken.
    // -1 because the window is inclusive at both ends and today is one of the
    // days: a 30-day range is today plus the 29 before it. dateStrDaysAgo(30)
    // returned a 31-day window, which is also why the "sets per week"
    // arithmetic on the muscle chart was quietly diluted.
    const cutoff = historyRangeDays == null ? '' : dateStrDaysAgo(historyRangeDays - 1);
    const inRange = workouts.filter(w => w.exercises.length > 0 && w.date >= cutoff);

    // SEARCH narrows the same set the range picker produces, so the charts keep
    // describing exactly the sessions listed underneath them — the invariant
    // the range picker was built around, extended rather than punctured.
    //
    // Filtering happens at the EXERCISE level, never the set level. Two
    // reasons. It answers the question people actually ask ("how has my bench
    // gone?") by showing bench sessions containing only bench, instead of
    // whole squat days that happened to include it. And set indices are
    // load-bearing: the delete and inline-edit handlers address a set by its
    // position in `exEntry.sets`, so dropping sets from that array would point
    // every row at the wrong record. Dropping whole exercises leaves every
    // surviving set at its original index.
    //
    // Shallow copies, so nothing here can write through to the cached store.
    const ranged = !historySearch ? inRange : inRange.map(w => {
      const kept = w.exercises.filter(ex => {
        const rec = exercisesById[ex.exerciseId];
        return rec && nameKey(rec.name).includes(nameKey(historySearch));
      });
      return kept.length ? { ...w, exercises: kept } : null;
    }).filter(Boolean);

    const note = document.getElementById('history-filter-note');
    if (historySearch) {
      const sets = ranged.reduce((a, w) => a + w.exercises.reduce((b, ex) => b + ex.sets.length, 0), 0);
      note.textContent = ranged.length
        ? `Showing only "${historySearch}" — ${sets} set${sets === 1 ? '' : 's'} across ${ranged.length} session${ranged.length === 1 ? '' : 's'}. Totals and charts below cover just this exercise.`
        : `Nothing matching "${historySearch}" in this range.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    renderHistoryCharts(ranged, exercisesById);

    const sessions = ranged.slice().sort((a, b) => b.date.localeCompare(a.date));
    if (sessions.length === 0) {
      historyList.innerHTML = workouts.some(w => w.exercises.length > 0)
        ? '<div class="empty">No sessions in this range.<br>Widen the range above to see older workouts.</div>'
        : '<div class="empty">No sessions yet.<br>Logged days show up here — or import a Fitbod export from Settings.</div>';
    } else {
      // Collapsed by default: the digest line (exercises / sets / volume /
      // duration) is enough to scan a month at a glance, and the full set
      // detail is one tap away when you actually want it.
      const shown = historyShowAll ? sessions : sessions.slice(0, HISTORY_LIST_CAP);
      for (const w of shown) {
        const st = workoutStats(w);
        const det = document.createElement('details');
        det.className = 'session';
        det.open = openSessions.has(w.date);
        det.addEventListener('toggle', () => {
          if (det.open) openSessions.add(w.date); else openSessions.delete(w.date);
        });

        const dateLabel = w.date === today
          ? 'Today'
          : new Date(w.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        const digest = [
          `${st.exercises} exercise${st.exercises === 1 ? '' : 's'}`,
          `${st.sets} set${st.sets === 1 ? '' : 's'}`,
          `${Math.round(fromKg(st.volumeKg)).toLocaleString()} ${weightUnit}`
        ];
        if (w.durationMs) digest.push(formatDuration(w.durationMs));

        const summary = document.createElement('summary');
        summary.innerHTML = `
          <span class="session-info">
            <span class="session-title">${esc(dateLabel)}${w.dayName ? ' · ' + esc(w.dayName) : ''}</span>
            <span class="session-digest">${esc(digest.join(' · '))}</span>
          </span>`;
        det.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'session-body';
        w.exercises.forEach(ex => body.appendChild(renderExerciseGroup(exercisesById[ex.exerciseId], ex, w.id, false)));
        det.appendChild(body);
        historyList.appendChild(det);
      }
      if (!historyShowAll && sessions.length > HISTORY_LIST_CAP) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'load-more';
        btn.textContent = `Show all ${sessions.length} sessions`;
        btn.dataset.action = 'load-more';
        historyList.appendChild(btn);
      }
    }

    delegate(historyList, 'click', HISTORY_CLICK_ACTIONS);
    delegate(historyList, 'change', HISTORY_CHANGE_ACTIONS);
    delegate(historyList, 'input', HISTORY_INPUT_ACTIONS);

    // All three reuse the `workouts` array read at the top of this function
    // rather than each re-reading the whole store.
    await renderWeekProgress(workouts);
    await refreshSessionCard();
    await refreshActiveWorkoutSection(workouts);
  }
