declare module "*.html" {
  const html: string
  export default html
}

/** SVGs are bundled as text (scripts/build.mjs), to inline into the app's own screens. */
declare module "*.svg" {
  const svg: string
  export default svg
}
