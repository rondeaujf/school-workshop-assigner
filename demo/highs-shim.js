// Browser bridge for the `highs` package's WebAssembly build.
//
// `dist/solver.js` (compiled from src/solver.ts) does `import highsLoader from 'highs'`.
// That bare specifier only resolves in Node (via package.json exports) or under a
// bundler — this demo is deliberately bundler-free (plain `npx serve` + a browser
// import map, see index.html), and `node_modules/highs/build/highs.js` is not an ES
// module: it's Emscripten's classic UMD-style output, which only exports via
// `module.exports` (Node/CommonJS) or `define()` (AMD). Loaded as a plain classic
// <script> (no `type="module"`), its `var Module = ...` becomes a global instead, so
// this shim loads it that way once, then wraps that global as the default export our
// compiled code expects: `highsLoader(options) => Promise<{ solve }>`.
//
// The browser's import map (see index.html) points the bare specifier "highs" at
// this file, so nothing else in the codebase needs to know this bridge exists.

const shimDirectory = new URL('.', import.meta.url);

let classicScriptLoaded = null;

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

export default async function highsLoader(options = {}) {
  if (!classicScriptLoaded) {
    classicScriptLoaded = loadClassicScript(new URL('vendor/highs/highs.js', shimDirectory).href);
  }
  await classicScriptLoaded;

  const factory = globalThis.Module;
  if (typeof factory !== 'function') {
    throw new Error('highs.js loaded but did not define the expected global `Module` factory.');
  }

  const locateFile = options.locateFile ?? ((file) => new URL(`vendor/highs/${file}`, shimDirectory).href);
  return factory({ locateFile });
}
