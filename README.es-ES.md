<p align="center">
  <img src="assets/logo-mark.png" alt="Logotipo de WebBrain" width="92">
</p>

<h1 align="center">WebBrain</h1>

<p align="center">
  Agente de IA de cÃ³digo abierto para el navegador: conversa sobre pÃ¡ginas, automatiza tareas y ejecuta flujos de trabajo de varios pasos con el LLM que elijas.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Instala WebBrain desde Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="Instala WebBrain desde Complementos para Firefox"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="Instala WebBrain desde Complementos de Microsoft Edge"></a>
</p>

<p align="center">
  <a href="README.md">English</a> Â·
  <a href="README.zh-CN.md">ä¸­æ–‡</a> Â·
  <a href="README.fr.md">FranÃ§ais</a> Â·
  <a href="docs/">DocumentaciÃ³n</a> Â·
  <a href="https://webbrain.one">Sitio web</a> Â·
  <a href="https://discord.gg/cgC325ssfw">Discord</a> Â·
  <a href="LICENSE">GPL-3.0-or-later</a>
</p>

![WebBrain leyendo una pÃ¡gina, rellenando un formulario y obteniendo un archivo](assets/webbrain-demo.gif)

WebBrain es una extensiÃ³n del navegador que coloca un agente de IA en un panel lateral junto a
tus pestaÃ±as. PregÃºntale sobre la pÃ¡gina que estÃ¡s viendo o encÃ¡rgale una tarea y deja que haga clic,
escriba y navegue hasta completarla. Funciona con el modelo que elijas: un servidor local de
llama.cpp u Ollama, una API en la nube de un modelo de vanguardia o la opciÃ³n gestionada predeterminada,
que no necesita ninguna configuraciÃ³n.

## InstalaciÃ³n

