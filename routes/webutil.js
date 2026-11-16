import passport from "passport";
import { BasicStrategy } from "passport-http";
import _ from "lodash";
import * as ldapts from "ldapts";
import SIS from "../util/constants.js";
import * as P from "../util/promises.js";
import { isJwt } from "../util/session-manager.js";

// authorization using user and pass via the user manager
var _verifyUserPass = function(user, pass, done) {
    var userManager = this.auth[SIS.SCHEMA_USERS];
    P.nodeify(userManager.getVerifiedUser(user, pass), done);
};

// Escape a value so it is safe to embed as an RDN attribute value in a DN
// (RFC 4514). Prevents a crafted username from altering the bind DN.
var escapeDNValue = function(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\+/g, '\\+')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;')
        .replace(/</g, '\\<')
        .replace(/>/g, '\\>')
        .replace(/=/g, '\\=')
        .replace(/^ /, '\\ ')
        .replace(/ $/, '\\ ')
        .replace(/^#/, '\\#');
};

var getLdapVerificationFunc = function(sm, auth_config) {
    if (!auth_config) {
        throw new Error("LDAP authentication requires configuration.");
    }
    var userManager = sm.auth[SIS.SCHEMA_USERS];
    var url = auth_config.url;
    var ud = auth_config.user_domain;
    var ed = auth_config.email_domain;
    // Optional full-DN bind template (e.g. "cn=%u,ou=users,dc=example,dc=org")
    // for directories that bind by DN rather than an AD userPrincipalName. When
    // unset, SIS keeps binding as "<user>@<user_domain>" (Active Directory).
    var bindTemplate = auth_config.bind_dn_template;
    if (!url || !ed) {
        throw new Error("LDAP authentication requires url and email_domain");
    }
    if (!ud && !bindTemplate) {
        throw new Error("LDAP authentication requires either user_domain or bind_dn_template");
    }
    var client_opts = auth_config.client_opts || { };
    client_opts.url = url;
    if (client_opts.tlsOptions && client_opts.tlsOptions.rejectUnauthorized === false) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    // "user" that is in the created by fields - a super user
    var ldapSisUser = {
        name : "_sis_ldap_auth_",
        super_user : true
    };
    // Resolves with the SIS user of an account the directory accepts
    var verify = async function(user, pass) {
        var ldapUser = bindTemplate ?
            bindTemplate.replace(/%u/g, escapeDNValue(user)) :
            (user + '@' + ud);
        var client;
        try {
            client = new ldapts.Client(client_opts);
        } catch (err) {
            throw SIS.ERR_INTERNAL("Unable to create the LDAP client : " + err);
        }
        try {
            await client.bind(ldapUser, pass);
        } catch (err) {
            throw SIS.ERR_BAD_CREDS("LDAP authentication failed : " + err);
        } finally {
            // unbind - don't wait around / ignore unbind errors
            client.unbind().catch(function() { });
        }
        var userObj = {
            name : user,
            email : user + '@' + ed
        };
        return userManager.getOrCreateEmptyUser(userObj, ldapSisUser);
    };
    return function(user, pass, done) {
        P.nodeify(verify(user, pass), done);
    };
};

// authorization using a JWT session token
var _verifySessionToken = async function(sessionManager, userManager, token) {
    if (!sessionManager) {
        throw SIS.ERR_BAD_CREDS("Invalid token.");
    }
    var claims = await sessionManager.verify(token);
    var user = await userManager.getById(claims.sub, {lean : true});
    // a logout or password change bumps session_gen, ending
    // every session issued before it
    if ((user[SIS.FIELD_SESSION_GEN] || 0) !== claims.sgen) {
        throw SIS.ERR_BAD_CREDS("Session has ended.");
    }
    return user;
};

// authorization using sis_tokens (persistent tokens and temporary
// tokens issued before the switch to JWT sessions)
var _verifyStoredToken = async function(tokenFetcher, userManager, token) {
    var t = await tokenFetcher.getTokenByName(token);
    // check if the token has expired
    if (t[SIS.FIELD_EXPIRES] && t[SIS.FIELD_EXPIRES].getTime() - Date.now() <= 0) {
        throw SIS.ERR_BAD_CREDS("Token has expired.");
    }
    return userManager.getById(t[SIS.FIELD_USERNAME], {lean : true});
};

