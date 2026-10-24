// dsh-mermaid — browser half.
//
// Two surfaces share one Mermaid runtime:
//
//   1. Chat: an ordered entry in `conversation.chat.turnTail` renders every
//      ```mermaid / ```mmd fence found in the closing assistant message as a
//      diagram card below that message.
//   2. Markdown preview: a `documentPreviews` implementation in the extension
//      band wins over the built-in Markdown viewer for `.md` / `.markdown`,
//      parses the file, and renders Mermaid fences inline between the Markdown
//      blocks.
//
// The artifact is built by `build.mjs` (esbuild, format=iife) so `mermaid`,
// `marked`, and `dompurify` are inlined. Only `react` stays external: it is
// answered by the harness browser module table. The source below is plain JS
// with `React.createElement` so no JSX transform or second React is needed.
//
// The static imports are what make esbuild bundle these packages. They are not
// read from the loader's `require` because that parameter is opaque to esbuild
// and would leave the artifact nearly empty.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import mermaid from 'mermaid';

window.__ModuleLoader__.load({
	id: 'dsh-mermaid',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		// The harness exposes its own Markdown renderer in the browser module
		// table. Using it keeps the built-in typography, code blocks, footnotes,
		// and sanitization instead of shipping a second Markdown implementation.
		// guarded: a future harness may stop exposing the module, in which case
		// `renderMarkdownHtml` below is the fallback.
		let MarkdownText = null;
		try {
			MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives')?.MarkdownText ?? null;
		} catch {
			MarkdownText = null;
		}

		/** Chat seat for one completed Turn. */
		const CHAT_SLOT = 'conversation.chat.turnTail';
		/** Keyed document body seat; the key is also the preview implementation id. */
		const DOCUMENT_SLOT = 'sidebar.right.tab.document';
		/** Frame-wide overlay layer for the expanded diagram view. */
		const OVERLAY_SLOT = 'shell.overlay';
		/**
		 * The shipped Markdown body's key. We shadow this body at a lower priority
		 * instead of registering a second viewer, so the viewer dropdown keeps a
		 * single "Markdown" entry owned by the built-in implementation.
		 */
		const MARKDOWN_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown';
		/** Locale namespace for every string this plugin renders. */
		const LOCALE_NS = 'dshMermaid';
		/** Chat tail order: after deliverables and the schedule row. */
		const CHAT_ORDER = 35;
		/** Cell id of the chat contribution. */
		const CHAT_ID = 'dsh-mermaid-chat';
		/** Cell id of the expanded diagram overlay. */
		const OVERLAY_ID = 'dsh-mermaid-overlay';

		const EN = {
			'card.label': 'Mermaid',
			'card.diagram': 'Diagram',
			'card.source': 'Source',
			'card.expand': 'Expand',
			'card.copy': 'Copy',
			'card.copied': 'Copied',
			'card.rendering': 'Rendering diagram…',
			'card.error': 'Mermaid could not render this diagram',
			'card.empty': 'Empty diagram',
			'overlay.label': 'Mermaid diagram',
			'overlay.close': 'Close',
			'overlay.resize': 'Drag the corner to resize',
			'code.copy': 'Copy',
			'code.copied': 'Copied',
			'codeBlock.title': 'Code',
			'codeBlock.wrap': 'Wrap',
			'codeBlock.unwrap': 'No wrap',
			'footnotes': 'Footnotes',
			'overlay.maximize': 'Maximize',
			'overlay.defaultSize': 'Default size',
		};

		// ── runtimes ──────────────────────────────────────────────────────────
		// Mermaid, marked, and DOMPurify are bundled at build time; `mermaid` and
		// `marked` do their real work only when the first diagram/document renders.
		let purifier;
		let renderSequence = 0;
		let renderQueue = Promise.resolve();

		// ── expanded-diagram overlay store ───────────────────────────────────
		// The card and the overlay are two independent slot entries, so they meet
		// through this tiny module-level store rather than through props. Only one
		// diagram can be expanded at a time.
		let overlayState = null;
		const overlayListeners = new Set();

		/** @returns the diagram currently expanded in the overlay, or null. */
		function getOverlayState() {
			return overlayState;
		}

		/** Subscribe to overlay open/close changes. @returns its disposer. */
		function subscribeOverlay(listener) {
			overlayListeners.add(listener);
			return () => { overlayListeners.delete(listener); };
		}

		/** Open the expanded view for one rendered diagram. */
		function openOverlay(next) {
			overlayState = next;
			for (const listener of overlayListeners) listener();
		}

		/** Close the expanded view. */
		function closeOverlay() {
			if (overlayState === null) return;
			overlayState = null;
			for (const listener of overlayListeners) listener();
		}

		/** @returns a configured DOMPurify instance. */
		function getPurifier() {
			if (purifier !== undefined) return purifier;
			const candidate = DOMPurify?.default ?? DOMPurify;
			purifier = typeof candidate === 'function' && typeof candidate.sanitize !== 'function'
				? candidate(window)
				: candidate;
			purifier.addHook('afterSanitizeAttributes', (node) => {
				if (node.tagName === 'A') {
					node.setAttribute('target', '_blank');
					node.setAttribute('rel', 'noreferrer noopener');
				}
				if (node.tagName === 'IMG') node.setAttribute('loading', 'lazy');
			});
			return purifier;
		}

		// ── fenced-block parsing ──────────────────────────────────────────────
		/** Open-fence line: indentation, 3+ backticks/tildes, optional info word. */
		const OPEN_FENCE = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
		/** Mermaid fence info strings this plugin claims. */
		const MERMAID_LANGUAGES = new Set(['mermaid', 'mmd']);

		/**
		 * Split Markdown into ordinary blocks and Mermaid fences. Only closed
		 * fences are recognised; an unfinished fence stays in the Markdown part,
		 * which is what a streaming message or a partially paged file needs.
		 * @param {string} text - Markdown source.
		 * @returns {{type: 'markdown'|'mermaid', text?: string, code?: string}[]}
		 */
		function splitMermaid(text) {
			const lines = String(text ?? '').split('\n');
			const segments = [];
			let buffer = [];
			let index = 0;
			while (index < lines.length) {
				const open = OPEN_FENCE.exec(lines[index]);
				if (open === null) {
					buffer.push(lines[index]);
					index += 1;
					continue;
				}
				const marker = open[2][0];
				const minimum = open[2].length;
				const info = open[3].toLowerCase();
				const closing = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{${minimum},}\\s*$`);
				let close = index + 1;
				for (; close < lines.length; close += 1) {
					if (closing.test(lines[close])) break;
				}
				if (close >= lines.length) {
					// Unterminated fence: leave it to the Markdown parser.
					buffer.push(lines[index]);
					index += 1;
					continue;
				}
				if (MERMAID_LANGUAGES.has(info)) {
					if (buffer.length > 0) {
						segments.push({ type: 'markdown', text: buffer.join('\n') });
						buffer = [];
					}
					segments.push({ type: 'mermaid', code: lines.slice(index + 1, close).join('\n') });
				} else {
					for (let line = index; line <= close; line += 1) buffer.push(lines[line]);
				}
				index = close + 1;
			}
			if (buffer.length > 0) segments.push({ type: 'markdown', text: buffer.join('\n') });
			return segments;
		}

		/**
		 * Every Mermaid fence in a Markdown string.
		 * @param {string} text - Markdown source.
		 * @returns {string[]} diagram sources.
		 */
		function mermaidBlocks(text) {
			return splitMermaid(text)
				.filter(segment => segment.type === 'mermaid')
				.map(segment => segment.code)
				.filter(code => code.trim() !== '');
		}

		// ── Markdown rendering ────────────────────────────────────────────────
		/**
		 * Parse and sanitize one Markdown segment. Raw HTML in model output is
		 * untrusted, so `marked` output always passes through DOMPurify.
		 * @param {string} text - Markdown source.
		 * @returns {string} sanitized HTML.
		 */
		function renderMarkdownHtml(text) {
			const html = marked.parse(String(text ?? ''), { async: false, gfm: true, breaks: false });
			if (typeof html !== 'string') return '';
			return getPurifier().sanitize(html, {
				USE_PROFILES: { html: true },
				ADD_ATTR: ['target', 'rel', 'loading'],
			});
		}

		/** Whether a path is absolute in either spelling the Host accepts. */
		function isAbsoluteWorkspacePath(path) {
			return path.startsWith('/')
				|| /^[A-Za-z]:[/\\]/.test(path)
				|| path.startsWith('\\\\');
		}

		/** Split a path into its directory prefix (through the last separator) and name. */
		function pathPartsOf(path) {
			const trimmed = path.replace(/[/\\]+$/, '');
			if (trimmed === '') return { directory: '', name: path };
			const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
			return { directory: trimmed.slice(0, cut), name: trimmed.slice(cut) };
		}

		/**
		 * Address a decoded absolute file path through the authenticated file
		 * route. Mirrors the built-in Markdown preview's resolver.
		 */
		function fileMediaUrl(base, path) {
			if ((!/^https?:/.test(base) && !base.startsWith('dsh-app://app/'))
				|| !isAbsoluteWorkspacePath(path)
				|| /^[/\\]{2}/.test(path)
				|| /[\u0000-\u001f\u007f]/.test(path)) return undefined;
			return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;
		}

		/**
		 * Resolve one authored Markdown image destination beside the previewed
		 * document. HTTP(S), data, and unsupported schemes are left untouched.
		 */
		function markdownImageUrl(base, documentPath, destination) {
			const suffix = destination.search(/[?#]/);
			let path;
			try {
				path = decodeURIComponent(suffix === -1 ? destination : destination.slice(0, suffix));
			} catch {
				return undefined;
			}
			if (path.length === 0) return undefined;
			if (!/^[a-z]:[/\\]/i.test(path) && /^[a-z][a-z\d+.-]*:/i.test(path)) return undefined;
			if (!isAbsoluteWorkspacePath(path)) {
				if (documentPath === undefined) return undefined;
				path = pathPartsOf(documentPath).directory + path;
			}
			return fileMediaUrl(base, path);
		}

		/** Split an optional leading YAML frontmatter block from Markdown. */
		function splitFrontmatter(text) {
			const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/.exec(text);
			if (match === null) return { frontmatter: undefined, body: text };
			return { frontmatter: match[1], body: text.slice(match[0].length) };
		}

		// ── theme and Mermaid rendering ───────────────────────────────────────
		/** Read one host CSS custom property, with a fallback for non-browser tests. */
		function token(name, fallback) {
			if (typeof document === 'undefined' || document.documentElement === null) return fallback;
			const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
			return value === '' ? fallback : value;
		}

		/**
		 * Concrete palette handed to Mermaid. The base theme derives its shades
		 * from these colours, so the diagram follows the shell's light/dark mode.
		 * @param {string} scheme - `light` or `dark`.
		 * @returns {Record<string, string|boolean>}
		 */
		function mermaidThemeVariables(scheme) {
			const dark = scheme === 'dark';
			return {
				darkMode: dark,
				background: token('--dsw-alias-bg-layer-1', dark ? '#1c1c1f' : '#ffffff'),
				primaryColor: token('--dsw-alias-bg-layer-2', dark ? '#26262b' : '#f3f6fa'),
				primaryTextColor: token('--dsw-alias-label-primary', dark ? '#f2f2f3' : '#1b1b1f'),
				primaryBorderColor: token('--dsw-alias-border-l2', dark ? '#4a4a52' : '#c9d3df'),
				secondaryColor: token('--dsw-alias-bg-layer-1', dark ? '#202024' : '#eef5ff'),
				secondaryTextColor: token('--dsw-alias-label-primary', dark ? '#f2f2f3' : '#1b1b1f'),
				secondaryBorderColor: token('--dsw-alias-border-l1', dark ? '#3a3a42' : '#dce4ee'),
				tertiaryColor: token('--dsw-alias-bg-base', dark ? '#161618' : '#f7f9fc'),
				tertiaryTextColor: token('--dsw-alias-label-secondary', dark ? '#b8b8c0' : '#5a6572'),
				lineColor: token('--dsw-alias-label-secondary', dark ? '#9aa0aa' : '#6b7684'),
				textColor: token('--dsw-alias-label-primary', dark ? '#f2f2f3' : '#1b1b1f'),
				mainBkg: token('--dsw-alias-bg-layer-2', dark ? '#26262b' : '#f3f6fa'),
				nodeBorder: token('--dsw-alias-border-l2', dark ? '#4a4a52' : '#c9d3df'),
				clusterBkg: token('--dsw-alias-bg-layer-1', dark ? '#202024' : '#f7f9fc'),
				clusterBorder: token('--dsw-alias-border-l1', dark ? '#3a3a42' : '#dce4ee'),
				titleColor: token('--dsw-alias-label-primary', dark ? '#f2f2f3' : '#1b1b1f'),
				edgeLabelBackground: token('--dsw-alias-bg-layer-1', dark ? '#1c1c1f' : '#ffffff'),
				fontFamily: token('--dsw-font', 'inherit'),
				fontSize: '14px',
			};
		}

		/** Serialize Mermaid renders: the library mutates shared layout state. */
		function enqueueRender(work) {
			const next = renderQueue.then(work);
			renderQueue = next.then(() => undefined, () => undefined);
			return next;
		}

		/**
		 * Render one diagram to an SVG string.
		 * @param {string} code - Mermaid source.
		 * @param {string} scheme - `light` or `dark`.
		 * @returns {Promise<string>} SVG markup.
		 */
		function renderMermaidSvg(code, scheme) {
			return enqueueRender(async () => {
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: 'strict',
					theme: 'base',
					themeVariables: mermaidThemeVariables(scheme),
					flowchart: { htmlLabels: false, useMaxWidth: true },
					sequence: { useMaxWidth: true },
					gantt: { useMaxWidth: true },
					er: { useMaxWidth: true },
					mindmap: { useMaxWidth: true },
				});
				const id = `dsh-mermaid-${++renderSequence}`;
				const result = await mermaid.render(id, code);
				return result.svg;
			});
		}

		/** Follow the shell's active colour scheme through the theme service. */
		function useColorScheme(props) {
			const read = () => {
				try {
					return props.theme?.getTheme?.()?.active?.colorScheme === 'dark' ? 'dark' : 'light';
				} catch {
					return 'light';
				}
			};
			const [scheme, setScheme] = React.useState(read);
			React.useEffect(() => {
				if (typeof props.onThemeChange !== 'function') return undefined;
				return props.onThemeChange((snapshot) => {
					if (snapshot?.active?.colorScheme === 'dark') setScheme('dark');
					else setScheme('light');
				});
			}, [props.onThemeChange]);
			return scheme;
		}

		/** @returns the active locale's translator, or the English dictionary. */
		function useTranslator(props) {
			const fallback = React.useMemo(() => (key) => EN[key] ?? key, []);
			return props.t ?? fallback;
		}

		/**
		 * One diagram card: header (label, source toggle, copy), rendered SVG or
		 * source fallback. The card never disappears on a parse error; it shows
		 * the reason above the original source instead.
		 */
		function MermaidCard(props) {
			const { code, scheme, variant } = props;
			const t = useTranslator(props);
			const [showSource, setShowSource] = React.useState(false);
			const [copied, setCopied] = React.useState(false);
			const [state, setState] = React.useState({ status: 'loading' });

			React.useEffect(() => {
				let alive = true;
				if (code.trim() === '') {
					setState({ status: 'empty' });
					return () => { alive = false; };
				}
				setState({ status: 'loading' });
				renderMermaidSvg(code, scheme).then(
					(svg) => { if (alive) setState({ status: 'ready', svg }); },
					(error) => {
						if (!alive) return;
						const message = error instanceof Error ? error.message : String(error);
						setState({ status: 'error', message: message.split('\n')[0] });
					},
				);
				return () => { alive = false; };
			}, [code, scheme]);

			const copy = () => {
				const write = navigator.clipboard?.writeText?.(code);
				if (write === undefined) return;
				write.then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1200);
				}, () => undefined);
			};

			const head = h('div', { className: 'dsh-mermaid-head' },
				h('span', { className: 'dsh-mermaid-label' }, t('card.label')),
				h('span', { className: 'dsh-mermaid-spacer' }),
				state.status === 'ready'
					? h('button', {
						type: 'button',
						className: 'dsh-mermaid-btn',
						onClick: () => openOverlay({ svg: state.svg, code }),
					}, t('card.expand'))
					: null,
				state.status === 'ready'
					? h('button', {
						type: 'button',
						className: 'dsh-mermaid-btn',
						'aria-pressed': showSource,
						onClick: () => setShowSource((value) => !value),
					}, showSource ? t('card.diagram') : t('card.source'))
					: null,
				h('button', { type: 'button', className: 'dsh-mermaid-btn', onClick: copy }, copied ? t('card.copied') : t('card.copy')),
			);

			let body;
			if (showSource) {
				body = h('pre', { className: 'dsh-mermaid-source' }, code);
			} else if (state.status === 'loading') {
				body = h('div', { className: 'dsh-mermaid-loading' }, t('card.rendering'));
			} else if (state.status === 'empty') {
				body = h('div', { className: 'dsh-mermaid-loading' }, t('card.empty'));
			} else if (state.status === 'error') {
				body = h('div', { className: 'dsh-mermaid-failure' },
					h('div', { className: 'dsh-mermaid-error' }, `${t('card.error')}: ${state.message}`),
					h('pre', { className: 'dsh-mermaid-source' }, code),
				);
			} else {
				body = h('div', {
					className: 'dsh-mermaid-svg',
					// Mermaid's strict security level sanitizes the generated SVG; the
					// string is produced by the library, not by the model.
					dangerouslySetInnerHTML: { __html: state.svg },
				});
			}

			return h('div', {
				className: variant === 'document' ? 'dsh-mermaid-card dsh-mermaid-card-document' : 'dsh-mermaid-card',
			}, head, h('div', { className: 'dsh-mermaid-body' }, body));
		}

		// ── expanded-view geometry ────────────────────────────────────────────
		/** localStorage key for the reader's preferred modal size. */
		const OVERLAY_SIZE_KEY = 'dsh-mermaid.overlay.size';
		/** Minimum usable modal size. */
		const OVERLAY_MIN_WIDTH = 420;
		const OVERLAY_MIN_HEIGHT = 300;
		/** Default is deliberately generous; the corner handle can shrink it. */
		const OVERLAY_DEFAULT_WIDTH = 1120;
		const OVERLAY_DEFAULT_HEIGHT = 780;
		/** Keep 24px of the frame visible on every side. */
		const OVERLAY_MARGIN = 24;

		/**
		 * Top inset for dialogs, mirroring the shell's own rule: the frame's
		 * reserved top strip plus 20px, or just 20px in native fullscreen. On
		 * macOS this is `--dsh-frame-overlay-top` (48 + 20); `--dsh-frame-chrome-top`
		 * is Windows-only, so it is not enough here.
		 * @returns the top inset in CSS pixels, or 0 in a plain browser document.
		 */
		function frameOverlayTop() {
			if (typeof document === 'undefined') return 0;
			const root = document.documentElement;
			const raw = getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance').trim();
			const clearance = Number.parseFloat(raw);
			const fullscreen = root.hasAttribute('data-fullscreen');
			const shellTop = Number.isFinite(clearance) ? (fullscreen ? 0 : clearance) + 20 : 0;
			// The macOS desktop always keeps the 48px traffic-light strip; use it
			// as a floor even if the shell variable is missing or stale.
			const desktopFloor = root.getAttribute('data-platform') === 'darwin' && !fullscreen ? 68 : 0;
			return Math.max(shellTop, desktopFloor);
		}

		/** Clamp a size to the current viewport and the minimum. */
		function clampOverlaySize(width, height) {
			const viewportWidth = typeof window === 'undefined' ? OVERLAY_DEFAULT_WIDTH + OVERLAY_MARGIN * 2 : window.innerWidth;
			const viewportHeight = typeof window === 'undefined' ? OVERLAY_DEFAULT_HEIGHT + OVERLAY_MARGIN * 2 : window.innerHeight;
			const maxWidth = Math.max(OVERLAY_MIN_WIDTH, viewportWidth - OVERLAY_MARGIN * 2);
			const maxHeight = Math.max(OVERLAY_MIN_HEIGHT, viewportHeight - frameOverlayTop() - OVERLAY_MARGIN * 2);
			return {
				width: Math.round(Math.min(Math.max(width, OVERLAY_MIN_WIDTH), maxWidth)),
				height: Math.round(Math.min(Math.max(height, OVERLAY_MIN_HEIGHT), maxHeight)),
			};
		}

		/** Read the persisted size, clamped to this viewport. */
		function readOverlaySize() {
			try {
				const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(OVERLAY_SIZE_KEY);
				if (stored !== null) {
					const parsed = JSON.parse(stored);
					if (Number.isFinite(parsed?.width) && Number.isFinite(parsed?.height)) {
						return clampOverlaySize(parsed.width, parsed.height);
					}
				}
			} catch {
				// storage unavailable or malformed - use the default.
			}
			return clampOverlaySize(OVERLAY_DEFAULT_WIDTH, OVERLAY_DEFAULT_HEIGHT);
		}

		/** Persist the reader's size choice; failure leaves the session value. */
		function persistOverlaySize(size) {
			try {
				if (typeof localStorage !== 'undefined') {
					localStorage.setItem(OVERLAY_SIZE_KEY, JSON.stringify(size));
				}
			} catch {
				// storage unavailable - the size still applies until reload.
			}
		}

		/**
		 * Expanded diagram view: a centered, viewport-capped modal, mounted in the
		 * root `shell.overlay` list so it sits above every column and outside
		 * their scroll containers. The layer is click-through, so this root opts
		 * back into pointer events.
		 */
		function MermaidOverlay(props) {
			const t = useTranslator(props);
			const [state, setState] = React.useState(getOverlayState);
			const [size, setSize] = React.useState(readOverlaySize);
			const [resizing, setResizing] = React.useState(false);
			const closeRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const [maximized, setMaximized] = React.useState(false);
			const sizeRef = React.useRef(size);
			sizeRef.current = size;
			const dragRef = React.useRef(null);
			/** Size to return to when leaving the maximized state. */
			const restoreRef = React.useRef(null);
			const maximizedRef = React.useRef(maximized);
			maximizedRef.current = maximized;

			React.useEffect(() => subscribeOverlay(() => setState(getOverlayState())), []);

			// Every open starts from the reader's saved size, not from the size of
			// the previous (possibly maximized) session. A viewport change then
			// re-clamps the current size, or recomputes the maximum while maximized.
			React.useEffect(() => {
				if (state === null) return undefined;
				setSize(readOverlaySize());
				setMaximized(false);
				restoreRef.current = null;
				const onWindowResize = () => {
					if (maximizedRef.current) {
						setSize(clampOverlaySize(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
					} else {
						setSize((current) => clampOverlaySize(current.width, current.height));
					}
				};
				window.addEventListener('resize', onWindowResize);
				return () => window.removeEventListener('resize', onWindowResize);
			}, [state]);

			const startResize = (event) => {
				if (event.button !== undefined && event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				dragRef.current = {
					x: event.clientX,
					y: event.clientY,
					width: sizeRef.current.width,
					height: sizeRef.current.height,
				};
				event.currentTarget.setPointerCapture?.(event.pointerId);
				if (maximized) setMaximized(false);
				setResizing(true);
			};

			const moveResize = (event) => {
				const drag = dragRef.current;
				if (drag === null) return;
				setSize(clampOverlaySize(
					drag.width + event.clientX - drag.x,
					drag.height + event.clientY - drag.y,
				));
			};

			const endResize = (event) => {
				const drag = dragRef.current;
				if (drag === null) return;
				dragRef.current = null;
				setResizing(false);
				event.currentTarget.releasePointerCapture?.(event.pointerId);
				// Use the pointer-up coordinates rather than the last committed
				// render: React may batch the final pointermove.
				const finalSize = clampOverlaySize(
					drag.width + event.clientX - drag.x,
					drag.height + event.clientY - drag.y,
				);
				setSize(finalSize);
				persistOverlaySize(finalSize);
			};

			// One header button flips between the viewport-filling size and the
			// reader's saved/default size. Maximizing never overwrites the saved
			// preference.
			const toggleMaximized = () => {
				if (maximized) {
					const restore = restoreRef.current ?? readOverlaySize();
					restoreRef.current = null;
					setMaximized(false);
					setSize(clampOverlaySize(restore.width, restore.height));
					return;
				}
				restoreRef.current = sizeRef.current;
				setMaximized(true);
				setSize(clampOverlaySize(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
			};

			// Closing mid-drag must not leave a stale drag session behind.
			React.useEffect(() => {
				if (state !== null) return;
				dragRef.current = null;
				restoreRef.current = null;
				setResizing(false);
				setMaximized(false);
				// Preparing the next open here avoids a one-frame flash of the
				// previous (possibly maximized) size.
				setSize(readOverlaySize());
			}, [state]);

			React.useEffect(() => {
				if (state === null) return undefined;
				const previous = typeof document !== 'undefined' ? document.activeElement : null;
				const onKeyDown = (event) => {
					if (event.key !== 'Escape') return;
					event.preventDefault();
					closeOverlay();
				};
				document.addEventListener('keydown', onKeyDown);
				closeRef.current?.focus?.();
				return () => {
					document.removeEventListener('keydown', onKeyDown);
					previous?.focus?.();
				};
			}, [state]);

			if (state === null) return null;
			// Keep Tab inside the modal. The header has two controls, so cycle
			// between the first and last rather than pinning focus to Close.
			const trapFocus = (event) => {
				if (event.key !== 'Tab') return;
				const focusable = panelRef.current?.querySelectorAll?.('button:not([disabled])');
				if (focusable === undefined || focusable.length === 0) return;
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			};
			return h('div', {
				className: 'dsh-mermaid-overlay',
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': t('overlay.label'),
				onKeyDown: trapFocus,
			},
			h('div', {
				className: 'dsh-mermaid-overlay-backdrop',
				'aria-hidden': 'true',
				onClick: closeOverlay,
			}),
			h('div', {
				ref: panelRef,
				className: 'dsh-mermaid-overlay-panel',
				style: { width: `${size.width}px`, height: `${size.height}px` },
				'data-resizing': resizing || undefined,
			},
				h('div', { className: 'dsh-mermaid-overlay-head' },
					h('span', { className: 'dsh-mermaid-label' }, t('card.label')),
					h('span', { className: 'dsh-mermaid-spacer' }),
					h('button', {
						type: 'button',
						className: 'dsh-mermaid-btn',
						'aria-pressed': maximized,
						onClick: toggleMaximized,
					}, maximized ? t('overlay.defaultSize') : t('overlay.maximize')),
					h('button', {
						type: 'button',
						ref: closeRef,
						className: 'dsh-mermaid-btn',
						onClick: closeOverlay,
					}, t('overlay.close')),
				),
				h('div', {
					className: 'dsh-mermaid-overlay-body',
					// The same strict-mode SVG the card already rendered.
					dangerouslySetInnerHTML: { __html: state.svg },
				}),
				h('div', {
					className: 'dsh-mermaid-overlay-resizer',
					role: 'separator',
					'aria-label': t('overlay.resize'),
					title: t('overlay.resize'),
					onPointerDown: startResize,
					onPointerMove: moveResize,
					onPointerUp: endResize,
					onPointerCancel: endResize,
				}, h('svg', {
					className: 'dsh-mermaid-resize-glyph',
					width: 14,
					height: 14,
					viewBox: '0 0 14 14',
					'aria-hidden': 'true',
					focusable: 'false',
				}, h('path', {
					d: 'M12 5.5 5.5 12M12 9 9 12',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
				}))),
			));
		}

		// ── chat surface ──────────────────────────────────────────────────────
		/** Closing assistant text blocks of one Turn. */
		function closingBlocks(turn) {
			try {
				const tail = turn?.data?.get?.('turn-tail');
				const closing = tail?.closing;
				if (closing === undefined) return [];
				if (Array.isArray(closing.finalNode?.blocks)) return closing.finalNode.blocks;
				if (Array.isArray(closing.blocks)) return closing.blocks;
				return [];
			} catch {
				return [];
			}
		}

		/** Every Mermaid diagram carried by the closing assistant message. */
		function turnDiagrams(turn) {
			const diagrams = [];
			for (const block of closingBlocks(turn)) {
				if (block?.kind === 'text' && typeof block.text === 'string') {
					diagrams.push(...mermaidBlocks(block.text));
				}
			}
			return diagrams;
		}

		/**
		 * `conversation.chat.turnTail` entry. The owner supplies the Turn, so the
		 * plugin reads durable message blocks instead of watching the DOM.
		 */
		function ChatMermaidTail(props) {
			const scheme = useColorScheme(props);
			const diagrams = React.useMemo(() => turnDiagrams(props.turn), [props.turn]);
			if (diagrams.length === 0) return null;
			return h('div', { className: 'dsh-mermaid-tail' },
				diagrams.map((code, index) => h(MermaidCard, {
					key: `${index}-${code.length}`,
					code,
					scheme,
					t: props.t,
					variant: 'chat',
				})),
			);
		}

		// ── Markdown document preview ─────────────────────────────────────────
		/** Labels required by the shared `MarkdownText` primitive. */
		function markdownLabels(t) {
			return {
				code: {
					copyLabel: t('code.copy'),
					copiedLabel: t('code.copied'),
					toolbarLabels: {
						codeLabel: t('codeBlock.title'),
						wrapLabel: t('codeBlock.wrap'),
						unwrapLabel: t('codeBlock.unwrap'),
					},
				},
				footnotes: t('footnotes'),
			};
		}

		/**
		 * Replacement body for the built-in Markdown preview. It keeps the same
		 * viewer metadata and renders ordinary blocks through the harness's own
		 * `MarkdownText`, so headings, code highlighting, footnotes, and safety
		 * behavior stay identical to the shipped viewer. Only closed Mermaid
		 * fences are cut out and rendered as diagram cards.
		 */
		function MarkdownMermaidBody(props) {
			const scheme = useColorScheme(props);
			const t = useTranslator(props);
			const resource = props.useResource(props.resourceAddress);
			const absolutePath = resource?.value?.absolutePath;
			const text = props.content?.kind === 'text' ? props.content.text : '';
			const split = React.useMemo(() => splitFrontmatter(text), [text]);
			const segments = React.useMemo(() => splitMermaid(split.body), [split.body]);
			const labels = React.useMemo(() => markdownLabels(t), [t]);
			// Local README images are served by the authenticated /api/file route,
			// resolved relative to the previewed document's directory.
			const pathImages = React.useMemo(() => (absolutePath === undefined ? undefined : {
				resolve: (value) => markdownImageUrl(document.baseURI, absolutePath, value),
			}), [absolutePath]);

			if (props.content?.kind !== 'text') return null;
			const streaming = !props.content.eof;
			const lastMarkdownIndex = segments.reduce(
				(last, segment, index) => (segment.type === 'markdown' && segment.text.trim() !== '' ? index : last),
				-1,
			);

			return h('div', {
				className: 'dsh-md-doc',
				'data-document-markdown-mermaid': true,
				'data-markdown-renderer': MarkdownText === null ? 'fallback' : 'harness',
			},
				split.frontmatter === undefined
					? null
					: h('pre', { className: 'dsh-md-frontmatter' }, split.frontmatter),
				segments.map((segment, index) => {
					if (segment.type === 'mermaid') {
						return h(MermaidCard, {
							key: index,
							code: segment.code,
							scheme,
							t,
							variant: 'document',
						});
					}
					if (segment.text.trim() === '') return null;
					if (MarkdownText !== null) {
						return h(MarkdownText, {
							key: index,
							text: segment.text,
							streaming: streaming && index === lastMarkdownIndex,
							labels,
							pathImages,
						});
					}
					return h('div', {
						key: index,
						className: 'dsh-md-prose',
						dangerouslySetInnerHTML: { __html: renderMarkdownHtml(segment.text) },
					});
				}),
			);
		}

		// ── styles ────────────────────────────────────────────────────────────
		const CSS = `
.dsh-mermaid-tail { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 2px; }
.dsh-mermaid-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; overflow: hidden; }
.dsh-mermaid-card-document { margin: 14px 0; }
.dsh-mermaid-head { display: flex; align-items: center; gap: 4px; min-height: 32px; padding: 2px 8px 2px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-mermaid-label { color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; letter-spacing: 0.045em; text-transform: uppercase; }
.dsh-mermaid-spacer { flex: 1 1 auto; }
.dsh-mermaid-btn { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; padding: 3px 7px; border-radius: 6px; cursor: pointer; }
.dsh-mermaid-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-mermaid-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-mermaid-btn[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); }
.dsh-mermaid-body { padding: 10px 12px; overflow-x: auto; }
.dsh-mermaid-svg { min-width: 0; }
.dsh-mermaid-svg svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.dsh-mermaid-loading { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; }
.dsh-mermaid-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
.dsh-mermaid-failure .dsh-mermaid-source { margin-top: 8px; }
.dsh-mermaid-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: calc(var(--dsh-frame-overlay-top, 0px) + 24px) 24px 24px; pointer-events: auto; }
html[data-platform="darwin"]:not([data-fullscreen]) .dsh-mermaid-overlay { padding-top: calc(max(var(--dsh-frame-overlay-top, 68px), 68px) + 24px); }
html[data-windows-titlebar]:not([data-fullscreen]) .dsh-mermaid-overlay { padding-top: calc(var(--dsh-frame-overlay-top, 68px) + 24px); }
.dsh-mermaid-overlay-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: var(--dsw-mask-blur, blur(4px)); }
.dsh-mermaid-overlay-panel { position: relative; display: flex; flex-direction: column; max-width: 100%; max-height: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-panel, 12px); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); overflow: hidden; }
.dsh-mermaid-overlay-panel[data-resizing] { user-select: none; }
.dsh-mermaid-overlay-resizer { position: absolute; right: 0; bottom: 0; display: flex; align-items: flex-end; justify-content: flex-end; width: 30px; height: 30px; padding: 4px 6px 6px 4px; color: var(--dsw-alias-label-secondary); cursor: nwse-resize; touch-action: none; opacity: 0.4; transition: opacity 120ms ease; }
.dsh-mermaid-overlay-resizer:hover, .dsh-mermaid-overlay-resizer:active { opacity: 1; }
.dsh-mermaid-resize-glyph { display: block; }
.dsh-mermaid-overlay-head { display: flex; flex: none; align-items: center; gap: 4px; min-height: 40px; padding: 4px 10px 4px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-mermaid-overlay-body { display: flex; flex: 1 1 auto; min-height: 0; align-items: center; justify-content: center; padding: 16px; overflow: auto; }
.dsh-mermaid-overlay-body svg { display: block; width: auto !important; height: auto !important; max-width: 100% !important; max-height: 100% !important; }
.dsh-mermaid-source { margin: 0; padding: 10px 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: 12px/1.55 var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); white-space: pre; overflow: auto; max-height: 320px; border-radius: 0 0 8px 8px; }
.dsh-md-doc { min-width: 0; padding: 10px 12px 40px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-family: var(--dsw-font, inherit); white-space: normal; overflow-wrap: anywhere; }
.dsh-md-prose { font-size: 14px; line-height: 1.68; }
.dsh-md-frontmatter { margin: 8px 0 16px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: var(--dsw-font-markdown-small, 12px/1.55 var(--ds-font-family-code, ui-monospace, monospace)); white-space: pre-wrap; }
.dsh-md-prose > :first-child { margin-top: 0; }
.dsh-md-prose > :last-child { margin-bottom: 0; }
.dsh-md-prose p { margin: 0 0 12px; }
.dsh-md-prose h1, .dsh-md-prose h2, .dsh-md-prose h3, .dsh-md-prose h4, .dsh-md-prose h5, .dsh-md-prose h6 { margin: 22px 0 10px; color: var(--dsw-alias-label-primary); font-weight: 600; line-height: 1.3; }
.dsh-md-prose h1 { font-size: 1.7em; }
.dsh-md-prose h2 { font-size: 1.4em; }
.dsh-md-prose h3 { font-size: 1.2em; }
.dsh-md-prose h4, .dsh-md-prose h5, .dsh-md-prose h6 { font-size: 1em; }
.dsh-md-prose ul, .dsh-md-prose ol { margin: 0 0 12px; padding-left: 24px; }
.dsh-md-prose li { margin: 3px 0; }
.dsh-md-prose li > ul, .dsh-md-prose li > ol { margin: 3px 0; }
.dsh-md-prose blockquote { margin: 0 0 12px; padding: 2px 0 2px 12px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dsh-md-prose hr { margin: 20px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-md-prose a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dsh-md-prose a:hover { text-decoration: underline; }
.dsh-md-prose code { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.9em; padding: 1px 4px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); }
.dsh-md-prose pre { margin: 0 0 14px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); overflow: auto; }
.dsh-md-prose pre code { padding: 0; background: transparent; font-size: 12.5px; line-height: 1.6; white-space: pre; }
.dsh-md-prose table { width: max-content; min-width: 100%; margin: 0 0 14px; border-collapse: collapse; font-size: 13px; }
.dsh-md-prose th, .dsh-md-prose td { padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); text-align: left; vertical-align: top; }
.dsh-md-prose th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.dsh-md-prose img { max-width: 100%; height: auto; border-radius: 6px; }
.dsh-md-prose input[type="checkbox"] { margin-right: 6px; }
.dsh-md-prose del { color: var(--dsw-alias-label-secondary); }
`;

		/** Install this plugin's stylesheet for the lifetime of its effect. */
		function installStyles() {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-mermaid';
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => { tag.remove(); };
		}

		// ── plugin body ───────────────────────────────────────────────────────
		const inject = ['slots'];

		/**
		 * Register both surfaces. Every registration is owned by an effect, so
		 * unloading the plugin removes the tail entry and the document viewer.
		 * @param {object} ctx - restricted Cordis client context.
		 */
		function apply(ctx) {
			const locale = ctx.get('locale');
			const translate = locale === undefined ? (key) => key : locale.bind(LOCALE_NS);
			if (locale !== undefined) {
				ctx.effect(() => locale.register(LOCALE_NS, 'en', EN), 'dsh-mermaid: en dictionary');
			}
			ctx.effect(installStyles, 'dsh-mermaid: styles');

			// Entry-level injection: the shell gives slot components no theme
			// handle, so the plugin supplies its own plus a change subscription.
			const themeInject = () => ({
				theme: ctx.get('theme'),
				onThemeChange: (listener) => ctx.on('theme/change', listener),
				t: translate,
			});

			ctx.effect(() => ctx.slots.inject(CHAT_SLOT, () => ctx.slots.register({
				name: CHAT_SLOT,
				id: CHAT_ID,
				order: CHAT_ORDER,
				inject: themeInject,
			}, ChatMermaidTail)), 'dsh-mermaid: chat tail');

			// The overlay lives in the root layer, not inside the chat card: the
			// transcript clips its overflow and may animate with transforms, both
			// of which would trap a fixed-position child.
			ctx.effect(() => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
				name: OVERLAY_SLOT,
				id: OVERLAY_ID,
				order: 100,
				inject: () => ({ t: translate }),
			}, MermaidOverlay)), 'dsh-mermaid: expanded diagram overlay');

			const previews = ctx.get('documentPreviews');
			if (previews === undefined) {
				// A profile without the Sidebar document preview keeps the chat
				// surface and simply has nowhere to put the second one.
				return;
			}

			// Shadow the shipped Markdown body at a lower priority. The built-in
			// metadata (title "Markdown", extensions, loading mode) stays in
			// charge, so the viewer dropdown gains no second entry. Our body
			// renders ordinary blocks through MarkdownText and only adds the
			// diagram cards for Mermaid fences.
			ctx.effect(() => ctx.slots.inject(DOCUMENT_SLOT, () => ctx.slots.register({
				name: DOCUMENT_SLOT,
				key: MARKDOWN_BODY_ID,
				priority: -1,
				inject: themeInject,
			}, MarkdownMermaidBody)), 'dsh-mermaid: Markdown body override');
		}

		return {
			inject,
			apply,
			// Kept for the artifact test: fence parsing is the one piece of logic
			// whose failure would silently hide a diagram, so it is asserted
			// directly without a browser.
			__test: { splitMermaid, mermaidBlocks, splitFrontmatter, markdownImageUrl },
		};
	},
});
