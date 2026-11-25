// oxlint-disable-next-line typescript/triple-slash-reference -- dependent workspace projects need the virtual build module declaration.
/// <reference path="./security-scanner-controller-modules.d.ts" />

import controllerSource from 'void:security-scanner-controller-source';

/** The API build embeds the fixed scanner controller bundle (with the runner inside it). */
export function getSecurityScannerControllerSource(): string {
  if (!controllerSource) {
    throw new Error('The platform runtime is missing its security scanner controller bundle.');
  }
  return controllerSource;
}
