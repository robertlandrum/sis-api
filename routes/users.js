import ApiController from "./apicontroller.js";
import SIS from "../util/constants.js";

// User controller
class UserController extends ApiController {
    constructor(config) {
        var opts = { };
        // TODO - secure this when enabling.
        //opts[SIS.OPT_LOG_COMMTS] = true;
        opts[SIS.OPT_TYPE] = SIS.SCHEMA_USERS;
        SIS.UTIL_MERGE_SHALLOW(opts, config);
        super(opts);
        this.manager = this.sm.auth[SIS.SCHEMA_USERS];
        this.sessionManager = config[SIS.OPT_SESSION_MGR];
    }

    // extend attach to also attach the session token routes
    attach(app, prefix) {
        var apiPrefix = "/api/:version" + prefix;
        this.auth_token_path = apiPrefix + "/auth_token";
        if (!app.get(SIS.OPT_READONLY)) {
            // logout: ends every session of the authenticated user.  Registered
            // before the base routes so DELETE /users/:id does not capture it.
            app.delete(this.auth_token_path, this._handler(async function(req, res) {
                var user = await this.authenticate(req, res, SIS.SCHEMA_TOKENS);
                await this.manager.endSessions(user[SIS.FIELD_NAME]);
                res.status(204).end();
            }, false));
        }
        super.attach(app, prefix);
        // login: exchange Basic credentials for a JWT session token
        app.post(this.auth_token_path, this._handler(async function(req, res) {
            // cors support
            res.set('Access-Control-Allow-Credentials', true);
            req.isAuthTokenReq = true;
            await this._finish(req, res, 201, async () => {
                var user = await this.authenticate(req, res, 'basic');
                if (!this.sessionManager) {
                    throw SIS.ERR_INTERNAL("Session tokens are not configured.");
                }
                return this.sessionManager.issue(user);
            });
        }, false));
    }

    // No password hashes or server managed fields should be returned.
    convertToResponseObject(req, o) {
        var res = o;
        if (typeof res.toObject == 'function') {
            res = o.toObject();
        }
        if (req.isAuthTokenReq) {
            // token
            var expireDate = o[SIS.FIELD_EXPIRES];
            var timeLeft = expireDate.getTime() - Date.now();
            if (timeLeft <= 0) {
                timeLeft = 0;
            }
            res[SIS.FIELD_EXPIRES] = timeLeft;
        } else {
            delete res.pw;
            delete res[SIS.FIELD_SESSION_GEN];
        }
        return res;
    }
}

// all route controllers expose a setup method
export function setup(app, config) {
    if (!config[SIS.OPT_USE_AUTH]) {
        return;
    }
    var controller = new UserController(config);
    controller.attach(app, "/users");
}
