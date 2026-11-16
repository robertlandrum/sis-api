'use strict';

var ApiController = require("./apicontroller");
var SIS = require("../util/constants");

// Hook controller
class HookController extends ApiController {
    constructor(config) {
        var opts = { };
        opts[SIS.OPT_LOG_COMMTS] = true;
        opts[SIS.OPT_TYPE] = SIS.SCHEMA_HOOKS;
        opts[SIS.OPT_USE_AUTH] = config[SIS.OPT_USE_AUTH];
        SIS.UTIL_MERGE_SHALLOW(opts, config);
        super(opts);
        this.manager = require("../util/hook-manager")(this.sm, opts);
    }

    attach(app, prefix) {
        super.attach(app, prefix);
        var triggerPath = this.apiPrefix + "/trigger/:schema/:id";
        app.post(triggerPath, this._wrapAuth(function(req, res) {
            var options = this._getReqOptions(req);
            var id = req.params.id;
            var schema = req.params.schema;
            var p = this.manager.triggerHooks(schema, id, options);
            return this._finish(req, res, p, 200);
        }));
    }

    shouldSaveCommit(req) {
        if (req.method === "POST" &&
            req.path.indexOf("/hooks/trigger/") !== -1) {
            return false;
        }
        return super.shouldSaveCommit(req);
    }
}

// all route controllers expose a setup method
module.exports.setup = function(app, config) {
    var controller = new HookController(config);
    controller.attach(app, "/hooks");
};
