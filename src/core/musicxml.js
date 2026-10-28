'use strict';
// Modelo <-> MusicXML. MusicXML conserva armadura, dinámicas, pedal, cifrados, fermatas y letra:
// es la vía fiable de ComposeAnything para todo lo que el plugin en vivo no puede escribir.

const { XMLParser } = require('fast-xml-parser');
const { parseStream, splitVoices, DUR, DUR_BY_UNITS, DYNAMICS, splitUnits } = require('./dsl');
const { chordToXml, formatChord } = require('./chord');
const { staffList, measureCount, contextAt, barLength } = require('./score');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TYPE = { 96: ['whole', 0], 72: ['half', 1], 48: ['half', 0], 36: ['quarter', 1], 24: ['quarter', 0], 18: ['eighth', 1], 12: ['eighth', 0], 9: ['16th', 1], 6: ['16th', 0], 3: ['32nd', 0] };

// ---------------------------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------------------------

function dirXml(inner, staff, placement = 'below', sound = '') {
  return `<direction placement="${placement}"><direction-type>${inner}</direction-type><staff>${staff}</staff>${sound}</direction>`;
}

function directiveXml(d, staff) {
  switch (d.name) {
    case 'dyn': return dirXml(`<dynamics><${d.arg}/></dynamics>`, staff);
    case 'cresc': return dirXml(`<wedge type="crescendo" number="${staff}"/>`, staff);
    case 'dim': return dirXml(`<wedge type="diminuendo" number="${staff}"/>`, staff);
    case 'wedge': return dirXml(`<wedge type="stop" number="${staff}"/>`, staff);
    case 'ped': {
      const t = { s: 'start', c: 'change', x: 'stop' }[d.arg];
      return dirXml(`<pedal type="${t}" line="yes"${t === 'start' ? ' sign="yes"' : ''}/>`, staff);
    }
    case 'reh': return dirXml(`<rehearsal enclosure="rectangle">${esc(d.arg)}</rehearsal>`, staff, 'above');
    case 'txt': return dirXml(`<words font-style="italic">${esc(d.arg)}</words>`, staff, 'above');
    case 'tempo': {
      const [bpm, ...rest] = d.arg.split(/\s+/);
      const text = rest.join(' ');
      const words = text ? `<direction-type><words font-weight="bold">${esc(text)}</words></direction-type>` : '';
      return `<direction placement="above">${words}<direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><staff>${staff}</staff><sound tempo="${bpm}"/></direction>`;
    }
    case 'play': return `<direction placement="above"><direction-type><words/></direction-type><staff>${staff}</staff><sound tempo="${d.arg.split(/\s+/)[0]}"/></direction>`;
    case 'harm': return chordToXml(d.arg, staff);
    default: throw new Error('directiva desconocida ' + d.name);
  }
}

function lyricXml(mods, voiceState) {
  let out = '';
  for (const m of mods) {
    const mm = /^l(\d?)=(.+)$/.exec(m);
    if (!mm) continue;
    const verse = Number(mm[1] || 1);
    let txt = mm[2];
    if (txt === '_') { out += `<lyric number="${verse}"><extend/></lyric>`; continue; }
    const cont = txt.endsWith('-');
    if (cont) txt = txt.slice(0, -1);
    const open = !!voiceState.lyricOpen[verse];
    const syl = cont ? (open ? 'middle' : 'begin') : (open ? 'end' : 'single');
    voiceState.lyricOpen[verse] = cont;
    out += `<lyric number="${verse}"><syllabic>${syl}</syllabic><text>${esc(txt.replace(/_/g, ' '))}</text></lyric>`;
  }
  return out;
}

