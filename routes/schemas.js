'use strict';

var ApiController = require("./apicontroller");
var SIS = require("../util/constants");

// Schema controller
class SchemaController extends ApiController {
    constructor(config) {
        var opts = { };
        opts[SIS.OPT_LOG_COMMTS] = true;
        opts[SIS.OPT_FIRE_HOOKS] = true;
        opts[SIS.OPT_TYPE] = SIS.SCHEMA_SCHEMAS;
        opts[SIS.OPT_USE_AUTH] = config[SIS.OPT_USE_AUTH];
        SIS.UTIL_MERGE_SHALLOW(opts, config);
        super(opts);
        this.manager = this.sm;
    }
}

// all route controllers expose a setup method
module.exports.setup = function(app, config) {
    var controller = new SchemaController(config);
    controller.attach(app, "/schemas");
};
