/**
 * Host half of dsh-mermaid.
 *
 * The browser half (`lib/client.js`) renders the cards. This half keeps the
 * Loader row that makes the browser bundle discoverable and contributes the
 * bundled `dsh-mermaid` agent skill, so the model knows the exact fence contract
 * the renderer expects.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PROVIDER_NAME = 'dsh-mermaid';
const SKILL_NAME = PROVIDER_NAME;
const SKILL_BODY_URL = new URL('./assets/skills/dsh-mermaid/SKILL.md', import.meta.url);
const RESOURCE_BASE = {
	kind: 'directory',
	path: fileURLToPath(new URL('./assets/skills/dsh-mermaid/', import.meta.url)),
};

/** Matches BUNDLED_SKILL_RANK in @deepseek-ai/dsh-skill. */
const BUNDLED_SKILL_RANK = 600;

const DESCRIPTION = 'Generate valid Mermaid diagrams in closed mermaid code fences for DSH chat cards and Markdown previews. Use when the user asks for a diagram or when a visual explains architecture, a process, sequence, state machine, schema, or schedule.';

const CANDIDATE = {
	name: SKILL_NAME,
	description: DESCRIPTION,
	whenToUse: 'The user asks for a diagram, flowchart, sequence, state machine, ER/class model, Gantt chart, or any visual explanation that Mermaid can express.',
	invocation: {
		modelInvocable: true,
		userInvocable: true,
	},
	provider: PROVIDER_NAME,
	source: 'bundled',
	resourceBase: RESOURCE_BASE,
	rank: BUNDLED_SKILL_RANK,
	locator: SKILL_BODY_URL,
};

const provider = {
	name: PROVIDER_NAME,
	list: () => Promise.resolve([CANDIDATE]),
	async get() {
		return {
			name: CANDIDATE.name,
			description: CANDIDATE.description,
			invocation: CANDIDATE.invocation,
			provider: CANDIDATE.provider,
			source: CANDIDATE.source,
			resourceBase: CANDIDATE.resourceBase,
			content: await readFile(SKILL_BODY_URL, 'utf8'),
		};
	},
};

/** Cordis services needed by the host half. */
export const inject = ['skills'];

/** Register the bundled `dsh-mermaid` skill provider. */
export function apply(ctx) {
	ctx.skills.registerProvider(() => provider);
}
