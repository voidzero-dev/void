declare module 'void:security-scanner-controller-source' {
  const source: string;
  export default source;
}

declare module 'void:security-scanner-runner-source' {
  /** `dist/runner.mjs` of `@voidcloud/security-scanner`, embedded in the controller bundle. */
  const source: string;
  export default source;
}
