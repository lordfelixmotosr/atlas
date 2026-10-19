import type { ReactNode } from 'react';
import { parseSteamNotes, toSteamChangeNotes, type SteamNoteNode } from '../../lib/workshop-notes';

function render(nodes: SteamNoteNode[]): ReactNode {
  return nodes.map((node, key) => {
    if ('text' in node) return node.text;
    const children = render(node.children);
    switch (node.tag) {
      case 'h1': case 'h2': case 'h3': return <div key={key} role="heading" aria-level={Number(node.tag[1])} className="mt-3 mb-1 font-semibold">{children}</div>;
      case 'b': return <strong key={key}>{children}</strong>;
      case 'i': return <em key={key}>{children}</em>;
      case 'u': return <u key={key}>{children}</u>;
      case 'strike': return <s key={key}>{children}</s>;
      case 'code': return <code key={key} className="whitespace-pre-wrap rounded bg-ink/5 px-1 font-mono">{children}</code>;
      case 'list': return <ul key={key} className="list-disc pl-5 whitespace-normal">{children}</ul>;
      case 'olist': return <ol key={key} className="list-decimal pl-5 whitespace-normal">{children}</ol>;
      case 'li': return <li key={key} className="whitespace-pre-wrap">{children}</li>;
      case 'quote': return <blockquote key={key} className="border-l-2 border-line pl-3">{children}</blockquote>;
      case 'url': return <span key={key} className="underline" title={node.value}>{children}</span>;
      case 'spoiler': return <span key={key} className="bg-ink/10">{children}</span>;
      case 'hr': return <hr key={key} className="my-2 border-line" />;
      default: return <span key={key}>{children}</span>;
    }
  });
}

/** Render only React elements/text: pasted HTML and links cannot execute. */
export function WorkshopNotesPreview({ text }: { text: string }) {
  return <section aria-label="Steam change notes preview" className="space-y-2">
    <h3 className="text-xs font-medium">Steam preview</h3>
    <div data-steam-notes-preview className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper p-3 text-sm text-ink [overflow-wrap:anywhere]">
      {text.trim() ? render(parseSteamNotes(toSteamChangeNotes(text))) : <span className="text-muted">A timestamp will be recorded when you publish.</span>}
    </div>
    <p className="text-xs text-muted">Markdown is converted to Steam formatting on upload. Existing Steam tags are kept. Steam may use different fonts and spacing.</p>
  </section>;
}
