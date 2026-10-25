// Locale fallback for the plugin's own strings.
//
// The client locale service normally resolves the `dshMermaid` namespace. A
// plugin reload can briefly leave a card mounted after its dictionary was
// disposed (or before a replacement registered), and `t(key)` then returns the
// key unchanged. Falling back to the bundled English dictionary keeps the card
// controls readable instead of exposing `card.expand` / `card.source`.

/**
 * Resolve one key through the host translator, with a bundled fallback.
 *
 * @param {(key: string, params?: Record<string, unknown>) => unknown} t -
 *   host translator, possibly undefined or a key-returning stub.
 * @param {Record<string, string>} dictionary - bundled fallback strings.
 * @param {string} key - translation key.
 * @param {Record<string, unknown>} [params] - optional interpolation values.
 * @returns {string}
 */
export function translateWithFallback(t, dictionary, key, params) {
	let value;
	if (typeof t === 'function') {
		try {
			value = t(key, params);
		} catch {
			value = undefined;
		}
	}
	if (typeof value !== 'string' || value === '' || value === key) {
		value = dictionary[key] ?? key;
	}
	if (params !== undefined) {
		value = value.replace(/\{(\w+)\}/g, (match, name) => (
			name in params ? String(params[name]) : match
		));
	}
	return value;
}

/**
 * Build a translator bound to one host `t` function and the bundled dictionary.
 * The returned function is stable for a stable `t`, which keeps React memo
 * dependencies from churning.
 *
 * @param {(key: string, params?: Record<string, unknown>) => unknown} t
 * @param {Record<string, string>} dictionary
 * @returns {(key: string, params?: Record<string, unknown>) => string}
 */
export function createTranslator(t, dictionary) {
	return (key, params) => translateWithFallback(t, dictionary, key, params);
}
