#!/usr/bin/env python3
"""Mazurka Op. 1 (Dark Chilean Mazurek) - borrador de reconstruccion -> MusicXML.

Las alturas melodicas son DECISIONES NUEVAS de reconstruccion; el dossier no fija notas.
Datos del dossier respetados: piano solo, 3/4, Mib menor (6 bemoles), progresion A
Ebm-Gbmaj7-Db-Ab7, respuesta Abm-Bmaj7(Cbmaj7)-F#(Gb)-C#7(Db7), transicion PAM PAM
(Gbmaj7/B -> Bmaj7), 43 compases como referencia documental, forma A-B-A-B', cierre
abierto en Ab7(b9).

Uso: python build_mazurka.py [salida.musicxml]
"""
import re
import sys
from xml.sax.saxutils import escape

DIV = 24                      # divisiones por negra
BAR = 3 * DIV                 # compas de 3/4
DUR = {'w': 96, 'hd': 72, 'h': 48, 'qd': 36, 'q': 24, 'ed': 18, 'e': 12, 's': 6, 't': 3}
TYPE = {96: ('whole', 0), 72: ('half', 1), 48: ('half', 0), 36: ('quarter', 1),
        24: ('quarter', 0), 18: ('eighth', 1), 12: ('eighth', 0), 6: ('16th', 0), 3: ('32nd', 0)}
STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}

# nombre -> (raiz, alteracion, kind, texto, bajo|None, degree-b9?)
HARM = {
    'Ebm':       ('E', -1, 'minor', 'm', None, False),
    'Gbmaj7':    ('G', -1, 'major-seventh', 'maj7', None, False),
    'Db':        ('D', -1, 'major', '', None, False),
    'Ab7':       ('A', -1, 'dominant', '7', None, False),
    'Abm':       ('A', -1, 'minor', 'm', None, False),
    'Cbmaj7':    ('C', -1, 'major-seventh', 'maj7', None, False),
    'Gb':        ('G', -1, 'major', '', None, False),
    'Db7':       ('D', -1, 'dominant', '7', None, False),
    'Ab7b9':     ('A', -1, 'dominant', '7', None, True),
    'Gbmaj7/Cb': ('G', -1, 'major-seventh', 'maj7', ('C', -1), False),
}

# ---------------------------------------------------------------------------
# Partitura: compas -> (mano derecha, mano izquierda, slur_rh)
# Sintaxis de nota:  Eb4:ed!acc   acorde: [Bb2 Eb3]:q   silencio: r:q
# Duraciones: w h hd q qd e ed s t   Marcas: !acc !stac !ten !fer
# Pseudo-tokens: {harm X} {dyn p} {cresc} {dim} {wedge x} {ped s|c|x}
#                {tempo BPM texto} {txt texto} {reh texto}
# ---------------------------------------------------------------------------
S = {}


def bar(n, rh, lh, slur=False):
    S[n] = (rh, lh, slur)


# --- Introduccion (1-4) -----------------------------------------------------
bar(1, "{reh Intro} {tempo 120 Tempo di mazurka} {txt cupo, quasi sottovoce} {harm Ebm} {dyn pp} "
       "r:q Bb4:q!ten Gb4:q!ten",
       "{ped s} Eb2:q!ten [Bb2 Eb3]:q [Bb2 Eb3]:q")
bar(2, "F4:q!acc Eb4:h",
       "{ped c} Eb2:q [Bb2 Eb3]:q [Bb2 Eb3]:q")
bar(3, "{harm Db} {dyn p} r:q F4:q Ab4:q",
       "{ped c} Db2:q [Ab2 F3]:q [Ab2 F3]:q")
bar(4, "{harm Ab7} Ab4:q Cn5:q!acc Bb4:q",
       "{ped c} Ab1:q [Cn3 Eb3 Gb3]:q [Cn3 Eb3 Gb3]:q")

# --- A (5-12): ascenso, M1 ---------------------------------------------------
bar(5, "{reh A} {harm Ebm} {dyn p} {txt cantabile} Eb4:ed F4:s Gb4:q Bb4:q",
       "{ped c} Eb2:q [Bb2 Eb3 Gb3]:q [Bb2 Eb3 Gb3]:q", True)
bar(6, "{cresc} Cb5:q!acc Db5:e Eb5:e Eb6:q!acc",
       "{ped c} Eb2:q [Gb2 Bb2 Eb3]:q [Gb2 Bb2 Eb3]:q")
