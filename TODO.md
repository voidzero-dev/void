# Void View

- Prepare templates for every component in production storage, with a renderer lookup at runtime. Keep page output selective: include only templates reachable from the dynamic components actually rendered on that page, including descendants that may appear on later renders. The prototype keeps the prepared templates in the generated server module.
- Store compiled source for dynamic components and their transitive dynamic children as separate chunks. Evaluate assembling page bundles on demand, preparing bundles during rendering, or another delivery strategy later. The prototype selects compiled source fragments and emits them inline during SSR; a static page needs neither View templates nor View JavaScript.
