/** Steam's documented text formatting. Shared by upload and its local preview.
 * No HTML rendering, network access or provider calls are involved. */
export type SteamNoteNode = { text: string } | { tag: string; value?: string; children: SteamNoteNode[] };

export function parseSteamNotes(text: string): SteamNoteNode[] {
  const root: SteamNoteNode[] = [], stack: { tag: string; children: SteamNoteNode[] }[] = [{ tag: '', children: root }];
  const tokens = /\[(\/?)(h[123]|b|i|u|strike|spoiler|url|code|noparse|list|olist|quote|hr|\*)(?:=([^\]\r\n]*))?\]/gi;
  let cursor = 0, match: RegExpExecArray | null;
  const append = (value: string) => { if (value) stack[stack.length - 1].children.push({ text: value }); };
  while ((match = tokens.exec(text))) {
    append(text.slice(cursor, match.index)); cursor = tokens.lastIndex;
    const tag = match[2].toLowerCase(), closing = !!match[1];
    if (closing) {
      let index = stack.length - 1;
      while (index > 0 && stack[index].tag !== tag) index--;
      if (index) stack.length = index; else append(match[0]);
    } else if (tag === '*') {
      if (stack[stack.length - 1].tag === 'li') stack.pop();
      if (!['list', 'olist'].includes(stack[stack.length - 1].tag)) { append(match[0]); continue; }
      const node = { tag: 'li', children: [] as SteamNoteNode[] };
      stack[stack.length - 1].children.push(node); stack.push(node);
    } else if (stack.length >= 64) {
      append(match[0]);
    } else {
      const node = { tag, value: match[3], children: [] as SteamNoteNode[] };
      stack[stack.length - 1].children.push(node);
      if (tag === 'code' || tag === 'noparse') {
        const end = new RegExp(`\\[/${tag}\\]`, 'ig'); end.lastIndex = cursor;
        const close = end.exec(text);
        node.children.push({ text: text.slice(cursor, close?.index ?? text.length) });
        cursor = tokens.lastIndex = close ? end.lastIndex : text.length;
      } else if (tag === 'hr') {
        // Steam accepts [hr][/hr].
        if (text.slice(cursor, cursor + 5).toLowerCase() === '[/hr]') cursor = tokens.lastIndex += 5;
      } else stack.push(node);
    }
  }
  append(text.slice(cursor));
  return root;
}

export function toSteamChangeNotes(input: string): string {
  // Protect existing BBCode, escaped Markdown and code before converting. A
  // unique token prefix avoids mistaking user text for one of our placeholders.
  let prefix = '\uE000'; while (input.includes(prefix)) prefix += '\uE000';
  const saved: string[] = [];
  const hold = (value: string) => prefix + (saved.push(value) - 1) + '\uE001';
  let text = input.replace(/\r\n?/g, '\n').trim();
  const opening = /\[(h[123]|b|i|u|strike|spoiler|url|code|noparse|list|olist|quote)(?:=[^\]\n]*)?\]/gi;
  let protectedText = '', position = 0, start: RegExpExecArray | null;
  while ((start = opening.exec(text))) {
    const tag = start[1].toLowerCase(), boundary = new RegExp(`\\[(\\/?)${tag}(?:=[^\\]\\n]*)?\\]`, 'gi');
    boundary.lastIndex = opening.lastIndex;
    let depth = 1, end: RegExpExecArray | null;
    while ((end = boundary.exec(text))) {
      if (end[1]) depth--; else if (tag !== 'code' && tag !== 'noparse') depth++;
      if (!depth) break;
    }
    if (!end) continue;
    protectedText += text.slice(position, start.index) + hold(text.slice(start.index, boundary.lastIndex));
    position = opening.lastIndex = boundary.lastIndex;
  }
  text = protectedText + text.slice(position);
  text = text.replace(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\s*$/gm, (_all, _fence, body: string) => hold('[code]' + body.replace(/\n$/, '') + '[/code]'));
  text = text.replace(/`([^`\n]+)`/g, (_all, code: string) => hold('[code]' + code + '[/code]'));
  text = text.replace(/\\([\\`*_[\]{}()#+.!>~-])/g, (_all, char: string) => hold('[noparse]' + char + '[/noparse]'));
  function inline(value: string): string {
    return value
      .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_all, label: string, url: string) => hold('[url=' + url.replace(/\[/g, '%5B').replace(/\]/g, '%5D') + ']' + inline(label) + '[/url]'))
      .replace(/\*\*(?=\S)(.+?\S|\S)\*\*/g, '[b]$1[/b]')
      .replace(/(?<!\w)__(?=\S)(.+?\S|\S)__(?!\w)/g, '[b]$1[/b]')
      .replace(/~~(?=\S)(.+?\S|\S)~~/g, '[strike]$1[/strike]')
      .replace(/(?<!\*)\*(?=\S)([^*\n]+?)\*(?!\*)/g, '[i]$1[/i]')
      .replace(/(?<!\w)_(?=\S)([^_\n]+?)_(?!\w)/g, '[i]$1[/i]');
  }
  const output: string[] = [], lists: { indent: number; tag: string }[] = [];
  const close = () => output.push('[/' + lists.pop()!.tag + ']');
  for (const line of text.split('\n')) {
    const item = /^(\s*)(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const indent = item[1].replace(/\t/g, '    ').length, tag = /^\s*\d/.test(line) ? 'olist' : 'list';
      while (lists.length && (indent < lists[lists.length - 1].indent || (indent === lists[lists.length - 1].indent && tag !== lists[lists.length - 1].tag))) close();
      if (!lists.length || indent > lists[lists.length - 1].indent) { lists.push({ indent, tag }); output.push('[' + tag + ']'); }
      output.push('[*]' + inline(item[2]));
    } else if (lists.length && /^\s+\S/.test(line)) {
      output.push(inline(line.trim()));
    } else {
      while (lists.length) close();
      const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
      if (heading) { const level = Math.min(3, line.indexOf(' ')); output.push(`[h${level}]${inline(heading[1])}[/h${level}]`); }
      else if (/^>\s?/.test(line)) output.push('[quote]' + inline(line.replace(/^>\s?/, '')) + '[/quote]');
      else if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) output.push('[hr][/hr]');
      else output.push(inline(line));
    }
  }
  while (lists.length) close();
  text = output.join('\n');
  // Link labels can contain protected tokens, so expand until all are restored.
  for (let i = 0; i <= saved.length && text.includes(prefix); i++) {
    text = text.replace(new RegExp(prefix + '(\\d+)\uE001', 'g'), (_all, id: string) => saved[Number(id)] ?? _all);
  }
  return text;
}
