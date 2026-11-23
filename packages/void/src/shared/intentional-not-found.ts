/** Application 404s that must not fall through to a static asset. */
export const intentionalNotFoundRequests: WeakSet<Request> = new WeakSet();
