describe('User Manager', function() {
    "use strict";

    var should = require('should');
    var util = require('util');
    var async = require('async');

    var SIS = require("../util/constants");
    var TestUtil = require('./fixtures/util');
    var LocalTest = new TestUtil.LocalTest();
    var schemaManager = null;

    before(function(done) {
        LocalTest.start(function(err, mongoose) {
            schemaManager = require("../util/schema-manager")(mongoose, { auth : true });
            done(err);
        });
    });

    after(function(done) {
        LocalTest.stop(done);
    });

    var AuthFixture = require("./fixtures/authdata");
    var users = AuthFixture.createUsers();

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
        ["superman", "user_g3", true],
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

    describe("user management add/delete", function() {

        addTests.map(function(test) {
            var usr = test[0];
            var usr2 = test[1];
            var pass = test[2];
            var testName = util.format("%s %s add %s", usr, (pass ? "can" : "cannot"), usr2);
            it(testName, function(done) {
                var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                var u1 = users[usr];
                var u2 = users[usr2];
                userManager.add(u2, { user : u1 }).nodeify(function(err, obj) {
                    if (pass) {
                        // expect pass..
                        should.not.exist(err);
                        should.exist(obj);
                        obj[SIS.FIELD_NAME].should.eql(u2[SIS.FIELD_NAME]);
                        // delete the user
                        userManager.delete(obj[SIS.FIELD_NAME], { user : u1 }).nodeify(done);
                    } else {
                        should.exist(err);
                        done();
                    }
                });
            });
        });

    });

    var validateUpdate = function(err, obj) {
        should.not.exist(err);
        should.exist(obj);
        obj = obj.updated;
        should.exist(obj);
        return obj;
    };

    describe("user management update fields", function() {
        // add all users in parallel
        before(function(done) {
            async.parallel(superTests.map(function(test) {
                var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                var u1 = users[test[0]];
                var u2 = users[test[1]];
                return function(cb) {
                    userManager.add(u2, { user : u1 }).nodeify(cb);
                };
            }), done);
        });
        // delete all users in parallel
        after(function(done) {
            async.parallel(superTests.map(function(test) {
                var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                var u1 = users[test[0]];
                var u2 = users[test[1]];
                return function(cb) {
                    userManager.delete(u2[SIS.FIELD_NAME], { user : u1 }).nodeify(cb);
                };
            }), done);
        });

        // super users can update fields on anyone
        addTests.map(function(test) {
            var pass = test[2];
            var u1 = users[test[0]];
            var u2 = users[test[1]];
            // non super users can't update fields of another
            if (!u1.super_user && u1.name != u2.name) {
                pass = false;
            }
            var testName = util.format("%s %s update fields for %s", test[0], (test[2] ? "can" : "cannot"), test[1]);
            it(testName, function(done) {
                var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                // copy u2 to prevent tainting the object
                var copy = JSON.parse(JSON.stringify(u2));
                // set the email field
                copy.email = u1.name + "." + copy.name + "@test.com";
                userManager.update(copy.name, copy, { user : u1 }).nodeify(function(err, obj) {
                    if (pass) {
                        // expect pass..
                        obj = validateUpdate(err, obj);
                        obj.email.should.eql(copy.email);
                    } else {
                        should.exist(err);
                    }
                    done();
                });
            });
        });

        // users should be able to update their own fields
        Object.keys(users).map(function(username) {
            // superman wasn't added..
            if (username == "superman") { return; }
            it(username + " can update fields on itself", function(done) {
                var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                var u1 = users[username];
                var copy = JSON.parse(JSON.stringify(u1));
                // set the email field
                copy.email = username + "." + username + "@test.com";
                userManager.update(copy.name, copy, { user : u1 }).nodeify(function(err, obj) {
                    // expect pass..
                    obj = validateUpdate(err, obj);
                    obj.email.should.eql(copy.email);
                    done();
                });
            });
        });

    });

    describe("user management modify roles:", function() {
        // add all users in parallel
        before(function(done) {
            async.parallel(superTests.map(function(test) {
                var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                var u1 = users[test[0]];
                var u2 = users[test[1]];
                return function(cb) {
                    userManager.add(u2, { user : u1 }).nodeify(cb);
                };
            }), done);
        });
        // delete all users in parallel
        after(function(done) {
            async.parallel(superTests.map(function(test) {
                var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                var u1 = users[test[0]];
                var u2 = users[test[1]];
                return function(cb) {
                    userManager.delete(u2[SIS.FIELD_NAME], { user : u1 }).nodeify(cb);
                };
            }), done);
        });


        updateTests.map(function(test) {
            var pass = test[5];
            var action = test[2];
            var u1 = users[test[0]];
            var u2 = users[test[1]];
            var group = test[3];
            var role = test[4];
            var testName = null;
            if (action == 'u') {
                // u1 can/cannot update u2 to group role
                testName = util.format("%s %s update %s to %s %s",
                                          u1.name, (pass ? "can" : "cannot"), u2.name, group, role);
                it(testName, function(done) {
                    var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                    var oldRoleVal = u2.roles[group];
                    var copy = JSON.parse(JSON.stringify(u2));
                    copy.roles = copy.roles || {};
                    copy.roles[group] = role;
                    userManager.update(u2.name, copy, { user : u1 }).nodeify(function(err, obj) {
                        if (pass) {
                            obj = validateUpdate(err, obj);
                            obj.roles[group].should.eql(copy.roles[group]);
                            // revert change
                            copy.roles[group] = oldRoleVal;
                            userManager.update(u2.name, copy, { user : u1 }).nodeify(function(err, reverted) {
                                reverted = validateUpdate(err, reverted);
                                reverted.roles[group].should.eql(u2.roles[group]);
                                done();
                            });
                        } else {
                            should.exist(err);
                            done();
                        }
                    });
                });
            } else {
                // u1 can/canmot add/remove group to u2
                testName = util.format("%s %s %s %s to %s",
                                          u1.name, (pass ? "can" : "cannot"),
                                          (action == 'a' ? 'add' : 'remove'), group, u2.name);
                it(testName, function(done) {
                    var userManager = schemaManager.auth[SIS.SCHEMA_USERS];
                    var copy = JSON.parse(JSON.stringify(u2));
                    copy.roles = copy.roles || {};
                    if (action == 'd') {
                        delete copy.roles[group];
                    } else {
                        copy.roles[group] = role;
                    }
                    userManager.getById(u2.name).done(function(o1) {
                        userManager.update(u2.name, copy, { user : u1 }).nodeify(function(err, obj) {
                            if (pass) {
                                obj = validateUpdate(err, obj);
                                if (action == 'd') {
                                    should.not.exist(obj.roles[group]);
                                    // revert
                                    copy.roles[group] = u2.roles[group];
                                    userManager.update(u2.name, copy, { user : u1 }).nodeify(function(err, reverted) {
                                        reverted = validateUpdate(err, reverted);
                                        reverted.roles[group].should.eql(u2.roles[group]);
                                        done();
                                    });
                                } else {
                                    obj.roles[group].should.eql(role);
                                    userManager.getById(obj.name).done(function(o) {
                                        o.toObject().should.eql(obj.toObject());
                                        // revert
                                        delete copy.roles[group];
                                        userManager.update(u2.name, copy, { user : u1 }).nodeify(function(err, reverted) {
                                            reverted = validateUpdate(err, reverted);
                                            should.not.exist(reverted.roles[group]);
                                            done();
                                        });
                                    });
                                }
                            } else {
                                should.exist(err);
                                done();
                            }
                        });
                    });
                });
            }
        });
    });

    describe("edge cases", function() {
        var expectError = TestUtil.expectError;
        var userManager = null;
        var superUser = { name : "edge_super", super_user : true };
        var edgeAdmin = { name : "edge_admin", email : "edge_admin@test.com", pw : "edge_admin",
                          roles : { test_g1 : "admin" } };
        var edgeUser = { name : "edge_user", email : "edge_user@test.com", pw : "edge_user",
                         roles : { test_g1 : "user" } };

        before(async function() {
            userManager = schemaManager.auth[SIS.SCHEMA_USERS];
            for (var u of [edgeAdmin, edgeUser]) {
                await userManager.add(u, { user : superUser });
            }
        });

        after(async function() {
            for (var name of [edgeAdmin.name, edgeUser.name, "edge_new"]) {
                try {
                    await userManager.delete(name, { user : superUser });
                } catch (err) {
                    // not every test leaves it behind
                }
            }
        });

        it("accepts email addresses with long top level domains and plus tags", async function() {
            var emails = ["ops@acme.museum", "ops@corp.engineering", "first.last@mail.corp.example",
                          "ops+sis@corp.com", "o-p_s@corp-x.io"];
            for (var i = 0; i < emails.length; i++) {
                var name = "edge_email_" + i;
                var added = await userManager.add({ name : name, email : emails[i], pw : "p", roles : { } },
                                                  { user : superUser });
                added.email.should.eql(emails[i]);
                await userManager.delete(name, { user : superUser });
            }
        });

        it("rejects email addresses that are not addresses", async function() {
            for (var email of ["ops@x.c", "bad@", "@corp.com", "not-an-email", "ops@corp", "o ps@corp.com"]) {
                await expectError(userManager.add({ name : "edge_email_bad", email : email, pw : "p", roles : { } },
                                                  { user : superUser }), 400, /email/);
            }
        });

        it("ends the sessions of a user", async function() {
            var before = (await userManager.getById(edgeUser.name, { lean : true }))[SIS.FIELD_SESSION_GEN] || 0;
            (await userManager.endSessions(edgeUser.name)).should.eql(edgeUser.name);
            var after = (await userManager.getById(edgeUser.name, { lean : true }))[SIS.FIELD_SESSION_GEN];
            after.should.eql(before + 1);
            await expectError(userManager.endSessions("nobody"), 404);
        });

        it("verifies passwords", async function() {
            (await userManager.getVerifiedUser(edgeUser.name, edgeUser.pw)).name.should.eql(edgeUser.name);
            await expectError(userManager.getVerifiedUser(edgeUser.name, "wrong"), 401, /Invalid password/);
            await expectError(userManager.getVerifiedUser("nobody", "x"), 404);
        });

        it("requires a name", function() {
            userManager.validate(null).should.match(/must have a name/);
            userManager.validate({}).should.match(/must have a name/);
        });

        describe("getOrCreateEmptyUser", function() {
            it("rejects incomplete users", async function() {
                await expectError(userManager.getOrCreateEmptyUser(null, superUser), 500, /Invalid user/);
                await expectError(userManager.getOrCreateEmptyUser({ name : "x" }, superUser), 500, /Invalid user/);
            });

            it("returns the user that exists", async function() {
                var user = await userManager.getOrCreateEmptyUser({ name : edgeUser.name, email : "other@x.com" }, superUser);
                user.email.should.eql(edgeUser.email);
                user.roles.should.eql(edgeUser.roles);
            });

            it("creates a user without roles", async function() {
                var user = await userManager.getOrCreateEmptyUser({ name : "edge_new", email : "edge_new@x.com" }, superUser);
                user.name.should.eql("edge_new");
                user.roles.should.eql({});
                user.super_user.should.eql(false);
                (await userManager.getById("edge_new", { lean : true })).email.should.eql("edge_new@x.com");
            });

            it("passes on why the user could not be created", async function() {
                var err = await expectError(userManager.getOrCreateEmptyUser({ name : "edge_new2", email : "e@x.com" }, null),
                                            401, /User is null/);
                err[1].error.should.not.match(/ at /);
            });
        });

        describe("authorize", function() {
            it("allows everything when auth is off", async function() {
                var noAuth = Object.create(userManager);
                noAuth.authEnabled = false;
                var doc = { name : "x" };
                (await noAuth.authorize(SIS.EVENT_INSERT, doc, null)).should.equal(doc);
            });

            it("requires a user with roles", async function() {
                await expectError(userManager.authorize(SIS.EVENT_INSERT, { name : "x" }, null), 401, /User is null/);
                await expectError(userManager.authorize(SIS.EVENT_INSERT, { name : "x" }, { name : "y" }),
                                  401, /no roles/);
            });

            it("does not let users add or delete themselves", async function() {
                var doc = { name : edgeAdmin.name, roles : { test_g1 : "user" } };
                await expectError(userManager.authorize(SIS.EVENT_DELETE, doc, edgeAdmin), 401, /same name/);
            });

            it("does not let users change their own roles", async function() {
                var doc = (await userManager.getById(edgeAdmin.name)).toObject();
                var merged = await userManager.getById(edgeAdmin.name);
                merged.roles = { test_g1 : "admin", test_g2 : "user" };
                await expectError(userManager.authorize(SIS.EVENT_UPDATE, doc, edgeAdmin, merged),
                                  401, /cannot change their own roles/);
            });

            it("only lets role admins change roles of others", async function() {
                var doc = (await userManager.getById(edgeUser.name)).toObject();
                var merged = await userManager.getById(edgeUser.name);
                merged.roles = { test_g1 : "user", test_g2 : "user" };
                await expectError(userManager.authorize(SIS.EVENT_UPDATE, doc, edgeAdmin, merged),
                                  401, /not an admin of role test_g2/);
            });

            it("does not let role admins change other fields", async function() {
                var doc = (await userManager.getById(edgeUser.name)).toObject();
                var merged = await userManager.getById(edgeUser.name);
                merged.roles = { test_g1 : "admin" };
                merged.email = "changed@x.com";
                await expectError(userManager.authorize(SIS.EVENT_UPDATE, doc, edgeAdmin, merged),
                                  401, /non role fields. \(email\)/);
            });

            it("only lets the user change their own fields", async function() {
                var doc = (await userManager.getById(edgeUser.name)).toObject();
                var merged = await userManager.getById(edgeUser.name);
                merged.email = "changed@x.com";
                await expectError(userManager.authorize(SIS.EVENT_UPDATE, doc, edgeAdmin, merged),
                                  401, /Only the user or a super user/);
                (await userManager.authorize(SIS.EVENT_UPDATE, doc, edgeUser, merged)).should.equal(merged);
            });

            it("does not let users verify themselves", async function() {
                var doc = (await userManager.getById(edgeUser.name)).toObject();
                var merged = await userManager.getById(edgeUser.name);
                merged.verified = true;
                await expectError(userManager.authorize(SIS.EVENT_UPDATE, doc, edgeUser, merged),
                                  400, /verified state/);
            });
        });

        it("rejects when the user's tokens cannot be removed", async function() {
            var broken = Object.create(userManager);
            broken.sm = Object.create(schemaManager);
            broken.sm.getTokenManagerForUser = function() {
                return { model : { deleteMany : function() {
                    return { exec : function() { return Promise.reject(new Error("db down")); } };
                } } };
            };
            await expectError(broken.objectRemoved({ name : "x" }), 500, /Unable to clear tokens/);
        });
    });
});
