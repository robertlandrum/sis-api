import nconf from "nconf";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import supertest from "supertest";
import * as P from "../../util/promises.js";
import SIS from "../../util/constants.js";
import * as server from "../../server.js";

function loadConfig() {
    nconf.env('__').argv();
    nconf.file("config.test.json", import.meta.dirname + "/config.test.json");
    // git does not keep file modes; keep the test signing key private so the
    // server does not warn about it
    fs.chmodSync(path.join(import.meta.dirname, "keys", "jwt-default.key"), parseInt("600", 8));
}

function TestServer() {
    var serverData = null;

    this.setupRemote = function(url, username, password) {
        serverData = {
            request : supertest(url),
            username : username,
            password : password
        };
        return serverData;
    };

    // Start the local server (once) or connect to SIS_REMOTE_URL.  Resolves
    // with the server data - and calls callback(err, data) if one is given.
    this.start = function(callback) {
        return P.nodeify(start.call(this), callback);
    };

    var start = async function() {
        if (process.env.SIS_REMOTE_URL) {
            if (!process.env.SIS_REMOTE_USERNAME ||
                !process.env.SIS_REMOTE_PASSWORD) {
                throw "super credentials not set.";
            }
            return this.setupRemote(process.env.SIS_REMOTE_URL,
                                    process.env.SIS_REMOTE_USERNAME,
                                    process.env.SIS_REMOTE_PASSWORD);
        }
        if (serverData) {
            return serverData;
        }
        loadConfig();
        var started = await new Promise(function(resolve) {
            server.startServer(function(app, http) {
                resolve({ app : app, http : http });
            });
        });
        var schemaManager = started.app.get('schema_manager');
        var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
        // add a sistest_super user
        var localSuper = {
            name : 'sistest_local',
            super_user : true
        };
        var sisSuper = {
            name : 'sistest_super',
            pw : 'sistest',
            super_user : true,
            email : 'sistest@sis.test'
        };
        try {
            await userManager.getById(sisSuper.name);
        } catch (dne) {
            await userManager.add(sisSuper, { user : localSuper });
        }
        serverData = {
            server : server,
            mongoose : server.mongoose,
            http : started.http,
            app : started.app,
            request : supertest('http://127.0.0.1:' + nconf.get("server:port")),
            local : true,
            schemaManager : schemaManager,
            superUser : localSuper,
            username : 'sistest_super',
            password : 'sistest'
        };
        return serverData;
    };

    this.getSuperCreds = function() {
        if (!serverData) {
            return null;
        }
        return {
            username : serverData.username,
            password : serverData.password
        };
    };

    this.authToken = null;

    // Use a session of the super user for the requests from now on
    this.becomeSuperUser = function(callback) {
        return P.nodeify(becomeSuperUser.call(this), callback);
    };

    var becomeSuperUser = async function() {
        var creds = this.getSuperCreds();
        if (!creds) {
            throw "not initialized.";
        }
        var t = await this.getTempToken(creds.username, creds.password);
        this.authToken = t.name;
    };

    this.newRequest = function(method, url, token) {
        if (!serverData) {
            return null;
        }
        var result = serverData.request[method](url);
        if (method == 'post' || method == 'put') {
            result.set("Content-Type", "application/json");
        }
        if (token) {
            result.set("x-auth-token", token);
        } else if (this.authToken) {
            result.set("x-auth-token", this.authToken);
        }
        result.set('Accept', 'application/json');
        // supertest requests are thenable: await them
        return result;
    };

    // Stop the local server and close its database connection
    this.stop = function(callback) {
        return P.nodeify(stop(), callback);
    };

    var stop = async function() {
        if (!serverData) {
            throw "NOTHING TO STOP";
        }
        if (!serverData.local) {
            return;
        }
        var data = serverData;
        serverData = null;
        await new Promise(function(resolve, reject) {
            data.server.stopServer(data.http, function(err) {
                // stopping is done once the connection is closed - an error
                // closing the http server is not the test's problem
                resolve();
            });
        });
        // mongoose 8 connection.close() returns a promise (no callback)
        await data.mongoose.connection.close();
    };

    ['get', 'post', 'put', 'del'].forEach(function(method) {
        this[method] = function(url, token) {
            var result = this.newRequest(method, url, token);
            if (method == 'del') {
                result.set('Content-Length', 0);
            }
            return result;
        };
    }.bind(this));

    // Resolves with a session token of the user
    this.getTempToken = function(username, password, callback) {
        return P.nodeify(getTempToken.call(this, username, password), callback);
    };

    var getTempToken = async function(username, password) {
        if (!serverData) {
            throw "server not started.";
        }
        var req = this.post("/api/v1.1/users/auth_token")
                                    .auth(username, password)
                                    .send("auth");
        req.set('Content-Type', null);
        var res = await req.expect(201);
        return res.body;
    };
}

export { TestServer };

function LocalTest() {
    var dbData = null;

    // Connect to the test database.  Resolves with mongoose - and calls
    // callback(err, mongoose) if one is given.
    this.start = function(callback) {
        return P.nodeify(start(), callback);
    };

    var start = async function() {
        if (dbData) {
            return dbData.mongoose;
        }
        loadConfig();
        await mongoose.connect(nconf.get('db').url);
        dbData = {
            mongoose : mongoose
        };
        return mongoose;
    };

    // Drop the test database and close the connection
    this.stop = function(callback) {
        return P.nodeify(stop(), callback);
    };

    var stop = async function() {
        if (!dbData) {
            return;
        }
        var mongoose = dbData.mongoose;
        dbData = null;
        // mongoose 8 / modern driver use promises (no callbacks)
        await mongoose.connection.dropDatabase();
        await mongoose.connection.close();
    };

    this.superUser = { name : 'sistest', super_user : true };
}

export { LocalTest };

// utilities
// Await a promise that must reject with a SIS error tuple of the given
// status, optionally with a message matching pattern.  Resolves with the error.
export async function expectError(promise, status, pattern) {
    var err = null;
    try {
        await promise;
    } catch (e) {
        err = e;
    }
    if (!err) {
        throw new Error("expected a rejection with status " + status);
    }
    if (!(err instanceof Array)) {
        throw new Error("expected a SIS error tuple, got " + (err && err.stack || err));
    }
    if (err[0] !== status) {
        throw new Error("expected status " + status + ", got " + JSON.stringify(err.slice(0, 2)));
    }
    if (pattern && !pattern.test(err[1].error)) {
        throw new Error("expected an error matching " + pattern + ", got " + JSON.stringify(err[1]));
    }
    return err;
}

// return full - subset.  both are arrays
export function invert(full, subset) {
    return full.filter(function(item) {
        return subset.indexOf(item) == -1;
    });
}

// values
export function objectValues(obj) {
    var keys = Object.keys(obj);
    return keys.map(function(k) {
        return obj[k];
    });
}
