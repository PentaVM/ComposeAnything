'use strict';
// Plugin de MuseScore simulado: habla el mismo protocolo WebSocket ({action, params} -> {status, result}) y
// reproduce la semántica de cursor del plugin real. Sirve para pruebas y para desarrollar sin MuseScore.
//   node src/dev/mock-musescore.js [puerto]

const { WebSocketServer } = require('ws');
const { midiToName } = require('../core/dsl');

function startMock({ port = 0, staves = 2, measures = 2, time = [3, 4], fifths = 0, extras = true } = {}) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const barTicks = time[0] * (1920 / time[1]);
  const st = {
    staves: Array.from({ length: staves }, () => []),
    nMeasures: 0, barTicks, sel: { startStaff: 0, endStaff: 1, startTick: 0, endTick: 0 }, calls: [], extras: [], fifths,
  };
  const addMeasures = (k) => {
    for (let i = 0; i < k; i++) {
      for (const ev of st.staves) ev.push({ tick: st.nMeasures * barTicks, dur: barTicks, voice: 0, notes: null });
      st.nMeasures++;
    }
  };
  addMeasures(measures);

  const dur = (d) => Math.round((d.numerator * 1920) / d.denominator);
  const removeRange = (idx, voice, a, b) => { st.staves[idx] = st.staves[idx].filter((e) => !(e.voice === voice && e.tick < b && e.tick + e.dur > a)); };
  const clearRange = (idx, a, b) => {
    st.staves[idx] = st.staves[idx].filter((e) => !(e.tick >= a && e.tick < b));
    for (let t = a; t < b; t += barTicks) st.staves[idx].push({ tick: t, dur: barTicks, voice: 0, notes: null });
  };
  const summary = () => ({
    title: 'Mock', numMeasures: st.nMeasures,
    staves: st.staves.map((_, i) => ({ name: `staff${i}`, shortName: '', visible: true })),
    measures: Array.from({ length: st.nMeasures }, (_, m) => {
      const elements = {};
      st.staves.forEach((evs, i) => {
        elements[`staff${i}`] = evs.filter((e) => e.tick >= m * barTicks && e.tick < (m + 1) * barTicks)
          .sort((a, b) => a.tick - b.tick || a.voice - b.voice)
          .map((e) => ({
            name: e.notes ? 'Chord' : 'Rest', voice: e.voice, startTick: e.tick, durationTicks: e.dur,
            ...(e.notes ? { notes: e.notes.map((p) => ({ pitchMidi: p, tpc: 0, pitchName: midiToName(p, st.fifths).replace(/-?\d+$/, '') })) } : {}),
          }));
      });
      return { measure: m + 1, startTick: m * barTicks, numElements: 0, elements };
    }),
  });

  const EXTRA = ['clearStaffRange', 'addStaffText', 'addRehearsalMark', 'addHarmony', 'addDynamic', 'setKeySignature', 'addLyricsSyllabic'];
  const handlers = {
    ping: () => 'pong',
    getScore: () => ({ success: true, analysis: summary() }),
    appendMeasure: ({ count = 1 }) => { addMeasures(count); return { success: true }; },
    selectCustomRange: (p) => { st.sel = { startStaff: p.startStaff, endStaff: p.endStaff, startTick: p.startTick, endTick: p.endTick }; return { success: true }; },
    deleteSelection: () => { clearRange(st.sel.startStaff, st.sel.startTick, st.sel.endTick); return { success: true }; },
    addNote: (p) => {
      const idx = st.sel.startStaff, voice = p.voice || 0, tick = st.sel.startTick, d = dur(p.duration);
      if (p.addToChord) {
        const ev = st.staves[idx].find((e) => e.tick === tick && e.voice === voice && e.notes);
        if (!ev) return { error: 'no hay acorde donde añadir' };
        ev.notes.push(p.pitch);
      } else { removeRange(idx, voice, tick, tick + d); st.staves[idx].push({ tick, dur: d, voice, notes: [p.pitch] }); }
      if (p.advanceCursorAfterAction) st.sel.startTick = tick + d;
      return { success: true };
    },
    addRest: (p) => {
      const idx = st.sel.startStaff, voice = p.voice || 0, tick = st.sel.startTick, d = dur(p.duration);
      removeRange(idx, voice, tick, tick + d); st.staves[idx].push({ tick, dur: d, voice, notes: null });
      if (p.advanceCursorAfterAction) st.sel.startTick = tick + d;
      return { success: true };
    },
    setTempo: (p) => { st.extras.push({ action: 'setTempo', params: p, sel: { ...st.sel } }); return { success: true }; },
    setTimeSignature: (p) => { st.extras.push({ action: 'setTimeSignature', params: p }); return { success: true }; },
    addLyrics: (p) => { st.extras.push({ action: 'addLyrics', params: p }); return { success: true }; },
  };
  if (extras) {
    handlers.getCapabilities = () => ({ plugin: 'composeanything', version: 'mock', voiceParam: true, actions: ['getCapabilities', ...EXTRA], numStaves: staves, numMeasures: st.nMeasures });
    handlers.clearStaffRange = (p) => { clearRange(p.staff, p.startTick, p.endTick); return { success: true }; };
    for (const a of EXTRA.filter((x) => x !== 'clearStaffRange')) handlers[a] = (p) => { st.extras.push({ action: a, params: p }); return { success: true }; };
  }

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let cmd;
      try {
        cmd = JSON.parse(String(raw));
        st.calls.push(cmd.action);
        const h = handlers[cmd.action];
        if (!h) throw new Error('Unknown command: ' + cmd.action);
        ws.send(JSON.stringify({ status: 'success', result: h(cmd.params || {}) }));
      } catch (e) { ws.send(JSON.stringify({ status: 'error', message: String(e.message || e) })); }
    });
  });

  return new Promise((resolve) => wss.on('listening', () => resolve({
    port: wss.address().port, url: `ws://127.0.0.1:${wss.address().port}`, state: st,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  })));
}

if (require.main === module) {
  startMock({ port: Number(process.argv[2]) || 8765, staves: 2, measures: 4 }).then((m) => console.log('Plugin simulado escuchando en', m.url));
}

module.exports = { startMock };
