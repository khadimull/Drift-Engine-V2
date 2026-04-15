import React, { useState, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceLine, ComposedChart, Scatter
} from 'recharts';

// ── Color Palette ──────────────────────────────────────────────────────────────
const C = {
  overkill: '#f59e0b', undercall: '#ef4444', wrongTag: '#8b5cf6',
  stable: '#10b981', warning: '#f59e0b', critical: '#ef4444',
  bg: '#0f172a', card: '#1e293b', cardAlt: '#273549', text: '#f1f5f9',
  textDim: '#94a3b8', border: '#334155', accent: '#3b82f6',
  accentDim: '#1d4ed8', white: '#ffffff',
};

const TABS = [
  'Overview', 'SPC Charts', 'Error Classification', 'MOD Mistakes',
  'Coaching', 'AI Coach', 'RCA Analysis', 'Systemic Issues', 'Alerts', 'Event Log'
];

const TARGET_ACCURACY = 0.95;

// ── Utility helpers ────────────────────────────────────────────────────────────
const pct = (n, d) => d === 0 ? 0 : ((n / d) * 100);
const pctStr = (n, d) => pct(n, d).toFixed(1) + '%';
const mean = arr => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
const stddev = arr => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
};

const parsePolicy = raw => {
  if (!raw || raw === '[]' || raw === 'Misaligned') return [];
  const s = String(raw).trim();
  if (s === '[]' || s === '' || s === 'Misaligned') return [];
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return [s];
};

const isEmptyPolicy = raw => {
  const parsed = parsePolicy(raw);
  return parsed.length === 0;
};


// ── Fuzzy column finder ────────────────────────────────────────────────────────
const COLUMN_PATTERNS = {
  batch:        [/^batch$/i],
  market:       [/^market$/i],
  moderator:    [/^moderator$/i],
  taskId:       [/task.?id/i],
  alignment:    [/^alignment$/i],
  marketAnswer: [/market.*(?:top|voted|answer|reference)/i],
  modPolicy:    [/mod.*(?:policy|title|mismatch)/i],
  tcsLink:      [/tcs.*link/i, /^tcs$/i],
  rca:          [/^rca$/i],
  baselineIA:   [/baseline.*ia/i],
  totalWorked:  [/total.*worked/i],
  totalAligned: [/total.*aligned/i],
  impactPerCase:[/impact.*case/i],
};

function buildColumnMap(row) {
  const keys = Object.keys(row);
  const map = {};
  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    for (const p of patterns) {
      const found = keys.find(k => p.test(k));
      if (found) { map[field] = found; break; }
    }
  }
  return map;
}

function getVal(row, colMap, field) {
  const key = colMap[field];
  if (!key) return '';
  const v = row[key];
  return v == null ? '' : String(v).trim();
}

// ── Core classification engine ─────────────────────────────────────────────────
function classifyRow(row) {
  const alignment = String(row.Alignment || '').trim();
  const marketRaw = String(row['Market top voted answer'] || '').trim();
  const modRaw = String(row['Mod policy title'] || '').trim();

  // CASE 1: Alignment = "Misaligned"
  if (alignment === 'Misaligned') {
    const marketEmpty = isEmptyPolicy(marketRaw);
    const modEmpty = isEmptyPolicy(modRaw);
    if (marketEmpty && !modEmpty) return { type: 'OVERKILL', modPolicies: parsePolicy(modRaw), marketPolicies: [], swapped: false };
    if (!marketEmpty && modEmpty) return { type: 'UNDERCALL', modPolicies: [], marketPolicies: parsePolicy(marketRaw), swapped: false };
    if (!marketEmpty && !modEmpty) return { type: 'WRONG_TAG', modPolicies: parsePolicy(modRaw), marketPolicies: parsePolicy(marketRaw), swapped: false };
    return { type: 'MISALIGNED_UNKNOWN', modPolicies: [], marketPolicies: [], swapped: false };
  }

  // CASE 2: Alignment = "[]" (swapped columns)
  if (alignment === '[]') {
    const marketPolicies = parsePolicy(marketRaw);
    return { type: 'UNDERCALL', modPolicies: [], marketPolicies, swapped: true };
  }

  // CASE 3: Alignment = "[Policy Name]" (swapped columns)
  if (alignment && alignment !== 'Aligned') {
    const modPolicies = parsePolicy(alignment);
    const marketEmpty = isEmptyPolicy(marketRaw);
    if (marketEmpty) return { type: 'OVERKILL', modPolicies, marketPolicies: [], swapped: true };
    const marketPolicies = parsePolicy(marketRaw);
    return { type: 'WRONG_TAG', modPolicies, marketPolicies, swapped: true };
  }

  // Aligned row
  return { type: 'ALIGNED', modPolicies: [], marketPolicies: [], swapped: false };
}

// ── Sparkline component ────────────────────────────────────────────────────────
const Sparkline = ({ data, color = C.accent, width = 100, height = 28 }) => {
  if (!data || data.length < 2) return <span style={{ color: C.textDim, fontSize: 11 }}>—</span>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 4) - 2}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
};

