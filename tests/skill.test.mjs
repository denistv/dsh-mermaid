// Host half: the plugin contributes one bundled runtime skill provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject } from '../index.js';

test('registers the bundled dsh-mermaid skill provider', async () => {
	assert.deepEqual(inject, ['skills']);

	let providerFactory;
	const ctx = {
		skills: {
			registerProvider(factory) {
				providerFactory = factory;
				return () => {};
			},
		},
	};
	apply(ctx);
	assert.equal(typeof providerFactory, 'function');

	const provider = providerFactory();
	assert.equal(provider.name, 'dsh-mermaid');

	const candidates = await provider.list();
	assert.equal(candidates.length, 1);
	const candidate = candidates[0];
	assert.equal(candidate.name, 'dsh-mermaid');
	assert.equal(candidate.provider, 'dsh-mermaid');
	assert.equal(candidate.source, 'bundled');
	assert.equal(candidate.rank, 600);
	assert.equal(candidate.invocation.modelInvocable, true);
	assert.equal(candidate.invocation.userInvocable, true);
	assert.equal(candidate.resourceBase.kind, 'directory');
	assert.ok(candidate.resourceBase.path.includes('/assets/skills/dsh-mermaid'));

	const loaded = await provider.get(candidate);
	assert.equal(loaded.name, 'dsh-mermaid');
	assert.ok(candidate.locator.pathname.endsWith('/assets/skills/dsh-mermaid/SKILL.md'));
	assert.match(loaded.content, /^# Mermaid diagrams/m);
	const fence = String.fromCharCode(96).repeat(3);
	assert.match(loaded.content, new RegExp(`^${fence}mermaid$`, 'm'), 'examples use a direct mermaid fence');
	assert.equal(
		loaded.content.includes(String.fromCharCode(96).repeat(4) + 'text'),
		false,
		'examples are not nested inside a documentation wrapper',
	);
	assert.ok(loaded.content.includes('```mermaid'), 'skill documents the exact fence');
	assert.ok(loaded.content.includes('final assistant message'), 'skill places the fence in the visible answer');
	assert.ok(loaded.content.includes('Close the fence'), 'skill requires a closed fence');
});
