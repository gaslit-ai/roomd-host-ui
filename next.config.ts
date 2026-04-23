import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Pino uses worker threads for transports; Next.js cannot bundle them
	// cleanly through webpack. Keep pino external so it resolves via native
	// Node require on the server.
	serverExternalPackages: ["pino", "pino-pretty"],
};

export default nextConfig;
