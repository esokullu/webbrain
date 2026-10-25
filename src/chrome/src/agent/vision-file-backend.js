import { cdpClient } from '../cdp/cdp-client.js';
import { visionFileTargetAtPoint, visionInputMetadata, visionResourceMetadata, visionReadOriginalBlob,
  createVisionFileChooserTrap, visionChooserInputMatches } from './vision-file-target.js';

export async function readVisionSavedDownload(tabId, item, options = {}) {
  options.signal?.throwIfAborted();
  await cdpClient.attach(tabId);
  const result = await cdpClient.probeLocalFile(tabId, item.filename, {
    includeData: true, maxBytes: options.maxBytes || 25 * 1024 * 1024,
    ...(options.readPrefixBytes ? { readPrefixBytes: options.readPrefixBytes } : {}),
  });
  options.signal?.throwIfAborted();
  return result;
}

export function createVisionFileBackend() {
  const call = async (tabId, target, fn, args = []) => {
    const result = await cdpClient.sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId: target.objectId, functionDeclaration: fn,
      arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error('The selected file target is no longer available');
    return result.result?.value;
  };
  return {
    readSavedDownload: readVisionSavedDownload,
    async armChooser(tabId, point) {
      await cdpClient.attach(tabId);
      const tree = await cdpClient.sendCommand(tabId, 'Page.getFrameTree');
      const result = await cdpClient.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `(${createVisionFileChooserTrap.toString()})(${point.x},${point.y},3000)`, returnByValue: false,
      });
      if (result.exceptionDetails || !result.result?.objectId) throw new Error('The file chooser could not be guarded');
      return { objectId: result.result.objectId, point, frameId: tree.frameTree?.frame?.id };
    },
    async takeChooser(tabId, chooser) {
      const count = await call(tabId, chooser, 'function(){return this.count()}');
      if (count !== 1) throw new Error(count > 1 ? 'Multiple file choosers opened; no file was attached' : 'The upload control did not open a file chooser; no file was attached');
      const result = await cdpClient.sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId: chooser.objectId, functionDeclaration: 'function(){return this.take()}', returnByValue: false,
      });
      if (!result.result?.objectId || result.result.subtype === 'null') throw new Error('The guarded file chooser expired');
      const target = { objectId: result.result.objectId, point: chooser.point, kind: 'upload', chooser };
      const described = await cdpClient.sendCommand(tabId, 'DOM.describeNode', { objectId: target.objectId, depth: 0 });
      target.key = String(described.node?.backendNodeId || '');
      target.metadata = await call(tabId, target, `function(){return (${visionInputMetadata.toString()})(this)}`);
      if (!target.metadata) { await cdpClient.releaseObject(tabId, target.objectId); throw new Error('The selected chooser is not a live file input'); }
      return target;
    },
    async closeChooser(tabId, chooser) {
      await call(tabId, chooser, 'function(){this.close();return true}').catch(() => {});
    },
    async releaseChooser(tabId, chooser) {
      await this.closeChooser(tabId, chooser);
      await cdpClient.releaseObject(tabId, chooser.objectId).catch(() => {});
    },
    async bind(tabId, point, kind) {
      await cdpClient.attach(tabId);
      const tree = await cdpClient.sendCommand(tabId, 'Page.getFrameTree');
      const frame = tree.frameTree?.frame;
      if (!frame?.id) throw new Error('The current document is unavailable');
      const world = await cdpClient.sendCommand(tabId, 'Page.createIsolatedWorld', {
        frameId: frame.id, worldName: 'webbrain-vision-files', grantUniveralAccess: false,
      });
      const result = await cdpClient.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `(${visionFileTargetAtPoint.toString()})(${point.x},${point.y},${JSON.stringify(kind)})`,
        contextId: world.executionContextId, returnByValue: false,
      });
      if (!result.result?.objectId || result.result.subtype === 'null') return null;
      const target = { objectId: result.result.objectId, point, kind };
      const described = await cdpClient.sendCommand(tabId, 'DOM.describeNode', { objectId: target.objectId, depth: 0 });
      target.key = String(described.node?.backendNodeId || '');
      target.metadata = await call(tabId, target, `function(){return (${(kind === 'upload' ? visionInputMetadata : visionResourceMetadata).toString()})(this)}`);
      if (!target.metadata) { await cdpClient.releaseObject(tabId, target.objectId); return null; }
      return target;
    },
    async assertTarget(tabId, target) {
      if (target.chooser) {
        const result = await cdpClient.sendCommand(tabId, 'Runtime.callFunctionOn', {
          objectId: target.objectId, functionDeclaration: `function(holder,x,y){return holder.count() === 1 && (${visionChooserInputMatches.toString()})(this,holder.trigger(),x,y)}`,
          arguments: [{ objectId: target.chooser.objectId }, { value: target.point.x }, { value: target.point.y }], returnByValue: true,
        });
        if (result.exceptionDetails || result.result?.value !== true) throw Object.assign(new Error('The guarded file chooser target changed'), { code: 'vision_stale_frame' });
        return;
      }
      const same = await call(tabId, target, `function(x,y,kind){return this.isConnected && (${visionFileTargetAtPoint.toString()})(x,y,kind) === this}`,
        [target.point.x, target.point.y, target.kind]);
      if (!same) throw Object.assign(new Error('The selected file target changed; capture again'), { code: 'vision_stale_frame' });
    },
    async upload(tabId, target, source, { signal, beforeDispatch }) {
      if (source.filePath) {
        const current = await readVisionSavedDownload(tabId, source.download, { maxBytes: 8192, readPrefixBytes: 8192, signal });
        if (current.readable !== true || current.size !== source.size || current.lastModified !== source.lastModified || current.base64 !== source.base64)
          throw new Error('The saved file changed after its bytes were inspected');
        await this.assertTarget(tabId, target);
        return cdpClient.setFileInputFiles(tabId, target.objectId, [source.filePath], {
          sourceUrl: source.sourceUrl, abortSignal: signal, beforeDispatch,
        });
      }
      return cdpClient.setFileInputData(tabId, target.objectId, source, { abortSignal: signal, beforeDispatch });
    },
    async uploadedFiles(tabId, target) { return cdpClient.getFileInputFiles(tabId, target.objectId); },
    async readBlob(tabId, target, maxBytes) {
      return call(tabId, target, `async function(expected,maxBytes){return (${visionReadOriginalBlob.toString()})(this,expected,maxBytes)}`,
        [target.metadata.url, maxBytes]);
    },
    async release(tabId, target) { if (target?.objectId) await cdpClient.releaseObject(tabId, target.objectId); },
  };
}
