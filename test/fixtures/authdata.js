"use strict";

var P = require('../../util/promises');
var TestUtil = require('./util');

var genUser = function(name, defaults) {
    defaults.name = name;
    defaults.email = name + '@test.com';
    defaults.pw = name;
    return defaults;
};

var createUsers = function() {
    return {
        // superman
        "superman" : genUser("superman", { super_user : true }),
        "superman2" : genUser("superman2", { super_user : true }),
        // admin for test_g1
        "admin1" : genUser("admin1", {
            roles : {
                "test_g1" : "admin"
            }
        }),
        "admin1_1" : genUser("admin1_1", {
            roles : {
                "test_g1" : "admin"
            }
        }),
        // admin for test_g2
        "admin2" : genUser("admin2", {
            roles : {
                "test_g2" : "admin"
            }
        }),
        // admin for one group, user for other
        "admin3" : genUser("admin3", {
           roles : {
                "test_g1" : "admin",
                "test_g2" : "user"
            }
        }),
        "admin4" : genUser("admin4", {
            roles : {
                "test_g1" : "admin",
                "test_g2" : "admin"
            }
        }),
        "admin5" : genUser("admin5", {
            roles : {
                "test_g1" : "admin",
                "test_g2" : "admin",
                "test_g3" : "admin"
            }
        }),

        // user of test_g1
        "user1" : genUser("user1", {
            roles : {
                "test_g1" : "user"
            }
        }),
        "user2" : genUser("user2", {
            roles : {
                "test_g2" : "user"
            }
        }),
        "user3" : genUser("user3", {
            roles : {
                "test_g1" : "user",
                "test_g2" : "user"
            }
        }),
        "user4" : genUser("user4", {
            roles : {
                "test_g1" : "user",
                "test_g2" : "user",
                "test_g3" : "user"
            }
        }),
        "user_g3" : genUser("user_g3", {
            roles : {
                "test_g3" : "user"
            }
        })
    };
};

module.exports.createUsers = createUsers;
// recreate users.  The helpers here resolve when done - and call callback
// if one is given.
module.exports.initUsers = function(ApiServer, token, users, callback) {
    return P.nodeify(Promise.all(Object.keys(users).map(async function(name) {
        // delete user
        var res = await ApiServer.del('/api/v1.1/users/' + name, token);
        if (res.status != 404 && res.status != 200) {
            throw "unexpected del status : " + res.status;
        }
        await ApiServer.post('/api/v1.1/users', token)
            .send(users[name])
            .expect(201);
    })), callback);
};

// sets userToTokens[name] to a session token of each user
module.exports.createTempTokens = function(ApiServer, userToTokens, users, callback) {
    return P.nodeify(Promise.all(Object.keys(users).map(async function(name) {
        var user = users[name];
        userToTokens[name] = await ApiServer.getTempToken(user.name, user.pw);
    })), callback);
};

module.exports.getAuthSchemas = function() {
    return {
        test_s1 : {
            name : 'test_s1',
            _sis : { owner : ['test_g1', 'test_g2', 'test_g3'] },
            definition : {
                str : "String",
                num : "Number"
            },
            track_history : false
        },
        test_s2 : {
            name : 'test_s2',
            _sis : { owner : ['test_g1', 'test_g2'] },
            definition : {
                str : "String",
                num : "Number"
            },
            track_history : false
        },
        test_s3 : {
            name : 'test_s3',
            _sis : { owner : ['test_g2'] },
            definition : {
                str : "String",
                num : "Number"
            }
        },
        test_s4 : {
            name : "test_s4",
            _sis : { owner : ['test_g2'] },
            is_open : true,
            definition : {
                str : "String",
                num : "Number"
            }
        }
    };
};

module.exports.deleteSchemas = function(ApiServer, schemas, ensureExists, callback) {
    if (!(schemas instanceof Array)) {
        schemas = TestUtil.objectValues(schemas);
    }
    return P.nodeify(Promise.all(schemas.map(function(schema) {
        var req = ApiServer.del("/api/v1.1/schemas/" + schema.name);
        return ensureExists ? req.expect(200) : req;
    })), callback);
};

module.exports.addSchemas = function(ApiServer, schemas, callback) {
    if (!(schemas instanceof Array)) {
        schemas = TestUtil.objectValues(schemas);
    }
    return P.nodeify(Promise.all(schemas.map(function(schema) {
        return ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
    })), callback);
};

module.exports.createAuthEntities = function() {
    return {
        test_s1_e1 : {
            schema : "test_s1",
            entity : {
                str : "e1",
                num : 1,
            }
        },
        test_s1_e2 : {
            schema : "test_s1",
            entity : {
                str : "e2",
                num : 2,
                _sis : { owner : ["test_g1", "test_g2"] }
            }
        },
        test_s2_e3 : {
            schema : "test_s2",
            entity : {
                str : "e3",
                num : 3,
                _sis : { owner : ["test_g3", "test_g4"] }
            }
        },
        test_s3_e4 : {
            schema : "test_s3",
            entity : {
                str : "e4",
                num : 4
            }
        },
        test_s4_e5 : {
            schema : "test_s4",
            entity : {
                str : "e5",
                num : 5
            }
        }
    };
};
