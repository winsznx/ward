/** @type {import('next').NextConfig} */
const nextConfig = {
  // The /api/vet route spawns the orchestrator CLI (child_process) — Node runtime only.
  serverExternalPackages: [],
};

export default nextConfig;
