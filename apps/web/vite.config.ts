import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import oxc from "unplugin-oxc/vite";

export default defineConfig({
  plugins: [react(), oxc(), tailwindcss()],
  server: {
    port: 3000,
  },
});
