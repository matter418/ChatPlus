// esbuild inlines these as data URLs (see build.mjs); TypeScript just needs the shape.
declare module "*.mp3" {
    const dataUrl: string;
    export default dataUrl;
}
