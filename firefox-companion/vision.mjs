// Only the extension's native-messaging host can call these constrained
// operations. A run is bound to one top-level browser context by openRun.
// No page element lookup or synthetic DOM input is used after that binding.
const VIEWPORT = `(() => {
  const v = globalThis.visualViewport;
  return JSON.stringify({ width: v?.width || innerWidth, height: v?.height || innerHeight,
    offsetLeft: v?.offsetLeft || 0, offsetTop: v?.offsetTop || 0,
    scrollX: v?.pageLeft ?? scrollX, scrollY: v?.pageTop ?? scrollY,
    scale: v?.scale || 1, zoom: 1, devicePixelRatio: devicePixelRatio || 1,
    url: location.href, documentId: String(performance.timeOrigin), platform: navigator.platform || '' });
})()`;
function runFor(session, id) {
  const run = session.runs.get(id);
  if (!run) throw new Error('Firefox vision run stopped or disconnected');
  return run;
}
export async function readVisionViewport(session, id) {
  const run = runFor(session, id);
  const result = await session.send('script.evaluate', {
    target: { context: run.context }, expression: VIEWPORT, awaitPromise: false,
  });
  if (session.runs.get(id) !== run) throw new Error('Firefox vision run changed');
  const viewport = JSON.parse(result?.result?.value || 'null');
  if (!viewport || !Number.isFinite(viewport.width) || viewport.width <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0)
    throw new Error('Cannot read Firefox viewport geometry');
  return viewport;
}
function sameViewport(before, after) {
  return before?.url === after?.url && before?.documentId === after?.documentId
    && ['width', 'height', 'offsetLeft', 'offsetTop', 'scrollX', 'scrollY', 'scale', 'devicePixelRatio'].every(key =>
      Number.isFinite(before?.[key]) && Math.abs(before[key] - after[key]) < 0.01);
}
export async function captureVision(session, id) {
  const run = runFor(session, id);
  const before = await readVisionViewport(session, id);
  const capture = await session.send('browsingContext.captureScreenshot', {
    context: run.context, origin: 'viewport', format: { type: 'image/png' },
  });
  if (!sameViewport(before, await readVisionViewport(session, id))) throw new Error('Page changed during screenshot capture');
  return capture;
}
const KEY_VALUES = { Alt: '\uE00A', Control: '\uE009', Meta: '\uE03D', Shift: '\uE008',
  Enter: '\uE007', Tab: '\uE004', Escape: '\uE00C', Backspace: '\uE003', Delete: '\uE017',
  Insert: '\uE016', Home: '\uE011', End: '\uE010', PageUp: '\uE00E', PageDown: '\uE00F',
  ArrowLeft: '\uE012', ArrowUp: '\uE013', ArrowRight: '\uE014', ArrowDown: '\uE015' };
function keyValue(key) {
  if (KEY_VALUES[key]) return KEY_VALUES[key];
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return String.fromCharCode(0xE030 + Number(key.slice(1)));
  if (typeof key === 'string' && [...key].length === 1) return key;
  throw new Error('Unsupported Firefox vision key');
}
export async function performVisionInput(session, id, method, params, expected, release = false) {
  let dispatched = false;
  try {
    const run = runFor(session, id);
    const isRelease = method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp'
      || method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased';
    if (release && !isRelease) throw new Error('Only held input may bypass the vision frame fence');
    const viewport = release ? expected : await readVisionViewport(session, id);
    if (!release && !sameViewport(expected, viewport)) throw new Error('Screenshot frame is stale; capture again');
    let actions;
    if (method === 'Input.dispatchMouseEvent') {
      const button = { left: 0, middle: 1, right: 2 }[params.button];
      const point = { x: Math.round(params.x), y: Math.round(params.y) };
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) throw new Error('Invalid Firefox pointer coordinates');
      if (!release && (point.x < viewport.offsetLeft || point.y < viewport.offsetTop
        || point.x >= viewport.width + viewport.offsetLeft || point.y >= viewport.height + viewport.offsetTop))
        throw new Error('Pointer coordinates are outside the screenshot');
      const move = { type: 'pointerMove', ...point, origin: 'viewport', duration: 0 };
      if (params.type === 'mouseWheel') {
        if (![params.deltaX, params.deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) throw new Error('Invalid wheel delta');
        actions = [{ type: 'wheel', id: 'webbrain-vision-wheel', actions: [{ type: 'scroll', ...point, origin: 'viewport',
          deltaX: Math.round(params.deltaX), deltaY: Math.round(params.deltaY), duration: 100 }] }];
      } else {
        if (!['mouseMoved', 'mousePressed', 'mouseReleased'].includes(params.type)
          || params.type !== 'mouseMoved' && button === undefined) throw new Error('Invalid pointer action');
        actions = [{ type: 'pointer', id: 'webbrain-vision-pointer', parameters: { pointerType: 'mouse' }, actions:
          params.type === 'mouseReleased' ? [{ type: 'pointerUp', button }]
            : params.type === 'mousePressed' ? [move, { type: 'pointerDown', button }] : [move] }];
      }
    } else if (method === 'Input.dispatchKeyEvent') {
      if (!['rawKeyDown', 'keyDown', 'keyUp'].includes(params.type)) throw new Error('Invalid key event');
      actions = [{ type: 'key', id: 'webbrain-vision-keyboard', actions: [{ type: params.type === 'keyUp' ? 'keyUp' : 'keyDown', value: keyValue(params.key) }] }];
    } else if (method === 'Input.insertText') {
      if (typeof params.text !== 'string' || params.text.length > 16000) throw new Error('Invalid vision text');
      if (/[\uE000-\uE05D]/u.test(params.text)) throw new Error('Reserved WebDriver control characters are not literal text');
      // Literal line breaks are Unicode text, never the WebDriver Enter/Tab
      // control keys: typing a message must not submit it or move focus.
      const keys = [...params.text.replace(/\r\n?/g, '\n')].flatMap(value =>
        [{ type: 'keyDown', value }, { type: 'keyUp', value }]);
      actions = [{ type: 'key', id: 'webbrain-vision-keyboard', actions: keys }];
    } else throw new Error('Unsupported vision input command');
    if (session.runs.get(id) !== run) throw new Error('Firefox vision run stopped');
    dispatched = true;
    await session.send('input.performActions', { context: run.context, actions });
    return { success: true, dispatched: true };
  } catch (error) {
    // Release all held input when a native delivery fails, without retrying it.
    if (dispatched) {
      const run = session.runs.get(id);
      if (run) await session.send('input.releaseActions', { context: run.context }).catch(() => {});
    }
    error.dispatchState = { dispatched, noDispatch: !dispatched, outcomeUnknown: dispatched, retryable: !dispatched };
    throw error;
  }
}
