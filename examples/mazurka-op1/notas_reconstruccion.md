# Mazurka Op. 1 — borrador de reconstrucción (v1)

**Esto es una reconstrucción, no la partitura original.** El dossier no fija alturas melódicas; todas las notas de la melodía son decisiones nuevas.

## Archivos

| Archivo | Para qué |
|---|---|
| `Mazurka_Op1_reconstruccion.musicxml` | La partitura. En MuseScore: Archivo → Abrir (se abre en pestaña nueva, no toca otras hojas). |
| `Mazurka_Op1_reconstruccion.pdf` | Lectura rápida. |
| `Mazurka_Op1_reconstruccion.mp3` / `.mid` | Escucha con el sonido de MuseScore / MIDI. |
| `build_mazurka.py` | Generador: cada compás está escrito como texto y se puede retocar. |

## Forma (43 compases, 3/4, Mi bemol menor, 6 bemoles)

| Compases | Sección | Armonía | Qué pasa |
|---|---|---|---|
| 1–4 | Intro | Ebm · Ebm · Db · Ab7 | Quintas huecas `pp`, eco del motivo. Es la mitad final del ciclo. |
| 5–12 | A | Ebm · Gbmaj7 · Db · Ab7 (2 compases c/u) | Ascenso M1. Salto de octava al final del c.6 → llega a Gbmaj7 en el c.7. |
| 13–20 | A2 | igual, intensificada | Salto extremo (Sol♭5/6 en el c.14) y **caída de dos octavas** a Gbmaj7 (c.15). Escalada hasta Do7 (c.19) y cascada de semicorcheas (c.20). |
| 21 | PAM PAM | Gbmaj7/Cb → Cbmaj7 | 1.º golpe staccato `sfz` sin pedal; 2.º `fff` con pedal y fermata. |
| 22–29 | B | Abm · Cbmaj7 · Gb · Db7 | Respuesta grave y descendente. M3 = inversión diatónica de M1 (Mib-Fa-Solb-Sib → Sib-Lab-Solb-Mib). |
| 30–37 | A′ | Ebm · Gbmaj7 · Db · Ab7 | Retorno en octavas, acento en el 2.º tiempo, cascada final más lenta. |
| 38–43 | B′ / coda | Abm · Cbmaj7 · Gb · Db7 · Ab7(b9) | Respuesta fragmentada con silencios. Cierra **sin resolver** en Ab7(b9). |

## Qué es del dossier y qué es nuevo

- **Del dossier:** piano solo, 3/4, armadura de 6 bemoles, ambas progresiones, acompañamiento oom-pah-pah, PAM PAM (Gbmaj7/B → Bmaj7, escritos con Do♭ por la armadura), 43 compases, forma A–B–A–B′, salto del c.6 hacia Gbmaj7, cierre Ab7(b9).
- **Decisiones nuevas mías:** todas las alturas de la melodía, el reparto en compases de cada sección, los registros, los dos tempos (♩=120 y ♩=100), dinámicas, pedal, acentos y la longitud del fermata.
- **Sin verificar:** nada de esto se contrastó con el archivo original de Nelson.

## Puntos que conviene revisar al oírla

1. Tempo: 120 (A) y 100 (B). El dossier sugiere 120–140.
2. La caída c.14 → c.15 (Sol♭6 a Sol♭4, dos octavas): ¿suena a precipicio o es brusca?
3. El PAM PAM dura 2 s con el fermata; se puede alargar o acortar.
4. A′ repite A casi literal pero en octavas: ¿falta más transformación?
5. El final en Ab7(b9) con La natural arriba: ¿se queda suficientemente abierto?

## Conexión en vivo (opcional, aún no instalada)

El plugin de `mcp-musescore` solo escribe notas, silencios, compases, compás de 3/4 y tempo. **No** pone la armadura, dinámicas, acentos, pedal, ligaduras, cifrados ni fermatas, que son los que dan la identidad a esta pieza. Para usarlo hay que copiar `musescore-mcp-websocket.qml` a `Documentos\MuseScore4\Plugins`, activarlo en Plugins → Gestor de plugins y ejecutarlo, con una hoja en blanco ya creada con 6 bemoles y piano.
