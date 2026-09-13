/**
 * The intentionally small allow-list for this benchmark.  Keep this separate
 * from test/llm: these are browser agents with different observation and
 * action contracts, not interchangeable text/tool-call models.
 */
export const MODEL_CATALOG = Object.freeze({
  compass: Object.freeze({
    label: 'WebBrain Compass Tiny v2',
    model: 'webbrain-one/webbrain-compass-tiny-v2',
    source: 'https://huggingface.co/webbrain-one/webbrain-compass-tiny-v2',
    observation: 'DOM accessibility text',
    protocol: 'WebBrain function calls (native XML or OpenAI tool_calls)',
  }),
  browserUse: Object.freeze({
    label: 'Browser Use BU-30B-A3B Preview',
    model: 'browser-use/bu-30b-a3b-preview',
    source: 'https://huggingface.co/browser-use/bu-30b-a3b-preview',
    observation: 'Browser Use indexed DOM plus screenshot',
    protocol: 'Browser Use JSON action object',
  }),
  fara4b: Object.freeze({
    label: 'Microsoft Fara1.5-4B',
    model: 'microsoft/Fara1.5-4B',
    source: 'https://huggingface.co/microsoft/Fara1.5-4B',
    observation: 'Screenshot only',
    protocol: 'Fara computer_use XML action block',
  }),
  fara9b: Object.freeze({
    label: 'Microsoft Fara1.5-9B',
    model: 'microsoft/Fara1.5-9B',
    source: 'https://huggingface.co/microsoft/Fara1.5-9B',
    observation: 'Screenshot only',
    protocol: 'Fara computer_use XML action block',
  }),
  fara27b: Object.freeze({
    label: 'Microsoft Fara1.5-27B',
    model: 'microsoft/Fara1.5-27B',
    source: 'https://huggingface.co/microsoft/Fara1.5-27B',
    observation: 'Screenshot only',
    protocol: 'Fara computer_use XML action block',
  }),
});

export const ADAPTER_MODELS = Object.freeze({
  compass: new Set([MODEL_CATALOG.compass.model]),
  'browser-use': new Set([MODEL_CATALOG.browserUse.model]),
  fara: new Set([
    MODEL_CATALOG.fara4b.model,
    MODEL_CATALOG.fara9b.model,
    MODEL_CATALOG.fara27b.model,
  ]),
});

export function catalogEntryForModel(model) {
  return Object.values(MODEL_CATALOG).find(entry => entry.model === model) || null;
}