// Resolves with the user of the token
var verifySisToken = async function(sm, sessionManager, token) {
    var userManager = sm.auth[SIS.SCHEMA_USERS];
    try {
        return await (isJwt(token) ?
            _verifySessionToken(sessionManager, userManager, token) :
            _verifyStoredToken(sm.tokenFetcher, userManager, token));
    } catch (err) {
        // an unknown token (or one whose user is gone) is bad credentials,
        // not a missing resource
        if (err instanceof Array && err[0] === 404) {
            throw SIS.ERR_BAD_CREDS("Invalid token.");
        }
        throw err;
    }
};

var _verifySisToken = function(sm, sessionManager, token, done) {
    P.nodeify(verifySisToken(sm, sessionManager, token), done);
};

// Extract the API token from x-auth-token or Authorization: Bearer.
// Returns { token : string } or { error : SIS error }.  Basic credentials
// in Authorization are ignored here (they are only used to mint tokens).
var BEARER_PATTERN = /^Bearer[ ]+([^ ]+)[ ]*$/i;
var extractToken = function(req) {
    var headerToken = req.headers[SIS.HEADER_AUTH_TOKEN];
    var bearerToken = null;
    var authz = req.headers[SIS.HEADER_AUTHORIZATION];
    if (typeof authz === "string" && /^bearer(\s|$)/i.test(authz)) {
        var m = BEARER_PATTERN.exec(authz);
        if (!m) {
            return { error : SIS.ERR_BAD_REQ("Malformed Authorization: Bearer header") };
        }
        bearerToken = m[1];
    }
    if (headerToken && bearerToken && headerToken !== bearerToken) {
        return { error : SIS.ERR_BAD_REQ(SIS.HEADER_AUTH_TOKEN +
            " and Authorization: Bearer contain different tokens") };
    }
    var token = headerToken || bearerToken;
    if (!token) {
        return { error : SIS.ERR_BAD_REQ("Missing " + SIS.HEADER_AUTH_TOKEN +
                                         " or Authorization: Bearer header") };
    }
    return { token : token };
};
export { extractToken };

var getAuthType = function(config) {
    if (!config.auth_config || !config.auth_config.type ||
        SIS.AUTH_TYPES.indexOf(config.auth_config.type) == -1) {
        return SIS.AUTH_TYPE_SIS;
    }
    return config.auth_config.type;
};

// need a schema manager for the strategies
export function createUserPassStrategy(sm, config) {
    var type = getAuthType(config);
    var verifyFunc = _verifyUserPass.bind(sm);
    if (type == SIS.AUTH_TYPE_LDAP) {
        verifyFunc = getLdapVerificationFunc(sm, config.auth_config);
    }
    return new BasicStrategy({}, verifyFunc);
}

// The passport strategy for authenticating x-auth-token / Bearer tokens
class SisTokenStrategy extends passport.Strategy {
    constructor(sm, sessionManager) {
        super();
        this._verify = _verifySisToken.bind(null, sm, sessionManager);
        this.name = SIS.SCHEMA_TOKENS;
    }

    authenticate(req) {
        var extracted = extractToken(req);
        if (extracted.error) { return this.error(extracted.error); }

        var verified = (err, user) => {
            if (err) {
                return this.error(err);
            } else if (!user) {
                return this.error(SIS.ERR_BAD_CREDS("No user for the token exists."));
            }
            this.success(user);
        };

        this._verify(extracted.token, verified);
    }
}

export function createTokenStrategy(sm, sessionManager) {
    return new SisTokenStrategy(sm, sessionManager);
}

// Returns a promise that authenticates a request using the passport
// strategy registered under type.  Sets req.user on success.
export function authenticate(req, res, type) {
    return new Promise(function(resolve, reject) {
        passport.authenticate(type, { session : false }, function(err, user) {
            if (err) {
                if (type === SIS.SCHEMA_TOKENS && err instanceof Array && err[0] === 401) {
                    // RFC 6750 challenge for rejected tokens
                    res.set(SIS.HEADER_WWW_AUTHENTICATE,
                            'Bearer realm="sis", error="invalid_token"');
                }
                reject(err);
            } else if (!user) {
                reject(SIS.ERR_BAD_CREDS("Invalid credentials"));
            } else {
                req.user = user;
                resolve(user);
            }
        })(req, res);
    });
}