bar(7, "{harm Gbmaj7} {wedge x} {dyn mf} Db6:qd Bb5:e Ab5:q!acc",
       "{ped c} Gb2:q [Db3 F3 Bb3]:q [Db3 F3 Bb3]:q")
bar(8, "{dyn mp} Gb5:ed F5:s Db5:q Bb4:q",
       "{ped c} Gb2:q [Bb2 Db3 F3]:q [Bb2 Db3 F3]:q", True)
bar(9, "{harm Db} Ab4:ed Bb4:s Db5:q F5:q",
       "{ped c} Db2:q [Ab2 Db3 F3]:q [Ab2 Db3 F3]:q", True)
bar(10, "{cresc} F5:ed Gb5:s Ab5:q Db6:q",
        "{ped c} Db2:q [Db3 F3 Ab3]:q [Db3 F3 Ab3]:q")
bar(11, "{harm Ab7} {wedge x} {dyn mf} Eb6:qd!acc Db6:e Cn6:q",
        "{ped c} Ab1:q [Cn3 Eb3 Gb3]:q [Cn3 Eb3 Gb3]:q")
bar(12, "{dyn mp} Bb5:ed Ab5:s Gb5:q Eb5:q",
        "{ped c} Ab1:q [Eb3 Gb3 Cn4]:q [Eb3 Gb3 Cn4]:q", True)

# --- A2 (13-20): repeticion intensificada, salto extremo, caida -------------
bar(13, "{reh A2} {harm Ebm} {dyn mf} Eb4:ed F4:s Gb4:q Bb4:q!acc",
        "{ped c} [Eb1 Eb2]:q [Bb2 Eb3 Gb3]:q [Bb2 Eb3 Gb3]:q!acc", True)
bar(14, "{cresc} Cb5:q!acc Db5:e Eb5:e {wedge x} {dyn ff} [Gb5 Gb6]:q!acc",
        "{ped c} [Eb1 Eb2]:q [Gb2 Bb2 Eb3]:q [Gb2 Bb2 Eb3]:q!acc")
bar(15, "{harm Gbmaj7} {dyn mf} Gb4:qd!ten Ab4:e!acc Bb4:q",
        "{ped c} [Gb1 Gb2]:q!acc [Db3 F3 Bb3]:q [Db3 F3 Bb3]:q")
bar(16, "{cresc} Db5:ed Eb5:s F5:q Ab5:q",
        "{ped c} Gb2:q [Bb2 Db3 F3]:q [Bb2 Db3 F3]:q")
bar(17, "{harm Db} {wedge x} {dyn f} Ab5:ed Bb5:s Db6:q F6:q",
        "{ped c} [Db1 Db2]:q [Ab2 Db3 F3]:q [Ab2 Db3 F3]:q!acc")
bar(18, "{cresc} F6:qd!acc Gb6:e Ab6:q!acc",
        "{ped c} [Db1 Db2]:q [Db3 F3 Ab3]:q [Db3 F3 Ab3]:q!acc")
bar(19, "{harm Ab7} {wedge x} {dyn ff} [Cn6 Cn7]:qd!acc Bb6:e Ab6:q",
        "{ped c} [Ab1 Ab2]:q!acc [Cn3 Eb3 Gb3]:q [Cn3 Eb3 Gb3]:q!acc")
bar(20, "{cresc} Gb6:s!acc F6:s Eb6:s Db6:s Cn6:s Bb5:s Ab5:s Gb5:s F5:s Eb5:s Db5:s Cn5:s",
        "{ped c} [Ab1 Ab2]:q!acc [Cn3 Eb3 Gb3]:q [Cn3 Eb3 Gb3]:q {ped x}", True)

# --- PAM PAM (21) ------------------------------------------------------------
bar(21, "{reh PAM PAM} {harm Gbmaj7/Cb} {wedge x} {dyn sfz} [Gb4 Bb4 Db5 F5]:q!stac "
        "{harm Cbmaj7} {dyn fff} [Gb4 Bb4 Cb5 Eb5]:h!fer",
        "[Cb1 Cb2]:q!stac {ped s} [Cb2 Gb2 Cb3]:h!fer")

# --- B (22-29): respuesta grave, M3 = inversion diatonica de M1 --------------
bar(22, "{reh B} {tempo 100 Meno mosso} {txt cupo, dalle tenebre} {harm Abm} {dyn p} "
        "Bb4:ed!acc Ab4:s Gb4:q Eb4:q",
        "{ped c} Ab1:q [Eb2 Ab2 Cb3]:q [Eb2 Ab2 Cb3]:q", True)
