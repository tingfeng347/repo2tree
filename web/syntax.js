import hljs from './vendor/highlight.js';

const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const extensions = {py:'python',pyi:'python',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',mts:'typescript',cts:'typescript',html:'xml',htm:'xml',xml:'xml',svg:'xml',css:'css',json:'json',rs:'rust',go:'go',java:'java',sh:'bash',bash:'bash',zsh:'bash'};
const aliases = {tsx:'typescript',jsx:'javascript',js:'javascript',ts:'typescript',html:'xml',shell:'bash',sh:'bash',py:'python'};
const names = {python:'Python',javascript:'JavaScript',typescript:'TypeScript',xml:'HTML / XML',css:'CSS',json:'JSON',rust:'Rust',go:'Go',java:'Java',bash:'Shell'};
const documents = new Map(), snippets = new Map();
const MAX_SOURCE = 200_000, MAX_LINE = 12_000;

export function languageFor(path = '', language = '') {
  const extension = String(path).split('.').at(-1).toLowerCase();
  const name = extensions[extension] || aliases[language] || language;
  return names[name] ? name : null;
}
export function clearSyntaxCache() { documents.clear(); snippets.clear(); }
function cached(cache, key, value, limit) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value); return value;
}
export function highlightCode(text, path = '', language = '') {
  text = String(text ?? '');
  const lang = languageFor(path, language);
  if (!lang || text.length > MAX_LINE) return escape(text);
  const key = lang + '\0' + text;
  if (snippets.has(key)) return snippets.get(key);
  let html;
  try { html = hljs.highlight(text, {language:lang, ignoreIllegals:true}).value; }
  catch { html = escape(text); }
  return cached(snippets, key, html, 256);
}

// Highlight the complete document first so multiline comments/strings retain
// their lexical state, then balance spans per line for clickable line numbers.
export function splitHighlightedLines(html) {
  const lines = [], stack = [];
  let line = '', cursor = 0;
  for (const match of html.matchAll(/<span class="[^"]*">|<\/span>|\n/g)) {
    line += html.slice(cursor, match.index);
    const token = match[0];
    if (token === '\n') {
      lines.push(line + '</span>'.repeat(stack.length));
      line = stack.join('');
    } else {
      line += token;
      if (token === '</span>') stack.pop(); else stack.push(token);
    }
    cursor = match.index + token.length;
  }
  lines.push(line + html.slice(cursor) + '</span>'.repeat(stack.length));
  return lines;
}
export function sourceDocument(source, path = '', language = '') {
  const lang = languageFor(path, language), key = `${lang}:${path}`;
  if (documents.get(key)?.source === source) return documents.get(key).document;
  const large = source.length > MAX_SOURCE || source.split('\n').some(line => line.length > MAX_LINE);
  let highlighted = Boolean(lang && !large), lines;
  try { lines = highlighted ? splitHighlightedLines(hljs.highlight(source, {language:lang, ignoreIllegals:true}).value) : source.split('\n').map(escape); }
  catch { highlighted = false; lines = source.split('\n').map(escape); }
  const document = {lines, language:lang, label:names[lang] || '纯文本', highlighted,
    note:large ? '大文件以纯文本显示，保留全部源码与行号' : !highlighted ? '以纯文本显示' : '语法高亮'};
  cached(documents, key, {source, document}, 4);
  return document;
}
