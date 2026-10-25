// Mermaid render engine for dsh-mermaid.
//
// Mermaid mutates shared layout/parser state, so every call goes through one
// serial queue. The queue is deliberately defensive:
//
//   - identical `scheme + code` requests share one in-flight promise;
//   - successful SVGs are cached and re-used (chat remounts and theme toggles
//     must not re-render the same diagram forever);
//   - a render that never settles is raced against a timeout, so one bad
//     diagram cannot wedge every later card;
//   - `parse` runs first with `suppressErrorRendering: true`, so syntax errors
//     do not leave Mermaid's temporary error SVG in `document.body`;
//   - temporary nodes are removed defensively in `finally`.
//
// This module has no React dependency and accepts `mermaid` as a parameter so
// the queue/cache behavior can be tested without a browser.

/** Default time budget for one parse or render attempt. */
export const DEFAULT_RENDER_TIMEOUT_MS = 15_000;
/** Default number of cached SVGs (LRU). */
export const DEFAULT_CACHE_LIMIT = 64;
/** Private-use sentinel standing in for a cached SVG's instance id. */
const ID_PLACEHOLDER = '\uE000dsh-mermaid-instance-id\uE000';

/** Error raised when Mermaid exceeds the configured time budget. */
export class MermaidTimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = 'MermaidTimeoutError';
		this.code = 'MERMAID_TIMEOUT';
	}
}

/** Race a promise against a timer. A non-positive timeout disables the race. */
function withTimeout(promise, timeoutMs, message) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new MermaidTimeoutError(message));
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Create one renderer instance. The caller supplies the Mermaid namespace and
 * a theme-variable resolver; the renderer owns queue, cache, ids, and timeouts.
 *
 * @param {object} options
 * @param {object} options.mermaid - Mermaid namespace (`initialize`, `parse`, `render`).
 * @param {(scheme: string) => Record<string, unknown>} [options.themeVariables] -
 *   resolve Mermaid theme variables for `light` / `dark`.
 * @param {number} [options.timeoutMs] - per parse/render budget.
 * @param {number} [options.cacheLimit] - LRU capacity; `0` disables the cache.
 * @param {string} [options.idPrefix] - unique prefix for Mermaid element ids.
 * @returns {{render: (code: string, scheme?: string) => Promise<string>, clearCache: () => void, cacheSize: number, inflightSize: number}}
 */