bar(23, "Gb4:ed F4:s Eb4:q Cb4:q",
        "Ab1:q [Eb2 Ab2 Cb3]:q [Eb2 Ab2 Cb3]:q", True)
bar(24, "{harm Cbmaj7} {dyn pp} Eb4:qd!ten Db4:e Cb4:q",
        "{ped c} Cb2:q [Gb2 Bb2 Eb3]:q [Gb2 Bb2 Eb3]:q", True)
bar(25, "Bb3:qd!ten Ab3:e Gb3:q",
        "Cb2:q [Gb2 Bb2 Eb3]:q [Gb2 Bb2 Eb3]:q", True)
bar(26, "{harm Gb} {dyn p} Bb3:ed Db4:s Gb4:q Db4:q",
        "{ped c} Gb1:q [Db2 Gb2 Bb2]:q [Db2 Gb2 Bb2]:q", True)
bar(27, "F4:ed Eb4:s Db4:q Bb3:q",
        "Gb1:q [Db2 Gb2 Bb2]:q [Db2 Gb2 Bb2]:q", True)
bar(28, "{harm Db7} {dyn pp} Cb4:qd!acc Bb3:e Ab3:q",
        "{ped c} Db2:q [Ab2 Cb3 F3]:q [Ab2 Cb3 F3]:q", True)
bar(29, "{tempo 88 poco rit.} F4:qd Ab3:e F3:q",
        "Db2:hd {ped x}", True)

# --- A' (30-37): retorno transformado (octavas, acento en el 2o tiempo) -----
bar(30, "{reh A'} {tempo 120 Tempo I} {harm Ebm} {dyn p} Eb4:ed F4:s Gb4:q Bb4:q",
        "{ped s} Eb2:q [Bb2 Eb3 Gb3]:q!acc [Bb2 Eb3 Gb3]:q", True)
bar(31, "Cb5:q!acc Eb5:e Gb5:e Bb5:q!acc",
        "{ped c} Eb2:q [Gb2 Bb2 Eb3]:q!acc [Gb2 Bb2 Eb3]:q")
bar(32, "{harm Gbmaj7} {dyn mp} F6:qd!ten Db6:e Bb5:q",
        "{ped c} Gb2:q [Db3 F3 Bb3]:q!acc [Db3 F3 Bb3]:q", True)
bar(33, "Ab5:ed Gb5:s F5:q Db5:q",
        "{ped c} Gb2:q [Bb2 Db3 F3]:q!acc [Bb2 Db3 F3]:q", True)
bar(34, "{harm Db} {dyn mf} [Ab4 Ab5]:ed [Bb4 Bb5]:s [Db5 Db6]:q [F5 F6]:q",
        "{ped c} [Db1 Db2]:q [Ab2 Db3 F3]:q [Ab2 Db3 F3]:q!acc")
bar(35, "{cresc} [F5 F6]:ed [Gb5 Gb6]:s [Ab5 Ab6]:q [Db6 Db7]:q",
        "{ped c} [Db1 Db2]:q [Db3 F3 Ab3]:q!acc [Db3 F3 Ab3]:q")
bar(36, "{harm Ab7} {wedge x} {dyn ff} [Cn6 Cn7]:qd!acc [Bb5 Bb6]:e [Ab5 Ab6]:q",
        "{ped c} [Ab1 Ab2]:q!acc [Cn3 Eb3 Gb3]:q [Cn3 Eb3 Gb3]:q!acc")
bar(37, "{dim} Gb6:e!acc F6:e Eb6:e Db6:e Cn6:e Bb5:e",
        "{ped c} [Ab1 Ab2]:q [Cn3 Eb3 Gb3]:q [Cn3 Eb3 Gb3]:q {ped x}", True)

# --- B' / coda (38-43): respuesta fragmentada, cierre abierto en Ab7(b9) -----
bar(38, "{reh B'} {tempo 100 Meno mosso} {txt dalla lontananza} {harm Abm} {wedge x} {dyn pp} "
        "Bb4:ed!ten Ab4:s Gb4:q Eb4:q",
        "{ped s} Ab1:q [Eb2 Ab2 Cb3]:q [Eb2 Ab2 Cb3]:q", True)
bar(39, "{harm Cbmaj7} Eb4:qd Db4:e Cb4:q",
        "{ped c} Cb2:q [Gb2 Bb2 Eb3]:q [Gb2 Bb2 Eb3]:q", True)
