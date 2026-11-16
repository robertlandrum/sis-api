'use strict';

var nconf = require('nconf');
var P = require("../util/promises");
var vm = require("vm");
var SIS = require("../util/constants");
var clone = require("clone");
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
        this.manager = require("../util/script-manager")(schemaManager);
        this.hieraManager = require("../util/hiera-manager")(schemaManager);
        this.scriptCache = { };
    }

    _getScript(name) {
        var self = this;
        return this.manager.getById(name, { lean : true })
        .then(function(scriptObj) {
            var scriptText = scriptObj.script;
            LOGGER.info("have script", { script: scriptText });
            var cached = self.scriptCache[name];
            var scriptTime = scriptObj._sis._updated_at;
            var compiled = null;
            if (!cached) {
                compiled = new vm.Script(scriptText, { filename: name });
                self.scriptCache[name] = {
                    script : compiled,
                    time : scriptTime
                };
                return compiled;
            } else {
                if (scriptObj._sis._updated_at > cached.time) {
                    compiled = new vm.Script(scriptText, { filename: name });
                    cached.script = compiled;
                    cached.time = scriptTime;
                }
                return cached.script;
            }
        });
    }

    _createContext(holder, req) {
        var ctx = {
            client : new ApiClient(this.schemaManager, this.hieraManager),
            res : new ApiResponse(holder),
            req : req,
            Promise : Promise,
            // keep the csv.stringify shape that user scripts expect
            csv : { stringify : require('csv-stringify') },
            yaml : require('js-yaml'),
            async : async
        };
        return vm.createContext(clone(ctx));
    }

    handleRequest(req) {
        var self = this;
        var endpoint = req.endpoint;
        return this._getScript(endpoint)
        .then(function(script) {
            var defer = P.defer();
            var holder = new ResponseHolder(defer);
            var ctx = self._createContext(holder, req);
            script.runInNewContext(ctx);
            return defer.promise;
        })
        .then(function(holder) {
            return holder.response;
        })
        .catch(function(err) {
            if (Array.isArray(err)) {
                return Promise.reject(err);
            }
            LOGGER.error({ err : err, endpoint : endpoint }, "Script error");
            // the client gets the error and where in the script it happened,
            // but not the stack frames of the server
            var scriptLines = String((err && err.stack) || "").split("\n").filter(function(line) {
                return line.indexOf(endpoint + ":") !== -1;
            }).map(function(line) {
                return line.trim();
            });
            return Promise.reject(SIS.ERR_INTERNAL([String(err)].concat(scriptLines).join("\n")));
        });
    }
}

module.exports = ScriptRunner;
