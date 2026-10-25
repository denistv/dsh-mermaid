// Turn extraction: a diagram may live in any assistant text step, and identical
// diagrams in intermediate and closing messages must render once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { diagramsSignature, turnDiagrams, turnTexts } from '../src/turn.js';

const fence = (info, body) => `\`\`\`${info}\n${body}\n\`\`\``;

function step(blocks) {
	return { data: new Map([['assistant-step', { blocks }]]) };
}

function text(text) {
	return { kind: 'text', text };
}

test('collects text from every step and de-duplicates diagram sources', () => {
	const code = 'flowchart LR\n A-->B';
	const turn = {
		steps: [
			step([text(`Intro\n\n${fence('mermaid', code)}`)]),
			step([text('Some prose'), text(`Again:\n\n${fence('mmd', code)}`)]),
		],
		data: new Map([['turn-tail', { closing: null }]]),
	};

	assert.deepEqual(turnTexts(turn), [`Intro\n\n${fence('mermaid', code)}`, 'Some prose', `Again:\n\n${fence('mmd', code)}`]);
	assert.deepEqual(turnDiagrams(turn), [code]);
	assert.equal(diagramsSignature(turnDiagrams(turn)), code);
});

test('falls back to closing when steps are absent', () => {
	const code = 'sequenceDiagram\n A->>B: hi';
	const turn = {
		data: new Map([['turn-tail', { closing: { blocks: [text(fence('mermaid', code))] } }]]),
	};
	assert.deepEqual(turnDiagrams(turn), [code]);
});

test('reads finalNode blocks as well as blocks', () => {
	const code = 'graph TD\n A-->B';
	const turn = {
		data: new Map([['turn-tail', {
			closing: { finalNode: { blocks: [text(fence('mermaid', code))] } },
		}]]),
	};
	assert.deepEqual(turnDiagrams(turn), [code]);
});

test('ignores reasoning, tool blocks, empty and unclosed fences', () => {
	const turn = {
		steps: [step([
			{ kind: 'reasoning', text: fence('mermaid', 'graph TD\n A-->B') },
			{ kind: 'tool-call', text: fence('mermaid', 'graph TD\n C-->D') },
			text('```mermaid\ngraph TD\n E-->F\n'),
			text('```mermaid\n\n```'),
			text('plain text'),
		])],
	};
	assert.deepEqual(turnDiagrams(turn), []);
});

test('a throwing Turn shape degrades to an empty list', () => {
	const turn = {
		get steps() {
			throw new Error('future harness shape');
		},
	};
	assert.deepEqual(turnTexts(turn), []);
	assert.deepEqual(turnDiagrams(turn), []);
});

test('different diagrams keep first-seen order', () => {
	const turn = {
		steps: [
			step([text(fence('mermaid', 'graph TD\n A-->B'))]),
			step([text(fence('mermaid', 'graph TD\n C-->D'))]),
		],
	};
	assert.deepEqual(turnDiagrams(turn), ['graph TD\n A-->B', 'graph TD\n C-->D']);
});
