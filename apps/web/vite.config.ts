import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";

// In Docker the server is reachable as http://server:3000; on the host it's localhost.
const proxyTarget = process.env.PROXY_TARGET ?? "http://localhost:3000";
const proxy = {
  "/api": proxyTarget,
  "/health": proxyTarget,
};

export default defineConfig({
  plugins: [react()],
  // `server` = dev (vite); `preview` = prod (vite preview serving the build). Both proxy
  // /api to the server so the same single-origin setup works in dev and production.
  server: { host: true, port: 5173, proxy },
  // allowedHosts: self-hosters reach prod through a domain / reverse proxy; without this
  // `vite preview` rejects the Host header ("Blocked request"). Safe behind a trusted proxy.
  preview: { host: true, port: 5173, proxy, allowedHosts: true },
});
