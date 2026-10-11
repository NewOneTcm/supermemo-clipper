// Speak the *real* Chrome native-messaging protocol to our host, so the host
// runs exactly as Chrome would run it (length-prefixed UTF-8 JSON on stdin,
// same framing back on stdout). Default action is "diagnose", which checks
// everything but sends no keystroke and creates no element.
//
//   node test/host-probe.js [diagnose|new_and_paste] [pageUrl] [version]
//
// new_and_paste CREATES AN ELEMENT in SuperMemo (and steals its focus), so only
// use it when you actually want a note added.
"use strict";
const path = require("path");
const { spawn } = require("child_process");

const HOST_BAT = path.join(__dirname, "..", "native", "host.bat");
const action = process.argv[2] || "diagnose";
const pageUrl = process.argv[3] || "";
const version = process.argv[4] || "";

const payload = Buffer.from(JSON.stringify({
  action: action,
  pageUrl: pageUrl,
  version: version
}), "utf8");
const framed = Buffer.alloc(4 + payload.length);
framed.writeUInt32LE(payload.length, 0);
payload.copy(framed, 4);

const child = spawn("cmd.exe", ["/c", HOST_BAT], { stdio: ["pipe", "pipe", "pipe"] });
let out = Buffer.alloc(0);
let err = "";
child.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
child.stderr.on("data", (d) => { err += d.toString("utf8"); });
child.stdin.write(framed);
child.stdin.end();

const started = Date.now();
child.on("close", (code) => {
  console.log("exit=" + code + "  用时 " + (Date.now() - started) + "ms");
  if (err.trim()) console.log("STDERR:\n" + err.trim().slice(0, 800));
  if (out.length >= 4) {
    const len = out.readUInt32LE(0);
    const body = out.slice(4, 4 + len).toString("utf8");
    console.log("RESPONSE:\n" + body);
    try { console.log("\n格式化:"); console.log(JSON.stringify(JSON.parse(body), null, 2)); } catch (_) {}
  } else {
    console.log("无响应，收到 " + out.length + " 字节");
  }
});
