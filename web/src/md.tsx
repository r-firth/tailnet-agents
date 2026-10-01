import { Fragment, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// The small slice of Markdown agents actually write in chat and summaries:
// paragraphs, "- " / "1. " lists, **bold**, *italic*, `code` and links. It is
// rendered as React nodes (never innerHTML), so nothing here can inject markup.

function inline(src: string, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${key}i${i++}`;
    if (m[2] || m[3]) out.push(<b key={k}>{inline(m[2] || m[3], k)}</b>);
    else if (m[4]) out.push(<code key={k}>{m[4]}</code>);
    else if (m[5]) out.push(<a key={k} href={m[6]} target="_blank" rel="noreferrer">{m[5]}</a>);
    else if (m[7] || m[8]) out.push(<em key={k}>{inline(m[7] || m[8], k)}</em>);
    else if (m[9]) out.push(<a key={k} href={m[9]} target="_blank" rel="noreferrer">{m[9].replace(/^https?:\/\/(www\.)?/, '')}</a>);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/** Agents often send a list flattened onto one line: "… - **Cost:** nothing". Put the items back on their own lines. */
function unflatten(text: string): string {
  return text.replace(/ +- (?=\*\*[^*]+\*\*)/g, '\n- ');
}

// Full GitHub-flavoured Markdown (tables, headings, code blocks, task lists) for chat and results,
// as tailnet-agents renders it. react-markdown builds React nodes and skips raw HTML, so it stays safe.
const MD_COMPONENTS: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
  strong: ({ children }) => <b>{children}</b>,
};

export function Md({ text, className, inlineOnly }: { text: string | null | undefined; className?: string; inlineOnly?: boolean }) {
  if (!text) return null;
  if (inlineOnly) return <span className={className}>{inline(text.replace(/\s*\n+\s*/g, ' '))}</span>;
  return <div className={`md ${className || ''}`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{unflatten(text)}</ReactMarkdown></div>;
}

/** The old hand-rolled block renderer, kept for reference-free callers. */
export function MdLite({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  const lines = unflatten(text).replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => { if (para.length) { blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '), `p${blocks.length}`)}</p>); para = []; } };
  const flushList = () => {
    if (!list) return;
    const k = `l${blocks.length}`;
    const items = list.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>);
    blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      flushPara();
      const ordered = !!num;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((bullet || num)![1]);
    } else if (!line.trim()) { flushPara(); flushList(); }
    else if (list && /^\s{2,}/.test(raw)) list.items[list.items.length - 1] += ' ' + line.trim();
    else { flushList(); para.push(line.replace(/^#{1,6}\s+/, '')); }
  }
  flushPara(); flushList();
  return <div className={`md ${className || ''}`}>{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}

/** A memory hit's source as text: older hits carry a string, newer ones an object with a label. */
export function sourceLabel(source: unknown): string {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && typeof (source as { label?: unknown }).label === 'string') return (source as { label: string }).label;
  return '';
}

/** Plain text for places that cannot hold markup (titles, tooltips, one-line previews). */
export function stripMd(text: string | null | undefined): string {
  if (!text) return '';
  return unflatten(text)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}
