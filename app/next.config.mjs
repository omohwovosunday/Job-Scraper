/** @type {import('next').NextConfig} */
const nextConfig = {
  // Every page reads live data through the service role. Nothing here may be
  // statically generated at build time, and nothing may run in the browser.
  experimental: {},

  /**
   * Production builds write to .next-build, not .next.
   *
   * `next build` and `next dev` share .next by default, and the build deletes the
   * dev server's assets on the way past. The running server keeps serving HTML
   * that references /_next/static/css/app/layout.css, which the build has just
   * removed, so every stylesheet 404s and the page renders unstyled — while the
   * dev server reports no error at all, because from its side nothing failed.
   *
   * This cost an hour on 2026-09-13, twice, and the second time was after the
   * cause was already known. Separate directories make it structurally impossible
   * rather than something to remember.
   */
  distDir: process.env.NODE_ENV === 'production' ? '.next-build' : '.next',
};
export default nextConfig;
