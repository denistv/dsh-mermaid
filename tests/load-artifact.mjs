// Load the built artifact the way the DSH client module loader does, then
// exercise the contract and the fence parser without a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const artifact = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

const definitions = [];
const styleTags = [];
const documentStub = {
  documentElement: {},
  baseURI: 'http://127.0.0.1/',
  head: {
    appendChild(tag) { styleTags.push(tag); },
  },
  createElement() {
    return { dataset: {}, textContent: '', remove() {} };
  },
  querySelector() { return null; },
  addEventListener() {},
  removeEventListener() {},
  implementation: { createHTMLDocument() { return documentStub; } },
};
const windowStub = {
  __ModuleLoader__: {
    load(definition) { definitions.push(definition); },
  },
  addEventListener() {},
  removeEventListener() {},
  location: { href: 'http://127.0.0.1/' },
  document: documentStub,
  navigator: { userAgent: 'dsh-mermaid-test' },
};
const sandbox = {
  window: windowStub,
  document: documentStub,
  navigator: windowStub.navigator,
  location: windowStub.location,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  TextEncoder,
  TextDecoder,
  URL,
  Blob,
  MutationObserver: class { observe() {} disconnect() {} },
  getComputedStyle() { return { getPropertyValue() { return ''; } }; },
  matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(artifact, sandbox, { filename: 'lib/client.js' });

assert.equal(definitions.length, 1, 'the artifact registers one module');
assert.equal(definitions[0].id, 'dsh-mermaid', 'module id is the package name');

class Component {
	constructor(props) {
		this.props = props ?? {};
		this.state = {};
	}

	setState(update) {
		const next = typeof update === 'function' ? update(this.state, this.props) : update;
		this.state = { ...this.state, ...next };
	}
}

const React = {
	Component,
	createElement(type, props, ...children) { return { type, props, children }; },
	useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; },
	useEffect() {},
	useMemo(factory) { return factory(); },
	useCallback(callback) { return callback; },
};
const moduleExports = definitions[0].factory((id) => {
  if (id === 'react') return React;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null };
  throw new Error(`unexpected external module: ${id}`);
});

assert.equal(typeof moduleExports.apply, 'function', 'exports apply');
assert.ok(moduleExports.inject.includes('slots'), 'declares the slots service');

const registrations = [];
const previews = [];
const dictionaries = [];
const ctx = {
  get(name) {
    if (name === 'locale') {
      return {
        bind: () => (key) => key,
        register: (...args) => { dictionaries.push(args); return () => {}; },
      };
    }
    if (name === 'theme') return { getTheme: () => ({ active: { colorScheme: 'light' } }) };
    if (name === 'documentPreviews') {
      return { register: (definition) => { previews.push(definition); return () => {}; } };
    }
    return undefined;
  },
  on() { return () => {}; },
  effect(callback) { const cleanup = callback(); return () => cleanup?.(); },
  slots: {
    inject(name, callback) { callback(); return () => {}; },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

moduleExports.apply(ctx);

const chat = registrations.find((entry) => entry.options.name === 'conversation.chat.turnTail');
assert.ok(chat !== undefined, 'registers the chat turn-tail entry');
assert.equal(chat.options.id, 'dsh-mermaid-chat');
assert.equal(typeof chat.component, 'function');

const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay');
assert.ok(overlay !== undefined, 'registers the full-screen overlay entry');
assert.equal(overlay.options.id, 'dsh-mermaid-overlay');
assert.equal(typeof overlay.options.inject, 'function');

const documentBody = registrations.find((entry) => entry.options.name === 'sidebar.right.tab.document');
assert.ok(documentBody !== undefined, 'registers the document body');
assert.equal(
  documentBody.options.key,
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown',
  'shadows the shipped Markdown body instead of adding a viewer',
);
assert.equal(documentBody.options.priority, -1, 'lower priority replaces the shipped body');

assert.equal(previews.length, 0, 'does not add a second document-preview implementation');

assert.equal(dictionaries.length, 1, 'registers the English dictionary');
assert.ok(styleTags.length === 1, 'installs one stylesheet');

const { splitMermaid, mermaidBlocks, splitFrontmatter, markdownImageUrl, turnDiagrams } = moduleExports.__test;

const mixed = [
  '# Diagram',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  'After.',
].join('\n');
assert.deepEqual([...splitMermaid(mixed).map((segment) => segment.type)], ['markdown', 'mermaid', 'markdown']);
assert.deepEqual([...mermaidBlocks(mixed)], ['flowchart LR\n  A --> B']);

const unterminated = 'Intro\n\n```mermaid\nflowchart LR\n  A --> B\n';
assert.deepEqual([...splitMermaid(unterminated).map((segment) => segment.type)], ['markdown']);
assert.deepEqual([...mermaidBlocks(unterminated)], []);

const tildes = '~~~mmd\nsequenceDiagram\n  A->>B: hi\n~~~\n';
assert.deepEqual([...mermaidBlocks(tildes)], ['sequenceDiagram\n  A->>B: hi']);

const otherFence = '```js\nconst x = 1\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n';
assert.deepEqual([...mermaidBlocks(otherFence)], ['graph TD\n  A-->B']);
assert.ok(splitMermaid(otherFence)[0].text.includes('const x = 1'), 'non-Mermaid fences stay in Markdown');

const frontmatter = splitFrontmatter('---\ntitle: Demo\n---\n# Body\n');
assert.equal(frontmatter.frontmatter, 'title: Demo');
assert.equal(frontmatter.body, '# Body\n');

const base = 'http://127.0.0.1:61325/';
const documentPath = '/Users/denistv/src/dsh-mermaid/README.md';
assert.equal(
  markdownImageUrl(base, documentPath, 'examples/flowchart.png'),
  'http://127.0.0.1:61325/api/file?path=%2FUsers%2Fdenistv%2Fsrc%2Fdsh-mermaid%2Fexamples%2Fflowchart.png',
);
assert.equal(
  markdownImageUrl(base, documentPath, '/Users/denistv/src/dsh-mermaid/examples/pie.png?raw=1#top'),
  'http://127.0.0.1:61325/api/file?path=%2FUsers%2Fdenistv%2Fsrc%2Fdsh-mermaid%2Fexamples%2Fpie.png',
);
assert.equal(markdownImageUrl(base, documentPath, 'https://example.com/a.png'), undefined);
assert.equal(markdownImageUrl(base, undefined, 'examples/flowchart.png'), undefined);

const turnWithDiagram = {
  steps: [{
    data: new Map([['assistant-step', { blocks: [{ kind: 'text', text: mixed }] }]]),
  }],
};
assert.deepEqual([...turnDiagrams(turnWithDiagram)], ['flowchart LR\n  A --> B']);

console.log('artifact contract, fence parser, and image resolver: ok');
