// Pure Markdown / Mermaid-fence helpers shared by the chat surface, the
// document preview, and the Node tests. Nothing here touches React or Mermaid.

/** Open-fence line: indentation, 3+ backticks/tildes, optional info word. */
const OPEN_FENCE = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
/** Mermaid fence info strings this plugin claims. */
const MERMAID_LANGUAGES = new Set(['mermaid', 'mmd']);

/**
 * Split Markdown into ordinary blocks and Mermaid fences. Only closed fences
 * are recognised; an unfinished fence stays in the Markdown part, which is what
 * a streaming message or a partially paged file needs.
 * @param {string} text - Markdown source.
 * @returns {{type: 'markdown'|'mermaid', text?: string, code?: string}[]}
 */
export function splitMermaid(text) {
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
 * Every non-empty Mermaid fence in a Markdown string.
 * @param {string} text - Markdown source.
 * @returns {string[]} diagram sources.
 */
export function mermaidBlocks(text) {
	return splitMermaid(text)
		.filter((segment) => segment.type === 'mermaid')
		.map((segment) => segment.code)
		.filter((code) => code.trim() !== '');
}

/** Split an optional leading YAML frontmatter block from Markdown. */
export function splitFrontmatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/.exec(text);
	if (match === null) return { frontmatter: undefined, body: text };
	return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/** Whether a path is absolute in either spelling the Host accepts. */
export function isAbsoluteWorkspacePath(path) {
	return path.startsWith('/')
		|| /^[A-Za-z]:[/\\]/.test(path)
		|| path.startsWith('\\\\');
}

/** Split a path into its directory prefix (through the last separator) and name. */
export function pathPartsOf(path) {
	const trimmed = path.replace(/[/\\]+$/, '');
	if (trimmed === '') return { directory: '', name: path };
	const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
	return { directory: trimmed.slice(0, cut), name: trimmed.slice(cut) };
}

/**
 * Address a decoded absolute file path through the authenticated file route.
 * Mirrors the built-in Markdown preview's resolver.
 */
export function fileMediaUrl(base, path) {
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
export function markdownImageUrl(base, documentPath, destination) {
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
