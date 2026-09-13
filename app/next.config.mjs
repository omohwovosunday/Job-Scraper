/** @type {import('next').NextConfig} */
const nextConfig = {
  // Every page reads live data through the service role. Nothing here may be
  // statically generated at build time, and nothing may run in the browser.
  experimental: {},
};
export default nextConfig;
