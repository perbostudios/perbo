import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";
const server = await createServer();
await server.listen();
const env = {
  ...process.env,
  PERBO_DESKTOP_DEV_URL: "http://127.0.0.1:51859",
};
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ["."], { stdio: "inherit", env });
app.on("exit", async (code) => {
  await server.close();
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    app.kill("SIGTERM");
  });
