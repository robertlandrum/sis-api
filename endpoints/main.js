// The script runner child process entry point

'use strict';

var nconf = require('nconf');
var mongoose = require("mongoose");
var SIS = require("../util/constants");
var logger = require("../util/logger");
var createSchemaManager = require('../util/schema-manager');
var ScriptRunner = require('./runner');

if (process.env.TESTING) {
    nconf.env("__")
        .argv()
        .file("config.test.json", __dirname + "/../test/fixtures/config.test.json");
} else {
    nconf.env('__')
        .argv()
        .file("config.json.local", __dirname + "/../conf/config.json.local")
        .file("config.json", __dirname + "/../conf/config.json");
}


function sendResponse(res) {
    process.send({
        type : SIS.EP_DONE,
        data : res
    });
}

// Run the request and send the response back
async function handleRequest(runner, data) {
    try {
        sendResponse(await runner.handleRequest(data));
    } catch (err) {
        var status = err.status || 500;
        if (Array.isArray(err)) {
            status = err[0];
            err = err[1];
        }
        sendResponse({
            status : status,
            data : JSON.stringify(err),
            headers : { "Content-Type" : "application/json" }
        });
    }
}

// Connect, then tell the parent the process is ready for requests
async function start() {
    var opts = nconf.get('db').opts || { };
    await mongoose.connect(nconf.get('db').url, opts);
    var appConfig = nconf.get('app') || { };
    var schemaManager = createSchemaManager(mongoose, appConfig);
    await schemaManager.bootstrapEntitySchemas();
    var runner = new ScriptRunner(schemaManager);
    process.on("message", function(msg) {
        if (msg.type === SIS.EP_REQ) {
            handleRequest(runner, msg.data);
        }
    });
    process.send({ type : SIS.EP_READY });
}

start().catch(function(err) {
    console.log(err);
    process.send({ type : SIS.EP_ERROR, data : err });
});

// a rejection a script leaves unhandled is the script's bug - log it rather
// than let it end the process every endpoint shares
var LOGGER = logger.createLogger({ name : "ScriptProcess" });
process.on("unhandledRejection", function(reason) {
    LOGGER.error({ err : reason }, "Unhandled rejection in a script");
});

// need to also register the disconnect handler
process.on("disconnect", function() {
    // this is not ok.
    process.exit(1);
});
