import {
  normalizeRichTextToolbarAudit,
  richTextToolbarDecision,
  richTextToolbarEditorIdentityMatches,
  richTextToolbarPresetMatch,
  richTextToolbarRecoveryScopeMatches,
  richTextToolbarTextShape,
} from '../../src/chrome/src/agent/rich-text-toolbar-guard.js';

export function registerRichTextToolbarFixtures({
  test,
  setupContentHtml,
  setupContentFixture,
  call,
  Agent,
  FirefoxAgent,
  cdpClient,
  root,
}) {
  const toolbarLedgerView = (agent, tabId) => {
    const recoveryObligations = agent._richTextToolbarGuard.obligations(tabId);
    if (!recoveryObligations.length) return null;
    const primary = recoveryObligations[0];
    return {
      ...primary,
      recoveryObligations,
      blockedRefs: new Set(recoveryObligations.flatMap(obligation => obligation.blockedRefs || [])),
      blockedSelectors: new Set(recoveryObligations.flatMap(obligation => obligation.blockedSelectors || [])),
      blockedRegionRefs: new Set(recoveryObligations.flatMap(obligation => obligation.blockedRegionRefs || [])),
    };
  };

  for (const browserKind of ['chrome', 'firefox']) {
    test(`${browserKind}: compact native composer stays outside rich-text toolbar audit`, async (page) => {
      await setupContentHtml(page, `<!doctype html>
        <div style="display:flex;align-items:center;gap:6px;width:320px;height:44px">
          <input id="native-composer" type="text" style="width:190px;height:28px">
          <button type="button">Send</button>
        </div>`, browserKind);
      await page.focus('#native-composer');
      const probe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { text: 'Quarterly roadmap' },
      });
      if (
        !probe?.resolved
        || probe.fieldMeta?.type !== 'text'
        || probe.fieldMeta?.toolbarCandidate
      ) {
        throw new Error(`compact native composer must stay outside formatting audit: ${JSON.stringify(probe)}`);
      }
    });

    test(`${browserKind}: ordinary compact form controls stay outside a widened toolbar region`, async (page) => {
      await setupContentHtml(page, `<!doctype html>
        <style>
          body { margin: 20px; font: 16px sans-serif; }
          #ordinary-form { width: 720px; height: 60px; display: flex; align-items: center; gap: 8px; }
          #quantity { width: 22px; height: 16px; }
          #title { width: 240px; height: 24px; }
        </style>
        <form id="ordinary-form">
          <input id="quantity" value="11">
          <input id="title" aria-label="Title">
          <button id="save" type="button">Save</button>
        </form>`, browserKind);
      const refs = await page.evaluate(() => ({
        form: window.__wb_ax_ref(document.querySelector('#ordinary-form')),
        quantity: window.__wb_ax_ref(document.querySelector('#quantity')),
        title: window.__wb_ax_ref(document.querySelector('#title')),
        save: window.__wb_ax_ref(document.querySelector('#save')),
      }));
      const quantityProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.quantity, text: 'Document prose' },
      });
      const candidate = quantityProbe?.fieldMeta?.toolbarCandidate;
      if (
        !candidate
        || candidate.regionRef === refs.form
        || candidate.relatedRefs?.includes(refs.title)
        || candidate.relatedRefs?.includes(refs.save)
        || candidate.associatedEditorRef
      ) {
        throw new Error(`ordinary form siblings must stay outside the numeric candidate's recovery region: ${JSON.stringify({ refs, quantityProbe })}`);
      }
      const saveProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'click_ax',
        args: { ref_id: refs.save },
      });
      if (!saveProbe?.resolved || saveProbe.toolbarContext === true) {
        throw new Error(`ordinary Save control must not inherit toolbar context: ${JSON.stringify(saveProbe)}`);
      }

      const AgentClass = browserKind === 'chrome' ? Agent : FirefoxAgent;
      const agent = new AgentClass({ getVisionProvider: async () => null });
      const tabId = browserKind === 'chrome' ? 1881 : 1882;
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: refs.quantity, text: 'Document prose', clear: true },
        {},
        candidate,
        { source: 'structural', targetKind: 'font_size' },
        null,
        quantityProbe,
      );
      agent._probeRichTextToolbarRetryTarget = async () => saveProbe;
      const saveBlock = await agent._richTextToolbarToolBlock(tabId, 'click_ax', { ref_id: refs.save });
      if (saveBlock) {
        throw new Error(`ordinary Save control must remain dispatchable after a blocked numeric mis-target: ${JSON.stringify(saveBlock)}`);
      }
    });

    test(`${browserKind}: roleless nested toolbar binds Body/Heading siblings to the blocked recovery region`, async (page) => {
      await setupContentHtml(page, `<!doctype html>
        <style>
          body { margin: 20px; font: 16px sans-serif; }
          #editor-shell { width: 620px; border: 1px solid #aaa; }
          #roleless-toolbar { height: 42px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border-bottom: 1px solid #ccc; }
          #style-control, #family-control { height: 24px; display: flex; align-items: center; padding: 0 8px; border: 1px solid #bbb; }
          #size-wrap { width: 44px; height: 24px; display: flex; align-items: center; overflow: hidden; }
          #font-size { width: 22px; height: 16px; }
          #visual-editor { min-height: 150px; position: relative; padding: 12px; }
          #editor-proxy { position: absolute; right: 12px; top: 12px; width: 23px; height: 23px; }
        </style>
        <div id="editor-shell">
          <div id="roleless-toolbar">
            <div id="style-control" tabindex="0">Heading3</div>
            <div id="family-control" tabindex="0">Default</div>
            <div id="size-wrap"><input id="font-size" value="11"><button type="button">v</button></div>
            <button type="button">B</button><button type="button">I</button><button type="button">U</button>
          </div>
          <div id="visual-editor"><h3>Existing answer</h3><textarea id="editor-proxy" aria-label="Editor input"></textarea></div>
        </div>`, browserKind);
      const refs = await page.evaluate(() => ({
        toolbar: window.__wb_ax_ref(document.querySelector('#roleless-toolbar')),
        style: window.__wb_ax_ref(document.querySelector('#style-control')),
        size: window.__wb_ax_ref(document.querySelector('#font-size')),
        proxy: window.__wb_ax_ref(document.querySelector('#editor-proxy')),
      }));
      const sizeProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.size, text: 'Document prose' },
      });
      const candidate = sizeProbe?.fieldMeta?.toolbarCandidate;
      if (
        !candidate
        || candidate.regionRef !== refs.toolbar
        || candidate.associatedEditorRef !== refs.proxy
      ) {
        throw new Error(`roleless toolbar must widen past the nested size wrapper and bind its proxy editor: ${JSON.stringify({ refs, sizeProbe })}`);
      }
      const styleProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'click_ax',
        args: { ref_id: refs.style },
      });
      if (
        !styleProbe?.resolved
        || styleProbe.toolbarContext !== true
        || styleProbe.toolbarRegionRef !== refs.toolbar
        || styleProbe.toolbarRegionKey !== candidate.regionKey
      ) {
        throw new Error(`Body/Heading sibling must resolve to the same roleless toolbar region: ${JSON.stringify({ candidate, styleProbe })}`);
      }

      const AgentClass = browserKind === 'chrome' ? Agent : FirefoxAgent;
      const agent = new AgentClass({ getVisionProvider: async () => null });
      // Strict checks: the guard's refusal itself is under test.
      agent.strictGuards = true;
      const tabId = browserKind === 'chrome' ? 1901 : 1902;
      const wrongTarget = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: refs.size, text: 'Document prose', clear: true },
        wrongTarget,
        candidate,
        { source: 'structural', targetKind: 'font_size' },
        null,
        sizeProbe,
      );
      if (wrongTarget.associatedEditorRef !== refs.proxy || !String(wrongTarget.error || '').includes(refs.proxy)) {
        throw new Error(`blocked write must surface the exact associated editor ref: ${JSON.stringify(wrongTarget)}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => styleProbe;
      const styleBlock = await agent._richTextToolbarToolBlock(tabId, 'click_ax', { ref_id: refs.style });
      if (!styleBlock?.wrongTarget || styleBlock.dispatched !== false) {
        throw new Error(`Body/Heading toolbar retry must be blocked before it can change formatting: ${JSON.stringify(styleBlock)}`);
      }
    });

    test(`${browserKind}: click_ax keeps an already-visible nested textarea at its current scroll position`, async (page) => {
      await setupContentHtml(page, `<!doctype html>
        <style>
          body { margin: 0; }
          #scroller { width: 500px; height: 180px; overflow: auto; border: 1px solid #aaa; }
          .spacer { height: 260px; }
          #editor-proxy { display: block; width: 23px; height: 23px; }
        </style>
        <div id="scroller"><div class="spacer"></div><textarea id="editor-proxy"></textarea><div class="spacer"></div></div>`, browserKind);
      const state = await page.evaluate(() => {
        const scroller = document.querySelector('#scroller');
        const target = document.querySelector('#editor-proxy');
        scroller.scrollTop = 230;
        return {
          ref: window.__wb_ax_ref(target),
          before: scroller.scrollTop,
          targetRect: target.getBoundingClientRect().toJSON(),
          scrollerRect: scroller.getBoundingClientRect().toJSON(),
        };
      });
      const response = await call(page, 'click_ax', { ref_id: state.ref });
      const after = await page.evaluate(() => document.querySelector('#scroller').scrollTop);
      if (!response?.success || after !== state.before) {
        throw new Error(`visible proxy textarea click must not recenter its scroll container: ${JSON.stringify({ state, response, after })}`);
      }
    });

    test(`${browserKind}: rich-text toolbar metadata covers labelled controls and excludes labelled ordinary fields`, async (page) => {
      await setupContentFixture(page, 'rich-text-toolbar-target.html', browserKind);

      const refs = await page.evaluate(() => {
        const shadowHost = document.createElement('div');
        shadowHost.id = 'shadow-toolbar-host';
        const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
        shadowRoot.innerHTML = `
          <span id="shadow-quantity-label">Shadow quantity</span>
          <input id="shadow-labelled-size" aria-labelledby="shadow-quantity-label" value="11"
            style="width:34px;height:22px">
          <label for="shadow-explicit-size">Shadow explicit quantity</label>
          <input id="shadow-explicit-size" value="11" style="width:34px;height:22px">
          <div role="toolbar">
            <input id="shadow-family-input" value="Default" aria-controls="shadow-family-presets"
              style="width:118px;height:22px">
            <div id="shadow-family-presets" role="listbox">
              <div role="option">Roboto</div>
              <div role="option">Noto Sans</div>
            </div>
            <button type="button">B</button>
          </div>`;
        document.body.appendChild(shadowHost);

        const composedEditor = document.createElement('div');
        composedEditor.className = 'editor';
        composedEditor.innerHTML = `
          <div id="composed-toolbar" class="toolbar" role="toolbar"></div>
          <div id="composed-editor-body" class="body" contenteditable="true">Enter text</div>`;
        const composedHost = document.createElement('span');
        composedHost.id = 'composed-family-host';
        const composedRoot = composedHost.attachShadow({ mode: 'open' });
        composedRoot.innerHTML = `
          <input id="composed-family-input" value="Default" aria-controls="composed-family-presets"
            style="width:118px;height:22px">
          <div id="composed-family-presets" role="listbox">
            <div role="option">Roboto</div>
            <div role="option">Noto Sans</div>
          </div>`;
        composedEditor.querySelector('#composed-toolbar').appendChild(composedHost);
        const composedSiblingHost = document.createElement('span');
        composedSiblingHost.id = 'composed-sibling-host';
        const composedSiblingRoot = composedSiblingHost.attachShadow({ mode: 'open' });
        composedSiblingRoot.innerHTML = '<button id="composed-shadow-bold" type="button">B</button>';
        composedEditor.querySelector('#composed-toolbar').appendChild(composedSiblingHost);
        document.body.appendChild(composedEditor);

        const shadowToolbarEditor = document.createElement('div');
        shadowToolbarEditor.className = 'editor';
        const shadowToolbarHost = document.createElement('div');
        shadowToolbarHost.id = 'shadow-toolbar-component';
        const shadowToolbarRoot = shadowToolbarHost.attachShadow({ mode: 'open' });
        shadowToolbarRoot.innerHTML = `
          <div role="toolbar" style="height:42px;display:flex;align-items:center">
            <input id="shadow-toolbar-family-input" aria-label="Font family" value="Default" style="width:118px;height:22px">
          </div>`;
        shadowToolbarEditor.appendChild(shadowToolbarHost);
        const shadowToolbarBody = document.createElement('div');
        shadowToolbarBody.id = 'shadow-toolbar-editor-body';
        shadowToolbarBody.className = 'body';
        shadowToolbarBody.contentEditable = 'true';
        shadowToolbarBody.textContent = 'Enter text';
        shadowToolbarEditor.appendChild(shadowToolbarBody);
        document.body.appendChild(shadowToolbarEditor);

        const descendantShadowEditor = document.createElement('div');
        descendantShadowEditor.className = 'editor';
        descendantShadowEditor.innerHTML = `
          <div role="toolbar" style="height:42px;display:flex;align-items:center">
            <input id="descendant-shadow-family-input" type="text" aria-label="Font family" value="Default"
              style="width:118px;height:22px">
            <input id="descendant-toolbar-search" type="search" aria-label="Search links" value=""
              style="width:118px;height:22px">
            <input id="descendant-toolbar-unlabelled-search" type="search" value=""
              style="width:118px;height:22px">
            <input id="descendant-toolbar-filter" type="text" aria-label="Filter" value=""
              style="width:118px;height:22px">
            <input id="descendant-toolbar-bold" type="checkbox" aria-label="Bold">
          </div>`;
        const descendantBodyHost = document.createElement('div');
        descendantBodyHost.id = 'descendant-editor-component';
        descendantBodyHost.attachShadow({ mode: 'open' }).innerHTML = `
          <div id="descendant-shadow-editor-body" role="textbox" contenteditable="true"
            style="width:400px;height:180px">Enter text</div>`;
        descendantShadowEditor.appendChild(descendantBodyHost);
        document.body.appendChild(descendantShadowEditor);

        const compactComposer = document.createElement('div');
        compactComposer.style.cssText = 'display:flex;align-items:center;gap:6px;width:320px;height:44px';
        compactComposer.innerHTML = `
          <div id="compact-composer-body" role="textbox" contenteditable="true"
            style="width:190px;height:28px">Draft reply</div>
          <button type="button">Emoji</button>
          <button type="button">Send</button>`;
        document.body.appendChild(compactComposer);

        const ordinaryDocumentEditor = document.createElement('div');
        ordinaryDocumentEditor.className = 'editor';
        ordinaryDocumentEditor.innerHTML = `
          <div style="height:42px;display:flex;align-items:center;gap:6px">
            <input id="ordinary-document-title" type="text" value=""
              style="width:180px;height:28px">
            <button type="button">Save</button>
          </div>
          <textarea id="ordinary-document-body" style="width:400px;height:180px"></textarea>`;
        document.body.appendChild(ordinaryDocumentEditor);

        const conventionalToolbarEditor = document.createElement('div');
        conventionalToolbarEditor.className = 'editor';
        conventionalToolbarEditor.innerHTML = `
          <div style="height:42px;display:flex;align-items:center;gap:6px">
            <button type="button">B</button>
            <input id="conventional-toolbar-family" aria-label="Font family" value="Default"
              style="width:118px;height:22px">
            <input id="conventional-text-color" aria-label="Text color" value="#111111"
              style="width:118px;height:22px">
            <button type="button">I</button>
          </div>
          <div id="conventional-toolbar-editor-body" contenteditable="true"
            style="width:400px;height:180px">Enter text</div>`;
        document.body.appendChild(conventionalToolbarEditor);

        const conventionalShadowEditor = document.createElement('div');
        conventionalShadowEditor.className = 'editor';
        conventionalShadowEditor.innerHTML = `
          <div style="height:42px;display:flex;align-items:center;gap:6px">
            <button type="button">B</button>
            <span id="conventional-shadow-family-host"></span>
          </div>
          <div id="conventional-shadow-editor-body" contenteditable="true"
            style="width:400px;height:180px">Enter text</div>`;
        const conventionalShadowRoot = conventionalShadowEditor
          .querySelector('#conventional-shadow-family-host')
          .attachShadow({ mode: 'open' });
        conventionalShadowRoot.innerHTML = `
          <input id="conventional-shadow-family" aria-label="Font family" value="Default"
            style="width:118px;height:22px">`;
        document.body.appendChild(conventionalShadowEditor);

        const slottedToolbarEditor = document.createElement('div');
        slottedToolbarEditor.className = 'editor';
        const slottedToolbarHost = document.createElement('div');
        slottedToolbarHost.id = 'slotted-toolbar-component';
        slottedToolbarHost.attachShadow({ mode: 'open' }).innerHTML = `
          <div role="toolbar" style="height:42px;display:flex;align-items:center">
            <slot></slot>
          </div>`;
        const slottedToolbarInput = document.createElement('input');
        slottedToolbarInput.id = 'slotted-toolbar-family-input';
        slottedToolbarInput.value = 'Default';
        slottedToolbarInput.style.cssText = 'width:118px;height:22px';
        slottedToolbarHost.appendChild(slottedToolbarInput);
        slottedToolbarEditor.appendChild(slottedToolbarHost);
        const slottedToolbarBody = document.createElement('div');
        slottedToolbarBody.id = 'slotted-toolbar-editor-body';
        slottedToolbarBody.className = 'body';
        slottedToolbarBody.contentEditable = 'true';
        slottedToolbarBody.textContent = 'Enter text';
        slottedToolbarEditor.appendChild(slottedToolbarBody);
        document.body.appendChild(slottedToolbarEditor);

        const iframeBackedEditor = document.createElement('div');
        iframeBackedEditor.className = 'editor';
        iframeBackedEditor.innerHTML = `
          <div role="toolbar" style="height:42px;display:flex;align-items:center">
            <input id="iframe-toolbar-family-input" value="Default" style="width:118px;height:22px">
          </div>
          <iframe id="iframe-editor-body" style="width:400px;height:180px"
            srcdoc="<div id='inner-editor' contenteditable='true'>Enter text</div>"></iframe>`;
        document.body.appendChild(iframeBackedEditor);
        return {
          size: window.__wb_ax_ref(document.getElementById('font-size')),
          family: window.__wb_ax_ref(document.getElementById('font-family')),
          familyInput: window.__wb_ax_ref(document.getElementById('font-family-input')),
          editableFamily: window.__wb_ax_ref(document.getElementById('editable-font-family')),
          familyText: window.__wb_ax_ref(document.querySelector('#font-family span')),
          editor: window.__wb_ax_ref(document.getElementById('editor-body')),
          labelledBy: window.__wb_ax_ref(document.getElementById('labelled-by-size')),
          shadowLabelledBy: window.__wb_ax_ref(shadowRoot.getElementById('shadow-labelled-size')),
          shadowExplicitLabel: window.__wb_ax_ref(shadowRoot.getElementById('shadow-explicit-size')),
          shadowFamilyInput: window.__wb_ax_ref(shadowRoot.getElementById('shadow-family-input')),
          composedFamilyInput: window.__wb_ax_ref(composedRoot.getElementById('composed-family-input')),
          composedShadowBold: window.__wb_ax_ref(composedSiblingRoot.getElementById('composed-shadow-bold')),
          shadowToolbarFamilyInput: window.__wb_ax_ref(shadowToolbarRoot.getElementById('shadow-toolbar-family-input')),
          descendantShadowFamilyInput: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-shadow-family-input')),
          descendantToolbarSearch: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-toolbar-search')),
          descendantToolbarUnlabelledSearch: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-toolbar-unlabelled-search')),
          descendantToolbarFilter: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-toolbar-filter')),
          descendantToolbarBold: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-toolbar-bold')),
          compactComposer: window.__wb_ax_ref(compactComposer.querySelector('#compact-composer-body')),
          ordinaryDocumentTitle: window.__wb_ax_ref(ordinaryDocumentEditor.querySelector('#ordinary-document-title')),
          conventionalToolbarFamily: window.__wb_ax_ref(conventionalToolbarEditor.querySelector('#conventional-toolbar-family')),
          conventionalTextColor: window.__wb_ax_ref(conventionalToolbarEditor.querySelector('#conventional-text-color')),
          conventionalShadowFamily: window.__wb_ax_ref(conventionalShadowRoot.getElementById('conventional-shadow-family')),
          slottedToolbarFamilyInput: window.__wb_ax_ref(slottedToolbarInput),
          iframeToolbarFamilyInput: window.__wb_ax_ref(iframeBackedEditor.querySelector('#iframe-toolbar-family-input')),
          title: window.__wb_ax_ref(document.getElementById('title-size')),
          linkUrl: window.__wb_ax_ref(document.getElementById('link-url')),
          paragraphStyle: window.__wb_ax_ref(document.getElementById('paragraph-style')),
          ordinary: window.__wb_ax_ref(document.getElementById('ordinary-size')),
          ordinaryStatus: window.__wb_ax_ref(document.getElementById('ordinary-status')),
          secondary: window.__wb_ax_ref(document.getElementById('secondary-notes')),
        };
      });

      await page.evaluate(() => {
        const target = document.getElementById('iframe-toolbar-family-input');
        target.closest('.editor').style.marginTop = '1400px';
        window.scrollTo({ top: 0, behavior: 'instant' });
        document.documentElement.style.scrollBehavior = 'smooth';
      });
      const smoothScrollProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.iframeToolbarFamilyInput, text: 'Roboto' },
      });
      const settledTarget = await page.evaluate(() => {
        const rect = document.getElementById('iframe-toolbar-family-input').getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        document.documentElement.style.scrollBehavior = 'auto';
        return {
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          viewportHeight,
        };
      });
      if (
        !smoothScrollProbe?.resolved
        || Math.abs(smoothScrollProbe.rect.y - settledTarget.rect.y) > 2
        || Math.abs(smoothScrollProbe.rect.pageX - (settledTarget.rect.x + settledTarget.scrollX)) > 2
        || Math.abs(smoothScrollProbe.rect.pageY - (settledTarget.rect.y + settledTarget.scrollY)) > 2
        || smoothScrollProbe.rect.y < 0
        || smoothScrollProbe.rect.y + smoothScrollProbe.rect.h > settledTarget.viewportHeight
      ) {
        throw new Error(`smooth-scroll toolbar probe must settle and re-measure the target: ${JSON.stringify({ smoothScrollProbe, settledTarget })}`);
      }

      const toolbar = await call(page, 'set_field', {
        ref_id: refs.size,
        text: '42',
        clear: true,
      });
      const candidate = toolbar?.fieldMeta?.toolbarCandidate;
      if (!candidate || candidate.score < 6) {
        throw new Error(`expected strong toolbar candidate, got: ${JSON.stringify(toolbar)}`);
      }
      if (toolbar.fieldMeta?.name !== 'fontSize') {
        throw new Error(`fixture must cover a named toolbar control, got: ${JSON.stringify(toolbar.fieldMeta)}`);
      }
      if (!candidate.reasons.includes('semantic_toolbar')) {
        throw new Error(`expected semantic toolbar evidence, got: ${JSON.stringify(candidate)}`);
      }
      if (!candidate.relatedRefs.includes(refs.family) && !candidate.relatedRefs.includes(refs.familyText)) {
        throw new Error(`expected font-family sibling ref in toolbar scope, got: ${JSON.stringify(candidate)}`);
      }
      if (candidate.associatedEditorRef !== refs.editor) {
        throw new Error(`expected exact associated editor ref, got: ${JSON.stringify(candidate)}`);
      }
      if (candidate.associatedEditorIdentity?.id !== 'editor-body' || candidate.associatedEditorIdentity?.tag !== 'div') {
        throw new Error(`expected stable associated editor identity, got: ${JSON.stringify(candidate)}`);
      }
      const familyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.familyInput, text: 'Inter Display' },
      });
      const availableFamilies = familyProbe?.fieldMeta?.toolbarCandidate?.availablePresetValues || [];
      if (!availableFamilies.includes('Default') || !availableFamilies.includes('Inter Display') || !availableFamilies.includes('Times New Roman')) {
        throw new Error(`expected bounded control-owned font presets, got: ${JSON.stringify(familyProbe)}`);
      }
      const editableFamilyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.editableFamily, text: 'Inter Display' },
      });
      if (
        !editableFamilyProbe?.resolved
        || editableFamilyProbe.fieldMeta?.contentEditable !== true
        || !editableFamilyProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
        || !editableFamilyProbe.fieldMeta.toolbarCandidate.reasons?.includes('formatting_control_label')
        || !editableFamilyProbe.fieldMeta.toolbarCandidate.availablePresetValues?.includes('Default')
        || editableFamilyProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
      ) {
        throw new Error(`contenteditable rich-text formatting control must enter the toolbar audit: ${JSON.stringify(editableFamilyProbe)}`);
      }
      const editorBodyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.editor, text: 'Document prose' },
      });
      if (!editorBodyProbe?.resolved || editorBodyProbe.fieldMeta?.toolbarCandidate) {
        throw new Error(`rich-text editor body must not be classified as its own toolbar control: ${JSON.stringify(editorBodyProbe)}`);
      }
      const shadowFamilyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.shadowFamilyInput, text: 'Roboto' },
      });
      const shadowAvailableFamilies = shadowFamilyProbe?.fieldMeta?.toolbarCandidate?.availablePresetValues || [];
      if (!shadowAvailableFamilies.includes('Default') || !shadowAvailableFamilies.includes('Roboto') || !shadowAvailableFamilies.includes('Noto Sans')) {
        throw new Error(`expected shadow-local aria-controls presets, got: ${JSON.stringify(shadowFamilyProbe)}`);
      }
      const composedFamilyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.composedFamilyInput, text: 'Roboto' },
      });
      const composedCandidate = composedFamilyProbe?.fieldMeta?.toolbarCandidate;
      if (
        Number(composedCandidate?.score) < 4
        || !composedCandidate.reasons?.includes('semantic_toolbar')
        || composedCandidate.associatedEditorIdentity?.id !== 'composed-editor-body'
        || !composedCandidate.regionKey
        || !composedCandidate.relatedRefs?.includes(refs.composedShadowBold)
      ) {
        throw new Error(`expected toolbar ancestry through the input shadow host, got: ${JSON.stringify(composedFamilyProbe)}`);
      }
      const composedSiblingProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'click_ax',
        args: { ref_id: refs.composedShadowBold },
      });
      if (
        !composedSiblingProbe?.resolved
        || !composedSiblingProbe.toolbarContext
        || composedSiblingProbe.toolbarRegionKey !== composedCandidate.regionKey
      ) {
        throw new Error(`open-shadow toolbar siblings must share one stable region identity: ${JSON.stringify(composedSiblingProbe)}`);
      }
      const shadowToolbarProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.shadowToolbarFamilyInput, text: 'Roboto' },
      });
      if (
        !shadowToolbarProbe?.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
        || shadowToolbarProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'shadow-toolbar-editor-body'
      ) {
        throw new Error(`expected editor association through the toolbar shadow host, got: ${JSON.stringify(shadowToolbarProbe)}`);
      }
      const descendantShadowProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.descendantShadowFamilyInput, text: 'Roboto' },
      });
      if (
        !descendantShadowProbe?.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
        || descendantShadowProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'descendant-shadow-editor-body'
        || !descendantShadowProbe.fieldMeta.toolbarCandidate.associatedEditorRef
        || !descendantShadowProbe.fieldMeta.toolbarCandidate.relatedRefs?.includes(refs.descendantToolbarBold)
      ) {
        throw new Error(`expected descendant shadow editor association, got: ${JSON.stringify(descendantShadowProbe)}`);
      }
      const descendantBoldProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_checked',
        args: { ref_id: refs.descendantToolbarBold, checked: true },
      });
      if (
        !descendantBoldProbe?.resolved
        || !descendantBoldProbe.toolbarContext
        || descendantBoldProbe.toolbarRegionKey !== descendantShadowProbe.fieldMeta.toolbarCandidate.regionKey
      ) {
        throw new Error(`checkbox formatting controls must preserve their toolbar scope: ${JSON.stringify(descendantBoldProbe)}`);
      }
      const descendantSearchProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.descendantToolbarSearch, text: 'Quarterly roadmap' },
      });
      if (
        !descendantSearchProbe?.resolved
        || descendantSearchProbe.fieldMeta?.type !== 'search'
        || descendantSearchProbe.fieldMeta?.toolbarCandidate
      ) {
        throw new Error(`ordinary labelled toolbar search must stay outside formatting audit: ${JSON.stringify(descendantSearchProbe)}`);
      }
      const descendantUnlabelledSearchProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.descendantToolbarUnlabelledSearch, text: 'Quarterly roadmap' },
      });
      if (
        !descendantUnlabelledSearchProbe?.resolved
        || descendantUnlabelledSearchProbe.fieldMeta?.type !== 'search'
        || descendantUnlabelledSearchProbe.fieldMeta?.toolbarCandidate
      ) {
        throw new Error(`unlabelled native toolbar search must stay outside formatting audit: ${JSON.stringify(descendantUnlabelledSearchProbe)}`);
      }
      const descendantFilterProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.descendantToolbarFilter, text: 'Quarterly roadmap' },
      });
      if (
        !descendantFilterProbe?.resolved
        || descendantFilterProbe.fieldMeta?.type !== 'text'
        || descendantFilterProbe.fieldMeta?.toolbarCandidate
      ) {
        throw new Error(`ordinary labelled toolbar text filter must stay outside formatting audit: ${JSON.stringify(descendantFilterProbe)}`);
      }
      const compactComposerProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.compactComposer, text: 'Quarterly roadmap' },
      });
      if (
        !compactComposerProbe?.resolved
        || compactComposerProbe.fieldMeta?.contentEditable !== true
        || compactComposerProbe.fieldMeta?.toolbarCandidate
      ) {
        throw new Error(`compact contenteditable composer must stay outside formatting audit: ${JSON.stringify(compactComposerProbe)}`);
      }
      const ordinaryDocumentTitleProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.ordinaryDocumentTitle, text: 'Quarterly roadmap' },
      });
      if (!ordinaryDocumentTitleProbe?.resolved || ordinaryDocumentTitleProbe.fieldMeta?.toolbarCandidate) {
        throw new Error(`ordinary compact title near an editor must stay outside formatting audit: ${JSON.stringify(ordinaryDocumentTitleProbe)}`);
      }
      const conventionalToolbarProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.conventionalToolbarFamily, text: 'Inter Display' },
      });
      if (
        Number(conventionalToolbarProbe?.fieldMeta?.toolbarCandidate?.score) < 4
        || !conventionalToolbarProbe.fieldMeta.toolbarCandidate.reasons?.includes('formatting_control_label')
        || !conventionalToolbarProbe.fieldMeta.toolbarCandidate.reasons?.includes('dense_control_cluster')
        || conventionalToolbarProbe.fieldMeta.toolbarCandidate.reasons?.includes('semantic_toolbar')
        || conventionalToolbarProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'conventional-toolbar-editor-body'
      ) {
        throw new Error(`labelled formatting control in a conventional toolbar must enter the audit: ${JSON.stringify(conventionalToolbarProbe)}`);
      }
      const conventionalColorProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.conventionalTextColor, text: 'red' },
      });
      if (
        Number(conventionalColorProbe?.fieldMeta?.toolbarCandidate?.score) < 4
        || !conventionalColorProbe.fieldMeta.toolbarCandidate.reasons?.includes('formatting_control_label')
        || !conventionalColorProbe.fieldMeta.toolbarCandidate.reasons?.includes('dense_control_cluster')
        || conventionalColorProbe.fieldMeta.toolbarCandidate.reasons?.includes('semantic_toolbar')
        || conventionalColorProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'conventional-toolbar-editor-body'
      ) {
        throw new Error(`text-color control in a conventional toolbar must enter the audit: ${JSON.stringify(conventionalColorProbe)}`);
      }
      const denseCandidateRefs = await page.evaluate(() => {
        const makeEditor = (id, control) => {
          const editor = document.createElement('div');
          editor.className = 'editor';
          editor.innerHTML = `
            <div style="height:42px;display:flex;align-items:center;gap:6px">
              ${control}
              <button id="${id}-button" type="button">B</button>
            </div>
            <div contenteditable="true" style="width:400px;height:180px">Enter text</div>`;
          document.body.appendChild(editor);
          return window.__wb_ax_ref(editor.querySelector(`#${id}-button`));
        };
        return {
          select: makeEditor('dense-select', '<select aria-label="Font family" style="width:118px;height:22px"><option>Default</option><option>Inter</option></select>'),
          editable: makeEditor('dense-editable', '<div contenteditable="true" role="combobox" aria-label="Font family" style="width:118px;height:22px">Default</div>'),
        };
      });
      for (const [kind, refId] of Object.entries(denseCandidateRefs)) {
        const contextProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
          toolName: 'click_ax',
          args: { ref_id: refId },
        });
        if (contextProbe?.toolbarContext !== true || !contextProbe.toolbarRegionKey) {
          throw new Error(`dense ${kind} formatting controls must reconstruct their conventional toolbar region: ${JSON.stringify(contextProbe)}`);
        }
      }
      const conventionalShadowProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.conventionalShadowFamily, text: 'Inter Display' },
      });
      if (
        Number(conventionalShadowProbe?.fieldMeta?.toolbarCandidate?.score) < 4
        || !conventionalShadowProbe.fieldMeta.toolbarCandidate.reasons?.includes('formatting_control_label')
        || !conventionalShadowProbe.fieldMeta.toolbarCandidate.reasons?.includes('dense_control_cluster')
        || conventionalShadowProbe.fieldMeta.toolbarCandidate.reasons?.includes('semantic_toolbar')
        || conventionalShadowProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'conventional-shadow-editor-body'
      ) {
        throw new Error(`shadow-root target must count in its outer conventional toolbar: ${JSON.stringify(conventionalShadowProbe)}`);
      }
      const linkProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.linkUrl, text: 'https://openai.com' },
      });
      if (
        !linkProbe?.resolved
        || linkProbe.fieldMeta?.type !== 'url'
        || !linkProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
        || linkProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
      ) {
        throw new Error(`URL-typed rich-text link control must enter the toolbar audit: ${JSON.stringify(linkProbe)}`);
      }
      const nativeStyleProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.paragraphStyle, text: 'Heading 1' },
      });
      if (
        !nativeStyleProbe?.resolved
        || nativeStyleProbe.fieldMeta?.type !== 'select'
        || !nativeStyleProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
        || !nativeStyleProbe.fieldMeta.toolbarCandidate.availablePresetValues?.includes('Heading 1')
        || nativeStyleProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
      ) {
        throw new Error(`native rich-text style select must enter the toolbar audit: ${JSON.stringify(nativeStyleProbe)}`);
      }
      const slottedToolbarProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.slottedToolbarFamilyInput, text: 'Roboto' },
      });
      if (
        !slottedToolbarProbe?.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
        || slottedToolbarProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'slotted-toolbar-editor-body'
      ) {
        throw new Error(`expected toolbar ancestry through the input assigned slot, got: ${JSON.stringify(slottedToolbarProbe)}`);
      }
      const iframeBackedProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.iframeToolbarFamilyInput, text: 'Roboto' },
      });
      if (
        iframeBackedProbe?.fieldMeta?.toolbarCandidate?.associatedEditorIdentity?.tag !== 'iframe'
        || iframeBackedProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'iframe-editor-body'
        || !iframeBackedProbe.fieldMeta.toolbarCandidate.associatedEditorRef
      ) {
        throw new Error(`expected adjacent iframe editor association, got: ${JSON.stringify(iframeBackedProbe)}`);
      }
      const focusedProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { text: 'Paris' },
      });
      if (!focusedProbe?.resolved || focusedProbe.refId !== refs.size || !focusedProbe.dispatchBinding?.token || !focusedProbe.documentToken || !focusedProbe.refScopeUrl || !focusedProbe.toolbarContext || focusedProbe.toolbarRegionRef !== candidate.regionRef || focusedProbe.toolbarRegionKey !== candidate.regionKey || Number(focusedProbe.fieldMeta?.toolbarCandidate?.score) < 4) {
        throw new Error(`expected focused toolbar retry probe, got: ${JSON.stringify(focusedProbe)}`);
      }
      const staleKeyboardProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { text: '' },
      });
      await page.evaluate(() => {
        document.querySelector('#shadow-toolbar-host').shadowRoot
          .querySelector('#shadow-family-input').focus();
      });
      const staleKeyboard = await call(page, 'press_keys', {
        key: 'ArrowDown',
        dispatchBinding: staleKeyboardProbe.dispatchBinding,
      });
      if (staleKeyboard?.success !== false || staleKeyboard?.dispatched !== false || staleKeyboard?.noDispatch !== true) {
        throw new Error(`guarded keyboard input must fail closed after focus moves from the preflight element: ${JSON.stringify(staleKeyboard)}`);
      }
      const staleFocusedType = browserKind === 'chrome'
        ? await call(page, 'prepare_focused_type_dispatch', {
            dispatchBinding: focusedProbe.dispatchBinding,
            text: 'SHOULD_NOT_APPLY',
          })
        : await call(page, 'type', {
            text: 'SHOULD_NOT_APPLY',
            dispatchBinding: focusedProbe.dispatchBinding,
          });
      if (staleFocusedType?.success !== false || staleFocusedType?.dispatched !== false || staleFocusedType?.noDispatch !== true) {
        throw new Error(`focused typing must fail closed after focus moves from the preflight element: ${JSON.stringify(staleFocusedType)}`);
      }
      const shadowFocusedProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { text: 'Paris' },
      });
      if (
        !shadowFocusedProbe?.resolved
        || shadowFocusedProbe.refId !== refs.shadowFamilyInput
        || !shadowFocusedProbe.dispatchBinding?.token
        || !shadowFocusedProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
      ) {
        throw new Error(`expected deeply focused shadow toolbar target, got: ${JSON.stringify(shadowFocusedProbe)}`);
      }
      const shadowKeyboardProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { text: '' },
      });
      const guardedKeyboard = await call(page, 'press_keys', {
        key: 'ArrowDown',
        dispatchBinding: shadowKeyboardProbe.dispatchBinding,
      });
      if (guardedKeyboard?.success !== true || guardedKeyboard?.dispatched !== true) {
        throw new Error(`guarded keyboard input must dispatch only while the preflight element retains focus: ${JSON.stringify(guardedKeyboard)}`);
      }
      if (browserKind === 'chrome') {
        const preparedFocusedType = await call(page, 'prepare_focused_type_dispatch', {
          dispatchBinding: shadowFocusedProbe.dispatchBinding,
          text: 'Paris',
        });
        if (
          preparedFocusedType?.success !== true
          || !/^\d+:[0-9a-f]+$/.test(preparedFocusedType.beforeSignature || '')
          || Object.hasOwn(preparedFocusedType, 'value')
        ) {
          throw new Error(`trusted focused typing must prepare an exact secret-free target: ${JSON.stringify(preparedFocusedType)}`);
        }
        const unmodifiedVerification = await call(page, 'verify_focused_type_dispatch', {
          dispatchBinding: shadowFocusedProbe.dispatchBinding,
          text: 'Paris',
          clear: false,
          beforeSignature: preparedFocusedType.beforeSignature,
        });
        if (unmodifiedVerification?.success !== true || unmodifiedVerification.verified !== false) {
          throw new Error(`focused verification must reject an unmodified target: ${JSON.stringify(unmodifiedVerification)}`);
        }
        const insertedProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
          toolName: 'type_text',
          args: { text: 'Paris' },
        });
        const insertedPreparation = await call(page, 'prepare_focused_type_dispatch', {
          dispatchBinding: insertedProbe.dispatchBinding,
          text: 'Paris',
        });
        await page.evaluate(() => {
          const input = document.querySelector('#shadow-toolbar-host').shadowRoot
            .querySelector('#shadow-family-input');
          input.value += 'Paris';
        });
        const insertedVerification = await call(page, 'verify_focused_type_dispatch', {
          dispatchBinding: insertedProbe.dispatchBinding,
          text: 'Paris',
          clear: false,
          beforeSignature: insertedPreparation.beforeSignature,
        });
        if (insertedPreparation?.success !== true || insertedVerification?.verified !== true) {
          throw new Error(`focused verification must accept the exact requested insertion: ${JSON.stringify({ insertedPreparation, insertedVerification })}`);
        }
        await page.evaluate(() => {
          document.querySelector('#shadow-toolbar-host').shadowRoot
            .querySelector('#shadow-family-input').value = 'Default';
        });
      } else {
        await call(page, 'release_dispatch_binding', {
          dispatchBinding: shadowFocusedProbe.dispatchBinding,
        });
      }

      const editorPoint = await page.evaluate(() => {
        const editor = document.getElementById('editor-body');
        editor.scrollIntoView({ block: 'center' });
        const rect = editor.getBoundingClientRect();
        window.__richTextRetryProbeScrolls = 0;
        editor.scrollIntoView = () => { window.__richTextRetryProbeScrolls += 1; };
        return { x: rect.x + 12, y: rect.y + 12 };
      });
      const coordinateProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'click',
        args: editorPoint,
      });
      const coordinateProbeScrolls = await page.evaluate(() => window.__richTextRetryProbeScrolls);
      if (!coordinateProbe?.resolved || coordinateProbe.refId !== refs.editor || !coordinateProbe.dispatchBinding?.token || coordinateProbeScrolls !== 0) {
        throw new Error(`coordinate retry probe must preserve viewport coordinates, got: ${JSON.stringify({ coordinateProbe, coordinateProbeScrolls })}`);
      }
      const selectorProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'click',
        args: { selector: '#editor-body' },
      });
      const selectorProbeScrolls = await page.evaluate(() => window.__richTextRetryProbeScrolls);
      if (!selectorProbe?.resolved || selectorProbe.refId !== refs.editor || !selectorProbe.dispatchBinding?.token || selectorProbeScrolls !== 1) {
        throw new Error(`selector retry probe must retain normal target scrolling, got: ${JSON.stringify({ selectorProbe, selectorProbeScrolls })}`);
      }
      await call(page, 'release_dispatch_binding', { dispatchBinding: coordinateProbe.dispatchBinding });
      await call(page, 'release_dispatch_binding', { dispatchBinding: selectorProbe.dispatchBinding });

      // Text entry does not scroll on dispatch the way a click does, so the
      // probe must not centre the page on an ordinary field just to score it.
      // Only a target that will be annotated into a classifier screenshot
      // earns the scroll.
      await page.evaluate(() => { window.__richTextRetryProbeScrolls = 0; });
      const ordinaryTypeProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { selector: '#editor-body', text: 'Document prose' },
      });
      const ordinaryTypeScrolls = await page.evaluate(() => window.__richTextRetryProbeScrolls);
      if (!ordinaryTypeProbe?.resolved || ordinaryTypeScrolls !== 0) {
        throw new Error(`an ordinary text-entry probe must not scroll the page, got: ${JSON.stringify({ ordinaryTypeProbe, ordinaryTypeScrolls })}`);
      }
      await call(page, 'release_dispatch_binding', { dispatchBinding: ordinaryTypeProbe.dispatchBinding });

      const escalatingScrolls = await page.evaluate(() => {
        window.__richTextEscalatingScrolls = 0;
        const control = document.getElementById('font-size');
        control.scrollIntoView = () => { window.__richTextEscalatingScrolls += 1; };
        return window.__richTextEscalatingScrolls;
      });
      const escalatingTypeProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { selector: '#font-size', text: 'Document prose' },
      });
      const escalatingTypeScrolls = await page.evaluate(() => window.__richTextEscalatingScrolls);
      if (
        !escalatingTypeProbe?.resolved
        || Number(escalatingTypeProbe.fieldMeta?.toolbarCandidate?.score) < 4
        || escalatingScrolls !== 0
        || escalatingTypeScrolls !== 1
      ) {
        throw new Error(`an escalating toolbar target must still be brought into view for the classifier, got: ${JSON.stringify({ escalatingTypeProbe, escalatingTypeScrolls })}`);
      }
      await call(page, 'release_dispatch_binding', { dispatchBinding: escalatingTypeProbe.dispatchBinding });

      await page.evaluate(() => {
        const container = document.createElement('div');
        const button = document.createElement('button');
        button.id = 'guarded-click-target';
        button.textContent = 'Safe action';
        container.appendChild(button);
        document.body.appendChild(container);
      });
      const staleClickProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'click',
        args: { selector: '#guarded-click-target' },
      });
      await page.evaluate(() => {
        const current = document.getElementById('guarded-click-target');
        current.replaceWith(current.cloneNode(true));
      });
      const staleClick = await call(page, 'click', {
        selector: '#guarded-click-target',
        dispatchBinding: staleClickProbe.dispatchBinding,
      });
      if (staleClick?.success !== false || staleClick?.dispatched !== false || staleClick?.noDispatch !== true) {
        throw new Error(`guarded click must fail closed after the preflight element is replaced: ${JSON.stringify(staleClick)}`);
      }
      const stableClickProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'click',
        args: { selector: '#guarded-click-target' },
      });
      const stableClick = await call(page, 'click', {
        selector: '#guarded-click-target',
        dispatchBinding: stableClickProbe.dispatchBinding,
      });
      if (stableClick?.success !== true) {
        throw new Error(`guarded click must dispatch while the approved element identity is stable: ${JSON.stringify(stableClick)}`);
      }

      await page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'toolbar-identity-rerender';
        input.value = 'ordinary';
        document.body.appendChild(input);
      });
      const identityProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { selector: '#toolbar-identity-rerender', text: 'Document prose' },
      });
      if (!identityProbe?.resolved || !identityProbe.dispatchBinding?.token) {
        throw new Error(`selector type probe must preserve exact target identity, got: ${JSON.stringify(identityProbe)}`);
      }
      await page.evaluate(() => {
        const current = document.getElementById('toolbar-identity-rerender');
        const replacement = current.cloneNode();
        replacement.value = '11';
        current.replaceWith(replacement);
      });
      const rerenderedType = await call(page, 'type', {
        selector: '#toolbar-identity-rerender',
        text: 'Document prose',
        clear: true,
        dispatchBinding: identityProbe.dispatchBinding,
      });
      const rerenderedValue = await page.evaluate(() => {
        const target = document.getElementById('toolbar-identity-rerender');
        const value = target.value;
        target.remove();
        return value;
      });
      if (rerenderedType?.success !== false || rerenderedType?.dispatched !== false || !rerenderedType?.retryable || rerenderedValue !== '11') {
        throw new Error(`rerendered selector target must fail closed before typing, got: ${JSON.stringify({ rerenderedType, rerenderedValue })}`);
      }

      const labelledBy = await call(page, 'set_field', {
        ref_id: refs.labelledBy,
        text: '12',
        clear: true,
      });
      if (
        !labelledBy?.success
        || labelledBy.fieldMeta?.ariaLabelledByText !== 'Quantity'
        || !labelledBy.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
        || !labelledBy.fieldMeta.toolbarCandidate.reasons.includes('semantic_toolbar')
      ) {
        throw new Error(`aria-labelledby toolbar field must enter the toolbar audit, got: ${JSON.stringify(labelledBy)}`);
      }

      const shadowLabelledBy = await call(page, 'set_field', {
        ref_id: refs.shadowLabelledBy,
        text: 'Document prose',
        clear: true,
      });
      if (!shadowLabelledBy?.success || shadowLabelledBy.fieldMeta?.toolbarCandidate || shadowLabelledBy.fieldMeta?.ariaLabelledByText !== 'Shadow quantity') {
        throw new Error(`shadow-local aria-labelledby field must stay outside toolbar audit, got: ${JSON.stringify(shadowLabelledBy)}`);
      }

      const shadowExplicitLabel = await call(page, 'set_field', {
        ref_id: refs.shadowExplicitLabel,
        text: 'Document prose',
        clear: true,
      });
      if (!shadowExplicitLabel?.success || shadowExplicitLabel.fieldMeta?.toolbarCandidate || shadowExplicitLabel.fieldMeta?.labelText !== 'Shadow explicit quantity') {
        throw new Error(`shadow-local explicit-label field must stay outside toolbar audit, got: ${JSON.stringify(shadowExplicitLabel)}`);
      }

      const title = await call(page, 'set_field', {
        ref_id: refs.title,
        text: '125%',
        clear: true,
      });
      if (
        !title?.success
        || title.fieldMeta?.title !== 'Zoom level'
        || !title.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
        || !title.fieldMeta.toolbarCandidate.reasons.includes('semantic_toolbar')
      ) {
        throw new Error(`title-labelled toolbar field must enter the toolbar audit, got: ${JSON.stringify(title)}`);
      }

      const ordinary = await call(page, 'set_field', {
        ref_id: refs.ordinary,
        text: '12',
        clear: true,
      });
      if (!ordinary?.success || ordinary.fieldMeta?.toolbarCandidate) {
        throw new Error(`labelled ordinary field must keep normal behavior, got: ${JSON.stringify(ordinary)}`);
      }
      const ordinarySelect = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'set_field',
        args: { ref_id: refs.ordinaryStatus, text: 'Published' },
      });
      if (!ordinarySelect?.resolved || ordinarySelect.fieldMeta?.type !== 'select' || ordinarySelect.fieldMeta?.toolbarCandidate) {
        throw new Error(`labelled ordinary select must keep normal behavior, got: ${JSON.stringify(ordinarySelect)}`);
      }
    });
  }

  test('Agent rich-text toolbar audit accepts visual family classification, rejects ordinary fields, and blocks the full toolbar scope', async () => {
    // executeTool is a thin deadline wrapper around _executeToolImpl, so the
    // shadow_dom_query body lives in the impl. Read both or this guard silently
    // stops inspecting the selector it exists to protect.
    const shadowQuerySource = [
      Agent.prototype.executeTool,
      Agent.prototype._executeToolImpl,
    ].filter(Boolean).map(fn => fn.toString()).join('\n');
    if (
      !shadowQuerySource.includes("const selectorLiteral = JSON.stringify(String(args.selector || ''))")
      || shadowQuerySource.includes("args.selector.replace(/'/g")
    ) {
      throw new Error('Chrome shadow_dom_query must embed selectors through a complete JSON string literal');
    }
    for (const AgentClass of [Agent, FirefoxAgent]) {
      const probeAdapter = new AgentClass({ getVisionProvider: async () => null })._richTextToolbarProbe;
      const frameHandshakeSource = [
        probeAdapter.frameGeometryToTop,
        probeAdapter.probeFocusedTarget,
      ].map(fn => fn.toString()).join('\n');
      if (frameHandshakeSource.includes('Math.random(') || !frameHandshakeSource.includes('secureRandomBase36Token(12)')) {
        throw new Error('rich-text frame handshakes must use cryptographically strong coordination tokens');
      }
      if (
        richTextToolbarRecoveryScopeMatches(
          'https://example.test/editor?mode=edit#/document/A',
          'https://example.test/editor?mode=edit#/document/B',
        )
      ) {
        throw new Error('hash-routed editor documents must remain separate recovery scopes');
      }
      if (
        !richTextToolbarRecoveryScopeMatches(
          'https://example.test/editor?mode=edit#/document/A',
          'https://example.test/editor?mode=edit#/document/A',
        )
      ) {
        throw new Error('an exact hash-routed editor document must remain recoverable');
      }
      const familyAudit = normalizeRichTextToolbarAudit({
        regionKind: 'rich_text_toolbar',
        targetKind: 'font_family',
        confidence: 0.94,
      });
      const candidate = {
        score: 4,
        reasons: ['unlabelled_text_control', 'compact_control', 'dense_control_cluster'],
        relatedRefs: ['ref_12', 'ref_13'],
        availablePresetValues: ['Default', 'Inter Display', 'Arial', 'Times New Roman'],
        regionRef: 'ref_10',
        regionKey: 'rtb:div:0:0:320:48',
        associatedEditorRef: 'ref_99',
        associatedEditorIdentity: {
          tag: 'div',
          id: 'editor-body',
          name: null,
          role: 'textbox',
          pageX: 20,
          pageY: 160,
          w: 400,
          h: 180,
        },
        regionRect: { x: 0, y: 0, w: 320, h: 48 },
        attemptedTextShape: {
          chars: 86,
          words: 14,
          lines: 1,
          numericPreset: false,
          urlLike: false,
        },
      };
      if (
        richTextToolbarEditorIdentityMatches(
          candidate.associatedEditorIdentity,
          { tag: 'div', id: 'editor-body', role: 'textbox' },
          { pageX: 520, pageY: 160, w: 400, h: 180 },
        )
      ) {
        throw new Error('matching editor IDs in separate component geometry must remain distinct');
      }
      if (
        !richTextToolbarEditorIdentityMatches(
          candidate.associatedEditorIdentity,
          { tag: 'div', id: 'editor-body', role: 'textbox' },
          { pageX: 20, pageY: 160, w: 400, h: 180 },
        )
      ) {
        throw new Error('matching editor identity and geometry must remain recoverable');
      }
      const familyDecision = richTextToolbarDecision(candidate, familyAudit);
      if (!familyDecision.wrongTarget || familyDecision.targetKind !== 'font_family') {
        throw new Error(`expected visual font-family rejection, got: ${JSON.stringify(familyDecision)}`);
      }
      const legitimateFamilyDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Inter Display'),
        attemptedPresetMatch: richTextToolbarPresetMatch('Inter Display', candidate.availablePresetValues),
      }, familyAudit);
      if (legitimateFamilyDecision.wrongTarget) {
        throw new Error(`short font-family value must remain allowed: ${JSON.stringify(legitimateFamilyDecision)}`);
      }
      for (const documentText of ['Paris', 'Quarterly roadmap']) {
        const mistakenFamilyDecision = richTextToolbarDecision({
          ...candidate,
          attemptedTextShape: richTextToolbarTextShape(documentText),
          attemptedPresetMatch: richTextToolbarPresetMatch(documentText, candidate.availablePresetValues),
        }, familyAudit);
        if (!mistakenFamilyDecision.wrongTarget) {
          throw new Error(`arbitrary short text must be rejected for font-family targets: ${JSON.stringify({ documentText, mistakenFamilyDecision })}`);
        }
      }
      const genericFamilyDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('system-ui'),
        attemptedPresetMatch: false,
      }, familyAudit);
      if (genericFamilyDecision.wrongTarget) {
        throw new Error(`standard generic font family must remain allowed: ${JSON.stringify(genericFamilyDecision)}`);
      }
      const styleAudit = {
        ...familyAudit,
        targetKind: 'style_preset',
      };
      const stylePresetValues = ['Body', 'Heading 1', 'Title'];
      const legitimateStyleDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Heading 1'),
        attemptedPresetMatch: richTextToolbarPresetMatch('Heading 1', stylePresetValues),
      }, styleAudit);
      if (legitimateStyleDecision.wrongTarget) {
        throw new Error(`control-owned style preset must remain allowed: ${JSON.stringify(legitimateStyleDecision)}`);
      }
      const uncertainPresetDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Heading 1'),
        attemptedPresetMatch: true,
      }, {
        ...familyAudit,
        targetKind: 'uncertain',
      });
      if (uncertainPresetDecision.wrongTarget) {
        throw new Error(`control-owned preset must survive an uncertain visual target kind: ${JSON.stringify(uncertainPresetDecision)}`);
      }
      const uncertainProseDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Quarterly roadmap'),
        attemptedPresetMatch: false,
      }, {
        ...familyAudit,
        targetKind: 'uncertain',
      });
      if (!uncertainProseDecision.wrongTarget) {
        throw new Error(`arbitrary prose must remain blocked for an uncertain visual target kind: ${JSON.stringify(uncertainProseDecision)}`);
      }
      const mistakenStyleDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Quarterly roadmap'),
        attemptedPresetMatch: richTextToolbarPresetMatch('Quarterly roadmap', stylePresetValues),
      }, styleAudit);
      if (!mistakenStyleDecision.wrongTarget) {
        throw new Error(`arbitrary short text must be rejected for style-preset targets: ${JSON.stringify(mistakenStyleDecision)}`);
      }
      const semanticStyleDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('h2'),
        attemptedPresetMatch: false,
      }, styleAudit);
      if (semanticStyleDecision.wrongTarget) {
        throw new Error(`semantic style token must remain allowed: ${JSON.stringify(semanticStyleDecision)}`);
      }
      const colorAudit = {
        ...familyAudit,
        targetKind: 'color',
      };
      for (const color of ['red', 'transparent', 'rebeccapurple']) {
        const colorDecision = richTextToolbarDecision({
          ...candidate,
          attemptedTextShape: richTextToolbarTextShape(color),
          attemptedPresetMatch: false,
        }, colorAudit);
        if (colorDecision.wrongTarget) {
          throw new Error(`CSS named color must remain allowed: ${JSON.stringify({ color, colorDecision })}`);
        }
      }
      const presetColorDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Brand Accent'),
        attemptedPresetMatch: true,
      }, colorAudit);
      if (presetColorDecision.wrongTarget) {
        throw new Error(`control-owned color preset must remain allowed: ${JSON.stringify(presetColorDecision)}`);
      }
      const proseColorDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Quarterly roadmap'),
        attemptedPresetMatch: false,
      }, colorAudit);
      if (!proseColorDecision.wrongTarget) {
        throw new Error(`ordinary prose must be rejected for color targets: ${JSON.stringify(proseColorDecision)}`);
      }
      const linkAudit = {
        ...familyAudit,
        targetKind: 'link',
      };
      for (const destination of [
        'https://example.com/docs',
        'www.example.com',
        '/docs/start',
        '../docs/start',
        'person@example.com',
        'mailto:person@example.com',
        'tel:+15551234567',
        '#overview',
      ]) {
        const linkDecision = richTextToolbarDecision({
          ...candidate,
          attemptedTextShape: richTextToolbarTextShape(destination),
        }, linkAudit);
        if (linkDecision.wrongTarget) {
          throw new Error(`common link destination must remain allowed: ${JSON.stringify({ destination, linkDecision })}`);
        }
      }
      for (const prose of ['Quarterly roadmap', 'Contact the project team']) {
        const proseLinkDecision = richTextToolbarDecision({
          ...candidate,
          attemptedTextShape: richTextToolbarTextShape(prose),
        }, linkAudit);
        if (!proseLinkDecision.wrongTarget) {
          throw new Error(`ordinary prose must be rejected for link targets: ${JSON.stringify({ prose, proseLinkDecision })}`);
        }
      }
      const numericSizeDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('14'),
      }, {
        ...familyAudit,
        targetKind: 'font_size',
      });
      if (numericSizeDecision.wrongTarget) {
        throw new Error(`numeric font-size preset must remain allowed: ${JSON.stringify(numericSizeDecision)}`);
      }
      const documentTextSizeDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('This is document content, not a size preset.'),
      }, {
        ...familyAudit,
        targetKind: 'font_size',
      });
      if (!documentTextSizeDecision.wrongTarget) {
        throw new Error(`document text must be rejected for font-size targets: ${JSON.stringify(documentTextSizeDecision)}`);
      }
      const otherFormattingAudit = {
        ...familyAudit,
        targetKind: 'other_formatting',
      };
      const numericFormattingDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('125%'),
      }, otherFormattingAudit);
      if (numericFormattingDecision.wrongTarget) {
        throw new Error(`numeric other-formatting value must remain allowed: ${JSON.stringify(numericFormattingDecision)}`);
      }
      const documentTextFormattingDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('This is document content, not a formatting preset.'),
      }, otherFormattingAudit);
      if (!documentTextFormattingDecision.wrongTarget) {
        throw new Error(`document text must be rejected for other-formatting targets: ${JSON.stringify(documentTextFormattingDecision)}`);
      }
      for (const prose of ['Paris', 'Quarterly roadmap']) {
        const shortProseFormattingDecision = richTextToolbarDecision({
          ...candidate,
          attemptedTextShape: richTextToolbarTextShape(prose),
          attemptedPresetMatch: false,
        }, otherFormattingAudit);
        if (!shortProseFormattingDecision.wrongTarget) {
          throw new Error(`short prose must be rejected for other-formatting targets: ${JSON.stringify({ prose, shortProseFormattingDecision })}`);
        }
      }
      const formattingPresetDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Single'),
        attemptedPresetMatch: true,
      }, otherFormattingAudit);
      if (formattingPresetDecision.wrongTarget) {
        throw new Error(`control-owned other-formatting preset must remain allowed: ${JSON.stringify(formattingPresetDecision)}`);
      }
      for (const targetKind of ['font_size', 'font_family', 'style_preset', 'color', 'link', 'other_formatting']) {
        const clearingDecision = richTextToolbarDecision({
          ...candidate,
          attemptedTextShape: richTextToolbarTextShape(''),
          attemptedPresetMatch: false,
        }, {
          ...familyAudit,
          targetKind,
        });
        if (clearingDecision.wrongTarget) {
          throw new Error(`explicit empty formatting reset must remain allowed: ${JSON.stringify({ targetKind, clearingDecision })}`);
        }
      }
      const ordinaryDecision = richTextToolbarDecision(candidate, {
        regionKind: 'ordinary_form_field',
        targetKind: 'ordinary_input',
        confidence: 0.96,
      });
      if (ordinaryDecision.wrongTarget) {
        throw new Error(`ordinary field visual classification must override weak structure: ${JSON.stringify(ordinaryDecision)}`);
      }
      for (const [value, preset] of [
        ['14', false],
        ['Inter Display', true],
        ['h2', false],
        ['red', false],
        ['https://example.test/docs', false],
      ]) {
        const structuralFormattingDecision = richTextToolbarDecision({
          ...candidate,
          attemptedTextShape: richTextToolbarTextShape(value),
          attemptedPresetMatch: preset,
        }, null);
        if (structuralFormattingDecision.wrongTarget) {
          throw new Error(`plausible formatting value must survive no-vision structural fallback: ${JSON.stringify({ value, structuralFormattingDecision })}`);
        }
      }
      const structuralProseDecision = richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: richTextToolbarTextShape('Paris'),
        attemptedPresetMatch: false,
      }, null);
      if (!structuralProseDecision.wrongTarget || structuralProseDecision.source !== 'structural_fallback') {
        throw new Error(`no-vision structural fallback must reject prose-like toolbar values: ${JSON.stringify(structuralProseDecision)}`);
      }
      const numericCandidate = {
        ...candidate,
        reasons: [...candidate.reasons, 'numeric_preset_value'],
        availablePresetValues: ['11', '14'],
      };
      for (const value of ['red', 'serif', 'h1', 'https://example.test/docs']) {
        const crossKindDecision = richTextToolbarDecision({
          ...numericCandidate,
          attemptedTextShape: richTextToolbarTextShape(value),
          attemptedPresetMatch: richTextToolbarPresetMatch(value, numericCandidate.availablePresetValues),
        }, null);
        if (!crossKindDecision.wrongTarget || crossKindDecision.source !== 'structural_fallback') {
          throw new Error(`numeric toolbar candidate accepted a cross-kind formatting value: ${JSON.stringify({ value, crossKindDecision })}`);
        }
      }
      for (const value of ['14', '16']) {
        const numericFallbackDecision = richTextToolbarDecision({
          ...numericCandidate,
          attemptedTextShape: richTextToolbarTextShape(value),
          attemptedPresetMatch: richTextToolbarPresetMatch(value, numericCandidate.availablePresetValues),
        }, null);
        if (numericFallbackDecision.wrongTarget) {
          throw new Error(`numeric toolbar candidate rejected a numeric value: ${JSON.stringify({ value, numericFallbackDecision })}`);
        }
      }

      const agent = new AgentClass({ getVisionProvider: async () => null });
      // Strict checks: the guard's refusal itself is under test.
      agent.strictGuards = true;
      const tabId = 77;
      const focusAgent = new AgentClass({ getVisionProvider: async () => null });
      const extensionGlobal = AgentClass === Agent ? 'chrome' : 'browser';
      const originalExtensionApi = globalThis[extensionGlobal];
      const frameMessages = [];
      const focusedFrameWaits = new Map();
      globalThis[extensionGlobal] = {
        webNavigation: {
          async getAllFrames() {
            return [
              { frameId: 0, parentFrameId: -1, url: 'https://example.test/editor' },
              { frameId: 7, parentFrameId: 0, url: 'https://frames.example.test/editor' },
              { frameId: 8, parentFrameId: 0, url: 'https://frames.example.test/inactive' },
            ];
          },
        },
        tabs: {
          async sendMessage(_tabId, message, options) {
            frameMessages.push({ message, options });
            if (message.action === 'wait_for_rich_text_toolbar_focused_child_frame') {
              return new Promise(resolve => focusedFrameWaits.set(message.params.token, resolve));
            }
            if (message.action === 'announce_rich_text_toolbar_focused_child_frame') {
              const resolve = focusedFrameWaits.get(message.params.token);
              focusedFrameWaits.delete(message.params.token);
              resolve?.({ matched: options.frameId === 7 });
              return { announced: true };
            }
            if (options.frameId === 0) {
              return {
                resolved: true,
                rect: { x: 10, y: 20, w: 500, h: 300 },
                fieldMeta: { tag: 'iframe' },
              };
            }
            if (options.frameId === 7) {
              return {
                resolved: true,
                refId: 'ref_7',
                dispatchBinding: { token: 'focused-frame-token' },
                rect: { x: 12, y: 9, w: 110, h: 24 },
                fieldMeta: {
                  tag: 'input',
                  toolbarCandidate: { score: 8, reasons: ['semantic_toolbar'] },
                },
                toolbarContext: true,
              };
            }
            return {
              resolved: true,
              refId: 'inactive_ref',
              dispatchBinding: { token: 'inactive-frame-token' },
              rect: { x: 14, y: 11, w: 100, h: 22 },
              fieldMeta: {
                tag: 'input',
                toolbarCandidate: { score: 99, reasons: ['semantic_toolbar'] },
              },
              toolbarContext: true,
            };
          },
        },
      };
      try {
        focusAgent._richTextToolbarProbe.frameRectToTop = async (_tabId, frames, frameId, rect) => ({
          ...rect,
          x: rect.x + (frames.length * 10),
          frameId,
        });
        const deepFrameProbe = await focusAgent._probeRichTextToolbarRetryTarget(
          tabId,
          'type_text',
          { text: 'Paris' },
          { mapAnnotation: true },
        );
        const probeMessages = frameMessages.filter(entry => entry.message.action === 'probe_rich_text_toolbar_retry_target');
        if (
          deepFrameProbe?.frameId !== 7
          || deepFrameProbe.refId !== 'ref_7'
          || deepFrameProbe.dispatchBinding?.token !== 'focused-frame-token'
          || deepFrameProbe.annotationRect?.x !== 42
          || probeMessages.length !== 2
          || probeMessages.map(entry => entry.options.frameId).join(',') !== '0,7'
          || !frameMessages.some(entry => entry.message.action === 'wait_for_rich_text_toolbar_focused_child_frame')
          || !frameMessages.some(entry => entry.message.action === 'announce_rich_text_toolbar_focused_child_frame' && entry.options.frameId === 7)
          || probeMessages.some(entry => entry.message.params.args.selector != null)
        ) {
          throw new Error(`focused type_text must probe only the handshaken focused frame branch: ${JSON.stringify({ deepFrameProbe, frameMessages })}`);
        }
        frameMessages.length = 0;
        const keyboardFrameProbe = await focusAgent._probeRichTextToolbarRetryTarget(
          tabId,
          'press_keys',
          { keys: ['ARROWDOWN', 'ENTER'] },
          { mapAnnotation: true },
        );
        const keyboardProbeMessages = frameMessages.filter(
          entry => entry.message.action === 'probe_rich_text_toolbar_retry_target',
        );
        if (
          keyboardFrameProbe?.frameId !== 7
          || keyboardFrameProbe.refId !== 'ref_7'
          || keyboardFrameProbe.dispatchBinding?.token !== 'focused-frame-token'
          || keyboardProbeMessages.map(entry => entry.options.frameId).join(',') !== '0,7'
        ) {
          throw new Error(`focused keyboard tools must share the handshaken target probe: ${JSON.stringify({ keyboardFrameProbe, frameMessages })}`);
        }
      } finally {
        if (originalExtensionApi === undefined) delete globalThis[extensionGlobal];
        else globalThis[extensionGlobal] = originalExtensionApi;
      }
      let capturedVisionMessages = null;
      agent.providerManager.getVisionProvider = async () => ({
        config: { model: 'fixture-vision', baseUrl: 'https://vision.example.test' },
      });
      agent._chatWithCostAllowance = async (_vision, messages) => {
        capturedVisionMessages = messages;
        return { content: JSON.stringify(familyAudit) };
      };
      const targetOnlyAudit = await agent._classifyRichTextToolbarTarget(
        tabId,
        { supportsVision: true },
        'data:image/png;base64,dGVzdA==',
      );
      const serializedVisionMessages = JSON.stringify(capturedVisionMessages);
      if (
        !targetOnlyAudit
        || serializedVisionMessages.includes('TRUSTED USER TASK CONTEXT')
        || serializedVisionMessages.includes('PROPOSED TOOL VALUE')
        || serializedVisionMessages.includes('taskTargetIntent')
        || !serializedVisionMessages.includes('Classify only that target')
      ) {
        throw new Error(`vision prompt must remain target-only: ${serializedVisionMessages}`);
      }
      agent.providerManager.getVisionProvider = async () => null;
      agent._lastAxScopes.set(tabId, { documentToken: 'doc-a', pageUrl: 'https://example.test/editor' });
      const result = { success: true, verified: true, dispatched: true };
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Paris' },
        result,
        candidate,
        familyDecision,
        familyAudit,
        { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
      );
      if (result.success || result.verified || !result.wrongTarget || result.dispatched !== false || result.noDispatch !== true) {
        throw new Error(`wrong target must be blocked before dispatch: ${JSON.stringify(result)}`);
      }
      const alternateControlBlock = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'type_text',
        { selector: '#font-size', text: 'Paris', clear: true },
        alternateControlBlock,
        {
          ...candidate,
          relatedRefs: ['ref_14', 'ref_15'],
        },
        familyDecision,
        familyAudit,
        { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
      );
      const deduplicatedState = toolbarLedgerView(agent, tabId);
      const deduplicatedObligation = deduplicatedState?.recoveryObligations?.[0];
      if (
        deduplicatedState?.recoveryObligations?.length !== 1
        || !deduplicatedObligation?.blockedRefs?.includes('ref_12')
        || !deduplicatedObligation?.blockedRefs?.includes('ref_14')
        || !deduplicatedObligation?.blockedSelectors?.includes('#font-size')
        || !deduplicatedState.blockedRefs?.has('ref_14')
        || !deduplicatedState.blockedSelectors?.has('#font-size')
      ) {
        throw new Error(`equivalent editor mutations must merge toolbar targets into one recovery obligation: ${JSON.stringify(deduplicatedState)}`);
      }
      agent.conversations.set(tabId, [{ role: 'system', content: 'test' }]);
      const persistedToolbarEntry = agent._conversationStorageEntry(tabId);
      if (
        persistedToolbarEntry?.richTextToolbarAudit?.recoveryObligations?.length !== 1
        || !persistedToolbarEntry.richTextToolbarAudit.recoveryObligations[0].blockedRefs.includes('ref_12')
        || Object.values(persistedToolbarEntry.richTextToolbarAudit).some(value => value instanceof Set)
      ) {
        throw new Error(`toolbar recovery must serialize into plain conversation state: ${JSON.stringify(persistedToolbarEntry)}`);
      }
      const persistenceApi = AgentClass === Agent ? 'chrome' : 'browser';
      const priorPersistenceApi = globalThis[persistenceApi];
      globalThis[persistenceApi] = {
        storage: {
          session: {
            get: async key => ({ [key]: structuredClone(persistedToolbarEntry) }),
          },
        },
      };
      try {
        const continued = new AgentClass({ getVisionProvider: async () => null });
        continued._processMessageInner = async () => ({
          hasObligation: continued._richTextToolbarGuard.hasPending(tabId),
          blockedRef: toolbarLedgerView(continued, tabId)?.blockedRefs?.has('ref_12'),
        });
        const continuedState = await continued.processMessage(
          tabId,
          'Please continue from where you left off.',
          () => {},
          'act',
          [],
          { trustedContinuation: true },
        );
        if (!continuedState?.hasObligation || !continuedState.blockedRef) {
          throw new Error(`trusted continuation lost persisted toolbar recovery: ${JSON.stringify(continuedState)}`);
        }

        const ordinaryTurn = new AgentClass({ getVisionProvider: async () => null });
        ordinaryTurn._processMessageInner = async () => ({
          hasObligation: ordinaryTurn._richTextToolbarGuard.hasPending(tabId),
        });
        const ordinaryState = await ordinaryTurn.processMessage(
          tabId,
          'Start a different task.',
          () => {},
          'act',
          [],
          {},
        );
        if (ordinaryState?.hasObligation) {
          throw new Error(`ordinary user turn revived persisted toolbar recovery: ${JSON.stringify(ordinaryState)}`);
        }
      } finally {
        if (priorPersistenceApi === undefined) delete globalThis[persistenceApi];
        else globalThis[persistenceApi] = priorPersistenceApi;
      }
      const siblingBlock = agent._richTextToolbarGuard.blockRef(tabId, 'click_ax', { ref_id: 'ref_13' }, 'doc-a');
      if (!siblingBlock?.blockedToolbarRef || siblingBlock.dispatched !== false) {
        throw new Error(`expected sibling toolbar ref block, got: ${JSON.stringify(siblingBlock)}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_13',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 80, y: 8, w: 24, h: 24 },
        fieldMeta: { tag: 'input', type: 'checkbox' },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
        toolbarRegionKey: candidate.regionKey,
      });
      const checkedToolbarBlock = await agent._richTextToolbarToolBlock(
        tabId,
        'set_checked',
        { ref_id: 'ref_13', checked: true },
      );
      if (!checkedToolbarBlock?.wrongTarget || checkedToolbarBlock.dispatched !== false) {
        throw new Error(`set_checked must not bypass an outstanding toolbar recovery: ${JSON.stringify(checkedToolbarBlock)}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_12',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 8, w: 60, h: 24 },
        fieldMeta: {},
        toolbarContext: true,
        toolbarRegionRef: '',
        toolbarRegionKey: candidate.regionKey,
      });
      const focusedRetryBlock = await agent._richTextToolbarToolBlock(tabId, 'type_text', { text: 'Paris' });
      if (!focusedRetryBlock?.wrongTarget || focusedRetryBlock.dispatched !== false) {
        throw new Error(`expected focused type_text toolbar retry block, got: ${JSON.stringify(focusedRetryBlock)}`);
      }
      const keyboardRetryBlock = await agent._richTextToolbarToolBlock(
        tabId,
        'press_keys',
        { keys: ['ARROWDOWN', 'ENTER'] },
      );
      if (!keyboardRetryBlock?.wrongTarget || keyboardRetryBlock.dispatched !== false) {
        throw new Error(`focused keyboard input must not bypass toolbar recovery: ${JSON.stringify(keyboardRetryBlock)}`);
      }
      const coordinateRetryBlock = await agent._richTextToolbarToolBlock(tabId, 'click', { x: 40, y: 20 });
      if (!coordinateRetryBlock?.wrongTarget || coordinateRetryBlock.dispatched !== false) {
        throw new Error(`expected coordinate toolbar retry block, got: ${JSON.stringify(coordinateRetryBlock)}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({ resolved: false });
      const unresolvedKeyboardBlock = await agent._richTextToolbarToolBlock(
        tabId,
        'press_keys',
        { keys: ['ARROWDOWN', 'ENTER'] },
      );
      if (unresolvedKeyboardBlock?.dispatched !== false || !unresolvedKeyboardBlock.retryable) {
        throw new Error(`unresolved focused keyboard input must fail closed during toolbar recovery: ${JSON.stringify(unresolvedKeyboardBlock)}`);
      }
      const otherToolbarProbe = {
        resolved: true,
        dispatchBinding: { token: 'other-toolbar-click-token', frameId: 0 },
        refId: 'ref_88',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 500, y: 8, w: 60, h: 24 },
        fieldMeta: {
          toolbarCandidate: {
            ...candidate,
            score: 8,
            reasons: ['unlabelled_text_control', 'compact_control', 'numeric_preset_value', 'semantic_toolbar'],
            relatedRefs: ['ref_88', 'ref_89'],
            regionRef: 'ref_80',
            associatedEditorRef: 'ref_199',
            associatedEditorIdentity: {
              ...candidate.associatedEditorIdentity,
              id: 'editor-body-b',
              pageX: 500,
            },
          },
        },
        toolbarContext: true,
        toolbarRegionRef: 'ref_80',
      };
      agent._probeRichTextToolbarRetryTarget = async () => otherToolbarProbe;
      const clickExecutionContext = {};
      const otherToolbarBlock = await agent._richTextToolbarToolBlock(
        tabId,
        'click',
        { selector: '#other-toolbar' },
        clickExecutionContext,
      );
      if (otherToolbarBlock || clickExecutionContext.dispatchBinding?.token !== 'other-toolbar-click-token') {
        throw new Error(`an unrelated toolbar click must stay allowed and bound to its audited target: ${JSON.stringify({ otherToolbarBlock, clickExecutionContext })}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        dispatchBinding: { token: 'guarded-editor-keyboard-token', frameId: 0 },
        refId: 'ref_99',
        frameId: 0,
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 20, y: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const keyboardExecutionContext = {};
      const allowedEditorKeyboard = await agent._richTextToolbarToolBlock(
        tabId,
        'press_keys',
        { key: 'ArrowDown' },
        keyboardExecutionContext,
      );
      if (
        allowedEditorKeyboard
        || keyboardExecutionContext.dispatchBinding?.token !== 'guarded-editor-keyboard-token'
        || keyboardExecutionContext.dispatchBinding?.frameId !== 0
      ) {
        throw new Error(`allowed recovery keyboard input must carry its exact focused target into dispatch: ${JSON.stringify({ allowedEditorKeyboard, keyboardExecutionContext })}`);
      }
      if (AgentClass === Agent) {
        const dispatchAgent = new AgentClass({ getVisionProvider: async () => null });
        const originalChrome = globalThis.chrome;
        const originalAttach = cdpClient.attach;
        const originalSendCommand = cdpClient.sendCommand;
        const dispatchOrder = [];
        dispatchAgent._richTextToolbarToolBlock = async (_tabId, _toolName, _args, context) => {
          context.dispatchBinding = { token: 'guarded-editor-keyboard-token', frameId: 7 };
          return null;
        };
        globalThis.chrome = {
          tabs: {
            get: async () => ({ url: 'https://example.test/editor' }),
            sendMessage: async (_tabId, message, options) => {
              dispatchOrder.push(`${message.action}:${options?.frameId ?? 'top'}`);
              return { success: true, matched: true };
            },
          },
        };
        cdpClient.attach = async () => { dispatchOrder.push('cdp:attach'); };
        cdpClient.sendCommand = async (_tabId, method) => { dispatchOrder.push(method); };
        try {
          const guardedDispatch = await dispatchAgent.executeTool(tabId, 'press_keys', { key: 'ArrowDown' });
          if (
            guardedDispatch?.success !== true
            || dispatchOrder.join(',') !== 'cdp:attach,consume_focused_dispatch_binding:7,Input.dispatchKeyEvent,Input.dispatchKeyEvent'
          ) {
            throw new Error(`Chrome keyboard dispatch must consume the guarded frame target immediately before CDP input: ${JSON.stringify({ guardedDispatch, dispatchOrder })}`);
          }
        } finally {
          cdpClient.attach = originalAttach;
          cdpClient.sendCommand = originalSendCommand;
          if (originalChrome === undefined) delete globalThis.chrome;
          else globalThis.chrome = originalChrome;
        }
      }
      agent._probeRichTextToolbarRetryTarget = async () => otherToolbarProbe;
      const otherToolbarPreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_88', text: 'Document prose' },
        { supportsVision: false },
      );
      if (!otherToolbarPreflight.block?.wrongTarget || otherToolbarPreflight.block.dispatched !== false) {
        throw new Error('a second toolbar must still be audited while a recovery obligation is open');
      }
      const preservedRecoveryState = toolbarLedgerView(agent, tabId);
      if (
        preservedRecoveryState?.associatedEditorRef !== 'ref_99'
        || preservedRecoveryState?.associatedEditorIdentity?.id !== 'editor-body'
        || preservedRecoveryState?.recoveryObligations?.length !== 2
        || !preservedRecoveryState.blockedRegionRefs?.has('ref_10')
        || !preservedRecoveryState.blockedRegionRefs?.has('ref_80')
        || agent._richTextToolbarGuard.completionAction(tabId)?.ref_id !== 'ref_12'
      ) {
        throw new Error(`a later toolbar must not replace the first unresolved editor: ${JSON.stringify(preservedRecoveryState)}`);
      }
      await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_88', text: 'Document prose' },
        { supportsVision: false },
      );
      if (toolbarLedgerView(agent, tabId)?.recoveryObligations?.length !== 2) {
        throw new Error('an identical blocked retry must not create duplicate recovery obligations');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_199',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 500, y: 160, pageX: 500, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body-b', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const secondEditorRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'set_field',
        { ref_id: 'ref_199', text: 'Paris' },
        { success: true, verified: true, method: 'set_field' },
      );
      if (secondEditorRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('editing the second toolbar\'s editor must not clear the first unresolved editor obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        dispatchBinding: { token: 'editor-body-click-token', frameId: 0 },
        refId: 'ref_99',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 20, y: 160, w: 400, h: 180 },
        fieldMeta: { contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const editorBodyBlock = await agent._richTextToolbarToolBlock(tabId, 'click', { selector: '#editor' });
      if (editorBodyBlock) {
        throw new Error(`editor-body recovery target must remain usable: ${JSON.stringify(editorBodyBlock)}`);
      }
      agent._effectiveRunMode = () => 'act';
      const doneBlock = agent._completionDoneBlock(tabId, 'done', { outcome: 'success' });
      if (doneBlock?.reason !== 'rich_text_toolbar_target_unresolved') {
        throw new Error(`expected unresolved toolbar completion block, got: ${JSON.stringify(doneBlock)}`);
      }
      const plainFinalBlock = agent._completionPlainFinalBlock(tabId);
      if (!plainFinalBlock?.includes('RUNTIME COMPLETION BLOCK') || !plainFinalBlock.includes('rich-text formatting toolbar')) {
        throw new Error(`expected unresolved toolbar plain-final block, got: ${JSON.stringify(plainFinalBlock)}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_98',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        fieldMeta: { contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const unrelatedRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(tabId, 'type_text', { text: 'Paris', clear: true }, {
        success: true,
        verified: true,
        method: 'contenteditable',
      });
      if (unrelatedRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('an unrelated contenteditable must not clear the toolbar completion obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_99',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        fieldMeta: { contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const unverifiedRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(tabId, 'type_text', { text: 'Paris', clear: true }, {
        success: true,
        method: 'contenteditable',
      });
      if (unverifiedRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('an unverified editor dispatch must retain the toolbar completion obligation');
      }
      for (const incorrectText of ['', 'Lyon']) {
        const incorrectTextRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(tabId, 'type_text', { text: incorrectText, clear: true }, {
          success: true,
          verified: true,
          method: 'contenteditable',
        });
        if (incorrectTextRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
          throw new Error(`an exact editor edit with mismatched text must retain the toolbar completion obligation: ${JSON.stringify(incorrectText)}`);
        }
      }
      const appendModeRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(tabId, 'type_text', { text: 'Paris' }, {
        success: true,
        verified: true,
        method: 'contenteditable',
      });
      if (appendModeRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('append-mode recovery must not discharge a blocked replacement edit');
      }
      const exactRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(tabId, 'type_text', { text: 'Paris', clear: true }, {
        success: true,
        verified: true,
        method: 'contenteditable',
      });
      const secondRecoveryState = toolbarLedgerView(agent, tabId);
      if (
        !exactRecovery
        || !agent._richTextToolbarGuard.hasPending(tabId)
        || secondRecoveryState?.associatedEditorRef !== 'ref_199'
        || secondRecoveryState?.blockedAttemptedText !== 'Document prose'
        || secondRecoveryState?.recoveryObligations?.length !== 1
      ) {
        throw new Error('recovering the first editor must retain and promote the second toolbar obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_199',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 500, y: 160, pageX: 500, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body-b', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const finalRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(tabId, 'set_field', { ref_id: 'ref_199', text: 'Document prose' }, {
        success: true,
        verified: true,
        method: 'set_field',
      });
      if (!finalRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('every accumulated toolbar obligation must be recovered before completion unblocks');
      }
      if (agent._richTextToolbarGuard.blockRef(tabId, 'click_ax', { ref_id: 'ref_13' }, 'doc-a')) {
        throw new Error('toolbar refs must be released after exact editor recovery');
      }

      const queuedFirstBlock = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_queue_toolbar_a', text: 'First queued edit' },
        queuedFirstBlock,
        candidate,
        familyDecision,
        familyAudit,
        { documentToken: 'doc-queue-a', refScopeUrl: 'https://example.test/editor' },
      );
      const queuedSecondBlock = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'type_text',
        { selector: '#queue-toolbar-b', text: 'Second queued edit' },
        queuedSecondBlock,
        {
          ...candidate,
          regionRef: 'ref_queue_region_b',
          associatedEditorRef: 'ref_queue_editor_b',
          associatedEditorIdentity: { ...candidate.associatedEditorIdentity, id: 'queue-editor-b', pageX: 500 },
        },
        familyDecision,
        familyAudit,
        { documentToken: 'doc-queue-a', refScopeUrl: 'https://example.test/editor' },
      );
      agent._clearRichTextToolbarDocumentState(tabId);
      const queuedNavigationState = toolbarLedgerView(agent, tabId);
      if (
        queuedNavigationState?.recoveryObligations?.length !== 2
        || queuedNavigationState.recoveryObligations.some(obligation => obligation.recoveryOnly !== true || obligation.associatedEditorRef)
        || !agent._richTextToolbarGuard.hasPending(tabId)
      ) {
        throw new Error('navigation must preserve every accumulated recovery obligation while releasing document-scoped refs');
      }
      agent._resetRichTextToolbarAudit(tabId);

      for (const [frameId, documentToken] of [[7, 'sibling-frame-doc-a'], [8, 'sibling-frame-doc-b']]) {
        agent._applyRichTextToolbarWrongTarget(
          tabId,
          'iframe_type',
          { selector: '#font-size', text: 'Shared iframe edit', clear: true },
          {},
          candidate,
          familyDecision,
          familyAudit,
          { frameId, documentToken, refScopeUrl: 'https://frame.example.test/editor' },
        );
      }
      const siblingFrameState = toolbarLedgerView(agent, tabId);
      if (
        siblingFrameState?.recoveryObligations?.length !== 2
        || new Set(siblingFrameState.recoveryObligations.map(obligation => obligation.frameId)).size !== 2
      ) {
        throw new Error('identical editor templates in sibling frames must retain separate recovery obligations');
      }
      agent._richTextToolbarProbe.probeIframeTarget = async () => ({
        resolved: true,
        frameId: 8,
        documentToken: 'sibling-frame-doc-b',
        refScopeUrl: 'https://frame.example.test/editor',
        rect: { x: 10, y: 8, w: 60, h: 24 },
        fieldMeta: {},
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
        toolbarRegionKey: candidate.regionKey,
      });
      agent._probeRichTextToolbarRetryTarget = AgentClass.prototype._probeRichTextToolbarRetryTarget.bind(agent);
      const secondaryFrameToolbarBlock = await agent._richTextToolbarToolBlock(
        tabId,
        'iframe_click',
        { urlFilter: 'frame.example.test', selector: '#bold' },
      );
      if (!secondaryFrameToolbarBlock?.wrongTarget || secondaryFrameToolbarBlock.dispatched !== false) {
        throw new Error(`every accumulated iframe obligation must block its toolbar controls: ${JSON.stringify(secondaryFrameToolbarBlock)}`);
      }
      agent._resetRichTextToolbarAudit(tabId);

      const refLessIdentityRecoveryResult = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'type_text',
        { selector: '#font-family', text: 'Document prose' },
        refLessIdentityRecoveryResult,
        { ...candidate, associatedEditorRef: '' },
        familyDecision,
        familyAudit,
        { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
      );
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_200',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const refLessIdentityRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'set_field',
        { ref_id: 'ref_200', text: 'Document prose', clear: false },
        { success: true, verified: true, method: 'set_field' },
      );
      if (!refLessIdentityRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a selector-backed rejection without an editor ref must recover through matching editor identity');
      }

      const selectorRecoveryResult = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'type_text',
        { selector: '#font-family', text: 'Document prose' },
        selectorRecoveryResult,
        { ...candidate, associatedEditorRef: '' },
        familyDecision,
        familyAudit,
        { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
      );
      if (!agent._richTextToolbarGuard.hasPending(tabId) || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('selector rejection with a stable editor identity must retain a recoverable completion obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: '',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 8, pageX: 10, pageY: 8, w: 60, h: 24 },
        fieldMeta: { tag: 'input', type: 'text', toolbarCandidate: candidate },
        toolbarContext: true,
        toolbarRegionRef: '',
      });
      const selectorRetryBlock = await agent._richTextToolbarToolBlock(
        tabId,
        'type_text',
        { selector: '#font-family', text: 'Document prose' },
      );
      if (!selectorRetryBlock?.wrongTarget || selectorRetryBlock.dispatched !== false) {
        throw new Error(`the rejected toolbar selector must remain blocked while a recovery obligation exists: ${JSON.stringify(selectorRetryBlock)}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: '',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'other-editor', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const unrelatedSelectorRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'type_text',
        { selector: '#other-editor', text: 'Document prose' },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (unrelatedSelectorRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a selector resolving to a different editor must not clear the toolbar completion obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: '',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const exactSelectorRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'type_text',
        { selector: '#editor-body', text: 'Document prose' },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (!exactSelectorRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a selector resolving to the associated editor identity should clear the toolbar obligation');
      }

      const rerenderRecoveryResult = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Document prose' },
        rerenderRecoveryResult,
        candidate,
        familyDecision,
        familyAudit,
        { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
      );
      const validatedEditorProbe = {
        resolved: true,
        refId: 'ref_99',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      };
      agent._probeRichTextToolbarRetryTarget = async () => validatedEditorProbe;
      const rerenderPreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_99', text: 'Document prose' },
        { supportsVision: false },
      );
      if (rerenderPreflight.probe !== validatedEditorProbe) {
        throw new Error('toolbar preflight must preserve the validated editor target through execution');
      }
      agent._probeRichTextToolbarRetryTarget = async () => null;
      await agent._auditRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_99', text: 'Document prose' },
        { success: true, method: 'set_field', fieldMeta: validatedEditorProbe.fieldMeta },
        rerenderPreflight.probe,
      );
      if (!agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('pre-dispatch recovery evidence must not clear an obligation without an explicitly verified edit');
      }
      await agent._auditRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_99', text: 'Document prose' },
        { success: true, verified: true, method: 'set_field', fieldMeta: validatedEditorProbe.fieldMeta },
        rerenderPreflight.probe,
      );
      if (agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a validated editor edit must clear the toolbar obligation when a controlled rerender invalidates its old ref');
      }

      const iframeCandidate = {
        ...candidate,
        score: 8,
        reasons: ['unlabelled_text_control', 'compact_control', 'numeric_preset_value', 'semantic_toolbar'],
        availablePresetValues: ['11', '14'],
      };
      agent._richTextToolbarProbe.probeIframeTarget = async () => ({
        resolved: true,
        dispatchBinding: { token: 'iframe-toolbar-token', frameId: 7 },
        refId: 'ref_12',
        frameId: 7,
        documentToken: 'frame-doc-a',
        refScopeUrl: 'https://frame.example.test/editor',
        rect: { x: 10, y: 8, w: 60, h: 24 },
        annotationRect: { x: 110, y: 208, w: 60, h: 24 },
        fieldMeta: { toolbarCandidate: iframeCandidate },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const iframePreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'iframe_type',
        { urlFilter: 'frame.example.test', selector: '#font-size', text: 'Document prose' },
        { supportsVision: false },
      );
      if (!iframePreflight.block?.wrongTarget || iframePreflight.block.dispatched !== false) {
        throw new Error(`iframe_type must audit and block toolbar targets before dispatch: ${JSON.stringify(iframePreflight)}`);
      }
      if (toolbarLedgerView(agent, tabId)?.frameId !== 7) {
        throw new Error('an iframe toolbar obligation must retain its frame identity');
      }
      agent._probeRichTextToolbarRetryTarget = AgentClass.prototype._probeRichTextToolbarRetryTarget.bind(agent);
      const iframeToolbarClickBlock = await agent._richTextToolbarToolBlock(
        tabId,
        'iframe_click',
        { urlFilter: 'frame.example.test', selector: '#bold' },
      );
      if (!iframeToolbarClickBlock?.wrongTarget || iframeToolbarClickBlock.dispatched !== false) {
        throw new Error(`iframe toolbar clicks must remain blocked while an editor recovery obligation is open: ${JSON.stringify(iframeToolbarClickBlock)}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_12',
        documentToken: 'top-doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 8, w: 60, h: 24 },
        fieldMeta: { toolbarCandidate: iframeCandidate },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const unrelatedTopFrameBlock = await agent._richTextToolbarToolBlock(
        tabId,
        'click',
        { selector: '#font-size' },
      );
      if (unrelatedTopFrameBlock || !agent._richTextToolbarGuard.hasPending(tabId) || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('top-frame ref collisions must not consume or enforce iframe-scoped toolbar state');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: '',
        frameId: 7,
        documentToken: 'frame-doc-a',
        refScopeUrl: 'https://frame.example.test/editor',
        rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const iframeRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'iframe_type',
        { urlFilter: 'frame.example.test', selector: '#editor-body', text: 'Document prose' },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (!iframeRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('the associated iframe editor edit should clear the toolbar obligation');
      }

      const iframeBackedCandidate = {
        ...candidate,
        associatedEditorRef: 'ref_200',
        associatedEditorIdentity: {
          tag: 'iframe',
          id: null,
          name: null,
          role: null,
          pageX: 20,
          pageY: 160,
          w: 400,
          h: 180,
        },
      };
      const iframeBackedBlock = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Document prose' },
        iframeBackedBlock,
        iframeBackedCandidate,
        familyDecision,
        familyAudit,
        {
          documentToken: 'top-doc-a',
          refScopeUrl: 'https://example.test/editor',
          rect: { x: 10, y: 8, w: 60, h: 24 },
        },
      );
      if (!iframeBackedBlock.wrongTarget || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a top-frame toolbar with an iframe-backed editor must retain its recovery obligation');
      }
      const iframeBackedEditorProbe = {
        resolved: true,
        refId: 'ref_inner_editor',
        frameId: 7,
        documentToken: 'frame-doc-a',
        refScopeUrl: 'https://frame.example.test/editor',
        topFrameUrl: 'https://example.test/editor',
        rect: { x: 0, y: 0, w: 400, h: 180 },
        frameOwnerRect: { x: 20, y: 60, pageX: 20, pageY: 160, w: 400, h: 180 },
        frameOwnerMeta: { tag: 'iframe', id: 'other-frame', name: null, role: null },
        fieldMeta: { tag: 'div', id: 'inner-editor', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      };
      agent._probeRichTextToolbarRetryTarget = async () => iframeBackedEditorProbe;
      const unrelatedIframeRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'iframe_type',
        { selector: '#inner-editor', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (unrelatedIframeRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('an edit in a different iframe must not clear the iframe-backed editor obligation');
      }
      const matchingAnonymousFrameProbe = {
        ...iframeBackedEditorProbe,
        frameOwnerMeta: { ...iframeBackedEditorProbe.frameOwnerMeta, id: null },
      };
      agent._probeRichTextToolbarRetryTarget = async () => ({
        ...matchingAnonymousFrameProbe,
        topFrameUrl: '',
      });
      const unscopedIframeRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'iframe_type',
        { selector: '#inner-editor', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (unscopedIframeRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('an iframe edit without a verified top-page scope must retain the toolbar obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => matchingAnonymousFrameProbe;
      const iframeBackedRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'iframe_type',
        { selector: '#inner-editor', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (!iframeBackedRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a verified edit in the associated iframe editor must clear the toolbar obligation');
      }

      const nestedIframeBlock = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_nested_toolbar', text: 'Document prose' },
        nestedIframeBlock,
        iframeBackedCandidate,
        familyDecision,
        familyAudit,
        {
          frameId: 7,
          documentToken: 'toolbar-frame-doc-a',
          refScopeUrl: 'https://toolbar-frame.example.test/editor',
          rect: { x: 10, y: 8, w: 60, h: 24 },
        },
      );
      if (!nestedIframeBlock.wrongTarget || toolbarLedgerView(agent, tabId)?.frameId !== 7) {
        throw new Error('a nested iframe editor must retain the toolbar frame scope');
      }
      const nestedEditorProbe = {
        ...matchingAnonymousFrameProbe,
        frameId: 9,
        parentFrameId: 7,
        documentToken: 'nested-editor-doc-a',
        refScopeUrl: 'https://nested-editor.example.test/editor',
        frameOwnerScopeUrl: 'https://unrelated-toolbar-frame.example.test/editor',
        topFrameUrl: 'https://example.test/editor',
      };
      agent._probeRichTextToolbarRetryTarget = async () => nestedEditorProbe;
      const wrongNestedScopeRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'iframe_type',
        { selector: '#inner-editor', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (wrongNestedScopeRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a matching nested iframe owner in another toolbar frame must retain the obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        ...nestedEditorProbe,
        frameOwnerScopeUrl: 'https://toolbar-frame.example.test/editor',
      });
      const nestedIframeRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'iframe_type',
        { selector: '#inner-editor', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (!nestedIframeRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a verified nested iframe edit must use the owning toolbar-frame scope and clear the obligation');
      }

      agent.autoScreenshot = 'state_change';
      agent.autoScreenshotCount.delete(tabId);
      agent.providerManager.getVisionProvider = async () => ({
        config: { model: 'fixture-vision', baseUrl: 'https://vision.example.test' },
      });
      agent._richTextToolbarProbe.probeIframeTarget = async () => ({
        resolved: true,
        dispatchBinding: { token: 'unmapped-iframe-toolbar-token', frameId: 7 },
        refId: 'ref_12',
        frameId: 7,
        documentToken: 'frame-doc-a',
        refScopeUrl: 'https://frame.example.test/editor',
        rect: { x: 10, y: 8, w: 60, h: 24 },
        annotationRect: null,
        fieldMeta: { toolbarCandidate: iframeCandidate },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const unmappedIframePreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'iframe_type',
        { urlFilter: 'frame.example.test', selector: '#font-family', text: 'Document prose' },
        { supportsVision: false },
      );
      if (!unmappedIframePreflight.block?.noDispatch || !unmappedIframePreflight.block?.retryable) {
        throw new Error(`an unmappable iframe toolbar target must fail closed when visual audit is available: ${JSON.stringify(unmappedIframePreflight)}`);
      }
      agent.providerManager.getVisionProvider = async () => null;

      const staleDocumentResult = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Document prose' },
        staleDocumentResult,
        candidate,
        familyDecision,
        familyAudit,
        { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
      );
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_201',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 520, y: 160, pageX: 520, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const duplicateShadowIdRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'set_field',
        { ref_id: 'ref_201', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'set_field' },
      );
      if (duplicateShadowIdRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a matching editor ID at another component geometry must retain the toolbar obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_12',
        documentToken: 'doc-b',
        refScopeUrl: 'https://example.test/next',
        fieldMeta: { toolbarCandidate: candidate },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const crossDocumentBlock = await agent._richTextToolbarToolBlock(tabId, 'click_ax', { ref_id: 'ref_12' });
      const navigatedRecoveryState = toolbarLedgerView(agent, tabId);
      if (
        crossDocumentBlock
        || !agent._richTextToolbarGuard.hasPending(tabId)
        || navigatedRecoveryState?.recoveryOnly !== true
        || navigatedRecoveryState.associatedEditorRef
        || navigatedRecoveryState.blockedRefs?.size
        || navigatedRecoveryState.blockedSelectors?.size
      ) {
        throw new Error('navigation must release stale toolbar targets while preserving editor recovery identity');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_12',
        documentToken: 'doc-b',
        refScopeUrl: 'https://example.test/next',
        rect: { x: 10, y: 8, w: 60, h: 24 },
        fieldMeta: {
          toolbarCandidate: {
            ...candidate,
            score: 8,
            reasons: ['unlabelled_text_control', 'compact_control', 'numeric_preset_value', 'semantic_toolbar'],
          },
        },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const navigatedToolbarPreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Document prose' },
        { supportsVision: false },
      );
      if (!navigatedToolbarPreflight.block?.wrongTarget || navigatedToolbarPreflight.block.dispatched !== false) {
        throw new Error('a recovery-only obligation must still block a newly scoped toolbar candidate');
      }
      if (toolbarLedgerView(agent, tabId)?.recoveryObligations?.length !== 2) {
        throw new Error('a newly scoped toolbar mistake after navigation must retain both recovery obligations');
      }
      agent._effectiveRunMode = () => 'act';
      const navigatedDoneBlock = agent._completionDoneBlock(tabId, 'done', { outcome: 'success' });
      if (navigatedDoneBlock?.reason !== 'rich_text_toolbar_target_unresolved') {
        throw new Error(`navigation must not permit false success after a blocked toolbar edit: ${JSON.stringify(navigatedDoneBlock)}`);
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_77',
        documentToken: 'doc-b',
        refScopeUrl: 'https://unrelated.test/editor',
        rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const unrelatedOriginRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'set_field',
        { ref_id: 'ref_77', text: 'Document prose' },
        { success: true, verified: true, method: 'set_field' },
      );
      if (unrelatedOriginRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a same-shaped editor on another origin must not clear the toolbar obligation');
      }
      const unrelatedOriginSelectorRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'type_text',
        { selector: '#editor-body', text: 'Document prose' },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (unrelatedOriginSelectorRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('selector recovery on another origin must not clear the toolbar obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_99',
        documentToken: 'doc-b',
        refScopeUrl: 'https://example.test/next',
        rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const navigatedRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'set_field',
        { ref_id: 'ref_99', text: 'Document prose' },
        { success: true, verified: true, method: 'set_field' },
      );
      if (
        !navigatedRecovery
        || !agent._richTextToolbarGuard.hasPending(tabId)
        || toolbarLedgerView(agent, tabId)?.recoveryObligations?.length !== 1
      ) {
        throw new Error('the current-route edit must clear only the newly scoped obligation and retain the original route obligation');
      }
      const originalRouteProbe = {
        resolved: true,
        refId: 'ref_78',
        documentToken: 'doc-c',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      };
      agent._probeRichTextToolbarRetryTarget = async () => originalRouteProbe;
      const originalRoutePreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_78', text: 'Document prose' },
        { supportsVision: false },
      );
      const originalRouteRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'set_field',
        { ref_id: 'ref_78', text: 'Document prose' },
        { success: true, verified: true, method: 'set_field' },
        originalRoutePreflight.probe,
      );
      if (!originalRouteRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a verified matching editor edit on the original route must clear the toolbar obligation');
      }

      const anonymousEditorIdentity = {
        tag: 'div',
        id: null,
        name: null,
        role: 'textbox',
        pageX: 24,
        pageY: 620,
        w: 400,
        h: 180,
      };
      const anonymousEditorBlock = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_anon_toolbar', text: 'Document prose' },
        anonymousEditorBlock,
        { ...candidate, associatedEditorRef: '', associatedEditorIdentity: anonymousEditorIdentity },
        familyDecision,
        familyAudit,
        { documentToken: 'doc-anon-a', refScopeUrl: 'https://example.test/editor' },
      );
      agent._clearRichTextToolbarDocumentState(tabId);
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_anon_editor_fresh',
        documentToken: 'doc-anon-b',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 24, y: 120, pageX: 24, pageY: 620, w: 400, h: 180 },
        fieldMeta: { tag: 'div', id: null, name: null, role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const anonymousEditorRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'set_field',
        { ref_id: 'ref_anon_editor_fresh', text: 'Document prose' },
        { success: true, verified: true, method: 'set_field' },
      );
      if (!anonymousEditorRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('fresh page coordinates must recover an unnamed editor identity after reload');
      }

      const unscopedBlock = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Document prose' },
        unscopedBlock,
        { ...candidate, associatedEditorRef: '', associatedEditorIdentity: null },
        familyDecision,
        familyAudit,
        { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
      );
      const unknownRecoveryState = toolbarLedgerView(agent, tabId);
      if (
        !unscopedBlock.wrongTarget
        || !agent._richTextToolbarGuard.hasPending(tabId)
        || unknownRecoveryState?.recoveryTargetUnknown !== true
      ) {
        throw new Error('ambiguous editor association must retain a completion obligation with an unknown recovery target');
      }
      const unknownDoneBlock = agent._completionDoneBlock(tabId, 'done', { outcome: 'success' });
      if (unknownDoneBlock?.reason !== 'rich_text_toolbar_target_unresolved') {
        throw new Error(`an ambiguous editor obligation must block successful completion: ${JSON.stringify(unknownDoneBlock)}`);
      }
      if (agent._completionDoneBlock(tabId, 'done', { outcome: 'partial' })) {
        throw new Error('an ambiguous editor obligation must still permit an explicit partial outcome');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_toolbar_editor_like',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 8, w: 300, h: 120 },
        fieldMeta: { contentEditable: true, toolbarCandidate: candidate },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const toolbarLikeRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'type_ax',
        { ref_id: 'ref_toolbar_editor_like', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (toolbarLikeRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('an editor-like toolbar target must not clear an ambiguous editor obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_quantity',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 180, w: 180, h: 32 },
        fieldMeta: { tag: 'input', type: 'text' },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const ordinaryFieldRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'set_field',
        { ref_id: 'ref_quantity', text: 'Document prose' },
        { success: true, verified: true, method: 'set_field' },
      );
      if (ordinaryFieldRecovery || !agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('an ordinary form field must not clear an ambiguous editor obligation');
      }
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_ambiguous_editor_a',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 220, w: 300, h: 120 },
        fieldMeta: { tag: 'div', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const unknownEditorRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'type_ax',
        { ref_id: 'ref_ambiguous_editor_a', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (!unknownEditorRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('a verified non-toolbar editor edit must clear an ambiguous editor obligation');
      }

      const unknownIframeBlock = {};
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'iframe_type',
        { urlFilter: 'frame.example.test', selector: '#font-size', text: 'Document prose', clear: true },
        unknownIframeBlock,
        { ...candidate, associatedEditorRef: '', associatedEditorIdentity: null },
        familyDecision,
        familyAudit,
        {
          frameId: 7,
          documentToken: 'frame-doc-a',
          refScopeUrl: 'https://frame.example.test/editor',
          rect: { x: 10, y: 8, w: 60, h: 24 },
        },
      );
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_unknown_iframe_editor',
        frameId: 7,
        parentFrameId: 0,
        documentToken: 'frame-doc-a',
        refScopeUrl: 'https://frame.example.test/editor',
        frameOwnerScopeUrl: 'https://example.test/editor',
        topFrameUrl: 'https://example.test/editor',
        rect: { x: 20, y: 160, w: 400, h: 180 },
        fieldMeta: { tag: 'div', role: 'textbox', contentEditable: true },
        toolbarContext: false,
        toolbarRegionRef: '',
      });
      const unknownIframeRecovery = await agent._clearRichTextToolbarObligationAfterCorrectedEdit(
        tabId,
        'iframe_type',
        { urlFilter: 'frame.example.test', selector: '#editor-body', text: 'Document prose', clear: true },
        { success: true, verified: true, method: 'contenteditable' },
      );
      if (!unknownIframeRecovery || agent._richTextToolbarGuard.hasPending(tabId) || agent._richTextToolbarGuard.hasPending(tabId)) {
        throw new Error('unknown iframe editor recovery must compare the child document URL, not its parent frame URL');
      }

      let classifierArgCount = 0;
      let classifierCaptureCount = 0;
      agent.autoScreenshot = 'state_change';
      agent.maxScreenshotsPerTurn = 1;
      agent.autoScreenshotCount.set(tabId, 1);
      agent._captureAutoScreenshot = async () => {
        classifierCaptureCount += 1;
        return {
          dataUrl: 'data:image/png;base64,dGVzdA==',
          width: 800,
          height: 600,
          cssWidth: 800,
          cssHeight: 600,
        };
      };
      agent._annotateScreenshot = async dataUrl => dataUrl;
      agent._classifyRichTextToolbarTarget = async (...classifierArgs) => {
        classifierArgCount = classifierArgs.length;
        return familyAudit;
      };
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        dispatchBinding: { backendNodeId: 177, token: 'selector-toolbar-token', frameId: 0 },
        refId: 'ref_12',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 10, w: 120, h: 24 },
        fieldMeta: { toolbarCandidate: candidate },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const budgetWarnings = [];
      const guardedPreflight = () => agent._preflightRichTextToolbarTarget(
        tabId,
        'type_text',
        { selector: '#font-family', text: 'This document sentence is intentionally much too long to be a font family value.' },
        { supportsVision: true },
        { onUpdate: (kind, payload) => { if (kind === 'warning') budgetWarnings.push(payload.message); } },
      );

      // The model-facing budget is already spent. The turn's first safety
      // capture is reserved anyway, so the guard is never blinded on the first
      // guarded edit, and the overage is disclosed.
      const reservedPreflight = await guardedPreflight();
      if (
        !reservedPreflight.block?.wrongTarget
        || classifierArgCount === 0
        || classifierCaptureCount !== 1
        || agent.toolbarAuditScreenshotCount.get(tabId) !== 1
        || agent.autoScreenshotCount.get(tabId) !== 1
        || !budgetWarnings.some(message => message.includes("one reserved capture in addition to the 1 model-facing"))
      ) {
        throw new Error(`the turn's first toolbar safety capture must be reserved and disclosed: ${JSON.stringify({ reservedPreflight, classifierArgCount, classifierCaptureCount, budgetWarnings })}`);
      }

      // The finite turn's separate audit allowance is now spent, so the guard
      // falls back to structural scoring instead of billing another vision call.
      agent._resetRichTextToolbarAudit(tabId);
      classifierArgCount = 0;
      budgetWarnings.length = 0;
      const visualPreflight = await guardedPreflight();
      if (
        visualPreflight.shot
        || !visualPreflight.block?.wrongTarget
        || visualPreflight.block.dispatched !== false
        || !visualPreflight.block.rect
        || !visualPreflight.block.fieldMeta?.toolbarCandidate
        || visualPreflight.traceCapture
        || classifierArgCount !== 0
        || classifierCaptureCount !== 1
        || agent.toolbarAuditScreenshotCount.get(tabId) !== 1
        || agent.autoScreenshotCount.get(tabId) !== 1
        || !budgetWarnings.some(message => message.includes('structural scoring'))
      ) {
        throw new Error(`exhausted screenshot budget must use structural toolbar preflight without capture: ${JSON.stringify({ visualPreflight, classifierArgCount, classifierCaptureCount, budgetWarnings, screenshotCount: agent.autoScreenshotCount.get(tabId) })}`);
      }
      agent._resetRichTextToolbarAudit(tabId);
      agent.autoScreenshotCount.delete(tabId);
      agent.toolbarAuditScreenshotCount.delete(tabId);
      agent.toolbarAuditBudgetNotified.delete(tabId);

      let annotationOptions = null;
      classifierArgCount = 0;
      agent._annotateScreenshot = async (_dataUrl, _rect, _viewport, options) => {
        annotationOptions = options;
        return null;
      };
      agent._classifyRichTextToolbarTarget = async (...classifierArgs) => {
        classifierArgCount = classifierArgs.length;
        return {
          regionKind: 'ordinary_form_field',
          targetKind: 'ordinary_input',
          confidence: 0.99,
        };
      };
      const annotationFailurePreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'This document sentence must not be typed into a toolbar control.' },
        { supportsVision: true },
      );
      if (
        !annotationFailurePreflight.block?.wrongTarget
        || annotationFailurePreflight.block.visualTargetAudit?.source !== 'structural_fallback'
        || annotationFailurePreflight.traceCapture
        || classifierArgCount !== 0
        || annotationOptions?.fallbackToOriginal !== false
      ) {
        throw new Error(`failed target annotation must skip vision and use structural toolbar evidence: ${JSON.stringify({ annotationFailurePreflight, classifierArgCount, annotationOptions })}`);
      }
      agent._resetRichTextToolbarAudit(tabId);

      agent._annotateScreenshot = async () => 'data:image/png;base64,YW5ub3RhdGVk';
      agent._classifyRichTextToolbarTarget = async () => familyAudit;
      const shortDocumentPreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Paris' },
        { supportsVision: true },
      );
      if (!shortDocumentPreflight.block?.wrongTarget || shortDocumentPreflight.block.dispatched !== false) {
        throw new Error(`short non-preset document text must be blocked before dispatch: ${JSON.stringify(shortDocumentPreflight)}`);
      }
      agent._resetRichTextToolbarAudit(tabId);

      agent._classifyRichTextToolbarTarget = async () => styleAudit;
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_14',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 140, y: 10, w: 120, h: 24 },
        fieldMeta: {
          toolbarCandidate: {
            ...candidate,
            availablePresetValues: stylePresetValues,
          },
        },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const shortStylePreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_14', text: 'Quarterly roadmap' },
        { supportsVision: true },
      );
      if (!shortStylePreflight.block?.wrongTarget || shortStylePreflight.block.dispatched !== false) {
        throw new Error(`short non-preset style text must be blocked before dispatch: ${JSON.stringify(shortStylePreflight)}`);
      }
      agent._resetRichTextToolbarAudit(tabId);
      const allowedStylePreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_14', text: 'Heading 1' },
        { supportsVision: true },
      );
      if (allowedStylePreflight.block) {
        throw new Error(`control-owned style preset must pass preflight: ${JSON.stringify(allowedStylePreflight)}`);
      }

      agent._classifyRichTextToolbarTarget = async () => familyAudit;
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_12',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 10, w: 120, h: 24 },
        fieldMeta: { toolbarCandidate: candidate },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      // The reserved safety capture is per turn, and the cases above have
      // spent this turn's. Start a fresh one so the property under test here
      // is the model-facing slot, not the audit budget.
      agent.toolbarAuditScreenshotCount.delete(tabId);
      agent.toolbarAuditBudgetNotified.delete(tabId);
      const allowedPreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Inter Display' },
        { supportsVision: true },
      );
      if (allowedPreflight.block || !allowedPreflight.shot || !agent._canTakeAutoScreenshot(tabId)) {
        throw new Error(`allowed toolbar formatting must preserve the post-edit screenshot slot: ${JSON.stringify(allowedPreflight)}`);
      }
      const postEditShot = await agent._captureBudgetedAutoScreenshot(tabId);
      if (!postEditShot || agent.autoScreenshotCount.get(tabId) !== 1 || agent._canTakeAutoScreenshot(tabId)) {
        throw new Error('the preserved model-facing slot must remain usable exactly once after preflight');
      }
      agent.autoScreenshotCount.delete(tabId);

      agent.autoScreenshot = 'navigation';
      agent._captureAutoScreenshot = async () => {
        throw new Error('navigation-only auto-screenshot must suppress non-navigation field capture');
      };
      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_12',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 10, w: 120, h: 24 },
        fieldMeta: { toolbarCandidate: candidate },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const noScreenshotFamilyPreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_12', text: 'Paris' },
        { supportsVision: true },
      );
      if (
        !noScreenshotFamilyPreflight.block?.wrongTarget
        || noScreenshotFamilyPreflight.block.visualTargetAudit?.source !== 'structural_fallback'
        || noScreenshotFamilyPreflight.block.dispatched !== false
        || noScreenshotFamilyPreflight.shot
      ) {
        throw new Error(`expected no-screenshot nonnumeric toolbar preflight to fail closed: ${JSON.stringify(noScreenshotFamilyPreflight)}`);
      }
      agent._resetRichTextToolbarAudit(tabId);

      agent._probeRichTextToolbarRetryTarget = async () => ({
        resolved: true,
        refId: 'ref_20',
        documentToken: 'doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 10, w: 24, h: 18 },
        fieldMeta: {
          toolbarCandidate: {
            score: 8,
            reasons: ['unlabelled_text_control', 'compact_control', 'numeric_preset_value', 'semantic_toolbar'],
            relatedRefs: ['ref_20', 'ref_21'],
            regionRef: 'ref_10',
            associatedEditorRef: 'ref_99',
          },
        },
        toolbarContext: true,
        toolbarRegionRef: 'ref_10',
      });
      const structuralPreflight = await agent._preflightRichTextToolbarTarget(
        tabId,
        'set_field',
        { ref_id: 'ref_20', text: 'This is document content, not a size preset.' },
        { supportsVision: true },
      );
      if (!structuralPreflight.block?.wrongTarget || structuralPreflight.block.visualTargetAudit?.source !== 'structural_fallback' || structuralPreflight.block.dispatched !== false) {
        throw new Error(`expected no-screenshot font-size mismatch preflight, got: ${JSON.stringify(structuralPreflight)}`);
      }
    }
  });
}