InstÃ¡lalo desde [Chrome Web Store](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb),
[Complementos para Firefox](https://addons.mozilla.org/firefox/addon/webbrain/) o
[Complementos de Edge](https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo).

<details>
<summary><b>O cÃ¡rgalo desde el cÃ³digo fuente</b></summary>

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

**Chrome**: abre `chrome://extensions/`, activa el **Modo de desarrollador** (arriba a la
derecha), haz clic en **Cargar descomprimida** y selecciona la carpeta `webbrain/src/chrome`.

**Firefox**: abre `about:debugging#/runtime/this-firefox`, haz clic en **Cargar
complemento temporal** y selecciona `src/firefox/manifest.json`. Los complementos temporales
se eliminan al reiniciar Firefox; la instalaciÃ³n permanente requiere una firma a travÃ©s de
[addons.mozilla.org](https://addons.mozilla.org).

</details>

## Uso

Haz clic en el icono de WebBrain para abrir el panel lateral y escribe algo como:

- Â«Resume esta pÃ¡ginaÂ»
- Â«Busca todos los enlaces sobre preciosÂ»
- Â«Escribe â€œagentes de IAâ€ en el cuadro de bÃºsqueda y haz clic en BuscarÂ»
- Â«Ve a github.com y busca los repositorios en tendenciaÂ»

Hay tres modos que controlan lo que puede hacer el agente:

| Modo | QuÃ© puede hacer |
| --- | --- |
| **Ask** | Solo lectura. Lee la pÃ¡gina, responde a preguntas y obtiene contenido de URL. |
| **Act** | Hace clic, escribe, navega, sube y descarga archivos y rellena formularios. |
| **Dev** | AÃ±ade acceso al cÃ³digo fuente de la pÃ¡gina, los estilos, la consola y la red, asÃ­ como ediciones reversibles de la pÃ¡gina. |

## Elige un modelo

**WebBrain Compass 1.0** es la opciÃ³n predeterminada y no necesita clave de API ni configuraciÃ³n local.

Los **modelos locales** tampoco necesitan clave de API. Configura WebBrain para que se conecte a cualquier
servidor compatible con OpenAI:

```bash
llama-server -m your-model.gguf --port 8080          # llama.cpp
ollama serve                                          # Ollama  â†’ :11434/v1
vllm serve your-model --port 8000                     # vLLM    â†’ :8000/v1
python -m sglang.launch_server --model-path your-model --port 30000
```

LM Studio (`:1234/v1`), Jan (`:1337/v1`), LocalAI (`:8080/v1`) y GPT4All
(`:4891/v1`) funcionan del mismo modo. La ficha genÃ©rica **Local OpenAI-compatible Proxy**
tambiÃ©n admite pasarelas de bucle local con autenticaciÃ³n, como CLIProxyAPI; consulta la
[configuraciÃ³n segura del proxy de suscripciÃ³n](docs/providers-and-models.md#subscription-proxy-example-cliproxyapi).
**Unsloth Studio (Local)** utiliza la misma vÃ­a compatible con OpenAI, con el
puerto de Studio y la clave de API `sk-unsloth-` configurados por el usuario; consulta la
[configuraciÃ³n de Unsloth Studio](docs/providers-and-models.md#unsloth-studio).
Carga un modelo con una **ventana de contexto de al menos 16k tokens**: 8k solo funciona
con el nivel Compact, y 4k es insuficiente para el prompt del sistema y los esquemas de las
herramientas. WebBrain detecta automÃ¡ticamente la ventana real de llama.cpp, Ollama y LM
Studio, y compacta la conversaciÃ³n a medida que se llena. En Ollama,
llama.cpp, LM Studio y LocalAI, tambiÃ©n lee los metadatos nativos del servidor antes de
aÃ±adir capturas de pantalla; en Ajustes puedes elegir Auto, Force on y Off para controlar este comportamiento. Cuando
el campo opcional Model estÃ¡ vacÃ­o, se vuelven a comprobar las capacidades del modelo cargado en
cada turno del usuario, de modo que los cambios de modelo en caliente en el servidor surtan efecto. TambiÃ©n hay una
integraciÃ³n preliminar mediante `ollama launch webbrain --model <model>`. MÃ¡s informaciÃ³n:
[proveedores y modelos](docs/providers-and-models.md#local-providers).

**API en la nube**: OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, AWS
Bedrock, Mistral, DeepSeek, xAI Grok, MiniMax, Kimi, Qwen, z.ai GLM, Groq,
Together, Cloudflare, Nvidia NIM, Hugging Face, Fireworks, OpenRouter y muchos mÃ¡s.
Ajustes incluye **106 fichas de proveedores integradas en Chromium** (105 en Firefox),
entre ellas una opciÃ³n WebGPU local sin endpoint, con la configuraciÃ³n predefinida y probada de LFM2.5 2.6B,
y una opciÃ³n experimental para usar un repositorio ONNX personalizado de Hugging Face.
Consulta el [catÃ¡logo completo](docs/providers-and-models.md#extended-provider-catalog).

## Funciones

- **Lee cualquier pÃ¡gina**: texto, enlaces, formularios, tablas, PDF y elementos
  interactivos, mediante el Ã¡rbol de accesibilidad en lugar de selectores frÃ¡giles.
- **ActÃºa sobre ella**: hace clic, escribe, se desplaza, navega, sube y descarga archivos y verifica
  formularios, con solicitudes de permiso por sitio antes de realizar acciones con consecuencias.
- **Planifica antes de actuar**: Act y Dev pueden generar un plan estructurado, mostrarlo para
  su aprobaciÃ³n y fijarlo en el bloc de trabajo antes de ejecutar cualquier herramienta.
- **Agente de varios pasos**: bucle autÃ³nomo de uso de herramientas, configurable hasta 195 pasos
  (130 de forma predeterminada), con un botÃ³n para continuar al alcanzar el lÃ­mite.
- **Flujos de trabajo guardados**: convierte una ejecuciÃ³n satisfactoria en un flujo reutilizable,
  sin valores concretos incorporados, que puedes volver a ejecutar, exportar y compartir.
- **Tareas programadas y seguimientos**: `/schedule` para mÃ¡s adelante y `/watch` para consultar
  periÃ³dicamente una pÃ¡gina y actuar cuando se cumpla una condiciÃ³n.
- **Skills**: instrucciones y herramientas de confianza que solo se cargan cuando son pertinentes.
- **Contexto inteligente**: compactaciÃ³n automÃ¡tica basada en el nÃºmero de tokens, lÃ­mites para los resultados de
  las herramientas y recuperaciÃ³n de emergencia cuando se supera la capacidad del contexto.
- **Conversaciones por pestaÃ±a**: cada pestaÃ±a conserva su propio historial; memoria local opcional
  para las preferencias que indique el usuario.
- **Panel lateral pensado para leer**: respuestas de Ask en tiempo real, controles flotantes que
  mantienen tu pregunta a la vista a medida que crecen las respuestas, botones para copiar, un aviso de
  inspecciÃ³n de la pÃ¡gina y un botÃ³n de parada que funciona durante la ejecuciÃ³n.
- **Determinista de forma predeterminada**: temperatura `0.15` para las decisiones de control del navegador,
  `0.3` para Ask y `0` para las descripciones visuales de las capturas de pantalla.

## Herramientas del agente

WebBrain distingue entre **nivel** y **modo**. El nivel (`compact`, `mid`, `full`) es un
ajuste por proveedor que controla cuÃ¡ntas herramientas ve un modelo: Compact es adecuado para
modelos locales pequeÃ±os; Full desbloquea acciones como pasar el cursor, arrastrar y soltar, y trabajar con marcos y shadow DOM. El modo
(`ask`, `act`, `dev`) controla lo que permite el usuario.

La matriz completa de herramientas por nivel, las notas sobre WebMCP y los diagnÃ³sticos del modo Dev estÃ¡n en
[herramientas del agente](docs/agent-tools.md).

## Comandos con barra

Escribe `/help` en el panel para ver la sintaxis completa y las opciones. Estos son algunos de los mÃ¡s Ãºtiles:

| Comando | QuÃ© hace |
| --- | --- |
| `/ask` Â· `/act` Â· `/dev` Â· `/plan` | Cambia de modo antes de enviar el mensaje. |
| `/schedule [prompt]` | Crea una tarea programada. |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condiciÃ³n y acciÃ³n> [/beep]` | Consulta periÃ³dicamente la pÃ¡gina actual y actÃºa cuando se cumple una condiciÃ³n. |
| `/workflow` Â· `/workflow --save <nombre>` | Gestiona los flujos de trabajo guardados o convierte la Ãºltima ejecuciÃ³n satisfactoria en uno. |
| `/teach --start <nombre>` Â· `/teach --end` | Aprende un flujo de trabajo reutilizable a partir de las acciones que le muestras. |
| `/memory --add <texto>` | Guarda una preferencia del usuario. |
| `/screenshot [--full-page]` | Captura la pestaÃ±a o la pÃ¡gina completa, incluido el contenido fuera de la vista. |
| `/record [--transcribe]` | Graba la pestaÃ±a actual y, opcionalmente, guarda una transcripciÃ³n. |
| `/export [--traces \| --config]` | Descarga la conversaciÃ³n, la secuencia de herramientas o una copia de los ajustes. |
| `/compact` Â· `/reset` Â· `/verbose` | Compacta el contexto, borra la conversaciÃ³n o activa y desactiva los detalles de las herramientas. |
| `/allow-api` | Permite, solo en esta conversaciÃ³n, que `fetch_url` realice cambios cuando falla la interfaz. |

`/watch` realiza la primera comprobaciÃ³n de inmediato y despuÃ©s consulta la pÃ¡gina cada 60 segundos
(`--secs` admite valores de 30 a 120). Las condiciones relativas, como Â«cuando aparezca un nuevo commitÂ»,
establecen una referencia inicial en la primera comprobaciÃ³n; `--keep` mantiene el seguimiento activo y
suprime las alertas repetidas con la misma clave estable de evento.

Referencia completa, incluidos `/dangerously-skip-permissions` y los sufijos para capturar ejecuciones:
[comandos con barra](docs/slash-commands.md).

## Atajos de teclado

Los atajos del panel lateral de Chrome funcionan cuando el panel lateral de WebBrain tiene el foco.

| Atajo | QuÃ© hace |
| --- | --- |
| `Ctrl+/` o `Cmd+/` | Lleva el foco al campo de entrada. |
| `Ctrl+Shift+A` o `Cmd+Shift+A` | Cambia al modo Ask. |
| `Ctrl+Shift+X` o `Cmd+Shift+X` | Cambia al modo Act. |
| `Ctrl+Shift+D` o `Cmd+Shift+D` | Cambia al modo Dev. |
| `Escape` | Detiene la ejecuciÃ³n activa, salvo cuando solo cierra el autocompletado de comandos con barra. |
| `Escape` dos veces | Detiene una grabaciÃ³n activa desde WebBrain o desde las pÃ¡ginas del navegador. |

## DocumentaciÃ³n

| | |
| --- | --- |
| [Arquitectura](docs/architecture.md) | VisiÃ³n general del sistema, flujo de los turnos y subsistemas. |
| [Herramientas del agente](docs/agent-tools.md) | Niveles, modos y matriz completa de herramientas. |
| [Comandos con barra](docs/slash-commands.md) | Todos los comandos y sus opciones. |
| [Proveedores y modelos](docs/providers-and-models.md) | Las 105 fichas de proveedores, configuraciÃ³n local y niveles. |
| [Skills](docs/skills.md) | Skills incluidas, importaciÃ³n y herramientas de skills. |
| [Modelo de seguridad](docs/security-model.md) | Permisos, credenciales y lÃ­mites de confianza. |
| [Defensa frente a la inyecciÃ³n de prompts](docs/prompt-injection-defense.md) | Capas de defensa y carencias conocidas. |
| [Privacidad y flujo de datos](docs/privacy-and-data-flow.md) | QuÃ© sale del navegador y quÃ© permanece en Ã©l. |
| [Ãrbol de accesibilidad y referencias](docs/accessibility-tree-and-refs.md) | CÃ³mo se leen las pÃ¡ginas y se identifican los elementos sobre los que actuar. |
| [Adaptadores de sitios](docs/site-adapters.md) | Instrucciones por sitio y contratos versionados de flujos de trabajo. |
| [Formatos de exportaciÃ³n y flujos de trabajo](docs/export-and-workflow-formats.md) | `webbrain-config/1`, `webbrain-workflow/1`. |
| [AÃ±adir una herramienta](docs/adding-a-tool.md) Â· [LocalizaciÃ³n](docs/localization.md) Â· [Escenarios de prueba](docs/test-scenarios.md) | GuÃ­as para colaboradores. |
| [Comunidad](docs/community.md) | GuÃ­a del servidor de Discord: canales, roles, normas y vÃ­as de escalado. |

TambiÃ©n disponible en [ä¸­æ–‡](docs/zh-CN/) y [FranÃ§ais](docs/fr/).

## Comunidad

Habla de todo lo relacionado con WebBrain â€”ayuda, configuraciÃ³n de modelos locales y en la nube, adaptadores de
sitios, demostraciones y coordinaciÃ³n entre colaboradoresâ€” en el
[Discord de WebBrain](https://discord.gg/cgC325ssfw). Consulta
[comunidad](docs/community.md) para conocer la organizaciÃ³n del servidor y
[discord-setup](docs/discord-setup.md) para ver la configuraciÃ³n de los canales, los roles y la pantalla de bienvenida.
Los informes de errores y las solicitudes de funciones deben publicarse en las
[incidencias de GitHub](https://github.com/webbrain-one/webbrain/issues), no en Discord.

## Estructura del repositorio

```
src/chrome/       VersiÃ³n Manifest V3: service worker, chrome.scripting, sidePanel
src/firefox/      VersiÃ³n Manifest V2: pÃ¡gina en segundo plano, executeScript, sidebar_action
docs/            DocumentaciÃ³n de diseÃ±o y referencia (en, zh-CN, fr)
mcp-server/      Servidor MCP: delega tareas del navegador desde Claude Code, Codex y Cursor
lmstudio-plugin/ Herramientas web y delegaciÃ³n al navegador como plugin independiente de LM Studio
web/             Sitio de presentaciÃ³n y sitio de documentaciÃ³n
test/            Suite de pruebas de Node, benchmarks de escenarios con LLM y corpus de seguridad
```

Casi todo el cÃ³digo del agente se comparte entre ambas versiones. Consulta
[arquitectura](docs/architecture.md#chrome-vs-firefox-key-differences) para conocer
sus diferencias.

## Problemas conocidos

**La versiÃ³n para Firefox tiene bastantes mÃ¡s limitaciones que la de Chrome.** Firefox no tiene un equivalente al
Chrome DevTools Protocol a travÃ©s de `chrome.debugger`, por lo que su versiÃ³n no permite
atravesar el shadow DOM, generar eventos reales de ratÃ³n de confianza (algunos manejadores de React/Vue no
se activan), recorrer raÃ­ces shadow cerradas, disponer de un margen de reintentos de `resolveSelector`,
reintentar teniendo en cuenta la navegaciÃ³n de las SPA ni obtener capturas mediante CDP. Utiliza `tabs.captureTab`
para capturar el Ã¡rea visible, incluidas las pestaÃ±as de ejecuciÃ³n inactivas, pero sigue sin poder ofrecer
las capturas de precisiÃ³n de pÃ­xel o de pÃ¡gina completa que proporciona CDP en Chrome. Los adaptadores de sitios, la detecciÃ³n
visual, la detecciÃ³n de bucles, el bucle de capturas automÃ¡ticas y el conjunto de prompts y herramientas de Compact
_sÃ­_ estÃ¡n presentes en Firefox. Algunas aplicaciones de pÃ¡gina Ãºnica tambiÃ©n pueden no activar
la reinyecciÃ³n de los scripts de contenido tras una navegaciÃ³n del lado del cliente.

## CÃ³mo contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md). Para aÃ±adir una herramienta, sigue la lista de comprobaciÃ³n de
[aÃ±adir una herramienta](docs/adding-a-tool.md). Para aÃ±adir un proveedor, crea una subclase de
`BaseLLMProvider`, implementa `chat()` (y, opcionalmente, `chatStream()`) y
regÃ­strala en `providers/manager.js`, replicando ambos cambios en
`src/chrome/` y `src/firefox/`. Todos los proveedores normalizan sus respuestas al formato
`{ content, toolCalls, usage }`; encontrarÃ¡s mÃ¡s informaciÃ³n en
[proveedores y modelos](docs/providers-and-models.md#adding-a-provider).

Los cambios recientes estÃ¡n en [CHANGELOG.md](CHANGELOG.md).

## Servidor MCP

Permite que un agente de programaciÃ³n utilice *tu* navegador. Claude Code, Codex, Cursor y OpenClaw
pueden delegar una tarea en WebBrain, que se ejecuta en la sesiÃ³n en la que ya has iniciado
sesiÃ³n: con las cookies disponibles y la autenticaciÃ³n SSO ya completada. Un framework sin interfaz grÃ¡fica
arranca sin sesiÃ³n y se bloquea en la primera pantalla de acceso; aquÃ­ eso no ocurre.

```bash
claude mcp add --transport stdio webbrain -- npx -y @webbrain/mcp-server
```

Claude Code inicia el servidor automÃ¡ticamente al comenzar una sesiÃ³n MCP.
Si prefieres iniciarlo tÃº, ejecuta el siguiente comando y deja ese terminal
abierto (pulsa `Ctrl+C` para detenerlo):

```bash
npx -y @webbrain/mcp-server
```

Con el servidor en marcha, abre **WebBrain â†’ Settings â†’ General â†’ Advanced â†’
MCP**, establece la URL en `ws://127.0.0.1:17374/extension` y actÃ­valo.
**Solo en Chromium**: el entorno de ejecuciÃ³n del control y del puente utiliza el documento fuera de pantalla
de la extensiÃ³n, del que no dispone la versiÃ³n para Firefox.

Si en Ajustes aparece **Connection error: WebSocket error**, normalmente significa que no hay ningÃºn proceso
escuchando en la URL configurada. Inicia el servidor MCP, comprueba que la URL utiliza
el puerto `17374` y deja su proceso en ejecuciÃ³n. Consulta la
[guÃ­a de resoluciÃ³n de problemas de `mcp-server`](mcp-server/README.md#troubleshooting) para
comprobar si hay un proceso a la escucha y conocer los demÃ¡s puertos del puente.

```
webbrain_run(task: "abre el panel de Stripe y enumera los pagos fallidos de la semana
             pasada con sus importes y los correos electrÃ³nicos de los clientes", mode: "ask")
```

Utiliza `webbrain_extract` con un esquema JSON cuando quien realiza la llamada necesite una salida
estructurada y predecible en lugar de un resumen en prosa. El servidor expone seis herramientas a nivel de
tarea: ejecuciÃ³n, extracciÃ³n estructurada, estado, respuesta a una solicitud de aclaraciÃ³n, cancelaciÃ³n y
diagnÃ³stico de conexiÃ³n.

`mode='ask'` es de solo lectura. `mode='act'` puede hacer clic y escribir, sujeto a las mismas
solicitudes de aprobaciÃ³n en el navegador que recibe una persona. El servidor permite delegar tareas
en lugar de exponer las aproximadamente 50 operaciones bÃ¡sicas del navegador: el control de permisos de WebBrain
reside en el bucle del agente, por lo que acceder a cada operaciÃ³n a travÃ©s de un socket quedarÃ­a por debajo
de ese control y lo eludirÃ­a. MÃ¡s informaciÃ³n en [`mcp-server/`](mcp-server/).

La configuraciÃ³n completa de los clientes, los argumentos de las herramientas, el ciclo de vida de las ejecuciones,
los ejemplos de salida estructurada, los lÃ­mites de seguridad y la guÃ­a de resoluciÃ³n de problemas estÃ¡n en
[`web/docs/mcp/`](web/docs/mcp/).

> La extensiÃ³n mantiene **un solo** socket de puente a la vez: WebBrain Cloud (17373),
> el servidor MCP (17374) o el plugin de LM Studio (17375). Para cambiar de uno a otro, modifica
> la URL en **Settings â†’ General â†’ Advanced â†’ MCP**.

## Plugin de LM Studio

Un plugin independiente de [LM Studio](https://lmstudio.ai), disponible en
[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools):

```bash
lms clone webbrain/web-tools
```

`fetch_url` y `research_url` utilizan Ãºnicamente HTTP en Node: no necesitan navegador, pero tampoco
tienen cookies, sesiÃ³n ni JavaScript. Con la extensiÃ³n instalada en un navegador
Chromium, `browser_task` permite delegar tareas en tu navegador real con la sesiÃ³n iniciada,
para acceder a pÃ¡ginas autenticadas y renderizadas en el cliente a las que no puede llegar HTTP por sÃ­ solo.
Si no hay ninguna extensiÃ³n conectada, muestra un mensaje que indica cÃ³mo resolverlo; las herramientas HTTP
siguen funcionando en Firefox.

CÃ³digo fuente: [`lmstudio-plugin/`](lmstudio-plugin/).

## Colaboradores

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## CÃ³mo citar

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {WebBrain: Open-source AI browser agent for chatting with pages},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## Licencia

WebBrain 33.0.0 y las versiones posteriores se distribuyen bajo la licencia
[GPL-3.0-or-later](LICENSE), ya que la extensiÃ³n del navegador incluye
e integra el entorno de ejecuciÃ³n WebAssembly de Xapian/libzim, con licencia GPL. Las versiones
anteriores a la 33.0.0 conservan la licencia MIT que se aplicaba cuando se
publicaron; ese texto histÃ³rico se conserva en [LICENSES/MIT.txt](LICENSES/MIT.txt).

Creado con â¤ï¸ por [Emre Sokullu](https://emresokullu.com) y los [colaboradores de cÃ³digo abierto](https://github.com/webbrain-one/webbrain/graphs/contributors).

?
