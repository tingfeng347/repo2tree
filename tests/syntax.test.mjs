import test from 'node:test';
import assert from 'node:assert/strict';
import {highlightCode, sourceDocument, languageFor, clearSyntaxCache} from '../web/syntax.js';
const plain = html => html.replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#(?:39|x27);/g,"'").replace(/&amp;/g,'&');

test('Python multiline strings retain color and independent, exact source lines', () => {
  const source = 'def greet(name):\n    """First line\n    second <line>"""\n    return f"Hi {name}"\n';
  const doc = sourceDocument(source, 'app.py');
  assert.equal(doc.highlighted, true);
  assert.equal(doc.lines.map(plain).join('\n'), source);
  assert.match(doc.lines[2], /hljs-string/);
  for (const line of doc.lines) assert.equal((line.match(/<span /g)||[]).length,(line.match(/<\/span>/g)||[]).length);
});
test('TSX markup stays escaped while keywords and function names are highlighted', () => {
  const source = 'export function Page() { return <button onClick={() => alert("x")}>Hello</button> }';
  const result = highlightCode(source, 'Page.tsx');
  assert.match(result,/hljs-keyword/); assert.match(result,/hljs-title/);
  assert.doesNotMatch(result,/<button|<script|<img/);
  assert.equal(plain(result),source);
});
test('source that looks like HTML cannot inject DOM, even with unknown languages', () => {
  for (const path of ['app.py','app.ts','page.html','unknown.xyz']) {
    const source = '</code><img src=x onerror="alert(1)"><script>alert(1)</script>&';
    const result = highlightCode(source,path);
    assert.doesNotMatch(result,/<img|<script|<\/code/); assert.equal(plain(result),source);
  }
});
test('large and minified sources stay complete as plain text without invoking a grammar', () => {
  for (const source of ['return 1\n'.repeat(30000),'x'.repeat(13000)]) {
    const result=sourceDocument(source,'large.py');
    assert.equal(result.highlighted,false); assert.match(result.note,/大文件/);
    assert.equal(result.lines.map(plain).join('\n'),source);
  }
});
test('cached source lines survive stepping and are replaced when the source changes', () => {
  clearSyntaxCache();
  const first=sourceDocument('return 1','x.py');
  assert.equal(sourceDocument('return 1','x.py'),first);
  assert.notEqual(sourceDocument('return 2','x.py'),first);
  clearSyntaxCache(); assert.notEqual(sourceDocument('return 1','x.py'),first);
});
test('language choice is explicit and unsupported source remains readable', () => {
  assert.equal(languageFor('x.tsx','typescript'),'typescript');
  assert.equal(languageFor('x.rs'),'rust');
  assert.equal(languageFor('x.unknown','unsupported'),null);
  assert.equal(sourceDocument('hello <world>\n','x.unknown').lines.map(plain).join('\n'),'hello <world>\n');
});
