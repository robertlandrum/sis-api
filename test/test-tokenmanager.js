describe('Token Manager', function() {
    "use strict";

    var should = require('should');
    var util = require('util');

    var SIS = require("../util/constants");
    var TestUtil = require('./fixtures/util');
    var LocalTest = new TestUtil.LocalTest();
    var schemaManager = null;

    before(async function() {
        var mongoose = await LocalTest.start();
        schemaManager = require("../util/schema-manager")(mongoose, { auth : true });
    });

    after(async function() {
        await LocalTest.stop();
    });

    var users = require("./fixtures/authdata").createUsers();
    var addTests = [
        // array defining test
        // firstuser can add seconduser pass/fail
        // superman can add everyone
        ["superman", "admin1", true],
        ["superman", "admin1_1", true],
        ["superman", "superman2", true],
        ["superman", "admin2", true],
        ["superman", "admin3", true],
        ["superman", "admin4", true],
        ["superman", "admin5", true],
        ["superman", "user1", true],
        ["superman", "user2", true],
        ["superman", "user3", true],
        ["superman", "user4", true],
        // admin1 - similar as admin2
        ["admin1", "superman", false],
        ["admin1", "admin1_1", true],
        ["admin1", "admin2", false],
        ["admin1", "admin3", false],
        ["admin1", "admin4", false],
        ["admin1", "user1", true],
        ["admin1", "user2", false],
        ["admin1", "user3", false],
        // admin3
        ["admin3", "admin2", false],
        ["admin3", "admin4", false],
        ["admin3", "user1", true],
        ["admin3", "user2", false],
        ["admin3", "user3", false],
        // users
        ["user3", "superman", false],
        ["user3", "admin1", false],
        ["user3", "admin2", false],
        ["user3", "admin3", false],
        ["user3", "user1", false],
        ["user3", "user2", false]
    ];

    var superTests = addTests.filter(function(test) {
        return test[0] == 'superman';
    });


    var updateTests = [
        // test is:
        // [userDoingTheAction, userBeingManaged, action(add, delete, update), group modified, role, pass/fail]

        // adds and updates
        // admin1 can do whatever he wants on test_g1
        ["admin1", "admin2", 'a', 'test_g1', 'user', true],
        ["admin1", "admin3", 'd', 'test_g1', null, true],
        ["admin1", "user3", 'u', 'test_g1', 'admin', true],

        // superman does it all
        ["superman", "admin1", 'a', 'test_g2', 'user', true],
        ["superman", "admin1", 'a', 'test_g2', 'admin', true],
        ["superman", "user1", 'u', 'test_g1', 'user', true],

        // admin1 only administers test_g1
        ["admin1", "admin1_1", 'a', 'test_g2', 'user', false],
        // can't modify a super user
        ["admin1", "superman2", 'a', 'test_g1', 'user', false],

        // user3 isn't an admin of anything
        ["user3", "admin1", 'a', "test_g2", 'user', false]
    ];

    it("should not store tokens that expire", async function() {
        // temporary tokens are JWT sessions and never stored
        var tokenManager = schemaManager.getTokenManagerForUser("user1");
        var token = { username : "user1", expires : Date.now() + 10000 };
        await TestUtil.expectError(tokenManager.add(token, { user : users.superman }), 400, /cannot expire/);
    });

    describe("persistent tokens", function() {
        // add all users and a token in parallel
        before(async function() {
            var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
            await Promise.all(superTests.map(function(test) {
                return userManager.add(users[test[1]], { user : users[test[0]] });
            }));
        });

        // add tests should map to who can create a token for a user
        addTests.map(function(test) {
            var usr = test[0];
            var usr2 = test[1];
            var pass = test[2];
            var u1 = users[usr];
            var u2 = users[usr2];
            if (u2.super_user) {
                // can't create persistent tokens for super users..
                pass = false;
            }
            var testName = util.format("%s %s create token for %s", usr, (pass ? "can" : "cannot"), usr2);
            it(testName, async function() {
                var tokenManager = schemaManager.getTokenManagerForUser(u2[SIS.FIELD_NAME]);
                var token = {
                    username : u2[SIS.FIELD_NAME],
                    desc : "token added by " + u1[SIS.FIELD_NAME]
                };
                var added = tokenManager.add(token, { user : u1 });
                if (pass) {
                    (await added)[SIS.FIELD_USERNAME].should.eql(u2[SIS.FIELD_NAME]);
                } else {
                    await should(added).be.rejected();
                }
            });
        });

        // delete all users in parallel
        // and ensure the tokens are gone
        superTests.map(function(test) {
            it("Should delete user and all tokens for " + test[1], async function() {
                var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                var u = await userManager.delete(users[test[1]][SIS.FIELD_NAME], { user : users[test[0]] });
                should.exist(u);
                var tokenManager = schemaManager.getTokenManagerForUser(u[SIS.FIELD_NAME]);
                (await tokenManager.getAll({ }, null, null)).length.should.eql(0);
            });
        });
    });

    describe("edge cases", function() {
        var expectError = TestUtil.expectError;
        var userManager = null;
        var owner = { name : "token_owner", email : "token_owner@test.com", pw : "token_owner",
                      roles : { test_g1 : "user" } };

        before(async function() {
            userManager = schemaManager.auth[SIS.SCHEMA_USERS];
            await userManager.add(owner, { user : users.superman });
        });

        after(async function() {
            await userManager.delete(owner.name, { user : users.superman });
        });

        it("only gets the tokens of its user", async function() {
            var token = await schemaManager.getTokenManagerForUser(owner.name)
                .add({ desc : "mine" }, { user : users.superman });
            var other = schemaManager.getTokenManagerForUser("admin1");
            await expectError(other.getById(token.name), 404, /Token for admin1/);
            var mine = await schemaManager.getTokenManagerForUser(owner.name).getById(token.name);
            mine.desc.should.eql("mine");
            (await schemaManager.tokenFetcher.getTokenByName(token.name)).username.should.eql(owner.name);
        });

        it("rejects tokens for no user or another user", async function() {
            await expectError(schemaManager.tokenFetcher.add({ desc : "x" }, { user : users.superman }),
                              400, /invalid user/);
            await expectError(schemaManager.getTokenManagerForUser(owner.name)
                              .add({ username : "admin1" }, { user : users.superman }),
                              400, /must belong to token_owner/);
        });

        it("retries a token name that is taken", async function() {
            var crypto = require("crypto");
            var tokenManager = schemaManager.getTokenManagerForUser(owner.name);
            // the unique index on the token name is rebuilt in the background
            // after earlier specs drop the database - wait for it
            await schemaManager.indexesReady(tokenManager.model);
            await tokenManager.model.createIndexes();
            var first = await tokenManager.add({ desc : "first" }, { user : users.superman });
            var original = crypto.randomBytes;
            var calls = 0;
            crypto.randomBytes = function(n) {
                calls++;
                // the first name generated is the one already taken
                return calls === 1 ? Buffer.from(first.name, "hex") : original.call(crypto, n);
            };
            var second;
            try {
                second = await tokenManager.add({ desc : "second" }, { user : users.superman });
            } finally {
                crypto.randomBytes = original;
            }
            calls.should.eql(2);
            second.name.should.not.eql(first.name);
        });

        describe("authorize", function() {
            var tokenManager = null;
            before(function() {
                tokenManager = schemaManager.getTokenManagerForUser(owner.name);
            });

            it("requires a username", async function() {
                await expectError(tokenManager.authorize(SIS.EVENT_INSERT, {}, users.superman), 400, /Missing username/);
            });

            it("does not change the username", async function() {
                await expectError(tokenManager.authorize(SIS.EVENT_UPDATE, { username : owner.name },
                                                         users.superman, { username : "admin1" }),
                                  400, /Cannot change the username/);
            });

            it("does not change temporary tokens", async function() {
                var doc = { username : owner.name };
                await expectError(tokenManager.authorize(SIS.EVENT_UPDATE, doc, users.superman,
                                                         { username : owner.name, expires : new Date() }),
                                  400, /temporary token/);
            });

            it("requires a user with roles", async function() {
                var doc = { username : owner.name };
                await expectError(tokenManager.authorize(SIS.EVENT_INSERT, doc, null), 401, /User is null/);
                await expectError(tokenManager.authorize(SIS.EVENT_INSERT, doc, { name : "x" }), 401, /Invalid user/);
            });

            it("lets the user and admins of the user's roles manage tokens", async function() {
                var doc = { username : owner.name };
                (await tokenManager.authorize(SIS.EVENT_INSERT, doc, owner)).should.equal(doc);
                (await tokenManager.authorize(SIS.EVENT_INSERT, doc, users.admin1)).should.equal(doc);
                await expectError(tokenManager.authorize(SIS.EVENT_INSERT, doc, users.admin2), 401, /Only admins/);
            });

            it("resolves with the merged token on update", async function() {
                var merged = { username : owner.name, desc : "new" };
                (await tokenManager.authorize(SIS.EVENT_UPDATE, { username : owner.name }, owner, merged))
                    .should.equal(merged);
            });

            it("allows everything that keeps the username when auth is off", async function() {
                var noAuth = Object.create(tokenManager);
                noAuth.authEnabled = false;
                var doc = { username : owner.name };
                (await noAuth.authorize(SIS.EVENT_INSERT, doc, null)).should.equal(doc);
            });

            it("does not upsert", function() {
                tokenManager.canInsertWithId("x", { name : "x" }).should.eql(false);
            });
        });
    });

});
