describe('@API @V1.1API - Authorization API Entities', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');
    var AuthFixture = require("../fixtures/authdata");

    var ApiServer = new TestUtil.TestServer();

    var users = AuthFixture.createUsers();
    var userNames = Object.keys(users);
    var userToTokens = { };
    var superToken = null;

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        // issue create requests
        var creds = ApiServer.getSuperCreds();
        superToken = (await ApiServer.getTempToken(creds.username, creds.password)).name;
        await AuthFixture.initUsers(ApiServer, superToken, users);
        await AuthFixture.createTempTokens(ApiServer, userToTokens, users);
    });

    after(async function() {
        await ApiServer.stop();
    });

    // delete and add the schemas as the super user
    async function resetSchemas(schemas) {
        ApiServer.authToken = superToken;
        try {
            await AuthFixture.deleteSchemas(ApiServer, schemas, false);
            await AuthFixture.addSchemas(ApiServer, schemas);
        } finally {
            ApiServer.authToken = null;
        }
    }

    describe("add entities", function() {

        var schemas = AuthFixture.getAuthSchemas();
        var entities = AuthFixture.createAuthEntities();
        // init
        before(async function() {
            await resetSchemas(schemas);
        });

        // add entities
        var addEntityTests = {
            test_s1_e1 : {
                // any user belonging to g1 g2 or g3
                pass : userNames
            },
            test_s1_e2 : {
                // must belong to g1 and g2
                pass : ['superman', 'superman2', 'admin5',
                        'user4', 'admin3', 'admin4', 'user3']
            },
            test_s2_e3 : {
                // nobody should be able to add this
                pass : [],
                fail_code : 400
            },
            test_s3_e4 : {
                // must be member of g2
                pass : ['superman', 'superman2', 'admin2', 'admin3', 'admin4',
                        'admin5', 'user2', 'user3', 'user4']
            },
            test_s4_e5 : {
                // open schema - everyone should be able to
                pass : userNames
            }
        };

        Object.keys(addEntityTests).map(function(entityName) {
            var addTest = addEntityTests[entityName];
            var passes = addTest.pass;
            var failures = TestUtil.invert(userNames, passes);

            var entity = entities[entityName].entity;
            var schemaName = entities[entityName].schema;
            // passes
            passes.map(function(userName) {
                var testName = userName + " should be able to add entity " + entityName;
                it(testName, async function() {
                    var token = userToTokens[userName].name;
                    var res = (await ApiServer.post("/api/v1.1/entities/" + schemaName, token)
                        .send(entity)
                        .expect(201)).body;
                    // validate add worked
                    should.exist(res);
                    entity.str.should.eql(res.str);
                    res._sis[SIS.FIELD_CREATED_BY].should.eql(userName);
                    // delete
                    await ApiServer.del("/api/v1.1/entities/" + schemaName + "/" + res._id, token)
                        .expect(200);
                });
            }); // end passes

            // failures
            failures.map(function(userName) {
                var testName = userName + " should NOT be able to add entity " + entityName;
                it(testName, async function() {
                    var token = userToTokens[userName].name;
                    await ApiServer.post("/api/v1.1/entities/" + schemaName, token)
                        .send(entity)
                        .expect(addTest.fail_code || 401);
                });
            });
        });
    });

    // update entities
    describe("update entities", function() {
        var schemas = AuthFixture.getAuthSchemas();
        var entities = AuthFixture.createAuthEntities();
        // init
        before(async function() {
            await resetSchemas(schemas);
        });

        var updateEntityTests = {
            test_s1_e2 : [
                {
                    owner : ['test_g4'],
                    pass : [],
                    err_code : 400
                },
                {
                    owner : ['test_g3'],
                    pass : ['superman', 'superman2', 'admin5', 'user4'],
                    err_code : 401
                }
            ]
        };

        Object.keys(updateEntityTests).map(function(entityName) {
            var updateTests = updateEntityTests[entityName];
            var entity = entities[entityName].entity;
            var schemaName = entities[entityName].schema;

            // add the entity as the super user
            async function addEntity() {
                return (await ApiServer.post("/api/v1.1/entities/" + schemaName, superToken)
                    .send(entity)
                    .expect(201)).body;
            }

            updateTests.map(function(test) {
                var passes = test.pass;
                var failures = TestUtil.invert(userNames, passes);
                var ownerStr = JSON.stringify(test.owner);
                passes.map(function(uname) {
                    var testName = uname + " can update " + entityName + " w/ owners " + ownerStr;
                    it(testName, async function() {
                        var r1 = await addEntity();
                        // validate that it was added it
                        r1.should.have.property('_sis');
                        r1._sis.should.have.property('owner', entity._sis.owner);
                        r1._sis.should.have.property(SIS.FIELD_CREATED_BY);
                        var created_by = r1._sis[SIS.FIELD_CREATED_BY];
                        var token = userToTokens[uname].name;
                        r1._sis[SIS.FIELD_OWNER] = test[SIS.FIELD_OWNER];
                        var r2 = (await ApiServer.put("/api/v1.1/entities/" + schemaName + "/" + r1._id, token)
                            .send(r1)
                            .expect(200)).body;
                        // validate that it updated
                        r2._sis[SIS.FIELD_CREATED_BY].should.eql(created_by);
                        r2._sis[SIS.FIELD_UPDATED_BY].should.eql(uname);
                        // delete..
                        await ApiServer.del("/api/v1.1/entities/" + schemaName + "/" + r1._id, superToken)
                            .expect(200);
                    });
                });

                var failCode = test.err_code;
                failures.map(function(uname) {
                    var testName = uname + " cannot update " + schemaName + " w/ owners " + ownerStr;
                    it(testName, async function() {
                        var r1 = await addEntity();
                        // update it
                        var token = userToTokens[uname].name;
                        r1._sis[SIS.FIELD_OWNER] = test[SIS.FIELD_OWNER];
                        await ApiServer.put("/api/v1.1/entities/" + schemaName + "/" + r1._id, token)
                            .send(r1)
                            .expect(failCode);
                        // delete..
                        await ApiServer.del("/api/v1.1/entities/" + schemaName + "/" + r1._id, superToken)
                            .expect(200);
                    });
                });

            });
        });
    });

    // the users each update only their own entity
    var ownUpdates = function(testUsers) {
        var updates = { };
        testUsers.forEach(function(user) {
            updates[user] = {
                pass : [user],
                fail : testUsers.filter(function(u) { return u != user; })
            };
        });
        return updates;
    };

    // tests that testUsers can add, update (their own) and delete entities
    // of schema
    var entityTests = function(schema, testUsers) {
        var updates = ownUpdates(testUsers);
        var userToEntity = { };
        // adds
        testUsers.forEach(function(user) {
            it("should add an entity for " + user, async function() {
                var token = userToTokens[user].name;
                var res = (await ApiServer.post("/api/v1.1/entities/" + schema.name, token)
                    .send({ name : user }).expect(201)).body;
                res.name.should.eql(user);
                userToEntity[user] = res;
            });
        });
        // updates
        testUsers.forEach(function(user) {
            var entity = {
                name : user + "-update"
            };
            updates[user].pass.forEach(function(passUser) {
                it(user + " should update entity for " + passUser, async function() {
                    var token = userToTokens[user].name;
                    var url = "/api/v1.1/entities/" + schema.name + "/" + userToEntity[passUser]._id;
                    await ApiServer.put(url, token).send(entity).expect(200);
                });
            });
            updates[user].fail.forEach(function(failUser) {
                it(user + " should not update entity for " + failUser, async function() {
                    var token = userToTokens[user].name;
                    var url = "/api/v1.1/entities/" + schema.name + "/" + userToEntity[failUser]._id;
                    await ApiServer.put(url, token).send(entity).expect(401);
                });
            });

        });
        // deletes
        testUsers.forEach(function(user) {
            it("should delete the entity for " + user, async function() {
                var token = userToTokens[user].name;
                await ApiServer.del("/api/v1.1/entities/" + schema.name + "/" + userToEntity[user]._id, token)
                    .expect(200);
            });
        });
    };

    describe("Open schemas", function() {
        var schema = {
            _sis : { owner : ["nobody_should_be_a_member"] },
            name : "test_open_schema",
            is_open : true,
            definition : {
                name : "String"
            }
        };
        var testUsers = ['admin1', 'admin2', 'user_g3'];
        before(async function() {
            // nuke existing schema
            await resetSchemas([schema]);
        });


        it("should not add an entity for a user without roles", async function() {
            var user = { name : "open_no_roles", email : "open_no_roles@test.com", pw : "open_no_roles", roles : { } };
            await ApiServer.del("/api/v1.1/users/" + user.name, superToken);
            await ApiServer.post("/api/v1.1/users", superToken).send(user).expect(201);
            var token = (await ApiServer.getTempToken(user.name, user.pw)).name;
            var res = await ApiServer.post("/api/v1.1/entities/" + schema.name, token)
                .send({ name : user.name }).expect(400);
            res.body.error.should.match(/User must have roles assigned/);
            await ApiServer.del("/api/v1.1/users/" + user.name, superToken).expect(200);
        });

        entityTests(schema, testUsers);

        // regardless of token, user should be able to create, update and delete an open schema
        testUsers.forEach(function(user) {
            it(user + " should manage a schema entirely", async function() {
                var token = userToTokens[user].name;
                var u_schema = {
                    name : "test_open_schema_" + user,
                    _sis : { owner : ["nobody_should_be_a_member"] },
                    is_open : true,
                    definition : {
                        name : "String"
                    }
                };
                await ApiServer.del("/api/v1.1/schemas/" + u_schema.name, superToken);
                await ApiServer.post("/api/v1.1/schemas", token).send(u_schema).expect(201);
                u_schema.definition.num = "Number";
                await ApiServer.put("/api/v1.1/schemas/" + u_schema.name, token)
                    .send(u_schema).expect(200);
                await ApiServer.del("/api/v1.1/schemas/" + u_schema.name, token)
                    .expect(200);
            });
        });
    });

    describe("Public schemas", function() {
        var schema = {
            name : "test_public_schema",
            _sis : { owner : ["nobody_should_be_a_member"] },
            is_public : true,
            definition : {
                name : "String"
            }
        };
        var testUsers = ['admin1', 'admin2', 'user_g3'];
        before(async function() {
            // nuke existing schema
            await resetSchemas([schema]);
        });

        entityTests(schema, testUsers);

        // users should not be able to create public schemas they don't own
        testUsers.forEach(function(user) {
            it(user + " should not manage a public schema entirely", async function() {
                var token = userToTokens[user].name;
                var u_schema = {
                    name : "test_public_schema_" + user,
                    _sis : { owner : ["nobody_should_be_a_member"] },
                    is_public : true,
                    definition : {
                        name : "String"
                    }
                };
                await ApiServer.post("/api/v1.1/schemas", token).send(u_schema)
                    .expect(401);
                schema.definition.num = "Number";
                await ApiServer.put("/api/v1.1/schemas/" + schema.name, token)
                    .send(schema).expect(401);
                await ApiServer.del("/api/v1.1/schemas/" + schema.name, token)
                    .expect(401);
            });
        });
    });

    describe("Any owner can modify entities", function() {
        var schemaOwners = ["test_g1", "test_g3"];
        var schema = {
            name : "test_any_owner_schema",
            _sis : { owner : schemaOwners },
            any_owner_can_modify : true,
            definition : {
                name : "String"
            }
        };

        var usersWhoCanUpdate = userNames.filter(function(uName) {
            var u = users[uName];
            if (u.super_user) { return true; }
            var roles = Object.keys(u.roles);
            return roles.some(function(r) {
                return schemaOwners.indexOf(r) !== -1;
            });
        });

        var usersWhoCannotUpdate = userNames.filter(function(u) {
            return usersWhoCanUpdate.indexOf(u) === -1;
        });

        var usersInBothGroups = userNames.filter(function(uName) {
            var u = users[uName];
            if (u.super_user) { return true; }
            return schemaOwners.every(function(r) {
                return r in u.roles;
            });
        });

        var usersNotInBothGroups = userNames.filter(function(u) {
            return usersInBothGroups.indexOf(u) === -1;
        });

        before(async function() {
            // nuke existing schema
            await resetSchemas([schema]);
        });

        var entityIds = [];


        it("Should add the entity and have any_owner_can_modify as true", async function() {
            var entity = {
                name : "initial",
                _sis : { owner : schemaOwners }
            };
            var res = (await ApiServer.post("/api/v1.1/entities/" + schema.name, superToken)
                .send(entity).expect(201)).body;
            entity.name.should.eql(res.name);
            res._sis[SIS.FIELD_ANY_ADMIN_MOD].should.eql(true);
        });

        var endpoint = ["/api/v1.1/entities", schema.name].join("/");
        usersWhoCanUpdate.forEach(function(u) {
            var testName = u + " can create/update the entity";
            it(testName, async function() {
                var token = userToTokens[u].name;
                var res = (await ApiServer.post(endpoint, token).send({
                    name : u,
                    _sis : { owner : schemaOwners }
                }).expect(201)).body;
                res.name.should.eql(u);
                res = (await ApiServer.put(endpoint + "/" + res._id, token).send({
                    name : u + "_update"
                }).expect(200)).body;
                res.name.should.eql(u + "_update");
                entityIds.push(res._id);
            });
        });

        usersWhoCannotUpdate.forEach(function(u) {
            var testName = u + " can not create/update an entity";
            it(testName, async function() {
                var token = userToTokens[u].name;
                await ApiServer.post(endpoint, token).send({
                    name : u,
                    _sis : { owner : schemaOwners }
                }).expect(401);
                await ApiServer.put(endpoint + "/" + entityIds[0], token).send({
                    name : u
                }).expect(401);
            });
        });

        // now ensure that we can override the any owner can modify
        var entityIdsByBoth = [];
        usersInBothGroups.forEach(function(u) {
            var testName = u + " can create/update an entity";
            it(testName, async function() {
                var token = userToTokens[u].name;
                var res = (await ApiServer.post(endpoint, token).send({
                    name : u,
                    _sis : { owner : schemaOwners,
                             any_owner_can_modify : false
                           }
                }).expect(201)).body;
                res.name.should.eql(u);
                res._sis[SIS.FIELD_ANY_ADMIN_MOD].should.eql(false);
                res = (await ApiServer.put(endpoint + "/" + res._id, token).send({
                    name : u + "_both"
                }).expect(200)).body;
                res.name.should.eql(u + "_both");
                entityIdsByBoth.push(res._id);
            });
        });

        usersNotInBothGroups.forEach(function(u) {
            var testName = u + " cannot create/update an entity";
            it(testName, async function() {
                var token = userToTokens[u].name;
                await ApiServer.post(endpoint, token).send({
                    name : u,
                    _sis : { owner : schemaOwners,
                             any_owner_can_modify : false
                           }

                }).expect(401);
                // try to update one of the ones created
                await ApiServer.put(endpoint + "/" + entityIdsByBoth[0], token)
                    .send({
                        name : u + "_should_fail"
                    }).expect(401);
            });
        });
    });
});
