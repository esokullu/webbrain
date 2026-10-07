// Executed in the document in both browsers. Only the fingerprint leaves it.
// Visible text and values alone omit checked, disabled and ARIA state.
export function completionDocumentStamp() {
  const states = [];
  for (const element of document.querySelectorAll('*')) {
    const attributes = Array.from(element.attributes).filter(attribute =>
      attribute.name.startsWith('aria-') || ['role', 'hidden', 'inert', 'disabled', 'readonly', 'required'].includes(attribute.name));
    if (!attributes.length && !/^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON)$/.test(element.tagName)) continue;
    states.push([element.tagName, element.id, element.value, element.checked, element.indeterminate,
      element.disabled, element.readOnly, element.selected, element.selectedIndex,
      attributes.map(attribute => [attribute.name, attribute.value]).sort()]);
    if (states.length >= 1000) break;
  }
  const text = (document.body?.innerText || '').slice(0, 20000) + JSON.stringify(states);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return [location.href, performance.timeOrigin, text.length, hash].join('|');
}

export const COMPLETION_DOCUMENT_STAMP_SCRIPT = `(${completionDocumentStamp.toString()})()`;
// Document identity is separate from evidence freshness: unrelated page text
// must not invalidate an observation that did not include it.
export const COMPLETION_DOCUMENT_IDENTITY_SCRIPT = '[location.href, performance.timeOrigin].join("|")';
