// A class used to manage users, services and tokens

'use strict';

var SIS = require("./constants");
var Manager = require("./manager");
var crypto = require('crypto');
var jsondiff = require("jsondiffpatch");

// Users
class UserManager extends Manager {
    constructor(sm) {
        super(sm.getSisModel(SIS.SCHEMA_USERS), {});
        this.sm = sm;
        this.authEnabled = this.sm.authEnabled;
    }

    // End all of the user's sessions (logout everywhere)
    async endSessions(username) {
        var inc = { };
        inc[SIS.FIELD_SESSION_GEN] = 1;
        var result = await this.model.updateOne({ name : username }, { $inc : inc }).exec();
        if (!result.matchedCount) {
            throw SIS.ERR_NOT_FOUND(SIS.SCHEMA_USERS, username);
        }
        return username;
    }

    hashPw(pw) {
        if (!pw) { return null; }
        var h = crypto.createHash('sha256');
        h.update(pw, 'utf8');
        return h.digest('hex');
    }

    // need to hash the pw
    add(obj, options) {
        obj = JSON.parse(JSON.stringify(obj));
        // server managed
        delete obj[SIS.FIELD_SESSION_GEN];
        if (obj[SIS.FIELD_PW]) {
            obj[SIS.FIELD_PW] = this.hashPw(obj[SIS.FIELD_PW]);
        }
        return super.add(obj, options);
    }

    applyUpdate(obj, updateObj) {
        updateObj = JSON.parse(JSON.stringify(updateObj));
        // server managed
        delete updateObj[SIS.FIELD_SESSION_GEN];
        if (updateObj[SIS.FIELD_PW]) {
            updateObj[SIS.FIELD_PW] = this.hashPw(updateObj[SIS.FIELD_PW]);
            if (updateObj[SIS.FIELD_PW] !== obj[SIS.FIELD_PW]) {
                // a password change ends all existing sessions
                updateObj[SIS.FIELD_SESSION_GEN] = (obj[SIS.FIELD_SESSION_GEN] || 0) + 1;
            }
        }
        return super.applyUpdate(obj, updateObj);
    }

    // Resolves with the user if the password is right
    async getVerifiedUser(username, pw) {
        var u = await this.getById(username, { lean : true });
        if (u[SIS.FIELD_PW] != this.hashPw(pw)) {
            throw SIS.ERR_BAD_CREDS("Invalid password.");
        }
        return u;
    }

    // Resolves with the user named userObj.name, adding it without roles if it
    // does not exist yet (users authenticated by LDAP)
    async getOrCreateEmptyUser(userObj, superUser) {
        if (!userObj || !userObj.name || !userObj.email) {
            throw SIS.ERR_INTERNAL("Invalid user specified in getOrCreate");
        }
        var user;
        try {
            user = await this.model.findOne({ name : userObj.name }).exec();
        } catch (e) {
            throw SIS.ERR_INTERNAL(e);
        }
        if (user) {
            return user;
        }
        // add errors are already SIS errors
        return this.add({
            name : userObj.name,
            email : userObj.email,
            roles : { },
            super_user : false
        }, { user : superUser });
    }

    async authorize(evt, doc, user, mergedDoc) {
        if (!this.authEnabled) {
            return mergedDoc || doc;
        }
        if (!user) {
            throw SIS.ERR_BAD_CREDS("User is null.");
        }
        // super users do it all
        if (user[SIS.FIELD_SUPERUSER]) {
            return mergedDoc || doc;
        }
        if (!user[SIS.FIELD_ROLES]) {
            throw SIS.ERR_BAD_CREDS("User has no roles.");
        }
        // doc is a user object
        switch (evt) {
            case SIS.EVENT_INSERT:
            case SIS.EVENT_DELETE:
                if (doc[SIS.FIELD_SUPERUSER] && !user[SIS.FIELD_SUPERUSER]) {
                    throw SIS.ERR_BAD_CREDS("Only superusers can " + evt + " superusers.");
                }
                if (!SIS.UTIL_ENSURE_ROLE_SUBSET(user[SIS.FIELD_ROLES], doc[SIS.FIELD_ROLES], true)) {
                    throw SIS.ERR_BAD_CREDS("Cannot " + evt + " user unless admin of all roles.");
                }
                if (doc[SIS.FIELD_NAME] == user[SIS.FIELD_NAME]) {
                    throw SIS.ERR_BAD_CREDS("Cannot " + evt + " a user with the same name.");
                }
                return doc;
            default: // update
                // if changing roles, then an admin of the roles being added/removed
                // are allowed..
                if (doc[SIS.FIELD_SUPERUSER] && !user[SIS.FIELD_SUPERUSER] ||
                    mergedDoc[SIS.FIELD_SUPERUSER] && !user[SIS.FIELD_SUPERUSER]) {
                    throw SIS.ERR_BAD_CREDS("Only superusers can update superusers.");
                }
                if (!SIS.UTIL_ROLES_EQUAL(doc, mergedDoc)) {
                    // changing roles
                    if (doc[SIS.FIELD_NAME] == user[SIS.FIELD_NAME]) {
                        throw SIS.ERR_BAD_CREDS("User's cannot change their own roles.");
                    }
                    // need to get the diffs..
                    var k;
                    var userRoles = user[SIS.FIELD_ROLES];
                    var docRoles = doc[SIS.FIELD_ROLES] || { };
                    var roleDiff = jsondiff.diff(docRoles, mergedDoc[SIS.FIELD_ROLES]);
                    for (k in roleDiff) {
                        // need to make sure the user is an admin of the role being added/deleted/updated
                        if (!(k in userRoles) || userRoles[k] != SIS.ROLE_ADMIN) {
                            throw SIS.ERR_BAD_CREDS(user[SIS.FIELD_NAME] + " is not an admin of role " + k);
                        }
                    }
                    // non role fields can't be changed here.
                    var docDiff = jsondiff.diff(doc, mergedDoc.toObject());
                    delete docDiff[SIS.FIELD_ROLES];
                    for (k in docDiff) {
                        // can't change this field.
                        throw SIS.ERR_BAD_CREDS("Only the user or a super user can change non role fields. (" + k + ")");
                    }
                } else {
                    // not changing roles.. only fields
                    if (doc[SIS.FIELD_NAME] != user[SIS.FIELD_NAME]) {
                        throw SIS.ERR_BAD_CREDS("Only the user or a super user can change non role fields.");
                    }
                    if (SIS.FIELD_VERIFIED in doc && doc[SIS.FIELD_VERIFIED] != mergedDoc[SIS.FIELD_VERIFIED]) {
                        throw SIS.ERR_BAD_REQ("Cannot change verified state of self.");
                    }
                }
                return mergedDoc;
        } // end switch
    }

    // remove the user's tokens
    async objectRemoved(user) {
        var tokenManager = this.sm.getTokenManagerForUser(user[SIS.FIELD_NAME]);
        try {
            await tokenManager.model.deleteMany({ username : user[SIS.FIELD_NAME] }).exec();
        } catch (err) {
            throw SIS.ERR_INTERNAL("Unable to clear tokens for user.");
        }
        return user;
    }

    validate(obj, toUpdate) {
        if (!obj || !obj[SIS.FIELD_NAME]) {
            return "User must have a name.";
        }
        return SIS.UTIL_VALIDATE_ROLES(obj, true);
    }
}

module.exports = function(sm) {
    return new UserManager(sm);
};
