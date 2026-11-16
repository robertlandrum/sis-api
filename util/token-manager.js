
// A class used to manage users, services and tokens

'use strict';

var SIS = require("./constants");
var Manager = require("./manager");
var crypto = require("crypto");

// Token manager for a particular user
class TokenManager extends Manager {
    constructor(sm, username) {
        var opts = {};
        super(sm.getSisModel(SIS.SCHEMA_TOKENS), opts);
        this.sm = sm;
        this.username = username;
        this.authEnabled = this.sm.authEnabled;
    }

    // override add to use createToken
    async add(obj, options) {
        var user = options ? options.user : null;
        var err = this.validate(obj, false, options);
        if (err) {
            throw SIS.ERR_BAD_REQ(err);
        }
        var token = await this.authorize(SIS.EVENT_INSERT, obj, user);
        return this.createToken(token);
    }

    // raw fetch of a token - used for verifying a SIS token
    getTokenByName(token) {
        return super.getById(token, { lean : true });
    }

    getAll(condition, options, fields) {
        condition = condition || { };
        condition[SIS.FIELD_USERNAME] = this.username;
        return super.getAll(condition, options, fields);
    }

    async getById(id, options) {
        var token = await super.getById(id, options);
        // ensure the token matches the requested username
        if (token[SIS.FIELD_USERNAME] !== this.username) {
            throw SIS.ERR_NOT_FOUND('Token for ' + this.username, id);
        }
        return token;
    }

    validate(obj, toUpdate, options) {
        if (!this.username) {
            return "Token manager assigned to invalid user.";
        }
        if (obj[SIS.FIELD_USERNAME] && obj[SIS.FIELD_USERNAME] !== this.username) {
            return "Token must belong to " + this.username;
        }
        if (!toUpdate && obj[SIS.FIELD_EXPIRES]) {
            // temporary tokens are JWT sessions from POST /users/auth_token
            return "Stored tokens cannot expire.";
        }
        obj[SIS.FIELD_USERNAME] = this.username;
        return null;
    }

    // Save the token under a new random name and resolve with it
    async createToken(token) {
        for (;;) {
            // 128 bits of randomness as hex (replaces the former 'hat' dependency)
            token.name = crypto.randomBytes(16).toString('hex');
            try {
                return await new this.model(token).save();
            } catch (err) {
                if (!(err && err.code == 11000)) {
                    throw SIS.ERR_INTERNAL(err);
                }
                // duplicate token name - retry with a fresh one
            }
        }
    }

    // check if request user can read the tokens of user
    canAdministerTokensOf(reqUser, user) {
        // super users and the user himself can read tokens
        // of the user
        if (reqUser[SIS.FIELD_SUPERUSER] ||
            reqUser[SIS.FIELD_NAME] == user[SIS.FIELD_NAME]) {
            return true;
        }
        if (user[SIS.FIELD_SUPERUSER] && !reqUser[SIS.FIELD_SUPERUSER]) {
            return false;
        }
        // admins of all roles can
        return SIS.UTIL_ENSURE_ROLE_SUBSET(reqUser[SIS.FIELD_ROLES], user[SIS.FIELD_ROLES], true);
    }

    // only the user, super user
    async authorize(evt, doc, user, mergedDoc) {
        if (!doc[SIS.FIELD_USERNAME]) {
            throw SIS.ERR_BAD_REQ("Missing username in token.");
        }
        if (mergedDoc && mergedDoc[SIS.FIELD_USERNAME] != doc[SIS.FIELD_USERNAME]) {
            throw SIS.ERR_BAD_REQ("Cannot change the username of the token.");
        }
        if (mergedDoc && mergedDoc[SIS.FIELD_EXPIRES]) {
            // a stored temporary token issued before the switch to JWT sessions
            throw SIS.ERR_BAD_REQ("Cannot change a temporary token.");
        }
        if (!this.authEnabled) {
            return mergedDoc || doc;
        }
        if (!user) {
            throw SIS.ERR_BAD_CREDS("User is null.");
        }
        if (!user[SIS.FIELD_ROLES] && !user[SIS.FIELD_SUPERUSER]) {
            throw SIS.ERR_BAD_CREDS("Invalid user.");
        }
        var tokenUser = await this.sm.auth[SIS.SCHEMA_USERS].getById(doc[SIS.FIELD_USERNAME]);
        if (tokenUser[SIS.FIELD_SUPERUSER] && evt === SIS.EVENT_INSERT) {
            // super users cannot have a persistent token.  too much power
            throw SIS.ERR_BAD_REQ("Super users cannot have persistent tokens.");
        }
        if (!this.canAdministerTokensOf(user, tokenUser)) {
            throw SIS.ERR_BAD_CREDS("Only admins of the user or the user can manage the token.");
        }
        return mergedDoc || doc;
    }

    canInsertWithId(id, obj) {
        // always return false to disable upsert
        return false;
    }
}

/////////////////////////////////

module.exports = function(sm, username) {
    return new TokenManager(sm, username);
};
