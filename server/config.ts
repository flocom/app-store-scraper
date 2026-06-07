/** Runtime configuration, read from environment variables. */
export const config = {
  /** Port the HTTP server listens on. */
  port: Number(process.env.PORT ?? 8080),
  /** Bind address. 0.0.0.0 inside Docker so the tunnel can reach it. */
  host: process.env.HOST ?? '0.0.0.0',
  /**
   * Bearer token required on /api and /mcp. If unset, those routes are
   * OPEN — only acceptable for local development. A warning is logged.
   */
  authToken: process.env.AUTH_TOKEN ?? '',
  /** Public base URL (used in docs/health output only). */
  publicUrl: process.env.PUBLIC_URL ?? '',
};

export const authEnabled = config.authToken.length > 0;