// ── KPI Card ───────────────────────────────────────────────────────────────────
const KPICard = ({ title, value, subtitle, color = C.accent, icon }) => (
  <div style={{ background: C.card, borderRadius: 12, padding: '20px 24px', flex: '1 1 180px', minWidth: 180, border: `1px solid ${C.border}` }}>
    <div style={{ color: C.textDim, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{icon} {title}</div>
    <div style={{ color: color, fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
    {subtitle && <div style={{ color: C.textDim, fontSize: 12, marginTop: 4 }}>{subtitle}</div>}
  </div>
);

// ── Badge ──────────────────────────────────────────────────────────────────────
const Badge = ({ label, color }) => (
  <span style={{ background: color + '22', color, padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 700, border: `1px solid ${color}44` }}>{label}</span>
);

// ── Severity badge helper ──────────────────────────────────────────────────────
const severityBadge = errorRate => {
  if (errorRate > 10) return <Badge label="CRITICAL" color={C.critical} />;
  if (errorRate > 5) return <Badge label="WARNING" color={C.warning} />;
  return <Badge label="STABLE" color={C.stable} />;
};

const severityColor = errorRate => errorRate > 10 ? C.critical : errorRate > 5 ? C.warning : C.stable;

// ── Week key helper ────────────────────────────────────────────────────────────
const weekKey = dateStr => {
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return 'Unknown';
    const oneJan = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  } catch { return 'Unknown'; }
};

// ── Western Electric rules ─────────────────────────────────────────────────────
function westernElectricViolations(values, m, s) {
  const flags = new Array(values.length).fill(null);
  if (s === 0) return flags;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    // Rule 1: single point beyond 3σ
    if (Math.abs(v - m) > 3 * s) { flags[i] = 'R1:>3σ'; continue; }
    // Rule 2: 2 of 3 consecutive beyond 2σ on same side
    if (i >= 2) {
      const win = [values[i - 2], values[i - 1], values[i]];
      const above = win.filter(x => x > m + 2 * s).length;
      const below = win.filter(x => x < m - 2 * s).length;
      if (above >= 2 || below >= 2) { flags[i] = 'R2:2/3>2σ'; continue; }
    }
    // Rule 3: 4 of 5 consecutive beyond 1σ on same side
    if (i >= 4) {
      const win = values.slice(i - 4, i + 1);
      const above = win.filter(x => x > m + s).length;
      const below = win.filter(x => x < m - s).length;
      if (above >= 4 || below >= 4) { flags[i] = 'R3:4/5>1σ'; continue; }
    }
    // Rule 4: 8 consecutive on same side of mean
    if (i >= 7) {
      const win = values.slice(i - 7, i + 1);
      if (win.every(x => x > m) || win.every(x => x < m)) { flags[i] = 'R4:8run'; continue; }
    }
    // Rule 5: beyond 2σ
    if (Math.abs(v - m) > 2 * s) { flags[i] = 'R5:>2σ'; }
  }
  return flags;
}

// ── Export coaching report ──────────────────────────────────────────────────────
function exportCoachingReport(modStats) {
  let txt = 'MODERATOR DRIFT ANALYSIS — COACHING REPORT\n' + '='.repeat(50) + '\n\n';
  const sorted = [...modStats].sort((a, b) => b.errorRate - a.errorRate);
  sorted.forEach((m, idx) => {
    txt += `${idx + 1}. ${m.name}  (${m.market})\n`;
    txt += `   Error Rate: ${m.errorRate.toFixed(1)}%  |  Severity: ${m.errorRate > 10 ? 'CRITICAL' : m.errorRate > 5 ? 'WARNING' : 'STABLE'}\n`;
    txt += `   Overkill: ${m.overkill}  Undercall: ${m.undercall}  Wrong Tag: ${m.wrongTag}\n`;
    txt += `   Top Errors: ${m.topPolicies.slice(0, 3).map(p => p[0]).join(', ') || 'N/A'}\n`;
    txt += `   Recommendation: ${m.recommendation}\n\n`;
  });
  const blob = new Blob([txt], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'coaching_report.txt';
  a.click();
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [records, setRecords] = useState([]);
  const [activeTab, setActiveTab] = useState(0);
  const [alertThreshold, setAlertThreshold] = useState(5);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('ALL');
  const [dragOver, setDragOver] = useState(false);
  const [modFilter, setModFilter] = useState('ALL');
  const fileRef = useRef();

  // ── File parsing ─────────────────────────────────────────────────────────────
  const handleFile = useCallback(file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (json.length === 0) return;

      // Build fuzzy column map from first row's keys
      const colMap = buildColumnMap(json[0]);
      console.log('[Engine] Column mapping:', colMap);

      const processed = json.map((row, idx) => {
        // Parse batch date
        const batchRaw = row[colMap.batch] || '';
        let batchStr = '';
        if (batchRaw instanceof Date) {
          batchStr = batchRaw.toISOString().split('T')[0];
        } else {
          const s = String(batchRaw);
          const m = s.match(/(\d{4}-\d{2}-\d{2})/);
          batchStr = m ? m[1] : s;
        }

        const alignmentVal = getVal(row, colMap, 'alignment');
        const marketVal = getVal(row, colMap, 'marketAnswer');
        const modVal = getVal(row, colMap, 'modPolicy');

        const classification = classifyRow({
          Alignment: alignmentVal,
          'Market top voted answer': marketVal,
          'Mod policy title': modVal,
        });

        // Parse baseline metrics
        const parseNum = v => { const n = parseFloat(String(v).replace('%', '')); return isNaN(n) ? null : n; };

        return {
          id: idx,
          batch: batchStr,
          week: weekKey(batchStr),
          market: getVal(row, colMap, 'market'),
          moderator: getVal(row, colMap, 'moderator'),
          taskId: getVal(row, colMap, 'taskId'),
          alignmentRaw: alignmentVal,
          marketAnswer: marketVal,
          modPolicy: modVal,
          tcsLink: getVal(row, colMap, 'tcsLink'),
          rca: getVal(row, colMap, 'rca'),
          baselineIA: parseNum(getVal(row, colMap, 'baselineIA')),
          totalWorked: parseNum(getVal(row, colMap, 'totalWorked')),
          totalAligned: parseNum(getVal(row, colMap, 'totalAligned')),
          impactPerCase: parseNum(getVal(row, colMap, 'impactPerCase')),
          ...classification,
        };
      });
      console.log('[Engine] Classified:', processed.length, 'rows. Overkill:', processed.filter(r=>r.type==='OVERKILL').length, 'Undercall:', processed.filter(r=>r.type==='UNDERCALL').length, 'WrongTag:', processed.filter(r=>r.type==='WRONG_TAG').length);
      setRecords(processed);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onDrop = useCallback(e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }, [handleFile]);
  const onDragOver = useCallback(e => { e.preventDefault(); setDragOver(true); }, []);
  const onDragLeave = useCallback(() => setDragOver(false), []);

  // ── Computed analytics ───────────────────────────────────────────────────────
  const analytics = useMemo(() => {
    if (records.length === 0) return null;

    const total = records.length;
    const aligned = records.filter(r => r.type === 'ALIGNED').length;
    const misaligned = records.filter(r => r.type !== 'ALIGNED');
    const overkill = misaligned.filter(r => r.type === 'OVERKILL');
    const undercall = misaligned.filter(r => r.type === 'UNDERCALL');
    const wrongTag = misaligned.filter(r => r.type === 'WRONG_TAG');
    const unknown = misaligned.filter(r => r.type === 'MISALIGNED_UNKNOWN');
    const accuracy = pct(aligned, total);
    const gapTo95 = Math.max(0, 95 - accuracy);

    // Per-moderator stats
    const modMap = {};
    records.forEach(r => {
      if (!r.moderator) return;
      if (!modMap[r.moderator]) modMap[r.moderator] = { name: r.moderator, market: r.market, total: 0, aligned: 0, overkill: 0, undercall: 0, wrongTag: 0, errors: [], weeklyErrors: {}, policies: {}, overkillPolicies: {}, undercallPolicies: {}, wrongTagPairs: {}, rcaBreakdown: {} };
      const m = modMap[r.moderator];
      m.total++;
      if (r.type === 'ALIGNED') { m.aligned++; return; }
      if (r.type === 'OVERKILL') { m.overkill++; r.modPolicies.forEach(p => { m.overkillPolicies[p] = (m.overkillPolicies[p] || 0) + 1; }); }
      if (r.type === 'UNDERCALL') { m.undercall++; r.marketPolicies.forEach(p => { m.undercallPolicies[p] = (m.undercallPolicies[p] || 0) + 1; }); }
      if (r.type === 'WRONG_TAG') { m.wrongTag++; r.modPolicies.forEach(mp => r.marketPolicies.forEach(mkp => { const k = `${mp} → ${mkp}`; m.wrongTagPairs[k] = (m.wrongTagPairs[k] || 0) + 1; })); }
      m.errors.push(r);
      if (!m.weeklyErrors[r.week]) m.weeklyErrors[r.week] = 0;
      m.weeklyErrors[r.week]++;
      const allPolicies = [...r.modPolicies, ...r.marketPolicies];
      allPolicies.forEach(p => { m.policies[p] = (m.policies[p] || 0) + 1; });
      if (r.rca) { m.rcaBreakdown[r.rca] = (m.rcaBreakdown[r.rca] || 0) + 1; }
    });

    const modStats = Object.values(modMap).map(m => {
      const errorCount = m.overkill + m.undercall + m.wrongTag;
      const errorRate = pct(errorCount, m.total);
      const topPolicies = Object.entries(m.policies).sort((a, b) => b[1] - a[1]);
      const dominant = m.overkill >= m.undercall && m.overkill >= m.wrongTag ? 'overkill'
        : m.undercall >= m.overkill && m.undercall >= m.wrongTag ? 'undercall' : 'wrongTag';
      let recommendation = '';
      if (dominant === 'overkill') recommendation = `Moderator is over-enforcing. Calibrate on ${topPolicies[0]?.[0] || 'policy'}. Recommend shadow session on approve vs flag decisions.`;
      else if (dominant === 'undercall') recommendation = `Moderator is missing violations. Calibrate on ${topPolicies[0]?.[0] || 'policy'}. Recommend policy refresher training.`;
      else recommendation = `Moderator flags content but selects wrong policy. Recommend policy differentiation workshop for ${topPolicies.slice(0, 2).map(p => p[0]).join(' vs ') || 'policies'}.`;

      // Weekly trend for sparkline
      const weeks = Object.keys(m.weeklyErrors).sort();
      const weeklyTrend = weeks.map(w => m.weeklyErrors[w]);

      // Drift score: weighted combo of error rate + trend direction
      const trendSlope = weeklyTrend.length >= 2 ? (weeklyTrend[weeklyTrend.length - 1] - weeklyTrend[0]) / weeklyTrend.length : 0;
      const driftScore = errorRate + trendSlope * 10;

      const topOverkillPolicies = Object.entries(m.overkillPolicies).sort((a, b) => b[1] - a[1]);
      const topUndercallPolicies = Object.entries(m.undercallPolicies).sort((a, b) => b[1] - a[1]);
      const topWrongTagPairs = Object.entries(m.wrongTagPairs).sort((a, b) => b[1] - a[1]);
      const topRcas = Object.entries(m.rcaBreakdown).sort((a, b) => b[1] - a[1]);
      const modMistakeCount = m.rcaBreakdown['MOD MISTAKE'] || 0;

      return { ...m, errorCount, errorRate, topPolicies, dominant, recommendation, weeklyTrend, driftScore, topOverkillPolicies, topUndercallPolicies, topWrongTagPairs, topRcas, modMistakeCount };
    }).sort((a, b) => b.driftScore - a.driftScore);

    // Weekly site-level trend
    const weekMap = {};
    records.forEach(r => {
      if (!weekMap[r.week]) weekMap[r.week] = { total: 0, errors: 0 };
      weekMap[r.week].total++;
      if (r.type !== 'ALIGNED') weekMap[r.week].errors++;
    });
    const weeklyTrend = Object.entries(weekMap).sort((a, b) => a[0].localeCompare(b[0])).map(([wk, v]) => ({
      week: wk, total: v.total, errors: v.errors, rate: pct(v.errors, v.total),
    }));
    const trendRates = weeklyTrend.map(w => w.rate);
    const trendMean = mean(trendRates);
    const trendStd = stddev(trendRates);

    // Policy breakdown for overkill/undercall
    const overkillPolicies = {};
    overkill.forEach(r => r.modPolicies.forEach(p => { overkillPolicies[p] = (overkillPolicies[p] || 0) + 1; }));
    const undercallPolicies = {};
    undercall.forEach(r => r.marketPolicies.forEach(p => { undercallPolicies[p] = (undercallPolicies[p] || 0) + 1; }));

    // Confusion matrix
    const confusion = {};
    wrongTag.forEach(r => {
      r.modPolicies.forEach(mp => {
        r.marketPolicies.forEach(mkp => {
          const key = `${mp}|||${mkp}`;
          confusion[key] = (confusion[key] || 0) + 1;
        });
      });
    });
    const confusionEntries = Object.entries(confusion).map(([k, v]) => {
      const [mod, market] = k.split('|||');
      return { modTag: mod, marketTag: market, count: v };
    }).sort((a, b) => b.count - a.count);

    // RCA breakdown
    const rcaMap = {};
    records.forEach(r => {
      if (r.rca && r.type !== 'ALIGNED') {
        rcaMap[r.rca] = (rcaMap[r.rca] || 0) + 1;
      }
    });
    const rcaBreakdown = Object.entries(rcaMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

    // RCA per moderator
    const rcaByMod = {};
    records.forEach(r => {
      if (r.rca && r.type !== 'ALIGNED' && r.moderator) {
        if (!rcaByMod[r.moderator]) rcaByMod[r.moderator] = {};
        rcaByMod[r.moderator][r.rca] = (rcaByMod[r.moderator][r.rca] || 0) + 1;
      }
    });

    // Policy-level RCA
    const policyRca = {};
    records.forEach(r => {
      if (r.type !== 'ALIGNED' && r.rca) {
        const policies = [...r.modPolicies, ...r.marketPolicies];
        policies.forEach(p => {
          if (!policyRca[p]) policyRca[p] = {};
          policyRca[p][r.rca] = (policyRca[p][r.rca] || 0) + 1;
        });
      }
    });

    // Systemic issues: same task, 3+ different moderators same error
    const taskErrors = {};
    misaligned.forEach(r => {
      if (!r.taskId) return;
      if (!taskErrors[r.taskId]) taskErrors[r.taskId] = [];
      taskErrors[r.taskId].push(r);
    });
    const systemicIssues = Object.entries(taskErrors)
      .filter(([, rows]) => {
        const uniqueMods = new Set(rows.map(r => r.moderator));
        return uniqueMods.size >= 3;
      })
      .map(([taskId, rows]) => {
        const policies = new Set();
        rows.forEach(r => { r.modPolicies.forEach(p => policies.add(p)); r.marketPolicies.forEach(p => policies.add(p)); });
        return { taskId, count: rows.length, moderators: [...new Set(rows.map(r => r.moderator))], policies: [...policies], rows, errorTypes: rows.map(r => r.type) };
      })
      .sort((a, b) => b.count - a.count);

    // Also detect: same policy, many moderators confused
    const policySystemic = {};
    misaligned.forEach(r => {
      const policies = [...r.modPolicies, ...r.marketPolicies];
      policies.forEach(p => {
        if (!policySystemic[p]) policySystemic[p] = new Set();
        if (r.moderator) policySystemic[p].add(r.moderator);
      });
    });
    const policyIssues = Object.entries(policySystemic)
      .filter(([, mods]) => mods.size >= 3)
      .map(([policy, mods]) => ({ policy, moderatorCount: mods.size, moderators: [...mods] }))
      .sort((a, b) => b.moderatorCount - a.moderatorCount);

    // MOD MISTAKE deep dive
    const modMistakeRows = misaligned.filter(r => r.rca === 'MOD MISTAKE');
    const modMistakeOverkill = modMistakeRows.filter(r => r.type === 'OVERKILL');
    const modMistakeUndercall = modMistakeRows.filter(r => r.type === 'UNDERCALL');
    const modMistakeWrongTag = modMistakeRows.filter(r => r.type === 'WRONG_TAG');
    const modMistakeOverkillPolicies = {};
    modMistakeOverkill.forEach(r => r.modPolicies.forEach(p => { modMistakeOverkillPolicies[p] = (modMistakeOverkillPolicies[p] || 0) + 1; }));
    const modMistakeUndercallPolicies = {};
    modMistakeUndercall.forEach(r => r.marketPolicies.forEach(p => { modMistakeUndercallPolicies[p] = (modMistakeUndercallPolicies[p] || 0) + 1; }));
    const modMistakeByMod = {};
    modMistakeRows.forEach(r => {
      if (!modMistakeByMod[r.moderator]) modMistakeByMod[r.moderator] = { ok: 0, uc: 0, wt: 0, total: 0 };
      modMistakeByMod[r.moderator].total++;
      if (r.type === 'OVERKILL') modMistakeByMod[r.moderator].ok++;
      if (r.type === 'UNDERCALL') modMistakeByMod[r.moderator].uc++;
      if (r.type === 'WRONG_TAG') modMistakeByMod[r.moderator].wt++;
    });

    // Markets
    const markets = [...new Set(records.map(r => r.market).filter(Boolean))];
    const moderators = [...new Set(records.map(r => r.moderator).filter(Boolean))];

    return {
      total, aligned, misaligned: misaligned.length, overkill: overkill.length,
      undercall: undercall.length, wrongTag: wrongTag.length, unknown: unknown.length,
      accuracy, gapTo95, modStats, weeklyTrend, trendMean, trendStd,
      overkillPolicies, undercallPolicies, confusionEntries,
      rcaBreakdown, rcaByMod, policyRca, systemicIssues, policyIssues,
      modMistake: { total: modMistakeRows.length, overkill: modMistakeOverkill.length, undercall: modMistakeUndercall.length, wrongTag: modMistakeWrongTag.length, overkillPolicies: modMistakeOverkillPolicies, undercallPolicies: modMistakeUndercallPolicies, byMod: modMistakeByMod, rows: modMistakeRows },
      markets, moderators, records,
    };
  }, [records]);

  // ── Alert generation ─────────────────────────────────────────────────────────
  const alerts = useMemo(() => {
    if (!analytics) return [];
    const list = [];
    analytics.modStats.forEach(m => {
      if (m.errorRate > alertThreshold) {
        if (m.dominant === 'overkill') {
          list.push({ severity: m.errorRate > 10 ? 'CRITICAL' : 'WARNING', mod: m.name, market: m.market, type: 'OVERKILL_DRIFT', message: `Overkill drift detected for ${m.name} on ${m.topPolicies[0]?.[0] || 'policy'} — schedule 1:1 calibration`, errorRate: m.errorRate, policy: m.topPolicies[0]?.[0] });
        } else if (m.dominant === 'undercall') {
          list.push({ severity: m.errorRate > 10 ? 'CRITICAL' : 'WARNING', mod: m.name, market: m.market, type: 'UNDERCALL_PATTERN', message: `Undercall pattern for ${m.name} — add to next QA batch with focus on ${m.topPolicies[0]?.[0] || 'policy'}`, errorRate: m.errorRate, policy: m.topPolicies[0]?.[0] });
        } else {
          list.push({ severity: m.errorRate > 10 ? 'CRITICAL' : 'WARNING', mod: m.name, market: m.market, type: 'WRONG_TAG_PATTERN', message: `Wrong tag pattern for ${m.name} on ${m.topPolicies.slice(0, 2).map(p => p[0]).join(' vs ')} — recommend differentiation workshop`, errorRate: m.errorRate, policy: m.topPolicies[0]?.[0] });
        }
      }
      // Trend alerts
      if (m.weeklyTrend.length >= 3) {
        const last3 = m.weeklyTrend.slice(-3);
        if (last3.every((v, i) => i === 0 || v > last3[i - 1])) {
          list.push({ severity: 'WARNING', mod: m.name, market: m.market, type: 'WORSENING_TREND', message: `${m.name} shows worsening trend over last 3 weeks — proactive intervention recommended`, errorRate: m.errorRate });
        }
      }
    });
    return list.sort((a, b) => b.errorRate - a.errorRate);
  }, [analytics, alertThreshold]);

  // ── Filtered event log ───────────────────────────────────────────────────────
  const filteredRecords = useMemo(() => {
    let list = records;
    if (filterType !== 'ALL') list = list.filter(r => r.type === filterType);
    if (modFilter !== 'ALL') list = list.filter(r => r.moderator === modFilter);
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(r =>
        r.moderator.toLowerCase().includes(q) || r.taskId.toLowerCase().includes(q) ||
        r.market.toLowerCase().includes(q) || r.modPolicy.toLowerCase().includes(q) ||
        r.marketAnswer.toLowerCase().includes(q) || r.rca.toLowerCase().includes(q)
      );
    }
    return list;
  }, [records, filterType, modFilter, searchTerm]);

  // ── Styles ───────────────────────────────────────────────────────────────────
  const S = {
    app: { background: C.bg, color: C.text, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", minHeight: '100vh', padding: 0 },
    header: { background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)', padding: '20px 32px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 },
    title: { fontSize: 22, fontWeight: 800, letterSpacing: -0.5, display: 'flex', alignItems: 'center', gap: 10 },
    tabs: { display: 'flex', gap: 2, padding: '0 24px', background: C.card, borderBottom: `1px solid ${C.border}`, overflowX: 'auto', flexWrap: 'nowrap' },
    tab: (active) => ({ padding: '12px 18px', cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 500, color: active ? C.accent : C.textDim, borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent', transition: 'all .15s', whiteSpace: 'nowrap', background: 'none', border: 'none', outline: 'none' }),
    body: { padding: '24px 32px', maxWidth: 1600, margin: '0 auto' },
    row: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 },
    section: { background: C.card, borderRadius: 12, padding: 20, border: `1px solid ${C.border}`, marginBottom: 20 },
    sectionTitle: { fontSize: 15, fontWeight: 700, marginBottom: 14, color: C.text, display: 'flex', alignItems: 'center', gap: 8 },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { padding: '10px 12px', textAlign: 'left', borderBottom: `2px solid ${C.border}`, color: C.textDim, fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
    td: { padding: '8px 12px', borderBottom: `1px solid ${C.border}22`, verticalAlign: 'top' },
    upload: (active) => ({ border: `2px dashed ${active ? C.accent : C.border}`, borderRadius: 16, padding: '60px 40px', textAlign: 'center', cursor: 'pointer', transition: 'all .2s', background: active ? C.accent + '11' : C.card }),
    btn: (color = C.accent) => ({ background: color, color: C.white, border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13, transition: 'opacity .15s' }),
    select: { background: C.cardAlt, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 13, outline: 'none' },
    input: { background: C.cardAlt, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 12px', fontSize: 13, outline: 'none', flex: 1 },
  };

  // ── Upload screen ────────────────────────────────────────────────────────────
  if (records.length === 0) {
    return (
      <div style={S.app}>
        <div style={S.header}>
          <div style={S.title}>
            <span style={{ fontSize: 28 }}>MODERATOR DRIFT ANALYSIS</span>
          </div>
          <span style={{ color: C.textDim, fontSize: 13 }}>Trust & Safety QA Engine</span>
        </div>
        <div style={{ ...S.body, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '70vh' }}>
          <div
            style={S.upload(dragOver)}
            onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }}>+</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Drop Excel file here or click to upload</div>
            <div style={{ color: C.textDim, fontSize: 13, lineHeight: 1.6 }}>
              Expected columns: Batch, Market, Moderator, Task ID, Alignment,<br />
              Market top voted answer, Mod policy title, TCS Link, RCA
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!analytics) return null;

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 0: OVERVIEW
  // ──────────────────────────────────────────────────────────────────────────────
  const OverviewTab = () => {
    const errorPie = [
      { name: 'Overkill', value: analytics.overkill, color: C.overkill },
      { name: 'Undercall', value: analytics.undercall, color: C.undercall },
      { name: 'Wrong Tag', value: analytics.wrongTag, color: C.wrongTag },
    ].filter(d => d.value > 0);
    if (analytics.unknown > 0) errorPie.push({ name: 'Unknown', value: analytics.unknown, color: C.textDim });

    const topMods = analytics.modStats.slice(0, 10);

    return (
      <>
        {/* KPI Cards */}
        <div style={S.row}>
          <KPICard title="Total Cases" value={analytics.total.toLocaleString()} subtitle={`${analytics.aligned} aligned`} icon="*" />
          <KPICard title="Accuracy" value={analytics.accuracy.toFixed(1) + '%'} subtitle={`Target: 95%`} color={analytics.accuracy >= 95 ? C.stable : C.critical} icon="%" />
          <KPICard title="Gap to 95%" value={analytics.gapTo95.toFixed(1) + 'pp'} color={analytics.gapTo95 > 0 ? C.critical : C.stable} icon="^" />
          <KPICard title="Total Errors" value={analytics.misaligned} subtitle={`${pctStr(analytics.misaligned, analytics.total)} error rate`} color={C.critical} icon="!" />
        </div>
        <div style={S.row}>
          <KPICard title="Overkill" value={analytics.overkill} subtitle={pctStr(analytics.overkill, analytics.total)} color={C.overkill} icon="O" />
          <KPICard title="Undercall" value={analytics.undercall} subtitle={pctStr(analytics.undercall, analytics.total)} color={C.undercall} icon="U" />
          <KPICard title="Wrong Tag" value={analytics.wrongTag} subtitle={pctStr(analytics.wrongTag, analytics.total)} color={C.wrongTag} icon="W" />
          <KPICard title="Markets" value={analytics.markets.length} subtitle={analytics.markets.join(', ')} icon="M" />
        </div>

        {/* Error split pie + SPC trend */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ ...S.section, flex: '1 1 320px', minWidth: 320 }}>
            <div style={S.sectionTitle}>Error Type Distribution</div>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={errorPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={95} innerRadius={50} paddingAngle={3} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={{ stroke: C.textDim }} fontSize={11}>
                  {errorPie.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div style={{ ...S.section, flex: '2 1 500px', minWidth: 400 }}>
            <div style={S.sectionTitle}>Site-Level SPC — Weekly Misalignment Rate (%)</div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={analytics.weeklyTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="week" tick={{ fill: C.textDim, fontSize: 10 }} />
                <YAxis tick={{ fill: C.textDim, fontSize: 10 }} domain={[0, 'auto']} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
                <ReferenceLine y={analytics.trendMean} stroke={C.accent} strokeDasharray="6 3" label={{ value: 'Mean', fill: C.accent, fontSize: 10, position: 'right' }} />
                <ReferenceLine y={Math.max(0, analytics.trendMean - 2 * analytics.trendStd)} stroke={C.stable} strokeDasharray="4 4" label={{ value: '-2σ', fill: C.stable, fontSize: 10, position: 'right' }} />
                <ReferenceLine y={analytics.trendMean + 2 * analytics.trendStd} stroke={C.critical} strokeDasharray="4 4" label={{ value: '+2σ', fill: C.critical, fontSize: 10, position: 'right' }} />
                <ReferenceLine y={5} stroke={C.overkill} strokeDasharray="2 4" label={{ value: '95% Target', fill: C.overkill, fontSize: 10, position: 'left' }} />
                <Area type="monotone" dataKey="rate" fill={C.accent + '22'} stroke={C.accent} strokeWidth={2} dot={{ r: 3, fill: C.accent }} name="Misalignment %" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Moderator Risk Ranking */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Moderator Risk Ranking (by Drift Score)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['#', 'Moderator', 'Market', 'Cases', 'Errors', 'Error %', 'Overkill', 'Undercall', 'Wrong Tag', 'Drift Score', 'Severity', 'Trend'].map(h => <th key={h} style={S.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {topMods.map((m, i) => (
                  <tr key={m.name} style={{ background: i % 2 === 0 ? 'transparent' : C.border + '11' }}>
                    <td style={S.td}>{i + 1}</td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{m.name}</td>
                    <td style={S.td}>{m.market}</td>
                    <td style={S.td}>{m.total}</td>
                    <td style={S.td}>{m.errorCount}</td>
                    <td style={{ ...S.td, color: severityColor(m.errorRate), fontWeight: 700 }}>{m.errorRate.toFixed(1)}%</td>
                    <td style={{ ...S.td, color: C.overkill }}>{m.overkill}</td>
                    <td style={{ ...S.td, color: C.undercall }}>{m.undercall}</td>
                    <td style={{ ...S.td, color: C.wrongTag }}>{m.wrongTag}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{m.driftScore.toFixed(1)}</td>
                    <td style={S.td}>{severityBadge(m.errorRate)}</td>
                    <td style={S.td}><Sparkline data={m.weeklyTrend} color={severityColor(m.errorRate)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 1: SPC CHARTS
  // ──────────────────────────────────────────────────────────────────────────────
  const SPCTab = () => {
    const allWeeks = [...new Set(records.map(r => r.week))].sort();
    const modsToShow = analytics.modStats.filter(m => m.total >= 5).slice(0, 12);

    return (
      <>
        <div style={S.sectionTitle}>Per-Moderator Statistical Process Control Charts</div>
        <div style={{ color: C.textDim, fontSize: 12, marginBottom: 16 }}>
          Weekly misalignment count per moderator. Red dots indicate Western Electric rule violations.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 16 }}>
          {modsToShow.map(mod => {
            // Build weekly data
            const weeklyMap = {};
            records.filter(r => r.moderator === mod.name).forEach(r => {
              if (!weeklyMap[r.week]) weeklyMap[r.week] = { total: 0, errors: 0 };
              weeklyMap[r.week].total++;
              if (r.type !== 'ALIGNED') weeklyMap[r.week].errors++;
            });
            const data = allWeeks.map(w => ({
              week: w,
              errors: weeklyMap[w]?.errors || 0,
              total: weeklyMap[w]?.total || 0,
            })).filter(d => d.total > 0);

            const vals = data.map(d => d.errors);
            const m = mean(vals);
            const s = stddev(vals);
            const ucl = m + 2 * s;
            const lcl = Math.max(0, m - 2 * s);
            const flags = westernElectricViolations(vals, m, s);
            data.forEach((d, i) => { d.flag = flags[i]; });
            const hasViolation = flags.some(Boolean);
            const borderColor = hasViolation ? C.critical : mod.errorRate > 5 ? C.overkill : C.stable;

            return (
              <div key={mod.name} style={{ ...S.section, borderColor: borderColor + '66' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{mod.name} <span style={{ color: C.textDim, fontWeight: 400, fontSize: 12 }}>({mod.market})</span></div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {severityBadge(mod.errorRate)}
                    {hasViolation && <Badge label="WE VIOLATION" color={C.critical} />}
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <ComposedChart data={data}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="week" tick={{ fill: C.textDim, fontSize: 9 }} />
                    <YAxis tick={{ fill: C.textDim, fontSize: 9 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 11 }} />
                    <ReferenceLine y={m} stroke={C.accent} strokeDasharray="6 3" />
                    <ReferenceLine y={ucl} stroke={C.critical} strokeDasharray="4 4" />
                    <ReferenceLine y={lcl} stroke={C.stable} strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="errors" stroke={C.accent} strokeWidth={2} dot={({ cx, cy, payload }) => {
                      const fill = payload.flag ? C.critical : C.accent;
                      const r = payload.flag ? 5 : 3;
                      return <circle key={payload.week} cx={cx} cy={cy} r={r} fill={fill} stroke={fill} />;
                    }} name="Errors" />
                  </ComposedChart>
                </ResponsiveContainer>
                {data.filter(d => d.flag).length > 0 && (
                  <div style={{ fontSize: 10, color: C.critical, marginTop: 4 }}>
                    Violations: {data.filter(d => d.flag).map(d => `${d.week} (${d.flag})`).join(', ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 2: ERROR CLASSIFICATION
  // ──────────────────────────────────────────────────────────────────────────────
  const ErrorClassificationTab = () => {
    // Stacked bar per moderator
    const modBarData = analytics.modStats.filter(m => m.errorCount > 0).slice(0, 20).map(m => ({
      name: m.name, overkill: m.overkill, undercall: m.undercall, wrongTag: m.wrongTag,
    }));

    // Top overkill policies
    const overkillPol = Object.entries(analytics.overkillPolicies).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
    const undercallPol = Object.entries(analytics.undercallPolicies).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));

    // Overkill detail list
    const overkillCases = records.filter(r => r.type === 'OVERKILL').slice(0, 50);

    return (
      <>
        <div style={S.row}>
          <KPICard title="Overkill Cases" value={analytics.overkill} subtitle="Mod flagged, market approved" color={C.overkill} icon="O" />
          <KPICard title="Undercall Cases" value={analytics.undercall} subtitle="Mod approved, market flagged" color={C.undercall} icon="U" />
          <KPICard title="Wrong Tag Cases" value={analytics.wrongTag} subtitle="Both flagged, different policy" color={C.wrongTag} icon="W" />
        </div>

        {/* Stacked bar per moderator */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Error Breakdown by Moderator</div>
          <ResponsiveContainer width="100%" height={Math.max(300, modBarData.length * 28 + 60)}>
            <BarChart data={modBarData} layout="vertical" margin={{ left: 120 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis type="number" tick={{ fill: C.textDim, fontSize: 10 }} />
              <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 11 }} width={110} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
              <Legend />
              <Bar dataKey="overkill" stackId="a" fill={C.overkill} name="Overkill" />
              <Bar dataKey="undercall" stackId="a" fill={C.undercall} name="Undercall" />
              <Bar dataKey="wrongTag" stackId="a" fill={C.wrongTag} name="Wrong Tag" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Top policies overkilled vs undercalled */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ ...S.section, flex: '1 1 380px' }}>
            <div style={S.sectionTitle}>Most Commonly Overkilled Policies</div>
            <div style={{ color: C.textDim, fontSize: 11, marginBottom: 10 }}>Policies where moderators flagged content that the market approved</div>
            <ResponsiveContainer width="100%" height={Math.max(200, overkillPol.length * 30 + 40)}>
              <BarChart data={overkillPol} layout="vertical" margin={{ left: 140 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis type="number" tick={{ fill: C.textDim, fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 10 }} width={130} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
                <Bar dataKey="count" fill={C.overkill} name="Overkill Count" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ ...S.section, flex: '1 1 380px' }}>
            <div style={S.sectionTitle}>Most Commonly Undercalled Policies</div>
            <div style={{ color: C.textDim, fontSize: 11, marginBottom: 10 }}>Policies that moderators missed (market flagged, mod approved)</div>
            <ResponsiveContainer width="100%" height={Math.max(200, undercallPol.length * 30 + 40)}>
              <BarChart data={undercallPol} layout="vertical" margin={{ left: 140 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis type="number" tick={{ fill: C.textDim, fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 10 }} width={130} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
                <Bar dataKey="count" fill={C.undercall} name="Undercall Count" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Confusion Matrix */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Policy Confusion Matrix — Mod Tag vs Market Answer (Wrong Tag cases)</div>
          {analytics.confusionEntries.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Mod Tagged</th>
                    <th style={S.th}>Market Said</th>
                    <th style={S.th}>Count</th>
                    <th style={S.th}>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.confusionEntries.slice(0, 20).map((e, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : C.border + '11' }}>
                      <td style={{ ...S.td, color: C.wrongTag, fontWeight: 600 }}>{e.modTag}</td>
                      <td style={{ ...S.td, color: C.stable }}>{e.marketTag}</td>
                      <td style={{ ...S.td, fontWeight: 700 }}>{e.count}</td>
                      <td style={S.td}><span style={{ color: C.overkill, fontSize: 11 }}>Mod confuses {e.modTag} with {e.marketTag}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: C.textDim, fontSize: 13 }}>No wrong-tag confusion data available.</div>}
        </div>

        {/* Overkill highlight */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Overkill Drift Signals — Market Approved, Mod Added Dimension</div>
          <div style={{ color: C.textDim, fontSize: 11, marginBottom: 10 }}>
            These cases show market answer = [] (approved) but the moderator tagged a policy. This is a key drift indicator.
          </div>
          {overkillCases.length > 0 ? (
            <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Moderator</th>
                    <th style={S.th}>Task ID</th>
                    <th style={S.th}>Mod Policy (Overkill)</th>
                    <th style={S.th}>Market Answer</th>
                    <th style={S.th}>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {overkillCases.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : C.border + '11' }}>
                      <td style={{ ...S.td, fontWeight: 600 }}>{r.moderator}</td>
                      <td style={S.td}>{r.taskId}</td>
                      <td style={{ ...S.td, color: C.overkill }}>{r.modPolicies.join(', ') || r.modPolicy}</td>
                      <td style={{ ...S.td, color: C.stable }}>[] (Approved)</td>
                      <td style={{ ...S.td, color: C.overkill, fontSize: 11 }}>Moderator Overkill — market approved, mod added dimension {r.modPolicies[0] || 'unknown'} = drift signal</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: C.textDim, fontSize: 13 }}>No overkill cases found.</div>}
        </div>
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 3: COACHING
  // ──────────────────────────────────────────────────────────────────────────────
  const CoachingTab = () => {
    const sortedMods = analytics.modStats.filter(m => m.errorCount > 0);

    return (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Coaching Priority Queue</div>
            <div style={{ color: C.textDim, fontSize: 12, marginTop: 2 }}>Sorted by who needs coaching most urgently (drift score)</div>
          </div>
          <button style={S.btn(C.accent)} onClick={() => exportCoachingReport(sortedMods)}>Export Coaching Report</button>
        </div>

        {sortedMods.map((mod, idx) => {
          const totalErrors = mod.errorCount;
          const overkillPct = pct(mod.overkill, totalErrors);
          const undercallPct = pct(mod.undercall, totalErrors);
          const wrongTagPct = pct(mod.wrongTag, totalErrors);
          const borderColor = mod.errorRate > 10 ? C.critical : mod.errorRate > 5 ? C.overkill : C.stable;
          const patternLabel = mod.dominant === 'overkill' ? 'Overkill-Heavy' : mod.dominant === 'undercall' ? 'Undercall-Heavy' : 'Wrong-Tag-Heavy';
          const patternColor = mod.dominant === 'overkill' ? C.overkill : mod.dominant === 'undercall' ? C.undercall : C.wrongTag;

          // Mini bar data for this mod
          const miniBar = [{ name: mod.name, overkill: mod.overkill, undercall: mod.undercall, wrongTag: mod.wrongTag }];

          return (
            <div key={mod.name} style={{ ...S.section, borderLeft: `4px solid ${borderColor}`, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <span style={{ fontSize: 16, fontWeight: 700 }}>#{idx + 1} {mod.name}</span>
                    <span style={{ color: C.textDim, fontSize: 12 }}>({mod.market})</span>
                    {severityBadge(mod.errorRate)}
                    <Badge label={patternLabel} color={patternColor} />
                  </div>
                  <div style={{ color: C.textDim, fontSize: 12 }}>
                    {mod.total} cases | {totalErrors} errors ({mod.errorRate.toFixed(1)}%) | Drift Score: {mod.driftScore.toFixed(1)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: C.textDim, marginBottom: 2 }}>Weekly Trend</div>
                  <Sparkline data={mod.weeklyTrend} color={severityColor(mod.errorRate)} width={120} height={32} />
                  <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>
                    {mod.weeklyTrend.length >= 2 ? (
                      mod.weeklyTrend[mod.weeklyTrend.length - 1] > mod.weeklyTrend[mod.weeklyTrend.length - 2]
                        ? <span style={{ color: C.critical }}>Worsening</span>
                        : mod.weeklyTrend[mod.weeklyTrend.length - 1] < mod.weeklyTrend[mod.weeklyTrend.length - 2]
                          ? <span style={{ color: C.stable }}>Improving</span>
                          : <span>Flat</span>
                    ) : '—'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
                {/* Error split */}
                <div style={{ flex: '1 1 200px', minWidth: 200 }}>
                  <div style={{ fontSize: 11, color: C.textDim, fontWeight: 600, marginBottom: 6 }}>ERROR SPLIT</div>
                  <div style={{ display: 'flex', gap: 4, height: 18, borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
                    {mod.overkill > 0 && <div style={{ flex: mod.overkill, background: C.overkill }} title={`Overkill: ${mod.overkill}`} />}
                    {mod.undercall > 0 && <div style={{ flex: mod.undercall, background: C.undercall }} title={`Undercall: ${mod.undercall}`} />}
                    {mod.wrongTag > 0 && <div style={{ flex: mod.wrongTag, background: C.wrongTag }} title={`Wrong Tag: ${mod.wrongTag}`} />}
                  </div>
                  <div style={{ fontSize: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span><span style={{ color: C.overkill }}>Overkill:</span> {mod.overkill} ({overkillPct.toFixed(0)}%)</span>
                    <span><span style={{ color: C.undercall }}>Undercall:</span> {mod.undercall} ({undercallPct.toFixed(0)}%)</span>
                    <span><span style={{ color: C.wrongTag }}>Wrong Tag:</span> {mod.wrongTag} ({wrongTagPct.toFixed(0)}%)</span>
                  </div>
                </div>

                {/* Overkill policies */}
                <div style={{ flex: '1 1 200px', minWidth: 200 }}>
                  <div style={{ fontSize: 11, color: C.overkill, fontWeight: 600, marginBottom: 6 }}>▲ OVERKILL POLICIES — be less strict</div>
                  {mod.topOverkillPolicies.slice(0, 4).map(([pol, cnt], j) => (
                    <div key={pol} style={{ fontSize: 11, marginBottom: 2, display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: C.text }}>{j + 1}. {pol}</span>
                      <span style={{ color: C.overkill, fontWeight: 600 }}>{cnt}</span>
                    </div>
                  ))}
                  {mod.topOverkillPolicies.length === 0 && <div style={{ fontSize: 11, color: C.textDim }}>No overkill</div>}
                </div>

                {/* Leakage policies */}
                <div style={{ flex: '1 1 200px', minWidth: 200 }}>
                  <div style={{ fontSize: 11, color: C.undercall, fontWeight: 600, marginBottom: 6 }}>▼ LEAKAGE POLICIES — enforce more</div>
                  {mod.topUndercallPolicies.slice(0, 4).map(([pol, cnt], j) => (
                    <div key={pol} style={{ fontSize: 11, marginBottom: 2, display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: C.text }}>{j + 1}. {pol}</span>
                      <span style={{ color: C.undercall, fontWeight: 600 }}>{cnt}</span>
                    </div>
                  ))}
                  {mod.topUndercallPolicies.length === 0 && <div style={{ fontSize: 11, color: C.textDim }}>No leakage</div>}
                </div>

                {/* Recommendation */}
                <div style={{ flex: '2 1 300px', minWidth: 280 }}>
                  <div style={{ fontSize: 11, color: C.textDim, fontWeight: 600, marginBottom: 6 }}>COACHING RECOMMENDATION</div>
                  <div style={{ background: C.bg, borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.6, border: `1px solid ${borderColor}44` }}>
                    {mod.recommendation}
                    {mod.topOverkillPolicies.length > 0 && (
                      <div style={{ marginTop: 6, color: C.overkill, fontSize: 11 }}>
                        ▲ Stop over-enforcing: {mod.topOverkillPolicies.slice(0, 2).map(([p]) => p).join(', ')}
                      </div>
                    )}
                    {mod.topUndercallPolicies.length > 0 && (
                      <div style={{ marginTop: 4, color: C.undercall, fontSize: 11 }}>
                        ▼ Catch more on: {mod.topUndercallPolicies.slice(0, 2).map(([p]) => p).join(', ')}
                      </div>
                    )}
                  </div>
                  {mod.errorRate > 10 && (
                    <div style={{ marginTop: 8, fontSize: 11, color: C.critical, fontWeight: 600 }}>
                      ⚠ ACTION REQUIRED: Immediate 1:1 calibration session recommended
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {sortedMods.length === 0 && (
          <div style={{ ...S.section, textAlign: 'center', padding: 40 }}>
            <div style={{ color: C.stable, fontSize: 16, fontWeight: 600 }}>All moderators are within acceptable error thresholds</div>
          </div>
        )}
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 3: MOD MISTAKES FOCUS
  // ──────────────────────────────────────────────────────────────────────────────
  const ModMistakesTab = () => {
    const mm = analytics.modMistake;
    const okPol = Object.entries(mm.overkillPolicies).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
    const ucPol = Object.entries(mm.undercallPolicies).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
    const byModData = Object.entries(mm.byMod).map(([name, d]) => ({ name, ...d })).sort((a, b) => b.total - a.total);
    const modMistakeRate = analytics.misaligned > 0 ? pct(mm.total, analytics.misaligned) : 0;

    return (
      <>
        <div style={{ ...S.section, borderLeft: `4px solid ${C.critical}`, marginBottom: 20 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>🔍 MOD MISTAKE Deep Dive</div>
          <div style={{ color: C.textDim, fontSize: 13 }}>
            MOD MISTAKE accounts for <b style={{ color: C.critical }}>{mm.total}</b> of {analytics.misaligned} misalignments (<b style={{ color: C.critical }}>{modMistakeRate.toFixed(1)}%</b>).
            These are pure moderator errors — not policy ambiguity or systemic issues. This is the #1 coaching target.
          </div>
        </div>

        <div style={S.row}>
          <KPICard title="Total MOD MISTAKES" value={mm.total} subtitle={`${modMistakeRate.toFixed(1)}% of all errors`} color={C.critical} icon="🔴" />
          <KPICard title="Overkill in MM" value={mm.overkill} subtitle={`${pctStr(mm.overkill, mm.total)} — mod flagged approved content`} color={C.overkill} icon="▲" />
          <KPICard title="Leakage in MM" value={mm.undercall} subtitle={`${pctStr(mm.undercall, mm.total)} — mod missed violations`} color={C.undercall} icon="▼" />
          <KPICard title="Wrong Tag in MM" value={mm.wrongTag} subtitle={`${pctStr(mm.wrongTag, mm.total)} — tagged wrong policy`} color={C.wrongTag} icon="↔" />
        </div>

        {/* Per-moderator MOD MISTAKE breakdown */}
        <div style={S.section}>
          <div style={S.sectionTitle}>MOD MISTAKE Split by Moderator</div>
          <div style={{ color: C.textDim, fontSize: 11, marginBottom: 14 }}>Stacked: orange = overkill (flagged approved content), red = leakage (missed violation), purple = wrong tag</div>
          <ResponsiveContainer width="100%" height={Math.max(280, byModData.length * 32 + 60)}>
            <BarChart data={byModData} layout="vertical" margin={{ left: 120 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis type="number" tick={{ fill: C.textDim, fontSize: 10 }} />
              <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 11 }} width={110} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
              <Legend />
              <Bar dataKey="ok" stackId="a" fill={C.overkill} name="Overkill" />
              <Bar dataKey="uc" stackId="a" fill={C.undercall} name="Leakage" />
              <Bar dataKey="wt" stackId="a" fill={C.wrongTag} name="Wrong Tag" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Overkill vs Leakage policies within MOD MISTAKE */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ ...S.section, flex: '1 1 380px' }}>
            <div style={S.sectionTitle}>▲ Overkill: Policies Mods Incorrectly Tag ({mm.overkill} cases)</div>
            <div style={{ color: C.textDim, fontSize: 11, marginBottom: 10 }}>
              Market approved content (no violation) but mod tagged these policies. Train mods to be less strict here.
            </div>
            {okPol.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(200, okPol.length * 30 + 40)}>
                <BarChart data={okPol} layout="vertical" margin={{ left: 160 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis type="number" tick={{ fill: C.textDim, fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 10 }} width={150} />
                  <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
                  <Bar dataKey="count" fill={C.overkill} name="Overkill Count" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <div style={{ color: C.textDim }}>No overkill data</div>}
          </div>

          <div style={{ ...S.section, flex: '1 1 380px' }}>
            <div style={S.sectionTitle}>▼ Leakage: Policies Mods Miss ({mm.undercall} cases)</div>
            <div style={{ color: C.textDim, fontSize: 11, marginBottom: 10 }}>
              Market flagged a violation but mod approved. These are safety gaps — train mods to catch these.
            </div>
            {ucPol.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(200, ucPol.length * 30 + 40)}>
                <BarChart data={ucPol} layout="vertical" margin={{ left: 160 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis type="number" tick={{ fill: C.textDim, fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 10 }} width={150} />
                  <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
                  <Bar dataKey="count" fill={C.undercall} name="Leakage Count" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <div style={{ color: C.textDim }}>No leakage data</div>}
          </div>
        </div>

        {/* Actionable coaching summary */}
        <div style={{ ...S.section, background: '#0f2818', borderLeft: `4px solid ${C.stable}` }}>
          <div style={S.sectionTitle}>📋 Coaching Priority from MOD MISTAKES</div>
          <div style={{ fontSize: 12, lineHeight: 2, color: C.textDim }}>
            <div>1. <b style={{ color: C.text }}>Biggest overkill problem:</b> <b style={{ color: C.overkill }}>{okPol[0]?.name || 'N/A'}</b> — {okPol[0]?.count || 0} cases of mods flagging approved content. Run calibration showing approved vs violating examples.</div>
            <div>2. <b style={{ color: C.text }}>Biggest leakage gap:</b> <b style={{ color: C.undercall }}>{ucPol[0]?.name || 'N/A'}</b> — {ucPol[0]?.count || 0} missed violations. This is a safety risk. Add to mandatory policy refresher.</div>
            <div>3. <b style={{ color: C.text }}>Most mistake-prone mod:</b> <b style={{ color: C.critical }}>{byModData[0]?.name || 'N/A'}</b> with {byModData[0]?.total || 0} MOD MISTAKES — schedule immediate 1:1 calibration.</div>
            <div>4. <b style={{ color: C.text }}>Team pattern:</b> {mm.undercall > mm.overkill ? `Team leans toward leakage (${pctStr(mm.undercall, mm.total)}) — increase enforcement strictness across the board.` : `Team leans toward overkill (${pctStr(mm.overkill, mm.total)}) — calibrate on distinguishing borderline content.`}</div>
          </div>
        </div>

        {/* Recent MOD MISTAKE cases */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Recent MOD MISTAKE Cases (last 50)</div>
          <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
            <table style={S.table}>
              <thead><tr>
                {['Moderator', 'Type', 'Mod Tagged', 'Market Said', 'Batch', 'Task ID'].map(h => <th key={h} style={S.th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {mm.rows.slice(0, 50).map((r, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : C.border + '11' }}>
                    <td style={{ ...S.td, fontWeight: 600 }}>{r.moderator}</td>
                    <td style={S.td}><Badge label={r.type === 'OVERKILL' ? '▲ OVERKILL' : r.type === 'UNDERCALL' ? '▼ LEAKAGE' : '↔ WRONG TAG'} color={r.type === 'OVERKILL' ? C.overkill : r.type === 'UNDERCALL' ? C.undercall : C.wrongTag} /></td>
                    <td style={{ ...S.td, color: C.overkill }}>{r.modPolicies.join(', ') || r.modPolicy || '[] (approved)'}</td>
                    <td style={{ ...S.td, color: C.stable }}>{r.marketPolicies.join(', ') || r.marketAnswer || '[] (approved)'}</td>
                    <td style={{ ...S.td, color: C.textDim, fontSize: 11 }}>{r.batch}</td>
                    <td style={{ ...S.td, fontSize: 10, color: C.textDim }}>{r.taskId?.slice(0, 15)}...</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 5: AI COACH — Prompt Generator
  // ──────────────────────────────────────────────────────────────────────────────
  const AICoachTab = () => {
    const [selectedAIMod, setSelectedAIMod] = useState(null);
    const [copiedMod, setCopiedMod] = useState(null);

    const generatePrompt = (mod) => {
      const okPolicies = mod.topOverkillPolicies.slice(0, 5).map(([p, c]) => `  - ${p}: ${c} cases`).join('\n');
      const ucPolicies = mod.topUndercallPolicies.slice(0, 5).map(([p, c]) => `  - ${p}: ${c} cases`).join('\n');
      const wtPairs = mod.topWrongTagPairs.slice(0, 5).map(([p, c]) => `  - ${p}: ${c} cases`).join('\n');
      const rcas = mod.topRcas.slice(0, 5).map(([r, c]) => `  - ${r}: ${c} cases`).join('\n');
      const topPolicies = mod.topPolicies.slice(0, 5).map(([p, c]) => `  - ${p}: ${c} errors`).join('\n');
      const weekTrend = mod.weeklyTrend.length > 0 ? `Weekly error counts (oldest→newest): [${mod.weeklyTrend.join(', ')}]` : 'No weekly trend data';
      const trendDir = mod.weeklyTrend.length >= 2
        ? (mod.weeklyTrend[mod.weeklyTrend.length-1] > mod.weeklyTrend[mod.weeklyTrend.length-2] ? 'WORSENING' : mod.weeklyTrend[mod.weeklyTrend.length-1] < mod.weeklyTrend[mod.weeklyTrend.length-2] ? 'IMPROVING' : 'STABLE')
        : 'INSUFFICIENT DATA';

      return `You are a Trust & Safety QA coaching expert. Analyze the following moderator's performance data and provide a detailed, personalized coaching plan.

=== MODERATOR PROFILE ===
Name: ${mod.name}
Market: ${mod.market}
Total cases reviewed: ${mod.total}
Total errors: ${mod.errorCount} (Error rate: ${mod.errorRate.toFixed(1)}%)
Severity: ${mod.errorRate > 10 ? 'CRITICAL' : mod.errorRate > 5 ? 'WARNING' : 'STABLE'}
Drift Score: ${mod.driftScore.toFixed(1)}
Trend: ${trendDir}
${weekTrend}

=== ERROR BREAKDOWN ===
Overkill (flagged content that market approved): ${mod.overkill} cases (${pctStr(mod.overkill, mod.errorCount)})
Leakage/Undercall (missed violations market flagged): ${mod.undercall} cases (${pctStr(mod.undercall, mod.errorCount)})
Wrong Tag (both flagged but different policy): ${mod.wrongTag} cases (${pctStr(mod.wrongTag, mod.errorCount)})
Dominant pattern: ${mod.dominant === 'overkill' ? 'OVERKILL — too strict' : mod.dominant === 'undercall' ? 'UNDERCALL — too lenient' : 'WRONG TAG — policy confusion'}

=== OVERKILL DETAIL (policies mod incorrectly flagged) ===
${okPolicies || '  None'}
→ Context: "Overkill" means market says the content is approved/no violation, but the moderator tagged a policy. The moderator is being too strict on these policies.

=== LEAKAGE DETAIL (policies mod failed to catch) ===
${ucPolicies || '  None'}
→ Context: "Leakage" means market identified a violation, but the moderator approved the content. These are missed safety violations.

=== WRONG TAG DETAIL (mod tagged wrong policy) ===
${wtPairs || '  None'}
→ Format: "Mod tagged X → Market said Y"

=== ROOT CAUSE ANALYSIS (from QA review) ===
${rcas || '  None'}

=== TOP PROBLEM POLICIES (combined) ===
${topPolicies || '  None'}

=== INSTRUCTIONS ===
Based on this data, provide:
1. **Summary Assessment** — What is this moderator's main weakness in 2-3 sentences?
2. **Overkill Coaching Plan** — For each overkilled policy, explain what content the moderator is likely misinterpreting and give concrete examples of what should be approved vs flagged.
3. **Leakage Coaching Plan** — For each missed policy, explain what signals the moderator should look for. This is a safety priority.
4. **Wrong Tag Remediation** — Explain the distinction between confused policy pairs.
5. **Weekly Coaching Actions** — A specific 4-week plan with measurable goals (e.g., "Week 1: Shadow session on Frauds & Scams borderline cases. Goal: reduce overkill by 50%").
6. **Quick Reference Card** — A one-page summary the moderator can keep at their desk with key rules for their top 3 problem policies.

Be specific to THIS moderator's data. Do not give generic advice.`;
    };

    const copyPrompt = (mod) => {
      const prompt = generatePrompt(mod);
      navigator.clipboard.writeText(prompt).then(() => {
        setCopiedMod(mod.name);
        setTimeout(() => setCopiedMod(null), 2000);
      });
    };

    return (
      <>
        <div style={{ ...S.section, borderLeft: `4px solid ${C.accent}`, marginBottom: 20 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>🤖 AI Coaching Prompt Generator</div>
          <div style={{ color: C.textDim, fontSize: 13, lineHeight: 1.6 }}>
            Generate a detailed, data-rich prompt for each moderator. Copy and paste it into Claude or ChatGPT to get a personalized coaching plan based on their exact error patterns, overkill/leakage policies, and RCA data.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          {analytics.modStats.filter(m => m.errorCount > 0).map(mod => {
            const borderColor = mod.errorRate > 10 ? C.critical : mod.errorRate > 5 ? C.overkill : C.stable;
            const isSelected = selectedAIMod === mod.name;
            return (
              <div key={mod.name} style={{ flex: '1 1 280px', minWidth: 260 }}>
                <div style={{
                  ...S.section, cursor: 'pointer', marginBottom: 0,
                  borderLeft: `4px solid ${borderColor}`,
                  background: isSelected ? C.accent + '11' : C.card,
                  border: isSelected ? `1px solid ${C.accent}44` : `1px solid ${C.border}`,
                }} onClick={() => setSelectedAIMod(isSelected ? null : mod.name)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{mod.name}</span>
                    {severityBadge(mod.errorRate)}
                  </div>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 8 }}>
                    {mod.errorCount} errors ({mod.errorRate.toFixed(1)}%) | <span style={{ color: C.overkill }}>OK:{mod.overkill}</span> <span style={{ color: C.undercall }}>UC:{mod.undercall}</span> <span style={{ color: C.wrongTag }}>WT:{mod.wrongTag}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={{ ...S.btn(C.accent), fontSize: 11, padding: '6px 12px', flex: 1 }} onClick={(e) => { e.stopPropagation(); copyPrompt(mod); }}>
                      {copiedMod === mod.name ? '✓ Copied!' : '📋 Copy AI Prompt'}
                    </button>
                    <button style={{ ...S.btn(C.cardAlt), fontSize: 11, padding: '6px 12px' }} onClick={(e) => { e.stopPropagation(); setSelectedAIMod(isSelected ? null : mod.name); }}>
                      {isSelected ? '▲ Hide' : '▼ Preview'}
                    </button>
                  </div>
                </div>

                {isSelected && (
                  <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderTop: 'none', borderRadius: '0 0 12px 12px', padding: 16, maxHeight: 400, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>Prompt Preview</span>
                      <span style={{ fontSize: 10, color: C.textDim }}>{generatePrompt(mod).length.toLocaleString()} chars</span>
                    </div>
                    <pre style={{ fontSize: 11, color: C.textDim, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', background: C.card, padding: 12, borderRadius: 8, border: `1px solid ${C.border}`, maxHeight: 300, overflowY: 'auto' }}>
                      {generatePrompt(mod)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Bulk export */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Bulk Export All Prompts</div>
          <div style={{ color: C.textDim, fontSize: 12, marginBottom: 12 }}>Download all moderator coaching prompts as a single text file.</div>
          <button style={S.btn(C.accent)} onClick={() => {
            const allPrompts = analytics.modStats.filter(m => m.errorCount > 0).map((mod, i) => {
              return `${'═'.repeat(60)}\nMODERATOR ${i + 1}: ${mod.name}\n${'═'.repeat(60)}\n\n${generatePrompt(mod)}`;
            }).join('\n\n\n');
            const blob = new Blob([allPrompts], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'ai_coaching_prompts_all_moderators.txt';
            a.click();
          }}>
            📥 Download All AI Prompts ({analytics.modStats.filter(m => m.errorCount > 0).length} moderators)
          </button>
        </div>
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 4: RCA ANALYSIS
  // ──────────────────────────────────────────────────────────────────────────────
  const RCATab = () => {
    const rcaData = analytics.rcaBreakdown;
    const rcaPie = rcaData.slice(0, 8).map((d, i) => ({ ...d, color: [C.undercall, C.overkill, C.wrongTag, C.accent, C.stable, '#ec4899', '#06b6d4', '#a78bfa'][i % 8] }));

    // RCA by moderator heatmap data
    const allRcas = [...new Set(rcaData.map(r => r.name))].slice(0, 8);
    const modNames = analytics.modStats.filter(m => m.errorCount > 0).slice(0, 15).map(m => m.name);
    const heatmapData = [];
    modNames.forEach(modName => {
      const modRcas = analytics.rcaByMod[modName] || {};
      allRcas.forEach(rca => {
        if (modRcas[rca]) heatmapData.push({ mod: modName, rca, count: modRcas[rca] });
      });
    });

    // Policy-level RCA
    const policyRcaEntries = Object.entries(analytics.policyRca).slice(0, 10);

    return (
      <>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          {/* RCA bar chart */}
          <div style={{ ...S.section, flex: '1 1 400px', minWidth: 380 }}>
            <div style={S.sectionTitle}>Root Cause Analysis Breakdown</div>
            <ResponsiveContainer width="100%" height={Math.max(250, rcaData.length * 28 + 40)}>
              <BarChart data={rcaData.slice(0, 12)} layout="vertical" margin={{ left: 150 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis type="number" tick={{ fill: C.textDim, fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 10 }} width={140} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
                <Bar dataKey="count" fill={C.accent} name="Count" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* RCA pie chart */}
          <div style={{ ...S.section, flex: '1 1 320px', minWidth: 320 }}>
            <div style={S.sectionTitle}>RCA Distribution</div>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={rcaPie} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={100} innerRadius={45} paddingAngle={2} label={({ name, percent }) => `${name.slice(0, 20)}${name.length > 20 ? '..' : ''} ${(percent * 100).toFixed(0)}%`} labelLine={{ stroke: C.textDim }} fontSize={10}>
                  {rcaPie.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* RCA by moderator heatmap (table style) */}
        <div style={S.section}>
          <div style={S.sectionTitle}>RCA by Moderator Heatmap</div>
          {modNames.length > 0 && allRcas.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Moderator</th>
                    {allRcas.map(rca => <th key={rca} style={{ ...S.th, fontSize: 9, maxWidth: 100, whiteSpace: 'normal' }}>{rca}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {modNames.map((modName, mi) => {
                    const modRcas = analytics.rcaByMod[modName] || {};
                    const maxCount = Math.max(...allRcas.map(rca => modRcas[rca] || 0), 1);
                    return (
                      <tr key={modName} style={{ background: mi % 2 === 0 ? 'transparent' : C.border + '11' }}>
                        <td style={{ ...S.td, fontWeight: 600, whiteSpace: 'nowrap' }}>{modName}</td>
                        {allRcas.map(rca => {
                          const val = modRcas[rca] || 0;
                          const intensity = val / maxCount;
                          const bg = val > 0 ? `rgba(239, 68, 68, ${0.15 + intensity * 0.55})` : 'transparent';
                          return <td key={rca} style={{ ...S.td, textAlign: 'center', background: bg, fontWeight: val > 0 ? 700 : 400, color: val > 0 ? C.text : C.textDim }}>{val || '-'}</td>;
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: C.textDim, fontSize: 13 }}>Insufficient RCA data to generate heatmap.</div>}
        </div>

        {/* Policy-level RCA patterns */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Policy-Level RCA Patterns</div>
          <div style={{ color: C.textDim, fontSize: 11, marginBottom: 12 }}>Which policies cause which types of errors</div>
          {policyRcaEntries.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
              {policyRcaEntries.map(([policy, rcaCounts]) => {
                const rcaItems = Object.entries(rcaCounts).sort((a, b) => b[1] - a[1]);
                const total = rcaItems.reduce((s, [, v]) => s + v, 0);
                return (
                  <div key={policy} style={{ background: C.bg, borderRadius: 8, padding: 12, border: `1px solid ${C.border}` }}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, color: C.accent }}>{policy}</div>
                    {rcaItems.slice(0, 4).map(([rca, cnt]) => (
                      <div key={rca} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                        <span style={{ fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rca}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 60, height: 6, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${pct(cnt, total)}%`, height: '100%', background: C.accent, borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 10, color: C.textDim, minWidth: 20, textAlign: 'right' }}>{cnt}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : <div style={{ color: C.textDim, fontSize: 13 }}>No policy-level RCA data available.</div>}
        </div>
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 5: SYSTEMIC ISSUES
  // ──────────────────────────────────────────────────────────────────────────────
  const SystemicTab = () => {
    const { systemicIssues, policyIssues } = analytics;

    return (
      <>
        <div style={S.row}>
          <KPICard title="Systemic Task Issues" value={systemicIssues.length} subtitle="Tasks where 3+ mods made same error" color={C.critical} icon="!" />
          <KPICard title="Systemic Policy Issues" value={policyIssues.length} subtitle="Policies confusing 3+ moderators" color={C.overkill} icon="P" />
        </div>

        {/* Systemic task issues */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Systemic Issues — Multiple Moderators, Same Error</div>
          <div style={{ color: C.textDim, fontSize: 11, marginBottom: 12 }}>
            These cases indicate policy gaps, not individual moderator drift. When 3+ moderators make the same error on the same task, the issue is likely systemic.
          </div>
          {systemicIssues.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Task ID</th>
                    <th style={S.th}>Moderators</th>
                    <th style={S.th}>Error Count</th>
                    <th style={S.th}>Policies Involved</th>
                    <th style={S.th}>Error Types</th>
                    <th style={S.th}>Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {systemicIssues.slice(0, 20).map((issue, i) => (
                    <tr key={issue.taskId} style={{ background: i % 2 === 0 ? 'transparent' : C.border + '11' }}>
                      <td style={{ ...S.td, fontWeight: 600 }}>{issue.taskId}</td>
                      <td style={S.td}>{issue.moderators.join(', ')}</td>
                      <td style={{ ...S.td, fontWeight: 700, color: C.critical }}>{issue.count}</td>
                      <td style={{ ...S.td, color: C.accent }}>{issue.policies.join(', ')}</td>
                      <td style={S.td}>
                        {[...new Set(issue.errorTypes)].map(t => (
                          <Badge key={t} label={t.replace('_', ' ')} color={t === 'OVERKILL' ? C.overkill : t === 'UNDERCALL' ? C.undercall : C.wrongTag} />
                        ))}
                      </td>
                      <td style={{ ...S.td, fontSize: 11, color: C.overkill }}>
                        Recommend policy clarification on {issue.policies[0] || 'this area'} — {issue.moderators.length} moderators confused
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 30, color: C.textDim }}>
              No systemic task issues detected (no tasks with 3+ different moderators making the same error).
            </div>
          )}
        </div>

        {/* Systemic policy issues */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Team Level Policy Issues</div>
          <div style={{ color: C.textDim, fontSize: 11, marginBottom: 12 }}>
            Policies where 3+ moderators have made errors — this signals a team-level calibration gap, not individual mistakes
          </div>
          {policyIssues.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: 12 }}>
              {policyIssues.map((pi, i) => {
                // Compute overkill vs leakage for this policy across all mods
                const policyRows = records.filter(r => r.type !== 'ALIGNED' && ([...r.modPolicies, ...r.marketPolicies].includes(pi.policy)));
                const okCount = policyRows.filter(r => r.type === 'OVERKILL').length;
                const ucCount = policyRows.filter(r => r.type === 'UNDERCALL').length;
                const wtCount = policyRows.filter(r => r.type === 'WRONG_TAG').length;
                const totalP = okCount + ucCount + wtCount;
                const dominantType = okCount >= ucCount && okCount >= wtCount ? 'overkill' : ucCount >= okCount && ucCount >= wtCount ? 'leakage' : 'wrong_tag';
                const description = dominantType === 'overkill'
                  ? `Team is over-enforcing this policy — ${okCount} cases where content was approved by market but moderators flagged it. The threshold for what constitutes a violation is being set too low by the team.`
                  : dominantType === 'leakage'
                  ? `Team is missing violations on this policy — ${ucCount} cases where market flagged content but moderators approved it. This is a safety gap across the team.`
                  : `Team is confusing this policy with other policies — ${wtCount} cases where moderators flagged the wrong policy. The distinction between similar policies is unclear.`;
                const action = dominantType === 'overkill'
                  ? `1. Run team calibration session with 20+ side-by-side examples (approved vs flagged)\n2. Focus on borderline cases where team over-flags\n3. Create a "Do NOT flag" quick reference for common false positives`
                  : dominantType === 'leakage'
                  ? `1. SAFETY PRIORITY — run mandatory policy refresher for all ${pi.moderatorCount} affected moderators\n2. Visual recognition drill with 30 violation examples\n3. Add this policy to the weekly QA spotlight batch`
                  : `1. Run policy differentiation workshop comparing this policy to commonly confused ones\n2. Create a decision tree for distinguishing similar policies\n3. Add multi-tag practice cases to calibration queue`;

                return (
                <div key={pi.policy} style={{ background: C.bg, borderRadius: 10, padding: 16, border: `1px solid ${C.overkill}44`, borderLeft: `4px solid ${C.overkill}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{pi.policy}</div>
                    <Badge label="TEAM LEVEL ISSUE" color={C.overkill} />
                  </div>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 4 }}>{pi.moderatorCount} moderators confused — this affects the entire team, not just individuals</div>

                  {/* Error type split for this policy */}
                  {totalP > 0 && (
                    <div style={{ display: 'flex', gap: 4, height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
                      {okCount > 0 && <div style={{ flex: okCount, background: C.overkill }} title={`Overkill: ${okCount}`} />}
                      {ucCount > 0 && <div style={{ flex: ucCount, background: C.undercall }} title={`Leakage: ${ucCount}`} />}
                      {wtCount > 0 && <div style={{ flex: wtCount, background: C.wrongTag }} title={`Wrong Tag: ${wtCount}`} />}
                    </div>
                  )}
                  <div style={{ fontSize: 10, display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    {okCount > 0 && <span><span style={{ color: C.overkill }}>▲ Overkill:</span> {okCount}</span>}
                    {ucCount > 0 && <span><span style={{ color: C.undercall }}>▼ Leakage:</span> {ucCount}</span>}
                    {wtCount > 0 && <span><span style={{ color: C.wrongTag }}>↔ Wrong Tag:</span> {wtCount}</span>}
                  </div>

                  <div style={{ fontSize: 11, lineHeight: 1.6, marginBottom: 10, color: C.textDim }}>
                    <b style={{ color: C.text }}>What's happening:</b> {description}
                  </div>
                  <div style={{ fontSize: 11, lineHeight: 1.6, marginBottom: 10 }}>
                    <span style={{ color: C.textDim }}>Affected: </span>{pi.moderators.join(', ')}
                  </div>
                  <div style={{ background: C.card, borderRadius: 6, padding: 12, fontSize: 12, borderLeft: `3px solid ${C.stable}` }}>
                    <div style={{ color: C.stable, fontWeight: 700, fontSize: 11, marginBottom: 6 }}>RECOMMENDED ACTIONS:</div>
                    {action.split('\n').map((line, li) => (
                      <div key={li} style={{ color: C.text, lineHeight: 1.7, fontSize: 11 }}>{line}</div>
                    ))}
                  </div>
                </div>
                );
              })}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 30, color: C.textDim }}>
              No policy-level systemic issues detected.
            </div>
          )}
        </div>

        {/* Individual vs Systemic split */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Individual Drift vs Team Level Issue Split</div>
          {(() => {
            const systemicTaskIds = new Set(systemicIssues.map(s => s.taskId));
            const systemicErrors = records.filter(r => r.type !== 'ALIGNED' && systemicTaskIds.has(r.taskId)).length;
            const individualErrors = analytics.misaligned - systemicErrors;
            const pieData = [
              { name: 'Individual Drift', value: individualErrors, color: C.undercall },
              { name: 'Systemic (Team Level)', value: systemicErrors, color: C.overkill },
            ].filter(d => d.value > 0);
            return (
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <ResponsiveContainer width={260} height={200}>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={40} paddingAngle={3} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={{ stroke: C.textDim }} fontSize={10}>
                      {pieData.map((d, idx) => <Cell key={idx} fill={d.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                  <div><span style={{ color: C.undercall, fontWeight: 700 }}>Individual Drift:</span> {individualErrors} errors — address via moderator coaching</div>
                  <div><span style={{ color: C.overkill, fontWeight: 700 }}>Team Level Issues:</span> {systemicErrors} errors — address via team calibration and policy clarification</div>
                </div>
              </div>
            );
          })()}
        </div>
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 6: ALERTS
  // ──────────────────────────────────────────────────────────────────────────────
  const AlertsTab = () => {
    return (
      <>
        <div style={{ ...S.section, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Alert Sensitivity Threshold</div>
            <div style={{ color: C.textDim, fontSize: 11 }}>Moderators with error rate above this threshold will be flagged</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="range" min={1} max={20} step={0.5} value={alertThreshold} onChange={e => setAlertThreshold(parseFloat(e.target.value))} style={{ width: 200, accentColor: C.accent }} />
            <span style={{ fontWeight: 700, fontSize: 18, color: C.accent, minWidth: 50 }}>{alertThreshold}%</span>
          </div>
        </div>

        <div style={{ marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <KPICard title="Total Alerts" value={alerts.length} color={alerts.length > 0 ? C.critical : C.stable} icon="!" />
          <KPICard title="Critical" value={alerts.filter(a => a.severity === 'CRITICAL').length} color={C.critical} icon="!!" />
          <KPICard title="Warnings" value={alerts.filter(a => a.severity === 'WARNING').length} color={C.warning} icon="W" />
        </div>

        {alerts.length === 0 ? (
          <div style={{ ...S.section, textAlign: 'center', padding: 40 }}>
            <div style={{ color: C.stable, fontSize: 16, fontWeight: 600 }}>No alerts at current threshold ({alertThreshold}%)</div>
            <div style={{ color: C.textDim, fontSize: 12, marginTop: 4 }}>Try lowering the threshold to detect more subtle drift patterns</div>
          </div>
        ) : (
          <div>
            {alerts.map((alert, idx) => {
              const isCritical = alert.severity === 'CRITICAL';
              const typeColor = alert.type.includes('OVERKILL') ? C.overkill : alert.type.includes('UNDERCALL') ? C.undercall : alert.type.includes('WRONG') ? C.wrongTag : C.overkill;
              return (
                <div key={idx} style={{ ...S.section, borderLeft: `4px solid ${isCritical ? C.critical : C.warning}`, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <Badge label={alert.severity} color={isCritical ? C.critical : C.warning} />
                      <Badge label={alert.type.replace(/_/g, ' ')} color={typeColor} />
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{alert.mod}</span>
                      <span style={{ color: C.textDim, fontSize: 12 }}>({alert.market})</span>
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{alert.message}</div>
                  </div>
                  <div style={{ textAlign: 'right', minWidth: 80 }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: isCritical ? C.critical : C.warning }}>{alert.errorRate.toFixed(1)}%</div>
                    <div style={{ fontSize: 10, color: C.textDim }}>error rate</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Recommended actions summary */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Recommended Actions Summary</div>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Priority</th>
                <th style={S.th}>Moderator</th>
                <th style={S.th}>Type</th>
                <th style={S.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {alerts.slice(0, 15).map((alert, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : C.border + '11' }}>
                  <td style={{ ...S.td, fontWeight: 700 }}>#{i + 1}</td>
                  <td style={{ ...S.td, fontWeight: 600 }}>{alert.mod}</td>
                  <td style={S.td}><Badge label={alert.type.replace(/_/g, ' ')} color={alert.type.includes('OVERKILL') ? C.overkill : alert.type.includes('UNDERCALL') ? C.undercall : C.wrongTag} /></td>
                  <td style={{ ...S.td, fontSize: 12 }}>
                    {alert.type === 'OVERKILL_DRIFT' && `Schedule 1:1 calibration for ${alert.mod} on ${alert.policy || 'policy'}. Focus on approve vs flag boundary.`}
                    {alert.type === 'UNDERCALL_PATTERN' && `Add ${alert.mod} to next QA batch with focus on ${alert.policy || 'policy'}. Assign policy refresher module.`}
                    {alert.type === 'WRONG_TAG_PATTERN' && `Schedule policy differentiation workshop for ${alert.mod}. Focus on commonly confused policies.`}
                    {alert.type === 'WORSENING_TREND' && `Proactive intervention for ${alert.mod} — worsening over last 3 weeks. Schedule checkpoint.`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // TAB 7: EVENT LOG
  // ──────────────────────────────────────────────────────────────────────────────
  const EventLogTab = () => {
    const typeColorMap = { OVERKILL: C.overkill, UNDERCALL: C.undercall, WRONG_TAG: C.wrongTag, ALIGNED: C.stable, MISALIGNED_UNKNOWN: C.textDim };
    const PAGE_SIZE = 50;
    const [page, setPage] = useState(0);
    const pageRecords = filteredRecords.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const totalPages = Math.ceil(filteredRecords.length / PAGE_SIZE);

    return (
      <>
        {/* Filters */}
        <div style={{ ...S.section, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ ...S.input, maxWidth: 300 }} placeholder="Search moderator, task, policy, RCA..." value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setPage(0); }} />
          <select style={S.select} value={filterType} onChange={e => { setFilterType(e.target.value); setPage(0); }}>
            <option value="ALL">All Types</option>
            <option value="OVERKILL">Overkill</option>
            <option value="UNDERCALL">Undercall</option>
            <option value="WRONG_TAG">Wrong Tag</option>
            <option value="ALIGNED">Aligned</option>
          </select>
          <select style={S.select} value={modFilter} onChange={e => { setModFilter(e.target.value); setPage(0); }}>
            <option value="ALL">All Moderators</option>
            {analytics.moderators.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <span style={{ color: C.textDim, fontSize: 12 }}>{filteredRecords.length} records</span>
        </div>

        {/* Table */}
        <div style={{ ...S.section, padding: 0 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['Batch', 'Market', 'Moderator', 'Task ID', 'Type', 'Mod Policy', 'Market Answer', 'RCA', 'TCS Link'].map(h => <th key={h} style={S.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {pageRecords.map((r, i) => (
                  <tr key={r.id} style={{ background: i % 2 === 0 ? 'transparent' : C.border + '11', borderLeft: `3px solid ${typeColorMap[r.type] || C.textDim}` }}>
                    <td style={S.td}>{r.batch}</td>
                    <td style={S.td}>{r.market}</td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{r.moderator}</td>
                    <td style={{ ...S.td, fontSize: 11 }}>{r.taskId}</td>
                    <td style={S.td}><Badge label={r.type.replace('_', ' ')} color={typeColorMap[r.type] || C.textDim} /></td>
                    <td style={{ ...S.td, fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.modPolicy}>{r.modPolicy || '—'}</td>
                    <td style={{ ...S.td, fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.marketAnswer}>{r.marketAnswer || '—'}</td>
                    <td style={{ ...S.td, fontSize: 11 }}>{r.rca || '—'}</td>
                    <td style={S.td}>
                      {r.tcsLink ? <a href={r.tcsLink} target="_blank" rel="noopener noreferrer" style={{ color: C.accent, fontSize: 11, textDecoration: 'none' }}>Open</a> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: 12 }}>
              <button style={{ ...S.btn(C.cardAlt), opacity: page === 0 ? 0.4 : 1 }} disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
              <span style={{ color: C.textDim, fontSize: 12, lineHeight: '32px' }}>Page {page + 1} of {totalPages}</span>
              <button style={{ ...S.btn(C.cardAlt), opacity: page >= totalPages - 1 ? 0.4 : 1 }} disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </div>
      </>
    );
  };

  // ── Render active tab ────────────────────────────────────────────────────────
  const renderTab = () => {
    switch (activeTab) {
      case 0: return <OverviewTab />;
      case 1: return <SPCTab />;
      case 2: return <ErrorClassificationTab />;
      case 3: return <ModMistakesTab />;
      case 4: return <CoachingTab />;
      case 5: return <AICoachTab />;
      case 6: return <RCATab />;
      case 7: return <SystemicTab />;
      case 8: return <AlertsTab />;
      case 9: return <EventLogTab />;
      default: return <OverviewTab />;
    }
  };

  // ══════════════════════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ══════════════════════════════════════════════════════════════════════════════
  return (
    <div style={S.app}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.title}>
          <span>MODERATOR DRIFT ANALYSIS</span>
          <span style={{ fontSize: 12, fontWeight: 400, color: C.textDim, marginLeft: 8 }}>Coaching Engine v2.0</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ color: C.textDim, fontSize: 12 }}>{analytics.total.toLocaleString()} cases loaded | {analytics.moderators.length} moderators | {analytics.markets.length} markets</span>
          <button style={S.btn(C.cardAlt)} onClick={() => { setRecords([]); setActiveTab(0); }}>Upload New</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {TABS.map((tab, i) => (
          <button key={tab} style={S.tab(activeTab === i)} onClick={() => setActiveTab(i)}>
            {tab}
            {i === 8 && alerts.length > 0 && (
              <span style={{ background: C.critical, color: C.white, borderRadius: 99, padding: '1px 6px', fontSize: 10, fontWeight: 700, marginLeft: 6 }}>{alerts.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={S.body}>
        {renderTab()}
      </div>

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '16px 0', borderTop: `1px solid ${C.border}`, color: C.textDim, fontSize: 11 }}>
        Trust & Safety QA — Moderator Drift Analysis & Coaching Engine — Target: 95% Alignment
      </div>
    </div>
  );
}
