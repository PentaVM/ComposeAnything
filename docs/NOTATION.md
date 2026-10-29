# Notación de ComposeAnything

La obra se guarda como un texto compacto por compás y pentagrama. Es lo que la IA lee y escribe (`score_read` / `score_write`).

```
Eb4:ed!acc F4:s Gb4:q Bb4:q          melodía
[Bb2 Eb3 Gb3]:q                      acorde
r:q                                  silencio
{harm Ebm} {dyn p} {txt cantabile}   directivas (no ocupan tiempo)
```

## Alturas

Letra + `b`/`#`/`n` + octava científica: `C4` es el do central, `Eb4`, `F#3`, `Cn5` (natural). Se escribe con la **grafía de la armadura**: en 6 bemoles, `Cb5` y no `B4`. `Cb5` suena como si.

## Duraciones

| Código | Valor | Unidades (1 negra = 24) |
|---|---|---|
| `w` | redonda | 96 |
| `hd` / `h` | blanca con puntillo / blanca | 72 / 48 |
| `qd` / `q` | negra con puntillo / negra | 36 / 24 |
| `ed` / `e` | corchea con puntillo / corchea | 18 / 12 |
| `sd` / `s` | semicorchea con puntillo / semicorchea | 9 / 6 |
| `t` | fusa | 3 |

Cada voz de cada compás debe sumar **exactamente** el compás (3/4 = 72 unidades). Si no, `score_write` rechaza el bloque entero y dice cuánto falta o sobra.

## Marcas (tras la duración)

`!acc` acento · `!stac` staccato · `!ten` tenuto · `!marc` marcato · `!fer` fermata · `!ts` ligadura de unión con la siguiente nota igual · `!s(` / `!s)` ligadura de frase · `!l=Glo-` letra del verso 1 (guion final = la palabra continúa) · `!l2=` verso 2.

## Directivas

| Directiva | Efecto |
|---|---|
| `{harm Ebm}` `{harm Gbmaj7/Cb}` `{harm Ab7b9}` | cifrado de acordes |
| `{dyn mp}` | dinámica (`pppp` … `ffff`, `sf`, `sfz`, `fp`…) |
| `{cresc}` `{dim}` `{wedge x}` | regulador; `{wedge x}` lo cierra |
| `{ped s}` `{ped c}` `{ped x}` | pedal: pisar, cambiar, soltar |
| `{txt cantabile}` | texto de expresión |
| `{reh A}` | marca de ensayo |
| `{tempo 120 Allegro}` | tempo visible y de reproducción |
| `{play 88}` | cambia solo la reproducción (útil para un *rit.*) |

## Voces y pentagramas

Varias voces en un pentagrama se separan con `||`: `Bb4:hd || Eb4:hd`. Los pentagramas se numeran de arriba abajo en toda la obra:

| Plantilla | Pentagramas |
|---|---|
| `piano` | 1 mano derecha · 2 mano izquierda |
| `satb_open` | 1 soprano · 2 alto · 3 tenor · 4 bajo |
| `satb_closed` | 1 (soprano `||` alto) · 2 (tenor `||` bajo) |
| `voice_piano` | 1 voz · 2 piano MD · 3 piano MI |

## Ejemplo: un compás de mazurka en 3/4

```json
{ "measures": [{ "n": 5, "staves": {
  "1": "{harm Ebm} {dyn p} Eb4:ed F4:s Gb4:q Bb4:q",
  "2": "{ped s} Eb2:q [Bb2 Eb3 Gb3]:q [Bb2 Eb3 Gb3]:q"
}}]}
```

Más ejemplos reales en `examples/mazurka-op1/` (el MusicXML se importa con `score_import`).
