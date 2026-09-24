import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [reactRouter()], server: { host: "127.0.0.1", port: 5197, strictPort: true }, clearScreen: false });