// The SIS error to send for an error passed to express's error handler:
// a SIS error as it is, an error of the body parser (such as a body that is
// not JSON or is too large) as a bad request with its 4xx status, and
// anything else as an internal error
export function toSisError(err) {
    if (err instanceof Array && err.length >= 2) {
        return err;
    }
    if (err && err.expose && err.status >= 400 && err.status < 500) {
        if (err.type === "entity.parse.failed") {
            return SIS.ERR_BAD_REQ("Invalid JSON");
        }
        var badReq = SIS.ERR_BAD_REQ(err.message);
        return [err.status, badReq[1]];
    }
    return SIS.ERR_INTERNAL("Unexpected error : " + err);
}

// Express middleware that rejects requests without a valid API token
export async function requireToken(req, res, next) {
    try {
        await authenticate(req, res, SIS.SCHEMA_TOKENS);
    } catch (err) {
        if (!(err instanceof Array) || err.length < 2) {
            err = SIS.ERR_INTERNAL("Authentication failed : " + err);
        }
        res.status(err[0]).send(err[1]);
        return;
    }
    next();
}

var mapIds = function(objs) {
    return objs.map(function(obj) {
        return obj._id.toString();
    });
};

var getFindCond = function(key, condition) {
    var result = {};
    result[key] = condition;
    return result;
};

// Resolves with the ids of the objects schemaRef refers to that match
// condition at remainingPath, the path left over in the query.
// For instance, for a query for ref_field.num, schemaRef is the reference
// at ref_field and remainingPath is num.
var getObjectIds = async function(schemaRef, condition, remainingPath, sm) {
    if (!schemaRef.ref) {
        return [];
    }
    try {
        var sisModel = await sm.getEntityModelAsync(schemaRef.ref);
        if (sisModel.schema.path(remainingPath)) {
            // a path of the referenced objects - query it
            return mapIds(await sisModel.find(getFindCond(remainingPath, condition), '_id').exec());
        }
        // a path of the objects they refer to in turn
        var nested = SIS.UTIL_GET_OID_PATHS(sisModel.schema).find(function(ref) {
            return remainingPath.indexOf(ref.path + ".") === 0;
        });
        if (!nested) {
            // the path is invalid - nothing matches it
            return [];
        }
        var prefix = nested.path + ".";
        if (remainingPath == prefix + "_id") {
            // the referenced ids are on the objects - query them
            return mapIds(await sisModel.find(getFindCond(remainingPath, condition), '_id',
                                              { lean : true }).exec());
        }
        // get the ids of the nested objects and then the objects
        // that refer to them
        var ids = await getObjectIds(nested, condition, remainingPath.substring(prefix.length), sm);
        if (!ids.length) {
            return [];
        }
        var findCond = getFindCond(nested.path, ids.length == 1 ? ids[0] : { "$in" : ids });
        return mapIds(await sisModel.find(findCond, '_id', { lean : true }).exec());
    } catch (err) {
        throw err instanceof Array ? err : SIS.ERR_INTERNAL(err);
    }
};

var addIdsToFlattenedCondition = function(flattened, path, ids) {
    if (!ids || !ids.length ||
        ((flattened[path] instanceof Array) &&
         !flattened[path].length)) {
        flattened[path] = [];
        return;
    }
    if (!(path in flattened)) {
        if (ids.length == 1) {
            flattened[path] = ids[0];
        } else {
            flattened[path] = ids;
        }
    } else {
        var existingIds = flattened[path];
        if (existingIds instanceof Array) {
            flattened[path] = existingIds.filter(function(id) {
                return ids.indexOf(id) != -1;
            });
            if (flattened[path].length == 1) {
                flattened[path] = flattened[path][0];
            }
        } else {
            if (ids.indexOf(existingIds) == -1) {
                flattened[path] = [];
            }
        }
        // TODO: optimize

    }
};

function getValidKeys(condition) {
    var keys = Object.keys(condition);
    if (!keys.length) {
        return null;
    }
    var invalid = keys.some(function(key) {
        return key[key.length - 1] === '.' ||
            ((key === "$or" || key === "$and" || key === "$nor") &&
             !Array.isArray(condition[key]));
    });
    return invalid ? null : keys;
}

var OR_AND_NOR = ["$or","$and","$nor"];

