// Locale fallback: a card must show bundled English labels even when the host
// translator returns the key (for example during a plugin/locale reload).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslator, translateWithFallback } from '../src/i18n.js';

const EN = {
	'card.expand': 'Expand',
	'card.source': 'Source',
	'greet': 'Hello, {name}',
};

test('uses the host translation when it resolves', () => {
	assert.equal(translateWithFallback((key) => `host:${key}`, EN, 'card.expand'), 'host:card.expand');
});

test('falls back to the bundled dictionary when the host returns the key', () => {
	assert.equal(translateWithFallback((key) => key, EN, 'card.expand'), 'Expand');
	assert.equal(translateWithFallback((key) => key, EN, 'card.source'), 'Source');
});

test('falls back when the host translator throws', () => {
	assert.equal(translateWithFallback(() => { throw new Error('locale reload'); }, EN, 'card.expand'), 'Expand');
});

test('falls back when no translator is supplied', () => {
	assert.equal(translateWithFallback(undefined, EN, 'card.expand'), 'Expand');
});

test('returns the key when neither source has it', () => {
	assert.equal(translateWithFallback((key) => key, EN, 'unknown.key'), 'unknown.key');
});

test('interpolates params in both host and fallback translations', () => {
	assert.equal(translateWithFallback(undefined, EN, 'greet', { name: 'Denis' }), 'Hello, Denis');
	assert.equal(translateWithFallback((key, params) => `${key}:${params.name}`, EN, 'greet', { name: 'Denis' }), 'greet:Denis');
});

test('createTranslator is stable for a stable host translator', () => {
	const host = (key) => key;
	const first = createTranslator(host, EN);
	const second = createTranslator(host, EN);
	assert.equal(first('card.expand'), 'Expand');
	assert.equal(second('card.source'), 'Source');
});
