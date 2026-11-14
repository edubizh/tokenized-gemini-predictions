// The generated program client (`@outcome/program-client`, a workspace package of TypeScript
// sources) imports its own files with `.js` specifiers, which Node does not map to the `.ts`
// files on disk. Importing this module registers a resolver that does.
//
// It has to run before the client is resolved, and static imports are resolved before any module
// runs. So an entry point imports this file statically and loads everything else with a dynamic
// `import()`; alternatively start Node with `--import ./src/chain/client-loader.ts`.

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      const ownSource = context.parentURL !== undefined && !context.parentURL.includes("/node_modules/");
      if (relative && ownSource && specifier.endsWith(".js") && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
