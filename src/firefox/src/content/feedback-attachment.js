(() => {
  if (globalThis.__webbrainFeedbackAttachment) return;
  globalThis.__webbrainFeedbackAttachment = true;
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const destination = () => location.origin === 'https://github.com'
    && location.pathname === '/webbrain-one/webbrain/issues/new';
  if (!destination()) return;
  let draft, busy = false, banner, message, retryButton, downloadButton;
  const send = async (action, extra = {}) => {
    const result = await api.runtime.sendMessage({ target: 'background', action, id: draft?.id, token: draft?.token, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Feedback handoff failed.');
    return result;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function editor() {
    const scope = document.querySelector('main') || document.body;
    return scope.querySelector('textarea[name="issue[body]"], textarea#issue_body')
      || [...scope.querySelectorAll('textarea')].find(input => !input.disabled && !input.readOnly);
  }
  function fileInput(input) {
    if (!input) return null;
    for (const scope of [input.closest('file-attachment'), input.closest('form'), document.querySelector('main')]) {
      if (!scope) continue;
      const candidates = [...scope.querySelectorAll('input[type="file"]')].filter(field => !field.disabled);
      if (candidates.length === 1) return candidates[0];
    }
    return null;
  }
  function attached(input) {
    // An arbitrary link or the filename by itself is not upload evidence.
    return [...String(input?.value || '').matchAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g)].some(match => {
      try {
        const url = new URL(match[2]);
        return match[1] === draft.filename && url.origin === 'https://github.com'
          && (url.pathname.startsWith('/user-attachments/files/') || url.pathname.startsWith('/files/'));
      } catch { return false; }
    });
  }
  function show(text, failed = false) {
    message.textContent = text;
    retryButton.hidden = !failed || !draft.includeTrace;
    downloadButton.hidden = !failed || !draft.includeTrace;
  }
  function createBanner() {
    banner = document.createElement('aside');
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;max-width:420px;padding:16px;border:1px solid #8b949e;border-radius:8px;background:#fff;color:#24292f;box-shadow:0 4px 24px #0003;font:14px/1.5 system-ui';
    message = document.createElement('p'); message.style.margin = '0 0 8px';
    retryButton = document.createElement('button'); retryButton.type = 'button';
    retryButton.textContent = draft.copy.retry || 'Retry attachment'; retryButton.hidden = true;
    retryButton.addEventListener('click', async () => {
      if (busy) return;
      retryButton.disabled = true;
      try { await send('feedback_retry'); await upload(); }
      catch (error) { show(error.message, true); }
      finally { retryButton.disabled = false; }
    });
    downloadButton = document.createElement('button'); downloadButton.type = 'button';
    downloadButton.textContent = draft.copy.download || 'Download trace'; downloadButton.hidden = true;
    downloadButton.addEventListener('click', () => void send('feedback_preview').catch(error => show(error.message, true)));
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×';
    close.setAttribute('aria-label', draft.copy.close || 'Close');
    close.style.cssText = 'float:right;margin-left:8px'; close.addEventListener('click', () => banner.remove());
    banner.append(close, message, retryButton, downloadButton); document.body.append(banner);
  }
  async function waitForEditor() {
    for (let attempt = 0; attempt < 120 && destination(); attempt++) {
      const input = editor();
      if (input) return input;
      await sleep(250);
    }
    throw new Error(draft.copy.failed || 'The GitHub editor is not available.');
  }
  async function complete() {
    await send('feedback_result', { success: true });
    show(draft.copy.ready || 'Trace attached. Review and submit your feedback on GitHub.');
  }
  async function upload() {
    if (busy || !destination()) return;
    busy = true;
    try {
      const input = await waitForEditor();
      if (attached(input)) { await complete(); return; }
      show(draft.copy.uploading || 'Attaching your trace. Please wait before submitting the issue.');
      const chunks = [];
      for (let offset = 0; offset < draft.size; offset += draft.chunkBytes) {
        if (!destination()) throw new Error('The feedback destination changed.');
        const response = await send('feedback_chunk', { offset });
        const binary = atob(response.base64);
        chunks.push(Uint8Array.from(binary, character => character.charCodeAt(0)));
      }
      let target;
      for (let attempt = 0; attempt < 80 && destination(); attempt++) {
        target = fileInput(editor());
        if (target) break;
        await sleep(250);
      }
      if (!target || !destination()) throw new Error(draft.copy.failed || 'The GitHub upload control is not available.');
      await send('feedback_upload_started');
      const transfer = new DataTransfer();
      transfer.items.add(new File(chunks, draft.filename, { type: draft.mimeType || 'application/json' }));
      target.files = transfer.files;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      for (let attempt = 0; attempt < 240 && destination(); attempt++) {
        if (attached(editor())) { await complete(); return; }
        await sleep(250);
      }
      throw new Error(draft.copy.failed || 'The trace attachment could not be confirmed.');
    } catch (error) {
      await send('feedback_result', { success: false }).catch(() => {});
      show(draft.copy.failed || error.message, true);
    } finally { busy = false; }
  }
  void (async () => {
    draft = await send('feedback_claim');
    draft.copy ||= {};
    createBanner();
    const input = await waitForEditor();
    // React listens to native input events. Never replace text the user edited.
    if (!input.value || input.value.trim() === draft.initialBody.trim()) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, draft.body);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (!draft.includeTrace) {
      await send('feedback_result', { success: true });
      show(draft.copy.draftReady || 'Review and submit your feedback on GitHub.');
    } else if (attached(input)) await complete();
    else if (draft.status === 'uploading' || draft.status === 'failed') show(draft.copy.failed || 'Check the draft, then retry the attachment if needed.', true);
    else await upload();
  })().catch(error => {
    if (banner) show(draft?.copy?.failed || error.message, true);
    else globalThis.__webbrainFeedbackAttachment = false;
  });
})();
