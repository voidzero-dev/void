export type AppSetupModule = { id: string; file: string };

export function generateSetupCall({ file }: AppSetupModule): string {
  const option = `voidVue appSetup (${file})`;
  return `
  if (typeof setupApp !== "function") {
    throw new TypeError(${JSON.stringify(`${option} must default-export a function.`)});
  }
  const appHooks = setupApp(app);
  if (typeof appHooks?.then === "function") {
    void Promise.resolve(appHooks).catch(() => {});
    throw new TypeError(${JSON.stringify(`${option} must be synchronous.`)});
  }`;
}

export function generateSsrAppSetup(appSetup: AppSetupModule): string {
  return `
import setupApp from ${JSON.stringify(appSetup.id)};
import { isPageResponseError } from "void/pages-protocol";
async function requestApp(root, request) {
  const entry = await requestAppSetup(() => {
    const app = createSSRApp({ setup: () => entry.root.setup() });${generateSetupCall(appSetup)}
    return { app, root, appHooks };
  }, request);
  return Object.assign(entry, { root });
}`;
}

export function generateSsrRender(appSetup: AppSetupModule | undefined): string {
  const handler = appSetup
    ? `const setupErrorHandler = app.config.errorHandler;
  const boundary = boundaryManifest.pages[pageObj.component];
  if (Object.keys(boundaryManifest.plans).length) app.config.errorHandler = (error, ...args) => {
    if (!setupErrorHandler || isPageResponseError(error) || boundary?.errors.length ||
        boundaryManifest.plans[pageObj.component]) {
      renderFailure ??= { error };
    }
    try {
      setupErrorHandler?.(error, ...args);
    } catch (error) {
      renderFailure ??= { error };
    }
  };`
    : 'if (Object.keys(boundaryManifest.plans).length) app.config.errorHandler = error => { renderFailure ??= { error }; };';
  return `let renderFailure;
  ${handler}
  const html = await renderToString(app)${appSetup ? '.finally(() => { app.config.errorHandler = setupErrorHandler; })' : ''};
  if (renderFailure) throw renderFailure.error;`;
}
