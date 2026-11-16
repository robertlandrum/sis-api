describe('@API @V1.1API - Authorization API Tokens', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');
    var AuthFixture = require("../fixtures/authdata");

    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        // issue create requests
        var creds = ApiServer.getSuperCreds();
        var t = await ApiServer.getTempToken(creds.username, creds.password);
        await AuthFixture.initUsers(ApiServer, t.name, AuthFixture.createUsers());
    });

    after(async function() {
        await ApiServer.stop();
    });

    var users = AuthFixture.createUsers();
    var userNames = Object.keys(users);
    var userToTokens = { };

    describe("create tokens", function() {
        userNames.forEach(function(name) {
            var testName = "should create tokens for " + name;
            it(testName, async function() {
                // first token is a temp token
                var user = users[name];
                var token = await ApiServer.getTempToken(name, name);
                should.exist(token);
                name.should.eql(token.username);
                token.should.have.property('expires');
                // now use the token to create a persistent token
                var data = {
                    'desc' : 'persistent token'
                };
                var req = ApiServer.post("/api/v1.1/users/" + name + "/tokens", token.name)
                              .send(data);
                if (user.super_user) {
                    // super users get no persistent tokens
                    await req.expect(400);
                    userToTokens[name] = [token];
                } else {
                    var ptoken = (await req.expect(201)).body;
                    should.exist(ptoken);
                    name.should.eql(ptoken.username);
                    // store the tokens
                    userToTokens[name] = [token, ptoken];
                }
            });
        });
    });

    describe("get tokens", function() {
        // setup the test
        var nonSupers = userNames.filter(function(name) {
            return !users[name].super_user;
        });
        // admins map
        var admins_of = {
            superman : { pass : userNames, fail : [] },
            superman2 : { pass : userNames, fail : [] },
            admin1 : {
                pass : ['admin1_1', 'user1']
            },
            admin5 : { pass : nonSupers, fail : ['superman', 'superman2'] },
            user1 : { pass : [] },
            user4 : { pass : [] }
        };
        Object.keys(admins_of).forEach(function(name) {
            if (!admins_of[name].fail) {
                admins_of[name].pass.push(name);
                admins_of[name].fail = TestUtil.invert(userNames, admins_of[name].pass);
            }
        });

        // actual tests
        Object.keys(admins_of).forEach(function(name) {
            var admin_test = admins_of[name];
            var passes = admin_test.pass;
            passes.forEach(function(pass) {
                var testName = name + " should get tokens for " + pass;
                it(testName, async function() {
                    var reqToken = userToTokens[name][0].name;
                    var res = await ApiServer.get('/api/v1.1/users/' + pass + '/tokens', reqToken)
                        .expect(200);
                    res.body.should.be.an.instanceOf(Array);
                });
            });
            var fails = admin_test.fail;
            fails.forEach(function(fail) {
                var testName = name + " should not get tokens for " + fail;
                it(testName, async function() {
                    var reqToken = userToTokens[name][0].name;
                    await ApiServer.get('/api/v1.1/users/' + fail + '/tokens', reqToken)
                        .expect(401);
                });
            });
        });

        // some sanity tests
        // ensure that a user's token can't be accessed at the wrong path
        it("superman token should not show up under superman2", async function() {
            var reqToken = userToTokens.superman[0].name;
            var tokenToReq = userToTokens.superman2[0].name;
            var url = '/api/v1.1/users/superman/tokens/' + tokenToReq;
            await ApiServer.get(url, reqToken).expect(404);
        });

    });

    describe("delete tokens", function() {
        userNames.forEach(function(name) {
            it(name + " cannot delete a session token via the tokens api", async function() {
                // sessions are JWTs and are not stored; logout ends them
                var session = userToTokens[name][0];
                var url = "/api/v1.1/users/" + name + "/tokens/" + session.name;
                await ApiServer.del(url, session.name).expect(404);
            });
            var testName = name + " can delete own persistent tokens";
            it(testName, async function() {
                var session = userToTokens[name][0];
                var tokens = userToTokens[name].slice(1);
                await Promise.all(tokens.map(function(token) {
                    var url = "/api/v1.1/users/" + name + "/tokens/" + token.name;
                    return ApiServer.del(url, session.name).expect(200);
                }));
            });
        });
    });

});
