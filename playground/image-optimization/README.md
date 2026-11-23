# Image Optimization Playground

Six live examples for `Image`, `getImageProps()`, and the `/_void/image` endpoint. See the [Image Optimization guide](../../docs/guide/image-optimization.md).

From the repository root:

```sh
vp run --filter ./playground/image-optimization dev
vp run --filter ./playground/image-optimization build
vp run --filter ./playground/image-optimization preview
```

Use the browser’s Network panel to see which responsive candidate was downloaded, when lazy images start loading, and what format the optimizer returned. The remote example requires access to Unsplash; the other examples use checked-in images.

Photo: [Luca Bravo on Unsplash](https://unsplash.com/photos/body-of-water-near-mountain-during-daytime-zAjdgNXsMeg), under the [Unsplash License](https://unsplash.com/license).
