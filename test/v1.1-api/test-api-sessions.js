describe('@API @V1.1API - JWT sessions', function() {
    "use strict";

    var should = require('should');
    var fs = require('fs');
    var path = require('path');
    var crypto = require('crypto');

    var SIS = require("../../util/constants");
    var TestUtil = require('../fixtures/util');
    var ApiServer = new TestUtil.TestServer();

    var serverData = null;
    var superToken = null;

    // users created for this suite
    var users = {
        jwt_alice : { name : "jwt_alice", pw : "alice-pw", email : "alice@jwt.test",
                      roles : { jwt_g1 : "user" } },
        jwt_bob : { name : "jwt_bob", pw : "bob-pw", email : "bob@jwt.test",
                    roles : { jwt_g1 : "user" } },
        // users without any role cannot update themselves, so carol has one
        jwt_carol : { name : "jwt_carol", pw : "carol-pw", email : "carol@jwt.test",
                      roles : { jwt_g2 : "user" } }
    };

    function login(name, pw) {
        return ApiServer.getTempToken(name, pw || users[name].pw);
    }

    // a request with no x-auth-token set by the helper
    function rawRequest(method, url) {
        return ApiServer.newRequest(method, url);
    }

    // a simple authenticated write: create a persistent token for self
    function writeAs(name, setAuth) {
        var req = rawRequest('post', "/api/v1.1/users/" + name + "/tokens");
        setAuth(req);
        return req.send({ desc : "jwt test" });
    }

    function withHeader(token) {
        return function(req) { req.set("x-auth-token", token); };
    }

    function withBearer(token, scheme) {
        return function(req) { req.set("Authorization", (scheme || "Bearer") + " " + token); };
    }

    function deleteUser(name) {
        return ApiServer.del("/api/v1.1/users/" + name, superToken);
    }

    async function createUser(user) {
        await deleteUser(user.name);
        await ApiServer.post("/api/v1.1/users", superToken).send(user).expect(201);
    }

    function countStoredTokens(name) {
        var model = serverData.schemaManager.tokenFetcher.model;
        return model.countDocuments({ username : name }).exec();
    }

    before(async function() {
        serverData = await ApiServer.start();
        var creds = ApiServer.getSuperCreds();
        superToken = (await login(creds.username, creds.password)).name;
        await Promise.all(Object.keys(users).map(function(name) {
            return createUser(users[name]);
        }));
    });

    after(async function() {
        await Promise.all(Object.keys(users).map(deleteUser));
        await ApiServer.stop();
    });

    describe("login", function() {
        it("returns a JWT session token with an 8 hour expiry", async function() {
            var t = await login("jwt_alice");
            t.name.split(".").length.should.eql(3);
            t.username.should.eql("jwt_alice");
            t.expires.should.be.a.Number();
            t.expires.should.be.above(SIS.AUTH_EXPIRATION_TIME - 60000);
            t.expires.should.not.be.above(SIS.AUTH_EXPIRATION_TIME);
        });

        it("does not store the session token", async function() {
            if (!serverData.local) { return this.skip(); }
            var before = await countStoredTokens("jwt_alice");
            await login("jwt_alice");
            (await countStoredTokens("jwt_alice")).should.eql(before);
        });

        it("rejects bad credentials", async function() {
            await rawRequest('post', "/api/v1.1/users/auth_token")
                .auth("jwt_alice", "wrong")
                .set('Content-Type', null)
                .send("auth")
                .expect(401);
        });
    });

    describe("token headers", function() {
        var session = null;
        before(async function() {
            session = (await login("jwt_alice")).name;
        });

        it("accepts x-auth-token", async function() {
            await writeAs("jwt_alice", withHeader(session)).expect(201);
        });

        it("accepts Authorization: Bearer", async function() {
            await writeAs("jwt_alice", withBearer(session)).expect(201);
        });

        it("accepts a lowercase bearer scheme", async function() {
            await writeAs("jwt_alice", withBearer(session, "bearer")).expect(201);
        });

        it("accepts the same token in both headers", async function() {
            await writeAs("jwt_alice", function(req) {
                withHeader(session)(req);
                withBearer(session)(req);
            }).expect(201);
        });

        it("rejects different tokens in the two headers", async function() {
            var other = await login("jwt_alice");
            var res = await writeAs("jwt_alice", function(req) {
                withHeader(session)(req);
                withBearer(other.name + "x")(req);
            }).expect(400);
            res.body.error.should.match(/different tokens/);
        });

        it("rejects a malformed Bearer header", async function() {
            await writeAs("jwt_alice", function(req) {
                req.set("Authorization", "Bearer");
            }).expect(400);
        });

        it("ignores Basic credentials on API routes", async function() {
            var res = await writeAs("jwt_alice", function(req) {
                req.auth("jwt_alice", users.jwt_alice.pw);
            }).expect(400);
            res.body.error.should.match(/x-auth-token or Authorization: Bearer/);
        });

        it("sends a Bearer challenge for an invalid token", async function() {
            var bad = session.slice(0, -4) + "AAAA";
            var res = await writeAs("jwt_alice", withBearer(bad)).expect(401);
            res.headers['www-authenticate'].should.eql('Bearer realm="sis", error="invalid_token"');
            res.body.error.should.match(/Invalid token/);
            res.headers['access-control-expose-headers'].should.match(/WWW-Authenticate/);
        });

        it("rejects an expired JWT", async function() {
            if (!serverData.local) { return this.skip(); }
            var keyFile = path.join(__dirname, "..", "fixtures", "keys", "jwt-default.key");
            var key = crypto.createPrivateKey(fs.readFileSync(keyFile));
            var now = Math.floor(Date.now() / 1000);
            var jose = await import("jose");
            var jwt = await new jose.SignJWT({ sgen : 0 })
                .setProtectedHeader({ alg : "EdDSA", kid : "default", typ : "JWT" })
                .setIssuer("sis").setAudience(SIS.JWT_AUDIENCE).setSubject("jwt_alice")
                .setIssuedAt(now - 7200).setExpirationTime(now - 3600)
                .sign(key);
            var res = await writeAs("jwt_alice", withHeader(jwt)).expect(401);
            res.body.error.should.match(/Token has expired/);
        });
    });

    describe("persistent tokens", function() {
        var persistent = null;
        before(async function() {
            var t = await login("jwt_bob");
            persistent = (await writeAs("jwt_bob", withHeader(t.name)).expect(201)).body.name;
            persistent.should.match(/^[0-9a-f]{32}$/);
        });

        it("still work via x-auth-token", async function() {
            await writeAs("jwt_bob", withHeader(persistent)).expect(201);
        });

        it("work via Authorization: Bearer", async function() {
            await writeAs("jwt_bob", withBearer(persistent)).expect(201);
        });

        it("are not listed with sessions", async function() {
            var res = await ApiServer.get("/api/v1.1/users/jwt_bob/tokens", persistent).expect(200);
            res.body.forEach(function(t) {
                should.not.exist(t.expires);
                t.name.should.match(/^[0-9a-f]{32}$/);
            });
        });

        it("still accept a stored temporary token issued before JWT sessions", async function() {
            if (!serverData.local) { return this.skip(); }
            var Model = serverData.schemaManager.tokenFetcher.model;
            var legacy = crypto.randomBytes(16).toString('hex');
            await new Model({
                name : legacy, username : "jwt_bob",
                expires : new Date(Date.now() + 60000)
            }).save();
            await writeAs("jwt_bob", withHeader(legacy)).expect(201);
            await writeAs("jwt_bob", withBearer(legacy)).expect(201);
        });
    });

    describe("logout and invalidation", function() {
        it("ends every session of the user and no one else's", async function() {
            var tokens = await Promise.all([login("jwt_alice"), login("jwt_alice"), login("jwt_bob")]);
            var a1 = tokens[0].name, a2 = tokens[1].name, b1 = tokens[2].name;
            var req = rawRequest('del', "/api/v1.1/users/auth_token");
            withBearer(a1)(req);
            await req.set('Content-Length', 0).expect(204);
            var res = await writeAs("jwt_alice", withHeader(a1)).expect(401);
            res.body.error.should.match(/Session has ended/);
            await writeAs("jwt_alice", withHeader(a2)).expect(401);
            await writeAs("jwt_bob", withHeader(b1)).expect(201);
            // a fresh login works again
            var t = await login("jwt_alice");
            await writeAs("jwt_alice", withHeader(t.name)).expect(201);
        });

        it("requires a token", async function() {
            await rawRequest('del', "/api/v1.1/users/auth_token")
                .set('Content-Length', 0).expect(400);
        });

        it("does not let DELETE /users/:id capture auth_token", async function() {
            await rawRequest('del', "/api/v1.1/users/auth_token")
                .set("x-auth-token", superToken)
                .set('Content-Length', 0).expect(204);
            // the super user's session ended, so get a new one
            var creds = ApiServer.getSuperCreds();
            superToken = (await login(creds.username, creds.password)).name;
        });

        it("ends sessions when the password changes", async function() {
            var user = users.jwt_carol;
            var oldSession = (await login("jwt_carol")).name;
            var update = JSON.parse(JSON.stringify(user));
            update.pw = "carol-new-pw";
            await ApiServer.put("/api/v1.1/users/jwt_carol", oldSession)
                .send(update).expect(200);
            await writeAs("jwt_carol", withHeader(oldSession)).expect(401);
            user.pw = "carol-new-pw";
            var t = await login("jwt_carol");
            await writeAs("jwt_carol", withHeader(t.name)).expect(201);
        });

        it("keeps sessions when the same password is sent again", async function() {
            var user = users.jwt_carol;
            var session = (await login("jwt_carol")).name;
            await ApiServer.put("/api/v1.1/users/jwt_carol", session)
                .send(JSON.parse(JSON.stringify(user))).expect(200);
            await writeAs("jwt_carol", withHeader(session)).expect(201);
        });

        it("rejects the session of a deleted user", async function() {
            var user = { name : "jwt_dave", pw : "dave-pw", email : "dave@jwt.test", roles : { } };
            await createUser(user);
            var session = (await login("jwt_dave", user.pw)).name;
            await deleteUser("jwt_dave");
            var res = await writeAs("jwt_dave", withHeader(session)).expect(401);
            res.body.error.should.match(/Invalid token/);
        });

        it("applies role changes on the next request", async function() {
            var carol = JSON.parse(JSON.stringify(users.jwt_carol));
            var session = (await login("jwt_carol")).name;
            // carol cannot administer bob's tokens yet
            await ApiServer.get("/api/v1.1/users/jwt_bob/tokens", session).expect(401);
            carol.roles = { jwt_g1 : "admin" };
            delete carol.pw;
            await ApiServer.put("/api/v1.1/users/jwt_carol", superToken)
                .send(carol).expect(200);
            await ApiServer.get("/api/v1.1/users/jwt_bob/tokens", session).expect(200);
        });
    });

    describe("session_gen", function() {
        it("is not returned with users", async function() {
            var res = await ApiServer.get("/api/v1.1/users/jwt_alice", superToken).expect(200);
            should.not.exist(res.body.session_gen);
            should.not.exist(res.body.pw);
            res = await ApiServer.get("/api/v1.1/users", superToken).expect(200);
            res.body.forEach(function(u) {
                should.not.exist(u.session_gen);
            });
        });

        it("cannot be set by clients", async function() {
            var bob = JSON.parse(JSON.stringify(users.jwt_bob));
            delete bob.pw;
            bob.session_gen = 42;
            var session = (await login("jwt_bob")).name;
            await ApiServer.put("/api/v1.1/users/jwt_bob", superToken)
                .send(bob).expect(200);
            // the session is still valid, so session_gen did not change
            await writeAs("jwt_bob", withHeader(session)).expect(201);
        });
    });
});
