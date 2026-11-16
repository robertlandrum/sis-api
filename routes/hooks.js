import ApiController from "./apicontroller.js";
import SIS from "../util/constants.js";
import createHookManager from "../util/hook-manager.js";

// Hook controller
class HookController extends ApiController {
    constructor(config) {
        var opts = { };
        opts[SIS.OPT_LOG_COMMTS] = true;
        opts[SIS.OPT_TYPE] = SIS.SCHEMA_HOOKS;
        opts[SIS.OPT_USE_AUTH] = config[SIS.OPT_USE_AUTH];
        SIS.UTIL_MERGE_SHALLOW(opts, config);
        super(opts);
        this.manager = createHookManager(this.sm, opts);
    }

    attach(app, prefix) {
        super.attach(app, prefix);
        var triggerPath = this.apiPrefix + "/trigger/:schema/:id";
        app.post(triggerPath, this._wrapAuth(async function(req, res) {
            var options = this._getReqOptions(req);
            await this._finish(req, res, 200, () => {
                return this.manager.triggerHooks(req.params.schema, req.params.id, options);
            });
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
export function setup(app, config) {
    var controller = new HookController(config);
    controller.attach(app, "/hooks");
}
