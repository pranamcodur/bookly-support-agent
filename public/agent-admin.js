(function () {
  // ---- nav switching -------------------------------------------------------
  const navButtons = document.querySelectorAll('.navbtn');
  const panels = {
    prompt: document.getElementById('panel-prompt'),
    test: document.getElementById('panel-test'),
    tools: document.getElementById('panel-tools'),
    insights: document.getElementById('panel-insights'),
    csat: document.getElementById('panel-csat'),
  };

  function showPanel(name) {
    Object.entries(panels).forEach(([key, el]) => el.classList.toggle('active', key === name));
    navButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.panel === name));
    if (name === 'tools') loadTools();
    if (name === 'insights') loadInsights();
    if (name === 'csat') loadCsat();
  }

  navButtons.forEach((btn) => btn.addEventListener('click', () => showPanel(btn.dataset.panel)));

  // ---- Prompt panel ---------------------------------------------------------
  const promptBox = document.getElementById('promptBox');
  const promptBadge = document.getElementById('promptBadge');
  const charCount = document.getElementById('charCount');
  const promptStatus = document.getElementById('promptStatus');
  const saveBtn = document.getElementById('saveBtn');
  const resetBtn = document.getElementById('resetBtn');

  function updateCharCount() {
    charCount.textContent = `${promptBox.value.length.toLocaleString()} characters`;
  }

  function setBadge(isCustomized) {
    promptBadge.textContent = isCustomized ? 'customized' : 'default';
    promptBadge.className = `badge ${isCustomized ? 'custom' : 'default'}`;
  }

  function setStatus(text, kind) {
    promptStatus.textContent = text;
    promptStatus.className = `statusmsg ${kind || ''}`;
    if (text) setTimeout(() => { promptStatus.textContent = ''; }, 4000);
  }

  async function loadPrompt() {
    try {
      const res = await fetch('/api/admin/system-prompt');
      const data = await res.json();
      promptBox.value = data.prompt;
      setBadge(data.isCustomized);
      updateCharCount();
    } catch (err) {
      setStatus('Could not load the current prompt.', 'err');
    }
  }

  promptBox.addEventListener('input', updateCharCount);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch('/api/admin/system-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptBox.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed.');
      setBadge(true);
      setStatus('Saved — new conversations will use this prompt.', 'ok');
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  });

  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset to the built-in default prompt? Your customization will be deleted.')) return;
    try {
      const res = await fetch('/api/admin/system-prompt/reset', { method: 'POST' });
      const data = await res.json();
      promptBox.value = data.prompt;
      setBadge(false);
      updateCharCount();
      setStatus('Reset to default.', 'ok');
    } catch (err) {
      setStatus('Could not reset.', 'err');
    }
  });

  // ---- Test panel ------------------------------------------------------------
  const testLog = document.getElementById('testLog');
  const testComposer = document.getElementById('testComposer');
  const testInput = document.getElementById('testInput');
  const testResetBtn = document.getElementById('testResetBtn');
  let testSessionId = null;

  function addTestMsg(text, who) {
    const el = document.createElement('div');
    el.className = `msg ${who}`;
    el.textContent = text;
    testLog.appendChild(el);
    testLog.scrollTop = testLog.scrollHeight;
  }

  testComposer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = testInput.value.trim();
    if (!message) return;
    addTestMsg(message, 'user');
    testInput.value = '';
    try {
      const res = await fetch('/api/admin/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testSessionId, message, prompt: promptBox.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        addTestMsg(data.error || 'Test failed.', 'sys');
        return;
      }
      testSessionId = data.testSessionId;
      addTestMsg(data.reply, 'bot');
      if (data.meta && data.meta.tool) addTestMsg(`◆ ${data.meta.tool}`, 'sys');
      if (data.note) addTestMsg(data.note, 'sys');
    } catch (err) {
      addTestMsg('Could not reach the server.', 'sys');
    }
  });

  testResetBtn.addEventListener('click', async () => {
    if (testSessionId) {
      await fetch('/api/admin/test/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testSessionId }),
      }).catch(() => {});
    }
    testSessionId = null;
    testLog.innerHTML = '';
    addTestMsg('New test conversation started — using whatever is currently in the AOP tab.', 'sys');
  });

  // ---- Transcript Analysis: a donut chart of what customers ask about -----
  function buildTranscriptDonutChart() {
    const data = [
      { label: 'Order Status', value: 30, color: '#6C63FF' },
      { label: 'Return / Refund', value: 22, color: '#FF9F43' },
      { label: 'Shipping Questions', value: 12, color: '#E0D01A' },
      { label: 'Password / Account', value: 10, color: '#1FB8A6' },
      { label: 'Order Changes', value: 8, color: '#C77DFF' },
      { label: 'Product Questions', value: 7, color: '#3FD0E0' },
      { label: 'Billing Issues', value: 6, color: '#F45B69' },
      { label: 'Other', value: 5, color: '#D8D8DC' },
    ];
    const total = data.reduce((s, d) => s + d.value, 0);
    const cx = 310, cy = 230, outerR = 110, innerR = 62;
    const meanR = (outerR + innerR) / 2;
    const ringWidth = outerR - innerR;
    const C = 2 * Math.PI * meanR;

    function pt(angleDeg, r) {
      const rad = (angleDeg * Math.PI) / 180;
      return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
    }

    let cum = 0;
    const segs = data.map((d) => {
      const startPct = cum, endPct = cum + d.value;
      const midPct = (startPct + endPct) / 2;
      cum = endPct;
      const midAngle = (midPct / total) * 360;
      const dashLen = (d.value / total) * C;
      const dashOffset = -(startPct / total) * C;
      return { ...d, midAngle, dashLen, dashOffset };
    });

    const rings = segs.map((s) => `
      <circle cx="${cx}" cy="${cy}" r="${meanR}" fill="none" stroke="${s.color}"
        stroke-width="${ringWidth}" stroke-dasharray="${s.dashLen} ${C - s.dashLen}"
        stroke-dashoffset="${s.dashOffset}" transform="rotate(-90 ${cx} ${cy})" />
    `).join('');

    const leaders = segs.map((s) => {
      const bucket = (s.midAngle > 160 && s.midAngle < 220) ? 'bottom' : (s.midAngle >= 220 || s.midAngle <= 15) ? 'left' : 'right';
      const labelR = bucket === 'bottom' ? outerR + 68 : outerR + 52;
      const linePt = pt(s.midAngle, outerR);
      const labelPt = pt(s.midAngle, labelR);
      const anchor = bucket === 'bottom' ? 'middle' : bucket === 'left' ? 'end' : 'start';
      const dx = bucket === 'left' ? -6 : bucket === 'right' ? 6 : 0;
      const dy = bucket === 'bottom' ? 14 : 4;
      return `
        <line x1="${linePt.x.toFixed(1)}" y1="${linePt.y.toFixed(1)}" x2="${labelPt.x.toFixed(1)}" y2="${labelPt.y.toFixed(1)}" stroke="#9C9690" stroke-width="1"/>
        <text x="${(labelPt.x + dx).toFixed(1)}" y="${(labelPt.y + dy).toFixed(1)}" text-anchor="${anchor}" font-size="13" font-family="Inter, sans-serif" fill="#57534A">${s.label}</text>
      `;
    }).join('');

    return `
      <svg viewBox="0 0 620 470" xmlns="http://www.w3.org/2000/svg">
        <text x="310" y="28" text-anchor="middle" font-size="17" font-weight="700" font-family="Fraunces, serif" fill="#163326">What are customers asking?</text>
        ${rings}
        ${leaders}
      </svg>
    `;
  }

  // ---- Enable A/B Testing: side-by-side variant comparison cards ----------
  function checkIcon() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  }
  function starIcon() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>';
  }

  function buildABTestCards() {
    const metrics = [
      { title: 'Resolution rate', icon: checkIcon(), a: '76.9%', b: '70.4%' },
      { title: 'CSAT', icon: starIcon(), a: '4.6', b: '4.2' },
    ];
    const cards = metrics.map((m) => `
      <div class="abtest-card">
        <span class="abtest-badge">${m.icon}</span>
        <h4>${m.title}</h4>
        <div class="abtest-metric winner">
          <div class="abtest-value">${m.a}</div>
          <div class="variant-label">Variant A &mdash; current AOP</div>
        </div>
        <div class="abtest-metric runnerup">
          <div class="abtest-value">${m.b}</div>
          <div class="variant-label">Variant B &mdash; previous AOP</div>
        </div>
      </div>
    `).join('');
    return `<div class="abtest-grid">${cards}</div>`;
  }

  document.querySelectorAll('.test-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'Transcript Analysis') {
        const el = document.createElement('div');
        el.className = 'msg chart-msg';
        el.innerHTML = buildTranscriptDonutChart();
        testLog.appendChild(el);
        testLog.scrollTop = testLog.scrollHeight;
        return;
      }
      if (btn.dataset.action === 'Enable A/B Testing') {
        const el = document.createElement('div');
        el.className = 'msg chart-msg';
        el.innerHTML = buildABTestCards();
        testLog.appendChild(el);
        testLog.scrollTop = testLog.scrollHeight;
        return;
      }
      addTestMsg(`"${btn.dataset.action}" isn't wired up yet — placeholder for now.`, 'sys');
    });
  });

  document.querySelectorAll('.integration-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const status = document.getElementById('integrationStatus');
      if (!status) return;
      status.textContent = `${btn.dataset.integration} isn't connected yet — placeholder for now.`;
      status.className = 'statusmsg';
      setTimeout(() => { status.textContent = ''; }, 4000);
    });
  });

  // ---- Tools panel ------------------------------------------------------------
  let toolsLoaded = false;
  async function loadTools() {
    if (toolsLoaded) return;
    const container = document.getElementById('toolsList');
    try {
      const res = await fetch('/api/admin/tools');
      const data = await res.json();
      container.innerHTML = '';
      data.tools.forEach((tool) => {
        const card = document.createElement('div');
        card.className = 'tool-card';
        const params = Object.keys(tool.input_schema.properties || {});
        card.innerHTML = `
          <span class="name">${tool.name}</span>
          <span class="badge ${tool.requiresLogin ? 'login' : 'open'}">${tool.requiresLogin ? 'requires login' : 'always available'}</span>
          <p class="desc">${tool.description}</p>
          <p class="params">${params.length ? 'Parameters: ' + params.map((p) => `<code>${p}</code>`).join(' ') : 'No parameters'}</p>
        `;
        container.appendChild(card);
      });
      toolsLoaded = true;
    } catch (err) {
      container.textContent = 'Could not load tools.';
    }
  }

  // ---- Insights panel ---------------------------------------------------------
  async function loadInsights() {
    const container = document.getElementById('insightsBody');
    container.innerHTML = 'Loading…';
    try {
      const res = await fetch('/api/admin/insights');
      const data = await res.json();
      const engineRows = Object.entries(data.sessionsByEngine)
        .map(([k, v]) => `<div class="breakdown-row"><span>${k}</span><span>${v}</span></div>`).join('');
      const statusRows = Object.entries(data.ordersByStatus)
        .map(([k, v]) => `<div class="breakdown-row"><span>${k}</span><span>${v}</span></div>`).join('');

      container.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card"><div class="num">${data.activeSessions}</div><div class="label">Active sessions</div></div>
          <div class="stat-card"><div class="num">${data.loggedInSessions}</div><div class="label">Logged in</div></div>
          <div class="stat-card"><div class="num">${data.guestSessions}</div><div class="label">Guest sessions</div></div>
          <div class="stat-card"><div class="num">${data.totalOrders}</div><div class="label">Total orders</div></div>
          <div class="stat-card"><div class="num">${data.zendeskConfigured ? 'Live' : 'Simulated'}</div><div class="label">Zendesk mode</div></div>
          <div class="stat-card"><div class="num">${data.systemPromptCustomized ? 'Yes' : 'No'}</div><div class="label">Prompt customized</div></div>
        </div>
        <div class="breakdown">
          <h3>Sessions by engine</h3>
          ${engineRows || '<div class="breakdown-row"><span>No active sessions</span><span></span></div>'}
        </div>
        <div class="breakdown">
          <h3>Orders by status</h3>
          ${statusRows || '<div class="breakdown-row"><span>No orders</span><span></span></div>'}
        </div>
      `;
    } catch (err) {
      container.textContent = 'Could not load insights.';
    }
  }

  document.getElementById('refreshInsights').addEventListener('click', loadInsights);

  // ---- Observability: ask-a-question box (canned analysis, illustrative) ---
  const QUERY_ANSWERS = {
    'why are customers requesting refunds this week?':
      '342 return requests this week (+12% week-over-week). Top drivers: wrong item shipped ' +
      '(34%, 116 cases), changed my mind (26%, 89 cases), and arrived damaged (19%, 65 cases). ' +
      '41% of all returns this week came from the Fiction category.',
    'what are the top reasons for order cancellations on mobile vs. web?':
      '350 cancellations analyzed — 58% on mobile (203 orders), 42% on web (147 orders). Mobile: ' +
      'payment failures (37%), slow checkout (28%). Web: found a cheaper price elsewhere (44%), ' +
      'surprise shipping cost at checkout (31%).',
    'what feature requests surface most frequently in voice calls?':
      'Across 128 voice transcripts this month: order tracking via SMS (31% of calls), saved ' +
      'payment methods (24%), and gift wrapping at checkout (18%).',
    'what products are driving the most user frustration?':
      'Sentiment analysis across 890 conversations: "Project Hail Mary" (audiobook edition) ' +
      'accounts for 22% of negative-sentiment tickets; "The Way of Kings" (shipping damage) for ' +
      '17%. Together, these two titles drive over a third of all frustration signals this month.',
    'show me conversations where the customer expressed high frustration before dropping off.':
      '47 conversations (5.3% of total volume) showed a high-frustration signal followed by no ' +
      'reply within 10 minutes. 68% involved an in-progress return/refund flow. Median time from ' +
      'frustration signal to drop-off: 4.2 minutes.',
    'find any interactions where unmasked pii, credit card details, or hipaa-restricted data were mentioned.':
      'Scanned 2,140 conversations. 3 flagged for potential unmasked PII (full email addresses ' +
      'restated in chat); 0 credit card numbers detected; 0 HIPAA-restricted terms detected. All 3 ' +
      'PII flags were auto-redacted before storage — ticket IDs #4471, #4498, #4512 recommended for review.',
  };
  const QUERY_FALLBACK =
    'Found 218 matching conversations (18% of total volume analyzed). Top related theme: shipping ' +
    'delays (41%), followed by billing questions (23%). Try one of the sample questions below for a ' +
    'more detailed breakdown.';

  function runQuery(question) {
    const trimmed = (question || '').trim();
    if (!trimmed) return;
    const answer = QUERY_ANSWERS[trimmed.toLowerCase()] || QUERY_FALLBACK;
    const box = document.getElementById('queryAnswer');
    box.innerHTML = `
      <div class="query-answer-card">
        <p class="query-eyebrow">Analysis</p>
        <p class="query-question">${trimmed}</p>
        <p>${answer}</p>
      </div>
    `;
  }

  document.getElementById('queryForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('queryInput');
    runQuery(input.value);
  });

  document.querySelectorAll('.query-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('queryInput').value = chip.dataset.query;
      runQuery(chip.dataset.query);
    });
  });

  // ---- CSAT panel (mock data — no backend, purely illustrative) --------------
  // Static 14-day mock series so the dashboard looks the same on every load
  // rather than reshuffling — this is demo data, not a real metrics pipeline.
  const CSAT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const CSAT_SCORES = [4.3, 4.4, 4.2, 4.5, 4.6, 4.5, 4.7, 4.6, 4.4, 4.5, 4.7, 4.8, 4.6, 4.7];
  const DEFLECTION_RATES = [61, 63, 59, 65, 68, 70, 72, 69, 66, 68, 71, 74, 73, 75];
  const RESPONSE_TIMES = [2.4, 2.2, 2.5, 2.1, 1.9, 1.8, 1.7, 1.9, 2.0, 1.8, 1.6, 1.5, 1.6, 1.4];

  function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function trendDelta(arr) {
    const firstHalf = avg(arr.slice(0, Math.floor(arr.length / 2)));
    const secondHalf = avg(arr.slice(Math.floor(arr.length / 2)));
    return secondHalf - firstHalf;
  }

  function buildLineChart(values, { min, max, color, suffix = '', decimals = 1 }) {
    const W = 620, H = 190, padL = 34, padR = 12, padT = 14, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const x = (i) => padL + (i / (values.length - 1)) * plotW;
    const y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

    const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const gridLines = [0, 0.5, 1].map((f) => {
      const gy = padT + f * plotH;
      const val = (max - f * (max - min)).toFixed(decimals);
      return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" class="chart-grid"/>
              <text x="${padL - 6}" y="${gy + 3}" text-anchor="end" class="chart-axis-label">${val}${suffix}</text>`;
    }).join('');
    const dayLabels = values.map((v, i) => (i % 2 === 0
      ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="chart-axis-label">${CSAT_DAYS[i]}</text>` : '')).join('');
    const dots = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${color}"/>`).join('');

    return `<svg viewBox="0 0 ${W} ${H}">
      ${gridLines}
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${dayLabels}
    </svg>`;
  }

  function buildBarChart(values, { min, max, color, suffix = '' }) {
    const W = 620, H = 190, padL = 34, padR = 12, padT = 14, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const gap = 6;
    const barW = (plotW - gap * (values.length - 1)) / values.length;
    const y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

    const gridLines = [0, 0.5, 1].map((f) => {
      const gy = padT + f * plotH;
      const val = Math.round(max - f * (max - min));
      return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" class="chart-grid"/>
              <text x="${padL - 6}" y="${gy + 3}" text-anchor="end" class="chart-axis-label">${val}${suffix}</text>`;
    }).join('');
    const bars = values.map((v, i) => {
      const bx = padL + i * (barW + gap);
      const by = y(v);
      const label = i % 2 === 0 ? `<text x="${bx + barW / 2}" y="${H - 6}" text-anchor="middle" class="chart-axis-label">${CSAT_DAYS[i]}</text>` : '';
      return `<rect x="${bx}" y="${by}" width="${barW}" height="${padT + plotH - by}" rx="2" fill="${color}"><title>${v}${suffix}</title></rect>${label}`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}">${gridLines}${bars}</svg>`;
  }

  function buildCostSavingsChart() {
    // Formula: Tickets Deflected × Average Handle Time × Agent Hourly Rate.
    // Modeled on a team handling 1,000 tickets/week — same worked example
    // Decagon uses to explain the ROI calculation.
    const ticketsPerWeek = 1000;
    const deflectionRate = 0.70;
    const aht = 10; // minutes
    const hourlyRate = 20; // $/hr
    const weeksPerYear = 52;

    const deflected = ticketsPerWeek * deflectionRate; // 700
    const minutesSaved = deflected * aht; // 7,000
    const hoursSaved = Math.round((minutesSaved / 60) * 10) / 10; // 116.7 (rounded, carried forward)
    const weeklySavings = hoursSaved * hourlyRate; // $2,334
    const annualSavings = weeklySavings * weeksPerYear; // $121,368

    const fmt = (n) => n.toLocaleString('en-US');

    return `
      <div class="chart-card">
        <h3>Operational Cost Savings</h3>
        <p class="chart-sub">Value of agent time freed up by deflection — modeled on a team handling 1,000 tickets/week.</p>

        <div class="cost-savings-hero">
          <div class="cost-savings-figure">$${fmt(annualSavings)}</div>
          <div class="cost-savings-label">estimated annual savings</div>
        </div>

        <div class="cost-flow">
          <div class="cost-step"><div class="cost-step-value">${fmt(ticketsPerWeek)}</div><div class="cost-step-label">tickets / week</div></div>
          <div class="cost-op">&times;</div>
          <div class="cost-step"><div class="cost-step-value">${Math.round(deflectionRate * 100)}%</div><div class="cost-step-label">deflection rate</div></div>
          <div class="cost-op">=</div>
          <div class="cost-step highlight"><div class="cost-step-value">${fmt(deflected)}</div><div class="cost-step-label">tickets deflected / week</div></div>
        </div>

        <div class="cost-flow">
          <div class="cost-step"><div class="cost-step-value">${fmt(deflected)}</div><div class="cost-step-label">deflected / week</div></div>
          <div class="cost-op">&times;</div>
          <div class="cost-step"><div class="cost-step-value">${aht} min</div><div class="cost-step-label">avg handle time</div></div>
          <div class="cost-op">=</div>
          <div class="cost-step highlight"><div class="cost-step-value">${fmt(minutesSaved)} min</div><div class="cost-step-label">saved / week</div></div>
        </div>

        <div class="cost-flow">
          <div class="cost-step"><div class="cost-step-value">${fmt(minutesSaved)} min</div><div class="cost-step-label">&divide; 60</div></div>
          <div class="cost-op">=</div>
          <div class="cost-step highlight"><div class="cost-step-value">${hoursSaved} hrs</div><div class="cost-step-label">saved / week</div></div>
          <div class="cost-op">&times;</div>
          <div class="cost-step"><div class="cost-step-value">$${hourlyRate}/hr</div><div class="cost-step-label">agent rate</div></div>
          <div class="cost-op">=</div>
          <div class="cost-step"><div class="cost-step-value">$${fmt(weeklySavings)}</div><div class="cost-step-label">saved / week</div></div>
        </div>

        <div class="cost-flow">
          <div class="cost-step"><div class="cost-step-value">$${fmt(weeklySavings)}</div><div class="cost-step-label">saved / week</div></div>
          <div class="cost-op">&times;</div>
          <div class="cost-step"><div class="cost-step-value">${weeksPerYear}</div><div class="cost-step-label">weeks / year</div></div>
          <div class="cost-op">=</div>
          <div class="cost-step final"><div class="cost-step-value">$${fmt(annualSavings)}</div><div class="cost-step-label">annual savings</div></div>
        </div>

        <p class="cost-formula"><strong>Formula:</strong> Tickets Deflected &times; Average Handle Time &times; Agent Hourly Rate</p>
      </div>
    `;
  }

  function loadCsat() {
    const container = document.getElementById('csatBody');
    const csatAvg = avg(CSAT_SCORES);
    const deflAvg = avg(DEFLECTION_RATES);
    const rtAvg = avg(RESPONSE_TIMES);
    const csatDelta = trendDelta(CSAT_SCORES);
    const deflDelta = trendDelta(DEFLECTION_RATES);
    const rtDelta = trendDelta(RESPONSE_TIMES); // negative = faster = good

    const deltaHtml = (d, goodIfPositive, suffix, decimals) => {
      const good = goodIfPositive ? d >= 0 : d <= 0;
      const arrow = d >= 0 ? '▲' : '▼';
      return `<div class="delta ${good ? 'up' : 'down'}">${arrow} ${Math.abs(d).toFixed(decimals)}${suffix} vs. first week</div>`;
    };

    container.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card">
          <div class="num">${csatAvg.toFixed(1)} / 5</div>
          <div class="label">Avg CSAT (14d)</div>
          ${deltaHtml(csatDelta, true, '', 1)}
        </div>
        <div class="stat-card">
          <div class="num">${Math.round(deflAvg)}%</div>
          <div class="label">Deflection rate (14d)</div>
          ${deltaHtml(deflDelta, true, ' pts', 0)}
        </div>
        <div class="stat-card">
          <div class="num">${rtAvg.toFixed(1)}s</div>
          <div class="label">Avg response time</div>
          ${deltaHtml(rtDelta, false, 's', 1)}
        </div>
      </div>

      <div class="chart-card">
        <h3>CSAT score</h3>
        <p class="chart-sub">Customer satisfaction rating (out of 5), last 14 days</p>
        ${buildLineChart(CSAT_SCORES, { min: 3.5, max: 5, color: getComputedStyle(document.documentElement).getPropertyValue('--forest').trim() })}
      </div>

      <div class="chart-card">
        <h3>Deflection rate</h3>
        <p class="chart-sub">Share of conversations resolved without a human handoff / support ticket</p>
        ${buildBarChart(DEFLECTION_RATES, { min: 0, max: 100, suffix: '%', color: getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() })}
      </div>

      <div class="chart-card">
        <h3>Response time</h3>
        <p class="chart-sub">Average time to first reply, in seconds</p>
        ${buildBarChart(RESPONSE_TIMES, { min: 0, max: 3, suffix: 's', color: getComputedStyle(document.documentElement).getPropertyValue('--wine').trim() })}
      </div>

      ${buildCostSavingsChart()}
    `;
  }

  // ---- init --------------------------------------------------------------
  loadPrompt();
  addTestMsg('Testing uses whatever is currently in the AOP tab — save it first if you want the Test tab to reflect a permanent change.', 'sys');
})();
