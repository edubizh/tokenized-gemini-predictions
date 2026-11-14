// The generated program client imports its own files as "./x.js", the form a TypeScript build
// emits, while the workspace consumes the ".ts" sources directly. Turbopack does not map one to
// the other, so this loader drops the extension from relative imports and normal resolution
// finds the TypeScript file.
module.exports = function tsImportExtension(source) {
  return source.replace(/(\bfrom\s+["'])(\.{1,2}\/[^"']+)\.js(["'])/g, "$1$2$3");
};
