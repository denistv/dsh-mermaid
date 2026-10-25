// Render-engine behavior: cache, in-flight de-duplication, timeout recovery,
// parse-first error handling, and LRU eviction. Mermaid is a fake here; the
// real library only runs in the browser artifact.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMermaidRenderer, MermaidTimeoutError } from '../src/render.js';

function fakeMermaid(overrides = {}) {
	const calls = { initialize: 0, parse: 0, render: 0 };
	const mermaid = {
		initialize(options) {
			calls.initialize += 1;
			calls.lastOptions = options;
		},
		async parse() {
			calls.parse += 1;
			return true;
		},
		async render(_id, code) {
			calls.render += 1;
			return { svg: `<svg data-code="${code}"></svg>` };
		},
		...overrides,
	};
	return { mermaid, calls };
}

test('caches SVG by scheme and source', async () => {
	const { mermaid, calls } = fakeMermaid();
	const renderer = createMermaidRenderer({ mermaid, timeoutMs: 1000 });

	const first = await renderer.render('flowchart LR\n A-->B', 'light');
	const second = await renderer.render('flowchart LR\n A-->B', 'light');
	const dark = await renderer.render('flowchart LR\n A-->B', 'dark');

	assert.equal(first, second);
	assert.equal(dark, first);
	assert.equal(calls.render, 2, 'one render per scheme');
	assert.equal(calls.parse, 2);
	assert.equal(renderer.cacheSize, 2);
});

test('de-duplicates identical in-flight requests', async () => {
	let release;
	const pending = new Promise((resolve) => { release = resolve; });
	const { mermaid, calls } = fakeMermaid({
		async render() {
			calls.render += 1;
			return pending;
		},
	});
	const renderer = createMermaidRenderer({ mermaid, timeoutMs: 1000 });

	const left = renderer.render('graph TD\n A-->B');
	const right = renderer.render('graph TD\n A-->B');
	assert.notEqual(left, right, 'each caller gets its own materialized promise');
	await Promise.resolve();
	release({ svg: '<svg></svg>' });

	assert.deepEqual(await left, '<svg></svg>');
	assert.deepEqual(await right, '<svg></svg>');
	assert.equal(calls.render, 1);
	assert.equal(renderer.cacheSize, 1);
});

test('gives every cached SVG instance a unique DOM id', async () => {
	const { mermaid, calls } = fakeMermaid({
		async render(id) {
			calls.render += 1;
			return { svg: `<svg id="${id}"><marker id="${id}-marker"></marker><use href="#${id}-marker"></use></svg>` };
		},
	});
	const renderer = createMermaidRenderer({ mermaid, timeoutMs: 1000 });

	const first = await renderer.render('graph TD\n A-->B');
	const second = await renderer.render('graph TD\n A-->B');
	const idOf = (svg) => /<svg id="([^"]+)"/.exec(svg)[1];

	assert.equal(calls.render, 1, 'second call is a cache hit');
	assert.notEqual(first, second, 'cached source is materialized per mount');
	assert.notEqual(idOf(first), idOf(second));
	assert.ok(first.includes(`#${idOf(first)}-marker`));
	assert.ok(second.includes(`#${idOf(second)}-marker`));
	assert.equal(first.includes('\uE000'), false, 'sentinel is not leaked to the DOM');
	assert.equal(second.includes('\uE000'), false, 'sentinel is not leaked to the DOM');
});

test('times out one render and lets the queue continue', async () => {
	const { mermaid } = fakeMermaid({
		render(_id, code) {
			if (code === 'hang') return new Promise(() => {});
			return Promise.resolve({ svg: '<svg>ok</svg>' });
		},
	});
	const renderer = createMermaidRenderer({ mermaid, timeoutMs: 25 });

	await assert.rejects(renderer.render('hang'), (error) => {
		assert.ok(error instanceof MermaidTimeoutError);
		assert.equal(error.code, 'MERMAID_TIMEOUT');
		return true;
	});
	assert.equal(await renderer.render('good'), '<svg>ok</svg>');
});

test('a failed render does not poison later renders', async () => {
	const { mermaid, calls } = fakeMermaid({
		async render(_id, code) {
			calls.render += 1;
			if (code === 'bad') throw new Error('draw failed');
			return { svg: '<svg>later</svg>' };
		},
	});
	const renderer = createMermaidRenderer({ mermaid, timeoutMs: 1000 });

	await assert.rejects(renderer.render('bad'), /draw failed/);
	assert.equal(await renderer.render('good'), '<svg>later</svg>');
	assert.equal(calls.render, 2);
});

test('parses before rendering and never renders invalid syntax', async () => {
	const { mermaid, calls } = fakeMermaid({
		async parse() {
			calls.parse += 1;
			throw new Error('bad syntax');
		},
	});
	const renderer = createMermaidRenderer({ mermaid, timeoutMs: 1000 });

	await assert.rejects(renderer.render('not a diagram'), /bad syntax/);
	assert.equal(calls.parse, 1);
	assert.equal(calls.render, 0);
	assert.equal(renderer.cacheSize, 0);
});

test('initializes with error rendering suppressed', async () => {
	const { mermaid, calls } = fakeMermaid();
	const renderer = createMermaidRenderer({
		mermaid,
		timeoutMs: 1000,
		themeVariables: (scheme) => ({ darkMode: scheme === 'dark' }),
	});
	await renderer.render('graph TD\n A-->B', 'dark');

	assert.equal(calls.lastOptions.securityLevel, 'strict');
	assert.equal(calls.lastOptions.suppressErrorRendering, true);
	assert.equal(calls.lastOptions.startOnLoad, false);
	assert.deepEqual(calls.lastOptions.themeVariables, { darkMode: true });
});

test('evicts the least recently used entry above the cache limit', async () => {
	const { mermaid, calls } = fakeMermaid();
	const renderer = createMermaidRenderer({ mermaid, timeoutMs: 1000, cacheLimit: 2 });

	await renderer.render('a');
	await renderer.render('b');
	await renderer.render('a'); // cache hit
	await renderer.render('c'); // evicts b
	await renderer.render('b'); // must render again

	assert.equal(calls.render, 4);
	assert.equal(renderer.cacheSize, 2);
	assert.equal(renderer.inflightSize, 0);
	renderer.clearCache();
	assert.equal(renderer.cacheSize, 0);
});
