// @ts-nocheck
// Ported from the tested Felix additions: offline Tab completion for the chat box.
// Suggestions come from this chat's recent prompts and a few common requests; no model is called.
import {useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Ref, type TextareaHTMLAttributes} from 'react';

export type AtlasPromptAutocompleteProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  inputRef?: Ref<HTMLTextAreaElement>;
  history: readonly unknown[];
  conversationId: string;
  onComplete: (completed: string) => void;
  'data-demo'?: string;
};

export function atlasLocalPromptCompletion(value, messages) {
  if (typeof value !== 'string' || value.length > 4000) return '';
  const line = value.slice(value.lastIndexOf('\n') + 1);
  const prefix = line.trimStart();
  if (prefix.length < 4 || !/\p{L}{3}/u.test(prefix) || /[{}<>`]/.test(prefix)) return '';
  const candidates = [];
  const history = Array.isArray(messages) ? messages : [];
  for (let i = history.length - 1; i >= Math.max(0, history.length - 80); i--) {
    const message = history[i];
    if (message?.role !== 'user') continue;
    const text = typeof message.content === 'string' ? message.content :
      Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
    const firstLine = text.split(/\r?\n/, 1)[0].trim();
    if (firstLine.length <= 240 && !/[{}<>`]/.test(firstLine) && !/\b(?:api[_ -]?key|password|bearer|access[_ -]?token|refresh[_ -]?token)\b|sk-[A-Za-z0-9]/i.test(firstLine)) candidates.push(firstLine);
  }
  candidates.push(
    'Can you check this mod for errors?',
    'Can you help me fix this error?',
    'Please explain how this mod works',
    'Please fix the errors in this mod',
    'I want to create a RimWorld mod that ',
    'Create a new RimWorld mod that ',
    'Add a settings menu for ',
    'Add compatibility with ',
    'Add an option to disable ',
    'Add a Harmony patch for ',
    'Fix the bug where ',
    'Fix the error in ',
    'Find out why ',
    'Explain how this mod works',
    'Check this mod for errors',
    'Check compatibility with RimWorld 1.7',
    'Build the mod and check for errors',
    'Test the changes in RimWorld',
    'Update the mod to RimWorld 1.7',
    'Decompile the assembly and explain how it works',
    'Improve performance without changing gameplay',
    'Make this compatible with Combat Extended',
  );
  const normalized = prefix.toLocaleLowerCase();
  for (const candidate of candidates) {
    if (!candidate.toLocaleLowerCase().startsWith(normalized)) continue;
    let suffix = candidate.slice(prefix.length);
    if (suffix.trim().length < 3) continue;
    if (suffix.length > 110) {
      const boundary = suffix.lastIndexOf(' ', 110);
      if (boundary < 15) continue;
      suffix = suffix.slice(0, boundary);
    }
    return suffix;
  }
  return '';
}

export function atlasAutocompleteKeyAction(event, input, suffix, composing) {
  if (composing || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return 'composition';
  if (!suffix || !input || input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return '';
  if (event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) return 'accept';
  if (event.key === 'Escape') return 'dismiss';
  return '';
}

/** A drop-in textarea that shows the suggested rest of the line in grey; Tab accepts it, Escape dismisses it. */
export function AtlasPromptAutocomplete({inputRef, history, conversationId, onComplete, ...props}: AtlasPromptAutocompleteProps) {
  const input = useRef(null);
  const mirror = useRef(null);
  const currentConversation = useRef(conversationId);
  currentConversation.current = conversationId;
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [caret, setCaret] = useState({start: -1, end: -1});
  const [dismissed, setDismissed] = useState(null);
  const [scroll, setScroll] = useState({top: 0, left: 0});
  const [metrics, setMetrics] = useState({});
  const [previewHeight, setPreviewHeight] = useState(null);
  const hintId = useId();
  const value = typeof props.value === 'string' ? props.value : '';
  const proposed = useMemo(() => atlasLocalPromptCompletion(value, history), [value, history]);
  const suffix = focused && !composing && !props.disabled && dismissed !== value && caret.start === value.length && caret.end === value.length ? proposed : '';
  const snapshot = (node) => {
    if (!node) return;
    setCaret((previous) => previous.start === node.selectionStart && previous.end === node.selectionEnd ? previous : {start: node.selectionStart, end: node.selectionEnd});
  };
  const assignRef = useCallback((node) => {
    input.current = node;
    if (typeof inputRef === 'function') inputRef(node);
    else if (inputRef) inputRef.current = node;
  }, [inputRef]);
  useEffect(() => {
    setDismissed(null);
    setComposing(false);
    snapshot(input.current);
  }, [conversationId]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    let frame;
    const measure = () => {
      const style = getComputedStyle(node);
      const next = {
        width: node.clientWidth,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textAlign: style.textAlign,
        direction: style.direction,
        tabSize: style.tabSize,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        wordBreak: style.wordBreak,
      };
      setMetrics((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!suffix || !mirror.current) { setPreviewHeight(null); return; }
        const minimum = parseFloat(style.minHeight) || 28;
        setPreviewHeight(Math.max(minimum, Math.min(160, mirror.current.scrollHeight)));
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [value, suffix, focused]);
  const handleKeyDown = (event) => {
    const action = atlasAutocompleteKeyAction(event, input.current, suffix, composing);
    if (action === 'composition') return;
    if (action === 'accept') {
      event.preventDefault();
      const completed = value + suffix;
      onComplete(completed);
      setDismissed(null);
      requestAnimationFrame(() => {
        if (currentConversation.current !== conversationId || !input.current) return;
        input.current.setSelectionRange(completed.length, completed.length);
        snapshot(input.current);
      });
      return;
    }
    if (action === 'dismiss') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(value);
      return;
    }
    props.onKeyDown?.(event);
  };
  return <div className="atlas-prompt-autocomplete">
    <div className="atlas-prompt-input-wrap">
      {suffix && <div className="atlas-prompt-ghost" aria-hidden>
        <div ref={mirror} style={{...metrics, transform: `translate(${-scroll.left}px, ${-scroll.top}px)`}}>
          <span style={{visibility: 'hidden'}}>{value}</span><span className="atlas-prompt-suffix">{suffix}</span>
        </div>
      </div>}
      <textarea
        {...props}
        ref={assignRef}
        aria-autocomplete="inline"
        aria-describedby={suffix ? hintId : props['aria-describedby']}
        style={{...props.style, ...(suffix && previewHeight !== null ? {height: previewHeight} : {})}}
        onChange={(event) => { props.onChange?.(event); setDismissed(null); snapshot(event.currentTarget); }}
        onFocus={(event) => { setFocused(true); snapshot(event.currentTarget); props.onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); props.onBlur?.(event); }}
        onSelect={(event) => { snapshot(event.currentTarget); props.onSelect?.(event); }}
        onScroll={(event) => { setScroll({top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft}); props.onScroll?.(event); }}
        onCompositionStart={(event) => { setComposing(true); props.onCompositionStart?.(event); }}
        onCompositionEnd={(event) => { setComposing(false); snapshot(event.currentTarget); props.onCompositionEnd?.(event); }}
        onKeyDown={handleKeyDown}
      />
    </div>
    {suffix && <div id={hintId} className="atlas-autocomplete-hint">Tab to complete · Esc to dismiss</div>}
  </div>;
}