bar(40, "{harm Gb} Bb3:ed Db4:s Gb4:q r:q",
        "{ped c} Gb1:q [Db2 Gb2 Bb2]:q r:q", True)
bar(41, "{harm Db7} {tempo 88 poco rit.} Cb4:qd Bb3:e Ab3:q",
        "{ped c} Db2:q [Ab2 Cb3 F3]:q r:q", True)
bar(42, "{harm Ab7b9} {tempo 76 rit.} {dyn ppp} r:q An4:q!ten Gb4:q",
        "{ped c} Ab1:q [Cn3 Eb3 Gb3]:q [Cn3 Eb3 Gb3]:q")
bar(43, "[Gb4 An4 Cn5 Eb5]:hd!fer",
        "[Ab1 Ab2]:hd!fer {ped x}")

# ---------------------------------------------------------------------------
TOKEN = re.compile(r'\{[^}]*\}|\[[^\]]*\]\S*|\S+')


def parse_pitch(s):
    m = re.fullmatch(r'([A-G])([b#n]*)(\d)', s)
    if not m:
        raise ValueError('altura invalida: ' + s)
    step, acc, octv = m.group(1), m.group(2), int(m.group(3))
    alter = acc.count('#') - acc.count('b')
    return step, alter, octv, 12 * (octv + 1) + STEP[step] + alter


def parse_note_token(tok):
    head, rest = tok.split(':', 1)
    parts = rest.split('!')
    dur, mods = parts[0], parts[1:]
    if head == 'r':
        return {'rest': True, 'dur': DUR[dur], 'mods': mods, 'pitches': []}
    names = head[1:-1].split() if head.startswith('[') else [head]
    return {'rest': False, 'dur': DUR[dur], 'mods': mods, 'pitches': [parse_pitch(n) for n in names]}


def dir_xml(inner, staff, placement='below', sound=''):
    return (f'<direction placement="{placement}"><direction-type>{inner}</direction-type>'
            f'<staff>{staff}</staff>{sound}</direction>')


def pseudo_xml(body, staff):
    kind, _, arg = body.partition(' ')
    if kind == 'dyn':
        return dir_xml(f'<dynamics><{arg}/></dynamics>', staff)
    if kind == 'cresc':
        return dir_xml('<wedge type="crescendo" number="1"/>', staff)
    if kind == 'dim':
        return dir_xml('<wedge type="diminuendo" number="1"/>', staff)
    if kind == 'wedge':
        return dir_xml('<wedge type="stop" number="1"/>', staff)
    if kind == 'ped':
        t = {'s': 'start', 'c': 'change', 'x': 'stop'}[arg]
        sign = ' sign="yes"' if t == 'start' else ''
        return dir_xml(f'<pedal type="{t}" line="yes"{sign}/>', staff)
    if kind == 'reh':
        return dir_xml(f'<rehearsal enclosure="rectangle">{escape(arg)}</rehearsal>', staff, 'above')
    if kind == 'txt':
        return dir_xml(f'<words font-style="italic">{escape(arg)}</words>', staff, 'above')
    if kind == 'tempo':
        bpm, _, text = arg.partition(' ')
        inner = ''
        if text:
            inner += f'<words font-weight="bold">{escape(text)}</words>'
        parts = f'<direction-type>{inner}</direction-type>' if inner else ''
        metro = ''
        if text in ('Tempo di mazurka', 'Meno mosso', 'Tempo I'):
            metro = (f'<direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit>'
                     f'<per-minute>{bpm}</per-minute></metronome></direction-type>')
        return (f'<direction placement="above">{parts}{metro}<staff>{staff}</staff>'
                f'<sound tempo="{bpm}"/></direction>')
    if kind == 'harm':
        r, a, k, txt, bass, b9 = HARM[arg]
        x = f'<harmony><root><root-step>{r}</root-step><root-alter>{a}</root-alter></root>'
        x += f'<kind text="{txt}">{k}</kind>'
        if bass:
            x += f'<bass><bass-step>{bass[0]}</bass-step><bass-alter>{bass[1]}</bass-alter></bass>'
        if b9:
            x += ('<degree><degree-value>9</degree-value><degree-alter>-1</degree-alter>'
                  '<degree-type>add</degree-type></degree>')
        return x + f'<staff>{staff}</staff></harmony>'
    raise ValueError('pseudo-token desconocido: ' + body)