// "flatten" a query of mgr's objects to deal with all joins: a condition on
// a path of referenced objects becomes one on the ids of the objects that
// match it.  Resolves with the flattened query.
export async function flattenCondition(condition, schemaManager, mgr) {
    var references = mgr.getReferences();
    if (!condition || typeof condition !== 'object' ||
        !references || !references.length) {
        return condition;
    }
    var keys = getValidKeys(condition);
    if (!keys) {
        return condition;
    }
    var flattened = { };
    // the reference of each field in the condition on a join path
    var fieldToRef = { };
    var orAndNor = [];
    keys.forEach(function(key) {
        if (OR_AND_NOR.indexOf(key) !== -1) {
            orAndNor.push(key);
            return;
        }
        var ref = references.find(function(r) {
            return key.indexOf(r.path + ".") === 0 && key != r.path + "._id";
        });
        if (ref) {
            fieldToRef[key] = ref;
        } else {
            // shallow copy to flattened since it is a reference to an embedded
            // subdoc
            flattened[key] = condition[key];
        }
    });
    var fieldKeys = Object.keys(fieldToRef);
    if (!fieldKeys.length && !orAndNor.length) {
        return condition;
    }
    var results = await Promise.all([
        // the ids matching each join path
        Promise.all(fieldKeys.map(function(key) {
            var ref = fieldToRef[key];
            return getObjectIds(ref, condition[key], key.substring(ref.path.length + 1), schemaManager);
        })),
        // the flattened conditions of $or, $and and $nor
        Promise.all(orAndNor.map(function(key) {
            return Promise.all(condition[key].map(function(inner) {
                return flattenCondition(inner, schemaManager, mgr);
            }));
        }))
    ]);
    // the ids the objects must refer to, by path
    var refConds = { };
    results[0].forEach(function(ids, i) {
        addIdsToFlattenedCondition(refConds, fieldToRef[fieldKeys[i]].path, ids);
    });
    Object.keys(refConds).forEach(function(path) {
        var ids = refConds[path];
        flattened[path] = ids instanceof Array ? { "$in" : ids } : ids;
    });
    results[1].forEach(function(conditions, i) {
        flattened[orAndNor[i]] = conditions;
    });
    return flattened;
}

export function parsePopulate(reqQuery) {
    reqQuery = reqQuery || { };
    var param = reqQuery.populate;
    if (typeof param === 'string') {
        if (param === 'true') { return true; }
        if (param === 'false') { return false; }
        // array
        return _.uniq(param.split(",").map(_.trim));
    } else {
        return param || false;
    }
}

// The query parseQuery returns when q is not a JSON object.  Frozen: it is
// shared by every such request, so nothing may add a condition to it.
var ERROR_QUERY = Object.freeze({});

export { ERROR_QUERY };

// The error to send for a query parseQuery returned ERROR_QUERY for
export function invalidQueryError() {
    return SIS.ERR_BAD_REQ("Query parameter is invalid.  Must be JSON");
}

export function parseQuery(reqQuery, version, enforceLimit) {
    var query = reqQuery.q || { };
    // try parsing..
    try {
        if (typeof query === 'string') {
            query = JSON.parse(query);
        }
        if (typeof query !== "object" ||
            Array.isArray(query) ||
            !query) {
            query = ERROR_QUERY;
        }
    } catch (ex) {
        query = ERROR_QUERY;
    }
    var fields = reqQuery.fields;
    if (fields) {
        if (typeof fields !== 'string') {
            fields = null;
        } else {
            fields = fields.split(',').join(' ');
        }
    }
    var result = {'query' : query, 'fields' : fields};
    if (enforceLimit) {
        var limit = parseInt(reqQuery.limit, 10) || SIS.MAX_RESULTS;
        if (limit > SIS.MAX_RESULTS) { limit = SIS.MAX_RESULTS; }
        var offset = parseInt(reqQuery.offset, 10) || 0;
        result.limit = limit;
        result.offset = offset;
    } else {
        // optional - but still might be there
        if (reqQuery.limit) {
            result.limit = parseInt(reqQuery.limit, 10);
        }
        if (reqQuery.offset) {
            result.offset = parseInt(reqQuery.offset, 10);
        }
    }

    var sort = reqQuery.sort;
    if (sort) {
        var sortFields = sort.split(',');
        var sortOpt = sortFields.reduce(function(c, field) {
            // default asc
            var opt = 1;
            if (field[0] == '+' || field[0] == '-') {
                opt = field[0] == '+' ? 1 : -1;
                field = field.substr(1);
            }
            c[field] = opt;
            return c;
        }, { });
        result.sort = sortOpt;
    }
    return result;
}
