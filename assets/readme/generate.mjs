// Generates the README visuals (light + dark) next to this file: node assets/readme/generate.mjs
// Data: role counts from packages/mongo/src/roles.ts, pilot rows from docs/demo/pilot.md, feature states from
// docs/FEATURE-MATRIX.md. Update the constants below when those change.
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('.', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const SERIF = "'Iowan Old Style','Palatino Linotype',Palatino,Charter,Georgia,serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

const THEMES = {
  light: {
    bg: '#F8F7F4',
    surface: '#FFFFFF',
    ink: '#1D1F24',
    graphite: '#5C5F6B',
    faint: '#8A8D97',
    rule: '#DAD7CF',
    ruleSoft: '#ECEAE4',
    seal: '#2B48C8',
    sealBg: '#E9EDFC',
    amber: '#9A5800',
    amberBg: '#FBF0DC',
    bar: '#1D1F24',
    find: '#E4E2DC',
  },
  dark: {
    bg: '#16171A',
    surface: '#1F2024',
    ink: '#ECEBE8',
    graphite: '#A6A9B3',
    faint: '#7C7F89',
    rule: '#36383E',
    ruleSoft: '#2A2B30',
    seal: '#93A6FF',
    sealBg: '#1D2442',
    amber: '#E9B24E',
    amberBg: '#3A2D12',
    bar: '#ECEBE8',
    find: '#33353B',
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, { size = 14, family = SANS, fill, weight = 400, anchor = 'start', style = '' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${style ? ` font-style="${style}"` : ''}>${esc(s)}</text>`;
const svg = (w, h, t, body, title, desc) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<rect width="${w}" height="${h}" rx="16" fill="${t.bg}"/>
${body}
</svg>
`;
const mark = (x, y, s, fill) => {
  // Ruled text with one span redacted (same geometry as the app's BrandMark, 20-unit grid).
  const k = s / 20;
  const r = (rx, ry, rw, rh, rr) =>
    `<rect x="${x + rx * k}" y="${y + ry * k}" width="${rw * k}" height="${rh * k}" rx="${rr * k}" fill="${fill}"/>`;
  return (
    r(2, 3.5, 16, 1.6, 0.8) + r(2, 9.2, 3.5, 1.6, 0.8) + r(7, 7.6, 11, 4.8, 0.8) + r(2, 14.9, 10, 1.6, 0.8)
  );
};
const arrowDefs = (t) => `<defs>
<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.ink}"/></marker>
<marker id="ahs" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.seal}"/></marker>
<marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.faint}"/></marker>
</defs>`;

/* ---------- 1. Hero ---------- */
function hero(t) {
  const W = 1280,
    H = 400;
  let b = '';
  // Left: identity
  b += mark(72, 92, 64, t.ink);
  b += text(156, 145, 'Expunge', { size: 76, family: SERIF, fill: t.ink, weight: 500 });
  b += text(74, 212, 'A database-cleanup agent that rewrites', { size: 25, family: SERIF, fill: t.ink });
  b += text(74, 246, 'its own harness from measured failures.', { size: 25, family: SERIF, fill: t.ink });
  b += text(74, 300, 'The model stays fixed. The context, workflow, guardrails and', {
    size: 15,
    fill: t.graphite,
  });
  b += text(74, 322, 'tool grants around it change only when a gate on fresh worlds', {
    size: 15,
    fill: t.graphite,
  });
  b += text(74, 344, 'says they should, and the database commits every step.', {
    size: 15,
    fill: t.graphite,
  });

  // Right: a receipt-like record
  const X = 672,
    Y = 40,
    CW = 540,
    CH = 320;
  b += `<rect x="${X}" y="${Y}" width="${CW}" height="${CH}" rx="12" fill="${t.surface}" stroke="${t.rule}"/>`;
  b += text(X + 24, Y + 34, 'Cleanup of one synthetic customer', { size: 15, fill: t.ink, weight: 600 });
  b += text(X + CW - 24, Y + 34, 'illustration', {
    size: 13,
    fill: t.graphite,
    anchor: 'end',
    style: 'italic',
  });
  b += `<line x1="${X + 24}" y1="${Y + 50}" x2="${X + CW - 24}" y2="${Y + 50}" stroke="${t.ruleSoft}"/>`;
  const rows = [
    ['customers', 'deleted', 150],
    ['accounts', 'deleted', 118],
    ['messages', 'redacted', 196],
    ['events', 'tombstoned', 90],
    ['archives', 'not inspected', 0],
  ];
  rows.forEach(([coll, effect, w], i) => {
    const ry = Y + 82 + i * 36;
    b += text(X + 24, ry, coll, { size: 14, family: MONO, fill: t.ink });
    if (w) {
      b += `<rect x="${X + 150}" y="${ry - 13}" width="${w}" height="17" rx="2" fill="${t.bar}"/>`;
      b += text(X + CW - 24, ry, effect, { size: 13, fill: t.graphite, anchor: 'end' });
    } else {
      b += `<rect x="${X + 150}" y="${ry - 13}" width="170" height="17" rx="2" fill="${t.amberBg}" stroke="${t.amber}" stroke-dasharray="4 3"/>`;
      b += text(X + CW - 24, ry, effect, { size: 13, fill: t.amber, anchor: 'end', weight: 600 });
    }
  });
  // Seal rule: committed authority
  const sy = Y + CH - 50;
  b += `<line x1="${X + 24}" y1="${sy}" x2="${X + CW - 24}" y2="${sy}" stroke="${t.seal}" stroke-width="2"/>`;
  b += `<rect x="${X + 24}" y="${sy + 12}" width="236" height="26" rx="13" fill="${t.sealBg}" stroke="${t.seal}"/>`;
  b += `<circle cx="${X + 42}" cy="${sy + 25}" r="5" fill="none" stroke="${t.seal}" stroke-width="1.6"/>`;
  b += text(X + 56, sy + 30, 'Committed completion receipt', { size: 13, fill: t.seal, weight: 600 });
  b += `<rect x="${X + 272}" y="${sy + 12}" width="244" height="26" rx="13" fill="${t.amberBg}" stroke="${t.amber}"/>`;
  b += text(X + 394, sy + 30, 'Incomplete in registered scope', {
    size: 13,
    fill: t.amber,
    weight: 600,
    anchor: 'middle',
  });
  return svg(
    W,
    H,
    t,
    b,
    'Expunge',
    'Expunge wordmark beside an illustration of a cleanup receipt: four collections show redaction bars for deleted, redacted and tombstoned data, one collection is marked not inspected, and a blue committed-receipt seal sits next to an amber incomplete-in-registered-scope label.',
  );
}

/* ---------- 2. The loop ---------- */
function loop(t) {
  const W = 1280,
    H = 600;
  let b = arrowDefs(t);
  const box = (x, y, w, h, title, sub, { seal = false, dashed = false } = {}) => {
    const stroke = seal ? t.seal : t.rule;
    let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${seal ? t.sealBg : t.surface}" stroke="${stroke}" stroke-width="${seal ? 1.6 : 1}"${dashed ? ' stroke-dasharray="5 4"' : ''}/>`;
    s += text(x + w / 2, y + 30, title, {
      size: 15,
      fill: seal ? t.seal : t.ink,
      weight: 600,
      anchor: 'middle',
    });
    sub.forEach(
      (line, i) =>
        (s += text(x + w / 2, y + 52 + i * 18, line, { size: 12.5, fill: t.graphite, anchor: 'middle' })),
    );
    return s;
  };
  const lane = (y, h, label, note) => {
    let s = `<rect x="24" y="${y}" width="${W - 48}" height="${h}" rx="14" fill="none" stroke="${t.ruleSoft}"/>`;
    s += text(146, y + 30, label, { size: 18, family: SERIF, fill: t.ink, weight: 500 });
    s += text(146 + label.length * 9.4 + 14, y + 30, note, { size: 13, fill: t.graphite });
    return s;
  };
  // Top lane: run
  b += lane(28, 196, 'Run', 'every cleanup job, under the active harness');
  const topY = 76,
    topW = 238,
    topH = 104,
    topGap = 66,
    topX0 = 92;
  const top = [
    ['Durable worker', ['fixed model, fenced lease', 'pinned to the active harness']],
    ['Domain gateway', ['typed tools only: inspect,', 'resolve, discover, preview…']],
    ['World database', ['delete, redact, restrict,', 'tombstone in transactions']],
    ['Completion receipt', ['committed, and honest', 'when incomplete'], { seal: true }],
  ];
  top.forEach(([ti, sub, o], i) => (b += box(topX0 + i * (topW + topGap), topY, topW, topH, ti, sub, o)));
  for (let i = 0; i < 3; i++) {
    const x1 = topX0 + i * (topW + topGap) + topW,
      x2 = x1 + topGap;
    b += `<line x1="${x1 + 4}" y1="${topY + topH / 2}" x2="${x2 - 6}" y2="${topY + topH / 2}" stroke="${t.ink}" stroke-width="1.5" marker-end="url(#ah)"/>`;
  }
  // Bottom lane: improve
  b += lane(262, 300, 'Improve', 'between harness versions, only from measured failures');
  const n = 7,
    bw = 150,
    bgap = 22,
    bx0 = (W - (n * bw + (n - 1) * bgap)) / 2,
    by = 318,
    bh = 122;
  const bottom = [
    ['Grader', ['private database,', 'sealed post-states', 'the worker can’t read']],
    ['Evidence', ['outbox spans read', 'back by the observer,', 'leak-guarded']],
    ['Proposal', ['typed edit to context,', 'workflow, guardrails', 'or tool policy']],
    ['Compiler', ['61-code rejection', 'catalog; computes', 'the authority class']],
    ['Gate', ['parent vs candidate', 'on fresh paired', 'worlds (38 pairs)']],
    ['Human grant', ['descriptor of every', 'changed capability;', 'single use']],
    ['Promotion', ['atomic CAS of the', 'active harness;', 'rollback the same'], { seal: true }],
  ];
  bottom.forEach(([ti, sub, o], i) => (b += box(bx0 + i * (bw + bgap), by, bw, bh, ti, sub, o)));
  for (let i = 0; i < n - 1; i++) {
    const x1 = bx0 + i * (bw + bgap) + bw;
    b += `<line x1="${x1 + 3}" y1="${by + bh / 2}" x2="${x1 + bgap - 4}" y2="${by + bh / 2}" stroke="${t.ink}" stroke-width="1.5" marker-end="url(#ah)"/>`;
  }
  // Refusal stubs under compiler and gate
  [3, 4].forEach((i, k) => {
    const cx = bx0 + i * (bw + bgap) + bw / 2;
    b += `<line x1="${cx}" y1="${by + bh + 2}" x2="${cx}" y2="${by + bh + 34}" stroke="${t.faint}" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#ahg)"/>`;
    b += text(cx, by + bh + 52, k === 0 ? 'rejected' : 'held', {
      size: 12.5,
      fill: t.faint,
      anchor: 'middle',
      style: 'italic',
    });
  });
  // Receipt -> grader
  const rcx = topX0 + 3 * (topW + topGap) + topW / 2;
  const gcx = bx0 + bw / 2;
  b += `<path d="M ${rcx} ${topY + topH + 2} V 236 H ${gcx} V ${by - 6}" fill="none" stroke="${t.ink}" stroke-width="1.5" marker-end="url(#ah)"/>`;
  b += text(rcx - 12, 254, 'graded after the run', { size: 12.5, fill: t.graphite, anchor: 'end' });
  // Promotion -> worker (back up, on the left side)
  const pcx = bx0 + 6 * (bw + bgap) + bw / 2;
  const wx = topX0 - 30;
  b += `<path d="M ${pcx} ${by + bh + 2} V ${by + bh + 64} H ${wx - 30} V ${topY + topH / 2} H ${topX0 - 6}" fill="none" stroke="${t.seal}" stroke-width="2" marker-end="url(#ahs)"/>`;
  b += text(pcx - 12, by + bh + 82, 'the next job pins the newly active harness', {
    size: 13,
    fill: t.seal,
    anchor: 'end',
    weight: 600,
  });
  return svg(
    W,
    H,
    t,
    b,
    'The Expunge improvement loop',
    'Two lanes. Run: durable worker, domain gateway with typed tools, world database with transactional effects, committed completion receipt. Improve: grader on a private database, evidence read back by the observer, typed proposal, compiler with a rejection catalog, gate on fresh paired worlds, single-use human grant, atomic promotion. The compiler can reject and the gate can hold. Promotion feeds back to the worker, which pins the newly active harness.',
  );
}

/* ---------- 3. Access matrix ---------- */
const ROLES = {
  domain_executor: {
    world: { FIND: 13, UPDATE: 9, INSERT: 2, REMOVE: 6 },
    control: { FIND: 34, INSERT: 17, UPDATE: 5 },
  },
  observer: { world: { FIND: 2 }, control: { FIND: 15, INSERT: 9, UPDATE: 6, REMOVE: 1 } },
  proposer: { control: { FIND: 6, INSERT: 3 } },
  grader: {
    world: { FIND: 13 },
    private: { FIND: 7, INSERT: 1 },
    control: { FIND: 24, INSERT: 14, UPDATE: 4 },
  },
  approval_issuer: { control: { FIND: 8, INSERT: 2, UPDATE: 2 } },
  promoter: { world: { FIND: 2 }, control: { FIND: 14, UPDATE: 6, INSERT: 9 } },
  projection_reader: { control: { FIND: 13, INSERT: 1, UPDATE: 1, REMOVE: 1 } },
  privacy_controller: { world: { FIND: 2 }, control: { FIND: 15, UPDATE: 12, INSERT: 16, REMOVE: 2 } },
  fixture_builder: {
    world: { FIND: 13, INSERT: 13, UPDATE: 12, REMOVE: 7 },
    private: { FIND: 7, INSERT: 7 },
    control: { FIND: 7, INSERT: 11, UPDATE: 2 },
  },
};
const ROLE_LABEL = {
  domain_executor: ['domain_executor', 'the cleanup worker'],
  observer: ['observer', 'telemetry read-back'],
  proposer: ['proposer', 'writes proposals'],
  grader: ['grader', 'independent grading'],
  approval_issuer: ['approval_issuer', 'issues human grants'],
  promoter: ['promoter', 'moves the active harness'],
  projection_reader: ['projection_reader', 'serves the operator UI'],
  privacy_controller: ['privacy_controller', 'erasure lifecycle'],
  fixture_builder: ['fixture_builder', 'seeds synthetic worlds'],
};
function access(t) {
  const DBS = [
    ['world', 'World database', 'synthetic company data'],
    ['control', 'Control database', 'jobs, effects, harnesses'],
    ['private', 'Private database', 'sealed grader answers'],
  ];
  const VERBS = ['FIND', 'INSERT', 'UPDATE', 'REMOVE'];
  const left = 268,
    cell = 70,
    rowH = 44,
    top = 150,
    gapDb = 26;
  const W = left + 3 * (4 * cell) + 2 * gapDb + 40,
    H = top + 9 * rowH + 92;
  let b = '';
  b += text(40, 52, 'Who can touch what', { size: 26, family: SERIF, fill: t.ink, weight: 500 });
  b += text(
    40,
    78,
    'Collections each least-privilege principal may act on, per database and verb. A blank cell is a refusal.',
    { size: 14, fill: t.graphite },
  );
  DBS.forEach(([, name, sub], d) => {
    const x0 = left + d * (4 * cell + gapDb);
    b += text(x0 + 2 * cell, 108, name, { size: 15, fill: t.ink, weight: 600, anchor: 'middle' });
    b += text(x0 + 2 * cell, 126, sub, { size: 12.5, fill: t.graphite, anchor: 'middle' });
    VERBS.forEach(
      (v, i) =>
        (b += text(x0 + i * cell + cell / 2, top - 8, v.toLowerCase(), {
          size: 12,
          family: MONO,
          fill: t.graphite,
          anchor: 'middle',
        })),
    );
  });
  Object.keys(ROLES).forEach((p, r) => {
    const y = top + r * rowH;
    const highlight = p === 'domain_executor';
    if (r % 2 === 0)
      b += `<rect x="28" y="${y}" width="${W - 56}" height="${rowH}" rx="6" fill="${t.ruleSoft}" opacity="0.55"/>`;
    b += text(40, y + 20, ROLE_LABEL[p][0], {
      size: 13.5,
      family: MONO,
      fill: t.ink,
      weight: highlight ? 700 : 400,
    });
    b += text(40, y + 36, ROLE_LABEL[p][1], { size: 12, fill: t.graphite });
    DBS.forEach(([key], d) => {
      const x0 = left + d * (4 * cell + gapDb);
      VERBS.forEach((v, i) => {
        const n = ROLES[p][key]?.[v];
        const cx = x0 + i * cell + 6,
          cy = y + 7,
          cw = cell - 12,
          ch = rowH - 14;
        if (!n) {
          b += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="5" fill="none" stroke="${t.rule}" stroke-dasharray="2 3"/>`;
          return;
        }
        const write = v !== 'FIND';
        b += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="5" fill="${write ? t.ink : t.find}"/>`;
        b += text(cx + cw / 2, cy + ch / 2 + 5, n, {
          size: 13,
          family: MONO,
          fill: write ? t.bg : t.ink,
          weight: 600,
          anchor: 'middle',
        });
      });
    });
  });
  // Callout: worker vs private DB
  const px = left + 2 * (4 * cell + gapDb),
    py = top;
  b += `<rect x="${px + 2}" y="${py + 2}" width="${4 * cell - 4}" height="${rowH - 4}" rx="7" fill="none" stroke="${t.seal}" stroke-width="1.6"/>`;
  const fy = top + 9 * rowH + 34;
  b +=
    `<rect x="40" y="${fy - 12}" width="14" height="14" rx="3" fill="${t.find}"/>` +
    text(62, fy, 'read', { size: 13, fill: t.graphite });
  b +=
    `<rect x="112" y="${fy - 12}" width="14" height="14" rx="3" fill="${t.ink}"/>` +
    text(134, fy, 'write', { size: 13, fill: t.graphite });
  b +=
    `<rect x="186" y="${fy - 12}" width="14" height="14" rx="3" fill="none" stroke="${t.seal}" stroke-width="1.6"/>` +
    text(208, fy, 'the worker can’t read the grader’s answers (refused live on Atlas, code 13)', {
      size: 13,
      fill: t.graphite,
    });
  b += text(
    40,
    fy + 26,
    'Source: packages/mongo/src/roles.ts. Numbers are collection counts; observer and projection_reader also hold a change-stream grant on control.',
    { size: 12, fill: t.faint },
  );
  return svg(
    W,
    H,
    t,
    b,
    'Who can touch what',
    'Matrix of nine Atlas principals against the world, control and private databases and the find, insert, update and remove verbs, with the number of collections each may act on. The cleanup worker has no access to the private database; only the grader and the fixture builder read it.',
  );
}

/* ---------- 4. Evidence map ---------- */
const FEATURES = [
  [
    'Data and authority',
    [
      [3, 'Atlas layout, validators, principals', 'LV'],
      [4, 'Fenced leases, exactly-once effects', 'LV'],
      [5, 'Atomic promotion with grants', 'LV'],
      [6, 'Change-stream projections', 'LV'],
      [1, 'Provenance and revocation repair', 'LV'],
      [7, 'Search/Vector lesson retrieval', 'NS'],
    ],
  ],
  [
    'Worlds and grading',
    [
      [2, 'Scope keys, canaries, bounds', 'LV'],
      [8, 'Synthetic worlds, sealed manifests', 'LV'],
      [9, 'Independent grader', 'LV'],
      [18, 'Hider curriculum (simulated worker)', 'LV'],
    ],
  ],
  [
    'Run and sandbox',
    [
      [10, 'Typed worker tools, durable workflow', 'LV'],
      [11, 'Durable worker, OpenMuse port', 'LV'],
      [12, 'OpenBot candidate sandbox', 'IM'],
      [21, 'Crash, takeover, race tests', 'LV'],
    ],
  ],
  [
    'Improvement loop',
    [
      [16, 'Evidence-linked typed proposals', 'LV'],
      [17, 'Admission, approval, promotion', 'IM'],
      [19, 'Fresh-base meta experiment', 'IM'],
      [22, 'Preregistered benchmark run', 'BR'],
    ],
  ],
  [
    'Operator and tracing',
    [
      [13, 'Operator views (fixture backend)', 'LV'],
      [14, 'Review tool, reconnect epochs', 'IM'],
      [15, 'Raindrop tracing and read-back', 'IM'],
    ],
  ],
  [
    'Privacy and operations',
    [
      [20, 'Privacy lineage and erasure', 'LV'],
      [24, 'Continuity and handoff drill', 'LV'],
      [23, 'Packaging, runbooks, deployment', 'BR'],
    ],
  ],
];
function evidence(t) {
  const W = 1280,
    colW = 400,
    gx = 40,
    gy = 26;
  let b = '';
  b += text(40, 52, 'Where each feature stands', { size: 26, family: SERIF, fill: t.ink, weight: 500 });
  b += text(
    40,
    78,
    'All 24 rows of docs/FEATURE-MATRIX.md. A row moves only when an independent verifier records evidence.',
    { size: 14, fill: t.graphite },
  );
  // Summary bar
  const counts = { LV: 16, IM: 5, BR: 2, NS: 1 };
  const total = 24,
    barX = 40,
    barY = 100,
    barW = W - 80,
    barH = 14;
  let cx = barX;
  const segs = [
    ['LV', t.ink, null],
    ['IM', t.surface, t.ink],
    ['BR', t.surface, t.faint],
    ['NS', t.surface, t.faint],
  ];
  segs.forEach(([k, fill, stroke]) => {
    const w = (counts[k] / total) * barW;
    b += `<rect x="${cx + 1}" y="${barY}" width="${w - 2}" height="${barH}" rx="3" fill="${fill}"${stroke ? ` stroke="${stroke}"${k !== 'IM' ? ' stroke-dasharray="3 3"' : ''}` : ''}/>`;
    cx += w;
  });
  const legend = [
    ['LV', '16 locally verified', t.ink, null],
    ['IM', '5 implemented, awaiting verification', t.surface, t.ink],
    ['BR', '2 briefed', t.surface, t.faint],
    ['NS', '1 not started', t.surface, t.faint],
  ];
  let lx = 40;
  legend.forEach(([k, label, fill, stroke]) => {
    b += `<rect x="${lx}" y="${barY + 30}" width="14" height="14" rx="3" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.4"${k === 'BR' || k === 'NS' ? ' stroke-dasharray="3 2"' : ''}` : ''}/>`;
    b += text(lx + 22, barY + 42, label, { size: 13, fill: t.graphite });
    lx += 22 + label.length * 7.1 + 30;
  });
  // Groups in a 3-column grid
  const gridTop = 186,
    rowH = 30;
  const colY = [gridTop, gridTop, gridTop];
  FEATURES.forEach(([group, items], gi) => {
    const col = gi % 3;
    const x = 40 + col * (colW + gx),
      y = colY[col];
    b += text(x, y + 16, group, { size: 16, family: SERIF, fill: t.ink, weight: 600 });
    items.forEach(([num, name, st], i) => {
      const iy = y + 34 + i * rowH;
      const fill = st === 'LV' ? t.ink : t.surface;
      const stroke =
        st === 'LV'
          ? ''
          : ` stroke="${st === 'IM' ? t.ink : t.faint}" stroke-width="1.4"${st === 'IM' ? '' : ' stroke-dasharray="3 2"'}`;
      b += `<rect x="${x}" y="${iy}" width="16" height="16" rx="3" fill="${fill}"${stroke}/>`;
      b += text(x + 28, iy + 13, name, { size: 13.5, fill: st === 'LV' || st === 'IM' ? t.ink : t.graphite });
      b += text(x + colW - 12, iy + 13, `#${num}`, { size: 12, family: MONO, fill: t.faint, anchor: 'end' });
    });
    colY[col] = y + 34 + items.length * rowH + gy;
  });
  const H = Math.max(...colY) + 34;
  b += text(
    40,
    H - 22,
    'Snapshot of the matrix at a042552. Live Atlas and model runs from the demo are recorded in WHAT_IS_REAL.md; the matrix promotes a row to live only after the verifier reproduces it.',
    { size: 12, fill: t.faint },
  );
  return svg(
    W,
    H,
    t,
    b,
    'Where each feature stands',
    'Status of the 24 features in the feature matrix: 16 locally verified, 5 implemented and awaiting verification, 2 briefed, 1 not started, grouped into data and authority, worlds and grading, run and sandbox, improvement loop, operator and tracing, and privacy and operations.',
  );
}

/* ---------- 5. Pilot chart ---------- */
// docs/demo/pilot.md, per-episode table (PILOT, NOT ADMISSION).
const PILOT = [
  [
    'direct_nested',
    [
      [0, 5, 0],
      [2, 5, 0],
      [4, 5, 0],
    ],
  ],
  [
    'alias_two_hop',
    [
      [1, 6, 6],
      [3, 6, 6],
      [5, 6, 6],
    ],
  ],
];
const SERIES = { light: { w0: '#eb6834', cand: '#4a3aa7' }, dark: { w0: '#d95926', cand: '#9085e9' } };
function pilot(t, mode) {
  const c = SERIES[mode];
  const W = 1280,
    H = 470;
  let b = '';
  b += text(40, 52, 'Pilot: targeted residuals left per world', {
    size: 26,
    family: SERIF,
    fill: t.ink,
    weight: 500,
  });
  b += text(
    40,
    78,
    'Six fresh paired worlds, real model, all 12 receipts verified, 0 collateral. Lower is better; 0 means the receipt is complete in registered scope.',
    { size: 14, fill: t.graphite },
  );
  // Legend
  b +=
    `<rect x="40" y="98" width="14" height="14" rx="3" fill="${c.w0}"/>` +
    text(62, 110, 'W0 baseline harness', { size: 13.5, fill: t.ink });
  b +=
    `<rect x="220" y="98" width="14" height="14" rx="3" fill="${c.cand}"/>` +
    text(242, 110, 'candidate f1eb5184', { size: 13.5, fill: t.ink });
  const plotTop = 150,
    plotH = 220,
    base = plotTop + plotH,
    max = 6;
  const yOf = (v) => base - (v / max) * plotH;
  const panelW = 380,
    panelGap = 56,
    px0 = 92;
  // y axis labels + grid (shared)
  [0, 2, 4, 6].forEach((v) => {
    b += text(px0 - 14, yOf(v) + 4, v, { size: 12, family: MONO, fill: t.graphite, anchor: 'end' });
    b += `<line x1="${px0}" y1="${yOf(v)}" x2="${px0 + 2 * panelW + panelGap}" y2="${yOf(v)}" stroke="${v === 0 ? t.rule : t.ruleSoft}" stroke-width="${v === 0 ? 1.4 : 1}"/>`;
  });
  b += text(40, plotTop - 14, 'residuals', { size: 12, fill: t.graphite });
  PILOT.forEach(([family, pairs], pi) => {
    const x0 = px0 + pi * (panelW + panelGap);
    const slot = panelW / 3,
      bw = 34;
    pairs.forEach(([pair, w0, cand], i) => {
      const cx = x0 + slot * i + slot / 2;
      const bars = [
        [w0, c.w0, cx - bw - 1],
        [cand, c.cand, cx + 1],
      ];
      bars.forEach(([v, fill, x]) => {
        if (v === 0) {
          b += `<rect x="${x}" y="${base - 3}" width="${bw}" height="3" rx="1.5" fill="${fill}"/>`;
          b += text(x + bw / 2, base - 12, '0', {
            size: 13,
            family: MONO,
            fill: t.ink,
            weight: 700,
            anchor: 'middle',
          });
          return;
        }
        const y = yOf(v);
        b += `<path d="M${x},${base} V${y + 4} Q${x},${y} ${x + 4},${y} H${x + bw - 4} Q${x + bw},${y} ${x + bw},${y + 4} V${base} Z" fill="${fill}"/>`;
      });
      b += text(cx, base + 22, `pair ${pair}`, {
        size: 12.5,
        family: MONO,
        fill: t.graphite,
        anchor: 'middle',
      });
    });
    b += text(x0 + panelW / 2, base + 50, family, {
      size: 14,
      family: MONO,
      fill: t.ink,
      weight: 600,
      anchor: 'middle',
    });
    b += text(
      x0 + panelW / 2,
      base + 70,
      pi === 0 ? 'candidate completes all three; W0 leaves 5 each' : 'both arms stop with 6 residuals',
      { size: 13, fill: t.graphite, anchor: 'middle' },
    );
  });
  // Summary column
  const sx = px0 + 2 * panelW + panelGap + 52;
  b += `<line x1="${sx - 26}" y1="${plotTop - 6}" x2="${sx - 26}" y2="${base + 70}" stroke="${t.ruleSoft}"/>`;
  const stat = (y, label, a, bb) => {
    let s = text(sx, y, label, { size: 13, fill: t.graphite });
    s += text(sx, y + 34, a, { size: 28, family: SERIF, fill: c.w0 === '#eb6834' ? t.ink : t.ink });
    s += text(sx + 70, y + 34, 'vs', { size: 14, fill: t.graphite });
    s += text(sx + 100, y + 34, bb, { size: 28, family: SERIF, fill: t.ink, weight: 600 });
    return s;
  };
  b += stat(plotTop + 6, 'Useful completions (W0 vs candidate)', '0/6', '3/6');
  b += stat(plotTop + 86, 'Targeted residuals, total', '33', '18');
  b += stat(plotTop + 166, 'Collateral changes', '0', '0');
  b += text(sx, base + 50, 'A second run gave the same split.', { size: 13, fill: t.graphite });
  b += text(sx, base + 70, 'Pilot, not admission: no held-out split.', { size: 13, fill: t.graphite });
  return svg(
    W,
    H,
    t,
    b,
    'Pilot: targeted residuals left per world',
    'Grouped bar chart of residuals per pair. On direct_nested pairs 0, 2 and 4, W0 leaves 5 residuals each and the candidate leaves 0. On alias_two_hop pairs 1, 3 and 5, both arms leave 6. Useful completions: W0 0 of 6, candidate 3 of 6; residuals 33 vs 18; 0 collateral in both.',
  );
}

for (const [name, t] of Object.entries(THEMES)) {
  writeFileSync(`${OUT}/pilot-${name}.svg`, pilot(t, name));
  writeFileSync(`${OUT}/hero-${name}.svg`, hero(t));
  writeFileSync(`${OUT}/loop-${name}.svg`, loop(t));
  writeFileSync(`${OUT}/access-${name}.svg`, access(t));
  writeFileSync(`${OUT}/evidence-${name}.svg`, evidence(t));
}
console.log('ok');
