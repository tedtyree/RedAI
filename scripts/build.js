const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

const configs = [
  // Extension host — Node.js, CommonJS
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    bundle: true,
    sourcemap: true,
  },
  // WebView — browser, IIFE
  {
    entryPoints: ['webview/editor.ts'],
    outfile: 'dist/webview.js',
    format: 'iife',
    platform: 'browser',
    bundle: true,
    sourcemap: true,
  },
];

async function main() {
  if (isWatch) {
    const contexts = await Promise.all(configs.map(c => esbuild.context(c)));
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all(configs.map(c => esbuild.build(c)));
    console.log('Build complete.');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