function noteXml(t, staff, voice, state) {
  const [type, dots] = TYPE[t.dur];
  const common = `<voice>${voice}</voice><type>${type}</type>${'<dot/>'.repeat(dots)}<staff>${staff}</staff>`;
  if (t.kind === 'rest') return `<note><rest/><duration>${t.dur}</duration>${common}</note>`;
  const startsTie = t.mods.includes('ts');
  const arts = t.mods.filter((m) => ['acc', 'stac', 'ten', 'marc'].includes(m))
    .map((m) => ({ acc: '<accent/>', stac: '<staccato/>', ten: '<tenuto/>', marc: '<strong-accent/>' })[m]).join('');
  const slurNum = (voice % 4) + 1;
  const nowOpen = new Set();
  let out = '';
  t.pitches.forEach((p, k) => {
    const stops = state.tied.has(p.midi);
    if (startsTie) nowOpen.add(p.midi);
    let x = '<note>' + (k ? '<chord/>' : '');
    x += `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch><duration>${t.dur}</duration>`;
    if (stops) x += '<tie type="stop"/>';
    if (startsTie) x += '<tie type="start"/>';
    x += common;
    let nt = '';
    if (stops) nt += '<tied type="stop"/>';
    if (startsTie) nt += '<tied type="start"/>';
    if (k === 0) {
      if (t.mods.includes('s(')) nt += `<slur type="start" number="${slurNum}"/>`;
      if (t.mods.includes('s)')) nt += `<slur type="stop" number="${slurNum}"/>`;
      if (arts) nt += `<articulations>${arts}</articulations>`;
      if (t.mods.includes('fer')) nt += '<fermata type="upright"/>';
    }
    if (nt) x += `<notations>${nt}</notations>`;
    if (k === 0) x += lyricXml(t.mods, state);
    out += x + '</note>';
  });
  state.tied = nowOpen;
  return out;
}

function clefXml(c, n) {
  const line = c.clef === 'F' ? 4 : c.clef === 'C' ? 3 : 2;
  return `<clef number="${n}"><sign>${c.clef}</sign><line>${line}</line>${c.octave ? `<clef-octave-change>${c.octave}</clef-octave-change>` : ''}</clef>`;
}

