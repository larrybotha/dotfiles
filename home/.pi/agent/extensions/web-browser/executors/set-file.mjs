import { connect } from "./cdp.js";
import { readFileSync } from "fs";

const filePath = process.argv[2];
const selector = process.argv[3];

const cdp = await connect(5000);
const page = await cdp.waitForActivePage();
const sessionId = await cdp.attachToPage(page.targetId);

await cdp.send("DOM.enable", {}, sessionId);
await cdp.send("Page.enable", {}, sessionId);

const { root } = await cdp.send(
  "DOM.getDocument",
  { depth: -1, pierce: true },
  sessionId,
);
const { nodeId } = await cdp.send(
  "DOM.querySelector",
  {
    nodeId: root.nodeId,
    selector,
  },
  sessionId,
);

if (!nodeId) {
  console.error("file input not found for selector:", selector);
  await cdp.ws.close();
  process.exit(1);
}

const data = readFileSync(filePath);
const basename = filePath.split("/").pop();

await cdp.send(
  "DOM.setFileInputFiles",
  {
    nodeId,
    files: [`/tmp/${basename}`],
  },
  sessionId,
);
console.log("set file:", basename, "bytes:", data.length, "nodeId:", nodeId);

await cdp.ws.close();
