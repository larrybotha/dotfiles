import { connect } from "./cdp.js";

const cookie = process.argv[2];

const cdp = await connect(5000);
const page = await cdp.waitForActivePage();
const sessionId = await cdp.attachToPage(page.targetId);

await cdp.send("Network.enable", {}, sessionId);

const res = await cdp.send(
  "Network.setCookie",
  {
    name: "sessionid",
    value: cookie,
    domain: "localhost",
    path: "/",
    httpOnly: true,
    secure: false,
  },
  sessionId,
);
console.log("sessionid:", JSON.stringify(res));

const res2 = await cdp.send(
  "Network.setCookie",
  {
    name: "csrftoken",
    value: cookie,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
  },
  sessionId,
);
console.log("csrftoken:", JSON.stringify(res2));

await cdp.ws.close();