def render_staff(src, staff, voice, slur):
    toks = TOKEN.findall(src)
    notes = [i for i, t in enumerate(toks) if not t.startswith('{') and not t.startswith('r:')]
    first, last = (notes[0], notes[-1]) if slur and len(notes) > 1 else (-1, -1)
    out, total, rng, spans = [], 0, [], []
    for i, t in enumerate(toks):
        if t.startswith('{'):
            out.append(pseudo_xml(t[1:-1], staff))
            continue
        n = parse_note_token(t)
        typ, dots = TYPE[n['dur']]
        total += n['dur']
        if n['rest']:
            out.append(f'<note><rest/><duration>{n["dur"]}</duration><voice>{voice}</voice>'
                       f'<type>{typ}</type>{"<dot/>" * dots}<staff>{staff}</staff></note>')
            continue
        midis = [p[3] for p in n['pitches']]
        rng += midis
        spans.append(max(midis) - min(midis))
        for k, (step, alter, octv, _) in enumerate(n['pitches']):
            x = '<note>' + ('<chord/>' if k else '')
            x += f'<pitch><step>{step}</step>'
            x += f'<alter>{alter}</alter>' if alter else ''
            x += f'<octave>{octv}</octave></pitch><duration>{n["dur"]}</duration>'
            x += f'<voice>{voice}</voice><type>{typ}</type>{"<dot/>" * dots}<staff>{staff}</staff>'
            if k == 0:
                nt = ''
                if i == first:
                    nt += '<slur type="start" number="1"/>'
                if i == last:
                    nt += '<slur type="stop" number="1"/>'
                arts = ''.join({'acc': '<accent/>', 'stac': '<staccato/>', 'ten': '<tenuto/>'}[m]
                               for m in n['mods'] if m in ('acc', 'stac', 'ten'))
                if arts:
                    nt += f'<articulations>{arts}</articulations>'
                if 'fer' in n['mods']:
                    nt += '<fermata type="upright"/>'
                if nt:
                    x += f'<notations>{nt}</notations>'
            out.append(x + '</note>')
    return ''.join(out), total, rng, spans


def build():
    body, report = [], []
    for n in range(1, 44):
        rh, lh, slur = S[n]
        rx, rt, rrng, rsp = render_staff(rh, 1, 1, slur)
        lx, lt, lrng, lsp = render_staff(lh, 2, 5, False)
        if rt != BAR or lt != BAR:
            raise SystemExit(f'compas {n}: duraciones RH={rt} LH={lt}, esperado {BAR}')
        attrs = ''
        if n == 1:
            attrs = (f'<attributes><divisions>{DIV}</divisions><key><fifths>-6</fifths><mode>minor</mode></key>'
                     '<time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves>'
                     '<clef number="1"><sign>G</sign><line>2</line></clef>'
                     '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>')
        body.append(f'<measure number="{n}">{attrs}{rx}<backup><duration>{BAR}</duration></backup>{lx}</measure>')
        report.append((n, min(rrng + lrng) if rrng or lrng else None, max(rrng + lrng),
                       max(rsp + [0]), max(lsp + [0])))
    head = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
            '"http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0">'
            '<work><work-title>Mazurka Op. 1</work-title></work>'
            '<movement-title>Dark Chilean Mazurek - borrador de reconstrucción</movement-title>'
            '<identification><creator type="composer">Nelson (concepto y armonía) · reconstrucción melódica: Claude</creator>'
            '<encoding><software>build_mazurka.py</software><encoding-date>2026-10-28</encoding-date></encoding>'
            '</identification>'
            '<part-list><score-part id="P1"><part-name>Piano</part-name>'
            '<score-instrument id="P1-I1"><instrument-name>Piano</instrument-name></score-instrument>'
            '<midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument>'
            '</score-part></part-list><part id="P1">')
    return head + ''.join(body) + '</part></score-partwise>\n', report


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'Mazurka_Op1_reconstruccion.musicxml'
    xml, rep = build()
    with open(out, 'w', encoding='utf-8') as f:
        f.write(xml)
    worst_rh = max(r[3] for r in rep)
    worst_lh = max(r[4] for r in rep)
    print(f'OK: {len(rep)} compases de 3/4, todos suman {BAR} divisiones por mano -> {out}')
    print(f'Rango global MIDI: {min(r[1] for r in rep)}..{max(r[2] for r in rep)}')
    print(f'Mayor extension de acorde: RH {worst_rh} semitonos, LH {worst_lh} semitonos')