function toMusicXML(model) {
  const parts = model.parts;
  const all = staffList(model);
  const total = Math.max(1, measureCount(model));
  const states = new Map(); // `${global}:${voice}` -> {tied:Set, lyricOpen:{}}
  const st = (g, v) => { const k = `${g}:${v}`; if (!states.has(k)) states.set(k, { tied: new Set(), lyricOpen: {} }); return states.get(k); };

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0">';
  xml += `<work><work-title>${esc(model.meta.title)}</work-title></work>`;
  if (model.meta.subtitle) xml += `<movement-title>${esc(model.meta.subtitle)}</movement-title>`;
  xml += `<identification>${model.meta.composer ? `<creator type="composer">${esc(model.meta.composer)}</creator>` : ''}<encoding><software>ComposeAnything</software></encoding></identification>`;
  xml += '<part-list>';
  const groupAt = (id, edge) => (model.groups || []).map((g, i) => ({ ...g, n: i + 1 })).filter((g) => g[edge] === id);
  parts.forEach((p, i) => {
    for (const g of groupAt(p.id, 'from')) xml += `<part-group type="start" number="${g.n}"><group-symbol>${g.symbol || 'bracket'}</group-symbol><group-barline>yes</group-barline></part-group>`;
    const ch = i + 1 >= 10 ? i + 2 : i + 1;
    xml += `<score-part id="${p.id}"><part-name>${esc(p.name)}</part-name>${p.abbr ? `<part-abbreviation>${esc(p.abbr)}</part-abbreviation>` : ''}<score-instrument id="${p.id}-I1"><instrument-name>${esc(p.name)}</instrument-name></score-instrument><midi-instrument id="${p.id}-I1"><midi-channel>${Math.min(ch, 16)}</midi-channel><midi-program>${(p.program ?? 0) + 1}</midi-program></midi-instrument></score-part>`;
    for (const g of groupAt(p.id, 'to')) xml += `<part-group type="stop" number="${g.n}"/>`;
  });
  xml += '</part-list>';

  let prevTime = null, prevKey = null;
  const pieces = parts.map((p) => ({ p, out: [] }));
  for (let n = 1; n <= total; n++) {
    const m = model.measures[n] || {};
    const ctx = contextAt(model, n);
    const bar = barLength(ctx.time);
    const changedTime = !prevTime || prevTime[0] !== ctx.time[0] || prevTime[1] !== ctx.time[1];
    const changedKey = prevKey === null || prevKey !== ctx.key;
    for (const piece of pieces) {
      const mine = all.filter((s) => s.part === piece.p);
      let x = `<measure number="${n}"${m.partial && n === 1 ? ' implicit="yes"' : ''}>`;
      if (n === 1 || changedTime || changedKey) {
        x += `<attributes>${n === 1 ? '<divisions>24</divisions>' : ''}`;
        if (changedKey) x += `<key><fifths>${ctx.key}</fifths><mode>${ctx.mode || 'major'}</mode></key>`;
        if (changedTime) x += `<time><beats>${ctx.time[0]}</beats><beat-type>${ctx.time[1]}</beat-type></time>`;
        if (n === 1) {
          if (mine.length > 1) x += `<staves>${mine.length}</staves>`;
          mine.forEach((s) => { x += clefXml(s.staff, s.local); });
        }
        x += '</attributes>';
      }
      const ownTempo = Object.values(m.staves || {}).some((t) => /\{(tempo|play)\s/.test(t));
      if (n === 1 && piece === pieces[0] && !ownTempo) x += `<direction placement="above"><direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>${model.meta.tempo}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${model.meta.tempo}"/></direction>`;
      const streams = [];
      for (const s of mine) {
        const text = m.staves?.[s.global];
        const voices = text ? splitVoices(text) : [''];
        voices.forEach((v, vi) => streams.push({ s, vi, tokens: v.trim() ? parseStream(v) : null }));
      }
      streams.forEach((stream, idx) => {
        const voiceNo = (stream.s.local - 1) * 4 + stream.vi + 1;
        let len = 0;
        if (!stream.tokens) {
          x += `<note><rest measure="yes"/><duration>${bar}</duration><voice>${voiceNo}</voice><staff>${stream.s.local}</staff></note>`;
          len = bar;
        } else {
          for (const t of stream.tokens) {
            if (t.kind === 'dir') { if (stream.vi === 0 || t.name === 'harm') x += directiveXml(t, stream.s.local); }
            else { x += noteXml(t, stream.s.local, voiceNo, st(stream.s.global, voiceNo)); len += t.dur; }
          }
        }
        if (idx < streams.length - 1) x += `<backup><duration>${len}</duration></backup>`;
      });
      piece.out.push(x + '</measure>');
    }
    prevTime = ctx.time; prevKey = ctx.key;
  }
  for (const piece of pieces) xml += `<part id="${piece.p.id}">${piece.out.join('')}</part>`;
  return xml + '</score-partwise>\n';
}

// ---------------------------------------------------------------------------------------------
// Importar
// ---------------------------------------------------------------------------------------------

const tagOf = (n) => Object.keys(n).find((k) => k !== ':@');
const kids = (n) => n[tagOf(n)] || [];
const attrOf = (n, a) => n[':@']?.['@_' + a];
const childrenNamed = (n, name) => kids(n).filter((c) => tagOf(c) === name);
const child = (n, name) => childrenNamed(n, name)[0];
const textOf = (n) => { const t = kids(n).find((c) => '#text' in c); return t ? String(t['#text']) : ''; };
const childText = (n, name) => { const c = child(n, name); return c ? textOf(c) : undefined; };
const accStr = (a) => (a < 0 ? 'b'.repeat(-a) : '#'.repeat(a));

const KIND_FIX = { 'major-seventh': 'major-seventh' };

function harmonyToSym(h) {
  const rootEl = child(h, 'root');
  if (!rootEl) return null;
  const root = { step: childText(rootEl, 'root-step'), alter: Number(childText(rootEl, 'root-alter') || 0) };
  const kind = textOf(child(h, 'kind') || { x: [] }) || 'major';
  const bassEl = child(h, 'bass');
  const bass = bassEl ? { step: childText(bassEl, 'bass-step'), alter: Number(childText(bassEl, 'bass-alter') || 0) } : null;
  const degrees = childrenNamed(h, 'degree').map((d) => ({ value: Number(childText(d, 'degree-value')), alter: Number(childText(d, 'degree-alter') || 0), type: childText(d, 'degree-type') || 'add' }));
  try { return formatChord({ root, kind: KIND_FIX[kind] || kind, bass, degrees }); } catch { return null; }
}

function fromMusicXML(xml, { title } = {}) {
  const warnings = [];
  const warn = (m) => { if (warnings.length < 40) warnings.push(m); };
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true, parseTagValue: false, processEntities: true });
  const doc = parser.parse(xml);
  const root = doc.find((n) => tagOf(n) === 'score-partwise');
  if (!root) throw new Error('MusicXML no válido: falta <score-partwise> (los score-timewise no están soportados)');

  const meta = { title: title || 'Sin título', subtitle: '', composer: '', key: 0, mode: 'major', time: [4, 4], tempo: 100, template: 'import', hint: '' };
  const work = child(root, 'work');
  if (work && childText(work, 'work-title')) meta.title = childText(work, 'work-title');
  else if (childText(root, 'movement-title')) meta.title = childText(root, 'movement-title');
  if (work && childText(root, 'movement-title')) meta.subtitle = childText(root, 'movement-title');
  const ident = child(root, 'identification');
  if (ident) { const c = childrenNamed(ident, 'creator').find((e) => attrOf(e, 'type') === 'composer'); if (c) meta.composer = textOf(c); }

  const partInfo = {};
  for (const sp of childrenNamed(child(root, 'part-list') || { x: [] }, 'score-part')) {
    const mi = child(sp, 'midi-instrument');
    partInfo[attrOf(sp, 'id')] = { name: childText(sp, 'part-name') || 'Parte', abbr: childText(sp, 'part-abbreviation') || '', program: mi ? Number(childText(mi, 'midi-program') || 1) - 1 : 0 };
  }

  const model = { version: 1, meta, parts: [], groups: [], measures: {} };
  let globalOffset = 0, tempoSeen = false, firstPart = true;

  for (const partEl of childrenNamed(root, 'part')) {
    const pid = attrOf(partEl, 'id');
    const info = partInfo[pid] || { name: pid, abbr: '', program: 0 };
    const part = { id: pid, name: info.name, abbr: info.abbr, program: info.program, range: 'piano', staves: [{ clef: 'G' }] };
    let divisions = 1, time = [4, 4], key = 0, mode = 'major', nStaves = 1, prevTime = null, prevKey = null;
    const measures = childrenNamed(partEl, 'measure');

    measures.forEach((mEl, mi) => {
      const n = mi + 1;
      const streams = {}; // `${staff}|${voice}` -> {staff, voice, events: []}
      const dirs = [];
      let pos = 0, last = null;
      let measureTime = time, measureKey = key;
      for (const c of kids(mEl)) {
        const tg = tagOf(c);
        if (tg === 'attributes') {
          if (child(c, 'divisions')) divisions = Number(childText(c, 'divisions'));
          const k = child(c, 'key');
          if (k) { key = Number(childText(k, 'fifths') || 0); mode = childText(k, 'mode') || mode; measureKey = key; }
          const t = child(c, 'time');
          if (t) { time = [Number(childText(t, 'beats')), Number(childText(t, 'beat-type'))]; measureTime = time; }
          if (child(c, 'staves')) { nStaves = Number(childText(c, 'staves')); while (part.staves.length < nStaves) part.staves.push({ clef: 'G' }); }
          for (const cl of childrenNamed(c, 'clef')) {
            const idx = Number(attrOf(cl, 'number') || 1) - 1;
            while (part.staves.length <= idx) part.staves.push({ clef: 'G' });
            const oct = Number(childText(cl, 'clef-octave-change') || 0);
            part.staves[idx] = { clef: childText(cl, 'sign') === 'F' ? 'F' : childText(cl, 'sign') === 'C' ? 'C' : 'G', ...(oct ? { octave: oct } : {}) };
          }
        } else if (tg === 'backup') pos -= Number(childText(c, 'duration') || 0);
        else if (tg === 'forward') pos += Number(childText(c, 'duration') || 0);
        else if (tg === 'note') {
          if (child(c, 'grace')) { warn(`compás ${n}: se omite una nota de adorno`); continue; }
          const staff = Number(childText(c, 'staff') || 1), voice = childText(c, 'voice') || '1';
          const dur = Number(childText(c, 'duration') || 0);
          const units = Math.round((dur * 24) / divisions);
          const isRest = !!child(c, 'rest');
          const pEl = child(c, 'pitch');
          const name = pEl ? childText(pEl, 'step') + accStr(Math.round(Number(childText(pEl, 'alter') || 0))) + childText(pEl, 'octave') : null;
          const key2 = `${staff}|${voice}`;
          const stream = (streams[key2] ||= { staff, voice, events: [] });
          if (child(c, 'time-modification')) warn(`compás ${n}: tresillo/tuplet aproximado (v0.1 no soporta tuplets)`);
          const mods = [];
          const nots = child(c, 'notations');
          if (nots) {
            for (const a of childrenNamed(nots, 'articulations')) for (const x of kids(a)) { const g = tagOf(x); if (g === 'accent') mods.push('acc'); else if (g === 'staccato') mods.push('stac'); else if (g === 'tenuto') mods.push('ten'); else if (g === 'strong-accent') mods.push('marc'); }
            if (child(nots, 'fermata')) mods.push('fer');
            for (const s of childrenNamed(nots, 'slur')) { const ty = attrOf(s, 'type'); if (ty === 'start') mods.push('s('); else if (ty === 'stop') mods.push('s)'); }
          }
          if (childrenNamed(c, 'tie').some((t) => attrOf(t, 'type') === 'start')) mods.push('ts');
          for (const ly of childrenNamed(c, 'lyric')) {
            const txt = childText(ly, 'text'); if (!txt) continue;
            const syl = childText(ly, 'syllabic'); const num = attrOf(ly, 'number') || '1';
            const cont = syl === 'begin' || syl === 'middle';
            mods.push(`l${num === '1' ? '' : num}=${txt.replace(/\s+/g, '_').replace(/!/g, '')}${cont ? '-' : ''}`);
          }
          if (child(c, 'chord') && last && last.stream === stream && !isRest) {
            last.ev.pitches.push(name);
            for (const m of mods) if (m === 'ts' && !last.ev.mods.includes('ts')) last.ev.mods.push('ts');
          } else {
            const ev = { pos, units, rest: isRest, pitches: isRest ? [] : [name], mods: isRest ? [] : mods };
            stream.events.push(ev);
            last = { stream, ev };
            pos += dur; // pos se mantiene en unidades de <divisions>; se normaliza a 1/24 de negra abajo
          }
        } else if (tg === 'direction' || tg === 'harmony') {
          const staff = Number(childText(c, 'staff') || 1);
          if (tg === 'harmony') { const sym = harmonyToSym(c); if (sym) dirs.push({ pos, staff, tok: `{harm ${sym}}` }); continue; }
          const sound = child(c, 'sound');
          let words = '', metro = null, others = [];
          for (const dt of childrenNamed(c, 'direction-type')) for (const x of kids(dt)) {
            const g = tagOf(x);
            if (g === 'dynamics') { for (const d of kids(x)) { const dn = tagOf(d); if (DYNAMICS.has(dn)) others.push(`{dyn ${dn}}`); } }
            else if (g === 'wedge') { const ty = attrOf(x, 'type'); if (ty === 'crescendo') others.push('{cresc}'); else if (ty === 'diminuendo') others.push('{dim}'); else if (ty === 'stop') others.push('{wedge x}'); }
            else if (g === 'pedal') { const ty = attrOf(x, 'type'); if (ty === 'start') others.push('{ped s}'); else if (ty === 'stop') others.push('{ped x}'); else if (ty === 'change') others.push('{ped c}'); }
            else if (g === 'rehearsal') others.push(`{reh ${textOf(x).replace(/[{}]/g, '')}}`);
            else if (g === 'words') words += (words ? ' ' : '') + textOf(x).replace(/[{}\n]/g, ' ').trim();
            else if (g === 'metronome') metro = childText(x, 'per-minute');
          }
          const sbpm = sound ? attrOf(sound, 'tempo') : null;
          if (metro || sbpm) {
            const bpm = Math.round(Number(metro || sbpm));
            if (!tempoSeen && firstPart) { meta.tempo = bpm; tempoSeen = true; }
            // El tempo inicial sin texto es meta.tempo: el exportador lo regenera, no lo duplicamos como directiva.
            if (metro && !words && n === 1 && pos === 0 && firstPart) { /* solo meta.tempo */ }
            else if (metro) { dirs.push({ pos, staff, tok: `{tempo ${bpm}${words ? ' ' + words : ''}}` }); words = ''; }
            else { if (words) dirs.push({ pos, staff, tok: `{txt ${words}}` }); dirs.push({ pos, staff, tok: `{play ${bpm}}` }); words = ''; }
          }
          if (words) dirs.push({ pos, staff, tok: `{txt ${words}}` });
          for (const o of others) dirs.push({ pos, staff, tok: o });
        }
      }

      const bar = barLength(measureTime);
      const staffText = {};
      for (let s = 1; s <= part.staves.length; s++) {
        const voiceKeys = Object.keys(streams).filter((k) => streams[k].staff === s).sort((a, b) => Number(streams[a].voice) - Number(streams[b].voice));
        if (!voiceKeys.length && !dirs.some((d) => d.staff === s)) continue;
        const voiceTexts = [];
        voiceKeys.forEach((vk, vIdx) => {
          const evs = streams[vk].events.map((e) => ({ ...e, p: Math.round((e.pos * 24) / divisions) }));
          const toks = [];
          let cur = 0;
          const pushRests = (u, at) => { for (const part2 of splitUnits(u)) { toks.push({ s: `r:${DUR_BY_UNITS[part2]}`, at, dur: part2 }); at += part2; } };
          for (const e of evs) {
            if (e.p > cur) pushRests(e.p - cur, cur);
            else if (e.p < cur) { warn(`compás ${n}: notas solapadas en una misma voz; se omite una`); continue; }
            let u = e.units;
            if (!Object.values(DUR).includes(u) && u % 3 !== 0) { u = Math.max(3, Math.round(u / 3) * 3); }
            const pieces = splitUnits(u || 3);
            let at = e.p;
            pieces.forEach((pu, i) => {
              const code = DUR_BY_UNITS[pu];
              if (e.rest) toks.push({ s: `r:${code}`, at, dur: pu });
              else {
                const head = e.pitches.length > 1 ? `[${e.pitches.join(' ')}]` : e.pitches[0];
                const mods = i === 0 ? [...e.mods] : [];
                if (i < pieces.length - 1 && !mods.includes('ts')) mods.push('ts');
                toks.push({ s: `${head}:${code}${mods.map((m) => '!' + m).join('')}`, at, dur: pu });
              }
              at += pu;
            });
            cur = e.p + pieces.reduce((a, b) => a + b, 0);
          }
          const isPartial = mi === 0 && attrOf(mEl, 'implicit') === 'yes';
          if (cur < bar && !isPartial) pushRests(bar - cur, cur);
          // Ajuste de seguridad: nunca superar la duración del compás.
          let total = toks.reduce((a, t) => a + t.dur, 0);
          while (total > bar && toks.length) { const t = toks.pop(); total -= t.dur; warn(`compás ${n}: exceso de duración recortado`); }
          if (total < bar && !isPartial) pushRests(bar - total, total);
          if (vIdx === 0) {
            const mine = dirs.filter((d) => d.staff === s).map((d) => ({ ...d, p: Math.round((d.pos * 24) / divisions) })).sort((a, b) => a.p - b.p);
            for (const d of mine) {
              const at = toks.findIndex((t) => t.at >= d.p && !t.s.startsWith('{'));
              toks.splice(at < 0 ? toks.length : at, 0, { s: d.tok, at: d.p, dur: 0 });
            }
          }
          voiceTexts.push(toks.map((t) => t.s).join(' '));
        });
        if (!voiceKeys.length) voiceTexts.push(dirs.filter((d) => d.staff === s).map((d) => d.tok).join(' ') + ' r:' + (DUR_BY_UNITS[bar] || splitUnits(bar).map((u) => DUR_BY_UNITS[u]).join(' r:')));
        staffText[globalOffset + s] = voiceTexts.join(' || ');
      }
      const entry = (model.measures[n] ||= { staves: {} });
      Object.assign(entry.staves, staffText);
      if (firstPart) {
        if (n === 1) { meta.time = measureTime; meta.key = measureKey; meta.mode = mode; }
        else {
          if (!prevTime || prevTime[0] !== measureTime[0] || prevTime[1] !== measureTime[1]) entry.time = measureTime;
          if (prevKey !== measureKey) entry.key = measureKey;
        }
        if (n === 1 && attrOf(mEl, 'implicit') === 'yes') entry.partial = true;
        prevTime = measureTime; prevKey = measureKey;
      }
    });
    model.parts.push(part);
    globalOffset += part.staves.length;
    firstPart = false;
  }
  return { model, warnings };
}

module.exports = { toMusicXML, fromMusicXML };
