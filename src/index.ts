import { loadConfig, loadEnv } from "./config";
import { createRouterServer } from "./server";

loadEnv();
const config = loadConfig(process.env.ROUTER_CONFIG);
const server = createRouterServer(config);

server.listen(config.port, () => {
  console.log(`ClaudeCode_router listening on http://localhost:${config.port}`);
  console.log(`providers: ${Object.keys(config.providers).join(", ")}`);
  console.log(`classifier: ${config.routing.classifier.enabled ? "on" : "off"}`);
});
