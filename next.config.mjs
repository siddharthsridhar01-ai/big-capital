/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },

  // Linting is skipped on Vercel. It checks style, not correctness, and every
  // change is already typechecked and tested locally before it is pushed, so
  // running it again in the cloud only lengthens the deploy.
  //
  // Type checking is deliberately NOT skipped: a type error can be a real bug,
  // and the build is the last place to catch one if a local check is forgotten.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
