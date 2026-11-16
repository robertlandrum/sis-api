import should from "should";
import SIS from "../../util/constants.js";
import * as TestUtil from "../fixtures/util.js";
import * as AuthFixture from "../fixtures/authdata.js";

describe('@API @V1.1API - Authorization API Schemas', function() {
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
        userNames.length.should.eql(Object.keys(userToTokens).length);
        userNames.forEach(function(uname) {
            userToTokens.should.have.property(uname);
            userToTokens[uname].should.have.property('username', uname);
        });
    });

    after(async function() {
        await ApiServer.stop();
    });

    // delete the schemas as the super user
    async function deleteSchemas(schemas) {
        ApiServer.authToken = superToken;
        try {
            await AuthFixture.deleteSchemas(ApiServer, schemas, false);
        } finally {
            ApiServer.authToken = null;
        }
    }

    // test adding schemas
    describe("adding schemas", function() {
        var schemas = AuthFixture.getAuthSchemas();
        // init
        before(async function() {
            // nuke existing schemas
            await deleteSchemas(schemas);
        });

        var addSchemaTests = {
            test_s1 : {
                pass : ['superman', 'superman2', 'admin5']
            },
            test_s2 : {
                pass : ['superman', 'superman2', 'admin5', 'admin4']
            }
        };

        Object.keys(addSchemaTests).forEach(function(schemaName) {
            var addTest = addSchemaTests[schemaName];
            var passes = addTest.pass;
            // figure out failures
            var failures = TestUtil.invert(userNames, passes);
            var schema = schemas[schemaName];
            // passes
            passes.forEach(function(userName) {
                var testName = userName + " should be able to add/delete " + schemaName;
                it(testName, async function() {
                    var token = userToTokens[userName].name;
                    var res = await ApiServer.post("/api/v1.1/schemas", token)
                        .send(schema)
                        .expect(201);
                    res.body.should.have.property(SIS.FIELD_NAME, schemaName);
                    // delete
                    await ApiServer.del("/api/v1.1/schemas/" + schemaName, token)
                        .expect(200);
                });
            }); // end passes

            // failures
            failures.forEach(function(userName) {
                var testName = userName + " should NOT be able to add " + schemaName;
                it(testName, async function() {
                    var token = userToTokens[userName];
                    userName.should.eql(token.username);
                    await ApiServer.post("/api/v1.1/schemas", token.name)
                        .send(schema)
                        .expect(401);
                });
            }); // end failures
        });
    });


    // update schemas
    describe("update schema owners", function() {
        // add / delete as superman
        // update as the user
        var schemas = AuthFixture.getAuthSchemas();

        // init
        before(async function() {
            // nuke existing schemas
            await deleteSchemas(schemas);
        });

        var updateTests = {
            test_s2 : [
                {
                    // tests that test_g3 can be added
                    owner : ['test_g1', 'test_g2', 'test_g3'],
                    pass : ['superman', 'superman2', 'admin5']
                },
                {
                    // tests that test_g1 can be removed by the users
                    owner : ['test_g2'],
                    pass : ['superman', 'superman2', 'admin4', 'admin5']
                },
                {
                    // tests that test_g4 is added
                    owner : ['test_g4'],
                    pass : ['superman', 'superman2']
                }
            ]
        };

        // (re)add the schema as the super user and update its owners as uname.
        // Resolves with the response of the update.
        async function updateOwners(schemaName, schema, owner, uname) {
            await ApiServer.del("/api/v1.1/schemas/" + schemaName, superToken);
            var added = (await ApiServer.post("/api/v1.1/schemas", superToken)
                .send(schema)
                .expect(201)).body;
            added._sis[SIS.FIELD_OWNER] = owner;
            return ApiServer.put("/api/v1.1/schemas/" + schemaName, userToTokens[uname].name)
                .send(added);
        }

        function expectStatus(res, status) {
            res.status.should.eql(status, JSON.stringify(res.body));
        }

        Object.keys(updateTests).forEach(function(schemaName) {
            var tests = updateTests[schemaName];
            var schema = schemas[schemaName];

            tests.forEach(function(updateTest) {
                var passes = updateTest.pass;
                var failures = TestUtil.invert(userNames, passes);
                var ownerStr = JSON.stringify(updateTest[SIS.FIELD_OWNER]);
                passes.map(function(uname) {
                    var testName = uname + " can update " + schemaName + " w/ owners " + ownerStr;
                    it(testName, async function() {
                        expectStatus(await updateOwners(schemaName, schema, updateTest[SIS.FIELD_OWNER], uname), 200);
                    });
                });

                failures.forEach(function(uname) {
                    var testName = uname + " cannot update " + schemaName + " w/ owners " + ownerStr;
                    it(testName, async function() {
                        expectStatus(await updateOwners(schemaName, schema, updateTest[SIS.FIELD_OWNER], uname), 401);
                    });
                });

            });
        });
    });

    describe("Open schemas", function() {

        var schema = {
            name : "test_very_open_schema",
            _sis : { owner : ["does_not_exist"] },
            is_open : true,
            definition : {
                name : "String"
            }
        };

        before(async function() {
            // nuke existing schemas
            await deleteSchemas([schema]);
        });

        it("Should be created by admin1", async function() {
            var token = userToTokens.admin1.name;
            await ApiServer.post("/api/v1.1/schemas", token)
                .send(schema).expect(201);
        });

        it("Should be updated by user4", async function() {
            var token = userToTokens.user4.name;
            schema.definition.num = "Number";
            await ApiServer.put("/api/v1.1/schemas/" + schema.name, token)
                .send(schema).expect(200);
        });

        it("Should not be updated by admin_2 changing is_open", async function() {
            var token = userToTokens.admin2.name;
            schema.is_open = false;
            await ApiServer.put("/api/v1.1/schemas/" + schema.name, token)
                .send(schema).expect(401);
        });

        it("Should be deleted by user2", async function() {
            var token = userToTokens.user2.name;
            await ApiServer.del("/api/v1.1/schemas/" + schema.name, token)
                .expect(200);
        });
    });

    describe("any_owner_can_modify schemas", function() {
        var schema = {
            name : "test_any_owner_schema",
            _sis : { owner : ["test_g1", "test_g2"] },
            any_owner_can_modify : true,
            definition : {
                name : "String"
            }
        };

        before(async function() {
            // nuke existing schema and create
            await deleteSchemas([schema]);
            await ApiServer.post("/api/v1.1/schemas", superToken)
                .send(schema).expect(201);
        });

        it("Should be updated by admin1", async function() {
            var token = userToTokens.admin1.name;
            schema.definition.num = "Number";
            await ApiServer.put("/api/v1.1/schemas/" + schema.name, token)
                .send(schema).expect(200);
        });

        it("Should be updated by admin2", async function() {
            var token = userToTokens.admin2.name;
            schema.definition.other_num = "Number";
            await ApiServer.put("/api/v1.1/schemas/" + schema.name, token)
                .send(schema).expect(200);
        });

        it("Should be deleted by admin1_1", async function() {
            var token = userToTokens.admin1_1.name;
            await ApiServer.del("/api/v1.1/schemas/" + schema.name, token)
                .expect(200);
        });
    });

});
