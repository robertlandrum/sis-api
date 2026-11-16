import fs from "fs";
import path from "path";
import nconf from "nconf";
import should from "should";
import * as server from "../server.js";
import * as TestUtil from "./fixtures/util.js";

describe('Authenticated reads API', function() {
    var ApiServer = new TestUtil.TestServer();

    var schema = {
        "name" : "test_auth_reads",
        _sis : { "owner" : ["test"] },
        "definition" : {
            "str" : "String"
        }
    };
    var script = {
        name : "test_auth_reads_params",
        script_type : "application/javascript",
        script : fs.readFileSync(path.join(import.meta.dirname, "fixtures", "scripts", "params.js"), "utf8"),
        _sis : { owner : ["test"] }
    };

    var token = null;
    var entity = null;

    before(async function() {
        nconf.add("auth_reads", {
            type : "literal",
            store : {
                "app" : { "auth_reads" : true }
            }
        });
        var sd = await ApiServer.start();
        await ApiServer.becomeSuperUser();
        // send tokens explicitly so unauthenticated requests are possible
        token = ApiServer.authToken;
        ApiServer.authToken = null;
        var options = { user : sd.superUser, version : "v1.1" };
        try {
            await sd.schemaManager.delete(schema.name, options);
        } catch (err) {
            // not there yet
        }
        await sd.schemaManager.add(schema, options);
        entity = (await ApiServer.post("/api/v1.1/entities/" + schema.name, token)
            .send({ str : "secret" }).expect(201)).body;
        await ApiServer.del("/api/v1.1/scripts/" + script.name, token);
        await ApiServer.post("/api/v1.1/scripts", token).send(script).expect(201);
    });

    after(async function() {
        nconf.remove("auth_reads");
        await ApiServer.del("/api/v1.1/schemas/" + schema.name, token);
        await ApiServer.del("/api/v1.1/scripts/" + script.name, token);
        await ApiServer.stop();
    });

    function securedPaths() {
        return [
            "/api/v1.1/schemas",
            "/api/v1.1/schemas/" + schema.name,
            "/api/v1.1/schemas/" + schema.name + "/commits",
            "/api/v1.1/hiera",
            "/api/v1.1/hooks",
            "/api/v1.1/scripts",
            "/api/v1.1/scripts/" + script.name,
            "/api/v1.1/users",
            "/api/v1.1/users/sistest_super",
            "/api/v1.1/users/sistest_super/tokens",
            "/api/v1.1/entities/" + schema.name,
            "/api/v1.1/entities/" + schema.name + "/" + entity._id,
            "/api/v1.1/entities/" + schema.name + "/" + entity._id + "/commits",
            "/api/v1.1/entities/" + schema.name + "/" + entity._id + "/revision/" + Date.now(),
            "/api/v1.1/endpoints/" + script.name + "/"
        ];
    }

    it("should reject reads without a token", async function() {
        await Promise.all(securedPaths().map(async function(p) {
            var res = await ApiServer.get(p);
            res.status.should.eql(400, p);
            res.body.error.should.match(/x-auth-token/, p);
        }));
    });

    it("should reject reads with an unknown token", async function() {
        await Promise.all(securedPaths().map(async function(p) {
            (await ApiServer.get(p, "not-a-real-token")).status.should.eql(401, p);
        }));
    });

    it("should allow reads with a valid token", async function() {
        await Promise.all(securedPaths().map(async function(p) {
            (await ApiServer.get(p, token)).status.should.eql(200, p);
        }));
    });

    it("should return entity data with a valid token", async function() {
        var res = await ApiServer.get("/api/v1.1/entities/" + schema.name + "/" + entity._id, token)
            .expect(200);
        res.body.str.should.eql("secret");
    });

    it("should leave /info open", async function() {
        await ApiServer.get("/api/v1.1/info").expect(200);
    });

    it("should leave HEAD / open for health checks", async function() {
        await ApiServer.newRequest("head", "/").expect(200);
    });

    it("should still issue tokens with user credentials", async function() {
        var creds = ApiServer.getSuperCreds();
        should.exist((await ApiServer.getTempToken(creds.username, creds.password)).name);
    });

    it("should still require a token for writes", async function() {
        await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send({ str : "nope" }).expect(400);
    });

    describe("config validation", function() {
        it("should reject auth_reads without auth", function() {
            (function() {
                server.validateAppConfig({ auth_reads : true });
            }).should.throw(/auth_reads requires app\.auth/);
            (function() {
                server.validateAppConfig({ auth : false, auth_reads : true });
            }).should.throw(/auth_reads requires app\.auth/);
        });

        it("should accept valid combinations", function() {
            server.validateAppConfig(undefined);
            server.validateAppConfig({ auth : true, auth_reads : true });
            server.validateAppConfig({ auth : false, auth_reads : false });
            server.validateAppConfig({ auth : true });
        });
    });
});
