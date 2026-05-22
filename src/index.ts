import { loadConfig, loadEnv } from "./config";
import { createRouterServer } from "./server";

loadEnv();
const config = loadConfig(process.env.ROUTER_CONFIG);
const server = createRouterServer(config);
const host = config.host ?? "127.0.0.1";

server.listen(config.port, host, () => {
  console.log(`ClaudeCode_router listening on http://${host}:${config.port}`);
  console.log(`providers: ${Object.keys(config.providers).join(", ")}`);
  console.log(`classifier: ${config.routing.classifier.enabled ? "on" : "off"}`);
});
