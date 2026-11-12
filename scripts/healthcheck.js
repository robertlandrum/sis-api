// Container healthcheck: exits 0 if the local server answers HEAD / with 200.
// Reads the same config as server.js, so it follows server.port and uses
// HTTPS when server.tls is enabled.
//
// usage: node scripts/healthcheck.js

"use strict";

var path = require("path");
var nconf = require("nconf");

var confDir = path.join(__dirname, "..", "conf");
nconf.env({ separator : '__', parseValues : true })
    .file("config.json.local", path.join(confDir, "config.json.local"))
    .file("config.json", path.join(confDir, "config.json"));

var server = nconf.get("server") || { };
var useTls = !!(server.tls && server.tls.enabled);

var req = require(useTls ? "https" : "http").request({
    host : server.address || "127.0.0.1",
    port : server.port,
    method : "HEAD",
    path : "/",
    // the cert is issued for the public name, not 127.0.0.1
    rejectUnauthorized : false,
    timeout : 4000
}, function(res) {
    process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", function() { req.destroy(new Error("timeout")); });
req.on("error", function() { process.exit(1); });
req.end();
