// Requests whose response depends on auth, including parent requests after a rewrite.
export const authDependentRequests: WeakSet<Request> = new WeakSet();
