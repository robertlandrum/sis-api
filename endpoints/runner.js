'use strict';

var vm = require("vm");
var clone = require("clone");
var csvStringify = require('csv-stringify');
var yaml = require('js-yaml');
var P = require("../util/promises");
var SIS = require("../util/constants");
var createScriptManager = require("../util/script-manager");
var createHieraManager = require("../util/hiera-manager");
var LOGGER = require("../util/logger").createLogger({
    name : "ScriptRunner"
});


// context apis
var ApiClient = require("./api-client");
var ApiResponse = require("./api-response");

// internal holder to ensure the script finishes before sending out
// a response
class ResponseHolder {
    constructor(defer) {
        this.response = null;
        this.defer = defer;
    }

    setResponse(response) {
        this.response = response;
        this.defer.resolve(this);
    }
}

// helper function to run a generator of promises
function async(gen) {
    // result = IteratorResult
    function handleResult(result) {
        if (result.done) { return result.value; }
        // wait for the promise to resolve before continuing
        return result.value.then(function(promiseResult) {
            // pass the promise result to the caller (doThing)
            return handleResult(gen.next(promiseResult));
        }, function(error) {
            // allows for try catch in the caller!
            return handleResult(gen.throw(error));
        });
    }
    return handleResult(gen.next());
}

class ScriptRunner {
    constructor(schemaManager) {
        this.schemaManager = schemaManager;
        this.manager = createScriptManager(schemaManager);
        this.hieraManager = createHieraManager(schemaManager);
        this.scriptCache = { };
    }

    // Resolves with the compiled script, compiling it again once it changed
    async _getScript(name) {
        var scriptObj = await this.manager.getById(name, { lean : true });
        LOGGER.debug({ script : name }, "Running script");
        var scriptTime = scriptObj._sis._updated_at;
        var cached = this.scriptCache[name];
        if (!cached || scriptTime > cached.time) {
            cached = {
                script : new vm.Script(scriptObj.script, { filename: name }),
                time : scriptTime
            };
            this.scriptCache[name] = cached;
        }
        return cached.script;
    }

    _createContext(holder, req) {
        var ctx = {
            client : new ApiClient(this.schemaManager, this.hieraManager),
            res : new ApiResponse(holder),
            req : req,
            Promise : Promise,
            // keep the csv.stringify shape that user scripts expect
            csv : { stringify : csvStringify },
            yaml : yaml,
            async : async
        };
        return vm.createContext(clone(ctx));
    }

    // Run the script of the request.  Resolves with the response it sends.
    async handleRequest(req) {
        var endpoint = req.endpoint;
        try {
            var script = await this._getScript(endpoint);
            var defer = P.defer();
            script.runInNewContext(this._createContext(new ResponseHolder(defer), req));
            return (await defer.promise).response;
        } catch (err) {
            if (Array.isArray(err)) {
                throw err;
            }
            LOGGER.error({ err : err, endpoint : endpoint }, "Script error");
            // the client gets the error and where in the script it happened,
            // but not the stack frames of the server
            var scriptLines = String((err && err.stack) || "").split("\n").filter(function(line) {
                return line.indexOf(endpoint + ":") !== -1;
            }).map(function(line) {
                return line.trim();
            });
            throw SIS.ERR_INTERNAL([String(err)].concat(scriptLines).join("\n"));
        }
    }
}

module.exports = ScriptRunner;
