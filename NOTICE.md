# Avisos de terceros

## mcp-musescore (MIT)

`plugin/composeanything.qml` es una obra derivada de [`musescore-mcp-websocket.qml`](https://github.com/ghchen99/mcp-musescore) de George Chen, licenciada MIT (copia de la licencia en `plugin/LICENSE-mcp-musescore`).

Cambios respecto al original: renombrado a ComposeAnything; parámetro `voice` en `addNote` y `addRest`; acciones nuevas `getCapabilities`, `clearStaffRange`, `addStaffText`, `addRehearsalMark`, `addHarmony`, `addDynamic`, `setKeySignature` y `addLyricsSyllabic`.

## Dependencias

| Paquete | Licencia |
|---|---|
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [ws](https://github.com/websockets/ws) | MIT |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | MIT |
| [Electron](https://github.com/electron/electron) (desarrollo) | MIT |

MuseScore es marca de MuseScore Limited y se distribuye por separado; ComposeAnything no incluye código de MuseScore.
