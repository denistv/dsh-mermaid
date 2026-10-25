// Turn-data extraction for the chat surface. The harness exposes a Turn as a
// reactive object with `steps` and per-turn data maps. A diagram can live in
// any assistant text block of the turn, not only in the closing one, so this
// module scans every available text block and de-duplicates identical sources.

import { mermaidBlocks } from './markdown.js';

/** Read a step's assistant payload without letting a shape change throw. */
function assistantStepOf(step) {
	try {
		return step?.data?.get?.('assistant-step');
	} catch {
		return undefined;
	}
}

/** Read the turn's closing payload without letting a shape change throw. */
function closingOf(turn) {
	try {
		return turn?.data?.get?.('turn-tail')?.closing;
	} catch {
		return undefined;
	}
}

/**
 * All text carried by one Turn, in step order.
 *
 * The primary source is `turn.steps[*].data.get('assistant-step').blocks`.
 * The durable `turn-tail.closing` payload is appended as a fallback (and for
 * harness versions where the step list is not exposed). Block objects are
 * de-duplicated by identity before their text is read.
 *
 * @param {object} turn - Turn passed to `conversation.chat.turnTail`.
 * @returns {string[]} text block contents.
 */
export function turnTexts(turn) {
	/** @type {Set<object>} */
	const seenBlocks = new Set();
	/** @type {string[]} */
	const texts = [];

	const pushBlocks = (blocks) => {
		if (!Array.isArray(blocks)) return;
		for (const block of blocks) {
			if (block === null || typeof block !== 'object' || seenBlocks.has(block)) continue;
			seenBlocks.add(block);
			if (block.kind === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
				texts.push(block.text);
			}
		}
	};

	try {
		if (Array.isArray(turn?.steps)) {
			for (const step of turn.steps) {
				const data = assistantStepOf(step);
				pushBlocks(data?.blocks);
				pushBlocks(data?.finalNode?.blocks);
			}
		}
	} catch {
		// A future Turn shape without a readable `steps` list falls back below.
	}

	const closing = closingOf(turn);
	pushBlocks(closing?.blocks);
	pushBlocks(closing?.finalNode?.blocks);

	return texts;
}

/**
 * Every unique Mermaid diagram carried by the Turn, in first-seen order.
 * Identical sources are rendered once even when an intermediate step and the
 * closing message contain the same fence.
 *
 * @param {object} turn - Turn passed to `conversation.chat.turnTail`.
 * @returns {string[]} diagram sources.
 */
export function turnDiagrams(turn) {
	const seen = new Set();
	/** @type {string[]} */
	const diagrams = [];
	for (const text of turnTexts(turn)) {
		for (const code of mermaidBlocks(text)) {
			const key = code.trim();
			if (key === '' || seen.has(key)) continue;
			seen.add(key);
			diagrams.push(code);
		}
	}
	return diagrams;
}

/**
 * Small stable signature for memo dependencies. It changes when the set of
 * diagrams changes, even if the Turn object is mutated in place.
 * @param {string[]} diagrams
 * @returns {string}
 */
export function diagramsSignature(diagrams) {
	return diagrams.join('\u0000');
}
