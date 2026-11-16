import vm from "vm";
import clone from "clone";
import csvStringify from "csv-stringify";
import yaml from "js-yaml";
import * as P from "../util/promises.js";
import SIS from "../util/constants.js";
import createScriptManager from "../util/script-manager.js";
import createHieraManager from "../util/hiera-manager.js";
import ApiClient from "./api-client.js";
import ApiResponse from "./api-response.js";
import * as logger from "../util/logger.js";

var LOGGER = logger.createLogger({
    name : "ScriptRunner"
});


// context apis

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

export default ScriptRunner;
