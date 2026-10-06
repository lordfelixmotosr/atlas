// @ts-nocheck
// Uses the real renderer components and real main-process asset protocol.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown, MarkdownImageScope } from '../src/components/markdown';
import { ToolResultBubble } from '../src/components/tool-result-renderer';

const paths = window.__atlasImagePaths;
if (!paths?.absolute || !paths?.fileUrl || !paths?.outside) throw new Error('Image fixture paths are missing');
const folder = 'atlas-image-fixture';
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const cases = [
  ['relative', 'Tests/Previews/sample.png'],
  ['encoded-space', 'Tests/Previews/sample%20image.png'],
  ['absolute', paths.absolute],
  ['file-url', paths.fileUrl],
  ['asset-url', 'modmixer-asset://chat/atlas-image-fixture/Tests%2FPreviews%2Fsample.png'],
  ['inline-data', 'data:image/png;base64,' + pixel],
];
const denied = [
  ['missing', 'Tests/Previews/missing.png'],
  ['traversal', '../../image-outside.png'],
  ['outside', paths.outside],
  ['script-scheme', 'javascript:alert%281%29'],
];
const toolMessage = { role: 'toolResult', toolName: 'read', toolCallId: 'image-fixture', isError: false, timestamp: 1,
  content: [{ type: 'image', mimeType: 'image/png', data: pixel }] };
createRoot(document.getElementById('root')).render(
  <MarkdownImageScope folder={folder}>
    <div className="grid grid-cols-3 gap-3 p-4">
      <style>{'[data-image-case] img { max-height: 96px; }'}</style>
      {cases.map(([name, source]) => <section key={name} data-image-case={name}><Markdown>{`![${name}](<${source}>)`}</Markdown></section>)}
      {denied.map(([name, source]) => <section key={name} data-denied-case={name}><Markdown>{`![${name}](<${source}>)`}</Markdown></section>)}
      <section data-safe-link=""><Markdown>{'[Blocked script](javascript:alert%281%29)'}</Markdown></section>
      <section data-tool-image=""><ToolResultBubble message={toolMessage} /></section>
    </div>
  </MarkdownImageScope>,
);
const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
window.__atlasImageTest = { async run() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const loaded = cases.every(([name]) => { const image = document.querySelector(`[data-image-case="${name}"] img`); return image?.complete && image.naturalWidth > 0; });
    const blocked = denied.every(([name]) => document.querySelector(`[data-denied-case="${name}"] [role="status"]`));
    if (loaded && blocked) break;
    await wait(100);
  }
  const dimensions = {};
  for (const [name] of cases) {
    const image = document.querySelector(`[data-image-case="${name}"] img`);
    assert(image?.complete && image.naturalWidth > 0, `Image case failed to display: ${name}`);
    const box = image.getBoundingClientRect();
    if (name !== 'inline-data') assert(box.width >= 16 && box.height >= 16, `Decoded image has no meaningful display size: ${name} (${box.width}×${box.height})`);
    dimensions[name] = { width: image.naturalWidth, height: image.naturalHeight,
      displayWidth: box.width, displayHeight: box.height };
  }
  for (const [name] of denied) assert(document.querySelector(`[data-denied-case="${name}"] [role="status"]`)?.textContent.includes('Image unavailable'), `Denied or missing image did not show fallback: ${name}`);
  assert(!document.querySelector('[data-safe-link] a')?.getAttribute('href')?.startsWith('javascript:'), 'Non-image links lost their URL policy');
  const tool = document.querySelector('[data-tool-image]');
  assert(tool.querySelector('button')?.textContent.includes('1 image'), 'Tool result did not report its image');
  tool.querySelector('button').click(); await wait(200);
  const toolImage = tool.querySelector('img'); if (toolImage) await toolImage.decode();
  assert(toolImage?.naturalWidth === 1, 'Expanded tool result image is missing');
  assert(!tool.textContent.includes('(no output)'), 'Image-only result incorrectly shows no output');
  document.getElementById('root').style.width = '360px'; await wait(150);
  assert([...document.querySelectorAll('[data-image-case] img')].every(image => image.getBoundingClientRect().width <= image.parentElement.getBoundingClientRect().width + 1), 'Image overflowed a narrow panel');
  for (const [name] of cases) {
    const box = document.querySelector(`[data-image-case="${name}"] img`).getBoundingClientRect();
    if (name !== 'inline-data') assert(box.width >= 16 && box.height >= 16, `Image is too small in a narrow panel: ${name} (${box.width}×${box.height})`);
    dimensions[name].narrowDisplayWidth = box.width;
    dimensions[name].narrowDisplayHeight = box.height;
  }
  return { relativePreviewLoaded: true, encodedSpacesLoaded: true, absolutePreviewLoaded: true,
    fileUrlLoaded: true, existingAssetUrlLoaded: true, inlineImageLoaded: true,
    missingFallback: true, traversalBlocked: true, outsideFileBlocked: true,
    scriptSchemeBlocked: true, safeLinksRetained: true, toolImageRendered: true,
    responsiveImages: true, dimensions };
} };
