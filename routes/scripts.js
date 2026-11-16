'use strict';

var ApiController = require("./apicontroller");
var SIS = require("../util/constants");
var nconf = require("nconf");

// Scripts controller
class ScriptController extends ApiController {
    constructor(config) {
        var opts = { };
        opts[SIS.OPT_LOG_COMMTS] = true;
        opts[SIS.OPT_TYPE] = SIS.SCHEMA_SCRIPTS;
        opts[SIS.OPT_USE_AUTH] = config[SIS.OPT_USE_AUTH];
        SIS.UTIL_MERGE_SHALLOW(opts, config);
        super(opts);
        this.manager = require("../util/script-manager")(this.sm, opts);
    }
}

// all route controllers expose a setup method
module.exports.setup = function(app, config) {
    if (!nconf.get('app:scripts_enabled')) {
        return;
    }
    var controller = new ScriptController(config);
    controller.attach(app, "/scripts");
};