export function createMermaidRenderer(options) {
	const {
		mermaid,
		themeVariables,
		timeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
		cacheLimit = DEFAULT_CACHE_LIMIT,
		idPrefix = 'dsh-mermaid',
	} = options ?? {};
	if (mermaid === undefined || mermaid === null) {
		throw new Error('createMermaidRenderer requires a mermaid namespace');
	}
	const limit = Number.isFinite(cacheLimit) ? Math.max(0, Math.floor(cacheLimit)) : DEFAULT_CACHE_LIMIT;

	/** @type {Map<string, string>} successful SVG cache, oldest first. */
	const cache = new Map();
	/** @type {Map<string, Promise<string>>} identical requests share one promise. */
	const inflight = new Map();
	let sequence = 0;
	let tail = Promise.resolve();

	/** Read a cache entry and refresh its LRU position. */
	function cacheGet(key) {
		const value = cache.get(key);
		if (value === undefined) return undefined;
		cache.delete(key);
		cache.set(key, value);
		return value;
	}

	/** Insert one SVG, evicting the least recently used entry above capacity. */
	function cacheSet(key, value) {
		if (limit === 0) return;
		cache.delete(key);
		cache.set(key, value);
		while (cache.size > limit) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}

	/** Apply the full configuration before every attempt (theme may have changed). */
	function configure(scheme) {
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'strict',
			// Critical: a syntax/draw error must reject instead of leaving an
			// error SVG behind in document.body.
			suppressErrorRendering: true,
			theme: 'base',
			themeVariables: themeVariables?.(scheme) ?? {},
			flowchart: { htmlLabels: false, useMaxWidth: true },
			sequence: { useMaxWidth: true },
			gantt: { useMaxWidth: true },
			er: { useMaxWidth: true },
			mindmap: { useMaxWidth: true },
		});
	}

	/** Remove Mermaid's temporary div/svg/iframe even if the library forgot. */
	function cleanup(id) {
		if (typeof document === 'undefined') return;
		for (const candidate of [`d${id}`, id, `i${id}`]) {
			try {
				document.getElementById?.(candidate)?.remove?.();
			} catch {
				// A detached or mocked document must not mask the render result.
			}
		}
	}

	/** Serialize one attempt behind the previous one. */
	function enqueue(job) {
		const run = tail.then(job);
		// The queue itself must never become rejected: a failed diagram may not
		// poison later diagrams.
		tail = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Next unique Mermaid element id / rendered SVG instance id. */
	function nextId() {
		return `${idPrefix}-${++sequence}`;
	}

	/**
	 * Replace the render-time id with a sentinel before caching. Cached SVG is
	 * shared by several cards, so it must not carry a concrete DOM id: duplicate
	 * ids would make `url(#marker)` resolve across cards.
	 */
	function normalizeSvg(svg, id) {
		if (!svg.includes(id)) return svg;
		return svg.split(id).join(ID_PLACEHOLDER);
	}

	/** Give one cached SVG its own concrete DOM ids for this mount. */
	function materializeSvg(svg) {
		if (!svg.includes(ID_PLACEHOLDER)) return svg;
		return svg.split(ID_PLACEHOLDER).join(nextId());
	}

	/** Render one attempt. Queue ownership is handled by `render`. */
	async function renderNow(code, scheme, id) {
		try {
			configure(scheme);
			if (typeof mermaid.parse === 'function') {
				const parsed = await withTimeout(
					Promise.resolve().then(() => mermaid.parse(code)),
					timeoutMs,
					`Mermaid parse timed out after ${timeoutMs}ms`,
				);
				if (parsed === false) throw new Error('Mermaid rejected the diagram syntax');
			}
			const result = await withTimeout(
				(() => {
					const renderPromise = Promise.resolve().then(() => mermaid.render(id, code));
					// If the race times out, Mermaid may keep working in the
					// background. Clean up its temporary nodes whenever the orphaned
					// promise eventually settles, not only when the timeout fires.
					renderPromise.then(() => cleanup(id), () => cleanup(id));
					return renderPromise;
				})(),
				timeoutMs,
				`Mermaid render timed out after ${timeoutMs}ms`,
			);
			if (result === undefined || result === null || typeof result.svg !== 'string') {
				throw new Error('Mermaid returned no SVG');
			}
			return normalizeSvg(result.svg, id);
		} finally {
			cleanup(id);
		}
	}

	/**
	 * Render one diagram. Cache hits and duplicate in-flight requests resolve
	 * without touching the queue; each caller still gets a unique SVG instance.
	 * @param {string} code - Mermaid source.
	 * @param {string} [scheme] - `light` or `dark`.
	 * @returns {Promise<string>} SVG markup.
	 */
	function render(code, scheme = 'light') {
		if (typeof code !== 'string') return Promise.reject(new TypeError('Mermaid source must be a string'));
		const key = `${scheme}\u0000${code}`;
		const cached = cacheGet(key);
		if (cached !== undefined) return Promise.resolve(cached).then(materializeSvg);
		const pending = inflight.get(key);
		if (pending !== undefined) return pending.then(materializeSvg);

		const id = nextId();
		const task = enqueue(() => renderNow(code, scheme, id));
		inflight.set(key, task);
		// Attach handlers immediately so a rejection is never unhandled when the
		// caller also observes it; delete the entry only after settling.
		task.then(
			(svg) => {
				cacheSet(key, svg);
				inflight.delete(key);
			},
			() => {
				inflight.delete(key);
			},
		);
		return task.then(materializeSvg);
	}

	return {
		render,
		clearCache() {
			cache.clear();
		},
		get cacheSize() {
			return cache.size;
		},
		get inflightSize() {
			return inflight.size;
		},
	};
}
